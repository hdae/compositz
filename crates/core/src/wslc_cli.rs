//! Delegate container create+start to the `wslc` CLI on the wslc endpoint.
//!
//! wslc registers the Windows localhost relay for published ports ONLY inside its
//! own create/start path (there is no adopt/relay-after-the-fact API), so a
//! container created through the raw Docker API is unreachable from a Windows
//! browser (ADR-031). The `wslc` CLI resolves the same default per-user session
//! the dial-stdio doorway talks to, so everything else (build / logs / events /
//! stop / rm) stays on the Docker API — wslc reconciles external stop/rm through
//! Docker events, including tearing the relay down.
//!
//! The argv built here is a PROJECTION of the same [`ContainerCreateBody`] the
//! bollard path sends: one spec source, two renderers. Any body field the
//! projection cannot carry MUST fail loudly instead of being dropped — a reduced
//! spec silently launching is worse than no launch.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use bollard::models::{ContainerCreateBody, HostConfig, Mount, MountType};

use crate::Error;

/// One `wslc` invocation (create or start) may pull image metadata and boot the
/// session VM on a cold start — generous, matches the engine connect timeout.
const WSLC_TIMEOUT: Duration = Duration::from_secs(120);

/// Create the container via `wslc create` and start it via `wslc start`,
/// returning the container id `wslc create` printed.
pub async fn create_and_start(name: &str, body: &ContainerCreateBody) -> Result<String, Error> {
    create_and_start_with(OsStr::new("wslc"), name, body).await
}

/// Program-injectable worker behind [`create_and_start`] — tests point it at a
/// stub executable, production always passes `wslc` (resolved via PATH like the
/// dial-stdio bridge's own `wslc` invocation).
pub async fn create_and_start_with(
    program: &OsStr,
    name: &str,
    body: &ContainerCreateBody,
) -> Result<String, Error> {
    let lines = env_file_lines(body)?;
    // The env vars travel via --env-file, NOT argv: sidesteps the ~32KB command
    // line limit and keeps HF_TOKEN-class secrets out of the process command
    // line (visible to every same-user process). The temp file MUST outlive the
    // `wslc create` run — wslc.exe parses it client-side at spawn.
    let env_file = match lines.is_empty() {
        true => None,
        false => {
            use std::io::Write;
            let mut file = tempfile::NamedTempFile::new()?;
            for line in &lines {
                writeln!(file, "{line}")?;
            }
            file.flush()?;
            Some(file)
        }
    };

    let args = wslc_create_args(name, body, env_file.as_ref().map(|f| f.path()))?;
    let stdout = run_wslc(program, &args, "create").await?;
    drop(env_file);
    let id = parse_container_id(&stdout)?;
    run_wslc(
        program,
        &[OsString::from("start"), OsString::from(&id)],
        "start",
    )
    .await?;
    Ok(id)
}

/// Render `wslc create` argv from the container spec. Pure; `env_file` is the
/// already-written env file when the spec carries env vars.
pub fn wslc_create_args(
    name: &str,
    body: &ContainerCreateBody,
    env_file: Option<&Path>,
) -> Result<Vec<OsString>, Error> {
    reject_unprojectable(body)?;

    let image = body
        .image
        .as_deref()
        .filter(|i| !i.is_empty())
        .ok_or_else(|| unsupported(name, "the container spec has no image"))?;

    let mut args: Vec<OsString> = vec!["create".into(), "--name".into(), name.into()];

    // Labels sorted by key so the argv (and its tests) are deterministic.
    for (key, value) in BTreeMap::from_iter(body.labels.iter().flatten()) {
        if has_line_break(key) || has_line_break(value) || key.contains('=') {
            return Err(unsupported(
                name,
                &format!("label `{key}` is not argv-safe"),
            ));
        }
        args.push("--label".into());
        args.push(format!("{key}={value}").into());
    }

    // Port bindings sorted by container port. wslc relays localhost TCP only —
    // a udp mapping MUST fail here, not silently publish without a relay.
    let bindings = body
        .host_config
        .as_ref()
        .and_then(|hc| hc.port_bindings.as_ref());
    for (key, binding) in BTreeMap::from_iter(bindings.iter().flat_map(|b| b.iter())) {
        let (container_port, proto) = key
            .split_once('/')
            .ok_or_else(|| unsupported(name, &format!("malformed port key `{key}`")))?;
        if proto != "tcp" {
            return Err(unsupported(
                name,
                &format!("port {container_port}/{proto} — wslc relays localhost TCP only"),
            ));
        }
        let container_port: u16 = container_port
            .parse()
            .map_err(|_| unsupported(name, &format!("malformed port key `{key}`")))?;
        for bind in binding.iter().flatten() {
            if bind.host_ip.as_deref().is_some_and(|ip| !ip.is_empty()) {
                return Err(unsupported(
                    name,
                    &format!(
                        "port {container_port} pins a host IP — wslc decides the binding address"
                    ),
                ));
            }
            let host: u16 = bind
                .host_port
                .as_deref()
                .unwrap_or_default()
                .parse()
                .map_err(|_| {
                    unsupported(name, &format!("port {container_port} has no host port"))
                })?;
            args.push("-p".into());
            args.push(format!("{host}:{container_port}").into());
        }
    }

    for mount in body
        .host_config
        .as_ref()
        .and_then(|hc| hc.mounts.as_ref())
        .into_iter()
        .flatten()
    {
        args.extend(volume_args(name, mount)?);
    }

    if body
        .host_config
        .as_ref()
        .and_then(|hc| hc.device_requests.as_ref())
        .is_some_and(|reqs| !reqs.is_empty())
    {
        args.push("--gpus".into());
        args.push("all".into());
    }

    match (env_file, body.env.as_ref().is_some_and(|e| !e.is_empty())) {
        (Some(path), true) => {
            args.push("--env-file".into());
            args.push(path.into());
        }
        (None, true) => {
            return Err(unsupported(
                name,
                "internal: spec has env vars but no env file was supplied",
            ));
        }
        (_, false) => {}
    }

    args.push(image.into());
    Ok(args)
}

/// The env-file lines (`KEY=VALUE`, one per line) for the spec's env vars, in
/// spec order. wslc.exe parses the file line-based (leading whitespace trimmed,
/// `#` lines skipped), so anything that cannot round-trip through that format
/// is rejected loudly instead of silently corrupting a value.
pub fn env_file_lines(body: &ContainerCreateBody) -> Result<Vec<String>, Error> {
    let mut lines = Vec::new();
    for entry in body.env.iter().flatten() {
        let Some((key, _value)) = entry.split_once('=') else {
            // A bare KEY means "pass the host env var through" to wslc — never
            // what a recipe spec intends.
            return Err(Error::WslcCli(format!(
                "env entry `{entry}` has no `=` — cannot express it in an env file"
            )));
        };
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(Error::WslcCli(format!(
                "env var name `{key}` is not env-file-safe"
            )));
        }
        if has_line_break(entry) {
            return Err(Error::WslcCli(format!(
                "env var `{key}` contains a line break — env files are line-based"
            )));
        }
        lines.push(entry.clone());
    }
    Ok(lines)
}

/// `-v source:target[:ro]` for a named-volume mount; anything else is
/// unprojectable (a BIND mount means bindDir, which wslc's `-v` would reinterpret
/// as a Windows-path share — semantically different, so refuse).
fn volume_args(name: &str, mount: &Mount) -> Result<[OsString; 2], Error> {
    if mount.typ == Some(MountType::BIND) {
        return Err(unsupported(
            name,
            "bind mounts (placement: bind) are not supported on the wslc endpoint yet",
        ));
    }
    let mut rest = mount.clone();
    rest.typ = None;
    rest.source = None;
    rest.target = None;
    rest.read_only = None;
    if mount.typ != Some(MountType::VOLUME) || rest != Mount::default() {
        return Err(unsupported(
            name,
            "a mount uses options `wslc create -v` cannot express",
        ));
    }
    let (Some(source), Some(target)) = (mount.source.as_deref(), mount.target.as_deref()) else {
        return Err(unsupported(
            name,
            "a volume mount is missing its source or target",
        ));
    };
    let spec = match mount.read_only == Some(true) {
        true => format!("{source}:{target}:ro"),
        false => format!("{source}:{target}"),
    };
    Ok(["-v".into(), spec.into()])
}

/// Fail loudly when the spec carries anything the argv projection does not
/// handle. Implemented as a remainder check — clear every handled field and
/// require what's left to be `Default` — so a future `to_create_spec` addition
/// (e.g. `shm_size`) breaks HERE at launch time instead of silently launching a
/// reduced container.
fn reject_unprojectable(body: &ContainerCreateBody) -> Result<(), Error> {
    if body.tty == Some(true) {
        return Err(Error::WslcCli(
            "tty containers are not supported via the wslc delegation".to_string(),
        ));
    }
    let mut rest = body.clone();
    rest.image = None;
    rest.env = None;
    rest.exposed_ports = None;
    rest.labels = None;
    rest.tty = None;
    rest.host_config = None;
    if rest != ContainerCreateBody::default() {
        return Err(Error::WslcCli(
            "the container spec uses Docker features the wslc delegation cannot express — refusing to launch a reduced container".to_string(),
        ));
    }
    let mut hc_rest = body.host_config.clone().unwrap_or_default();
    hc_rest.port_bindings = None;
    hc_rest.mounts = None;
    hc_rest.device_requests = None;
    if hc_rest != HostConfig::default() {
        return Err(Error::WslcCli(
            "the container's host config uses Docker features the wslc delegation cannot express — refusing to launch a reduced container".to_string(),
        ));
    }
    // --gpus all is the ONLY device-request shape we project; anything more
    // specific must not be silently widened to "all GPUs".
    for request in body
        .host_config
        .as_ref()
        .and_then(|hc| hc.device_requests.as_ref())
        .into_iter()
        .flatten()
    {
        if *request != crate::recipe::run::gpu_all_nvidia() {
            return Err(Error::WslcCli(
                "a device request other than `--gpus all` cannot be expressed via wslc".to_string(),
            ));
        }
    }
    Ok(())
}

/// The Docker label wslc stores its port bookkeeping under (source-verified:
/// it is wslc's own recovery format, versioned `V1`).
pub(crate) const WSLC_METADATA_LABEL: &str = "com.microsoft.wsl.container.metadata";

#[derive(serde::Deserialize)]
struct WslcMetadata {
    #[serde(rename = "V1")]
    v1: Option<WslcMetadataV1>,
}

#[derive(serde::Deserialize)]
struct WslcMetadataV1 {
    #[serde(rename = "Ports", default)]
    ports: Vec<WslcPortMapping>,
}

#[derive(serde::Deserialize)]
struct WslcPortMapping {
    #[serde(rename = "HostPort")]
    host_port: u16,
    #[serde(rename = "VmPort")]
    vm_port: u16,
}

/// Rewrite each listed public port from wslc's VM-side number to the Windows-side
/// one. wslc publishes `-p H:C` at the moby level under an internally-allocated
/// VmPort and keeps the Windows-side `H` only in its relay bookkeeping plus the
/// metadata label — so on the wslc endpoint the raw `PublicPort` is a number the
/// user can never reach. Translating at the list layer fixes the Services
/// display, the launch-time conflict check, and the readiness probe target in
/// one place. Containers without a parseable label (foreign, or pre-delegation
/// leftovers) are left untouched.
pub(crate) fn translate_summary_ports(containers: &mut [bollard::models::ContainerSummary]) {
    for container in containers.iter_mut() {
        let Some(map) = container.labels.as_ref().and_then(vmport_to_hostport) else {
            continue;
        };
        for port in container.ports.iter_mut().flatten() {
            if let Some(host) = port.public_port.and_then(|public| map.get(&public)) {
                port.public_port = Some(*host);
            }
        }
    }
}

/// VmPort → HostPort from the metadata label; `None` when the label is absent
/// or unparseable (a third-party container may carry anything under that key).
fn vmport_to_hostport(
    labels: &std::collections::HashMap<String, String>,
) -> Option<std::collections::HashMap<u16, u16>> {
    let meta: WslcMetadata = serde_json::from_str(labels.get(WSLC_METADATA_LABEL)?).ok()?;
    let ports = meta.v1?.ports;
    match ports.is_empty() {
        true => None,
        false => Some(
            ports
                .into_iter()
                .map(|p| (p.vm_port, p.host_port))
                .collect(),
        ),
    }
}

fn unsupported(name: &str, what: &str) -> Error {
    Error::WslcCli(format!("cannot launch `{name}` via wslc: {what}"))
}

fn has_line_break(s: &str) -> bool {
    s.contains('\n') || s.contains('\r')
}

/// The container id `wslc create` prints (its last non-empty stdout line).
fn parse_container_id(stdout: &str) -> Result<String, Error> {
    let id = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let hexish = (12..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if !hexish {
        return Err(Error::WslcCli(format!(
            "`wslc create` did not print a container id (stdout: {stdout:?})"
        )));
    }
    Ok(id.to_string())
}

/// Run one `wslc` invocation to completion, returning stdout. Non-zero exit
/// surfaces stderr verbatim (wslc's messages are localized — pass them through
/// rather than parse them).
async fn run_wslc(program: &OsStr, args: &[OsString], action: &str) -> Result<String, Error> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // wslc.exe is a console app: without this every lifecycle op would flash a
    // console window (same constant the dial-stdio bridge uses).
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let program_name = program.to_string_lossy();
    let output = tokio::time::timeout(WSLC_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            Error::WslcCli(format!(
                "`{program_name} {action}` timed out after {}s",
                WSLC_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| Error::WslcCli(format!("failed to run `{program_name}` for {action}: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = match stderr.trim().is_empty() {
            true => stdout.trim().to_string(),
            false => stderr.trim().to_string(),
        };
        return Err(Error::WslcCli(format!(
            "`{program_name} {action}` failed ({}): {detail}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_with_env(env: Vec<&str>) -> ContainerCreateBody {
        ContainerCreateBody {
            image: Some("img:1".to_string()),
            env: Some(env.into_iter().map(String::from).collect()),
            ..Default::default()
        }
    }

    #[test]
    fn env_lines_round_trip_in_spec_order() {
        let lines = env_file_lines(&body_with_env(vec!["B=2", "A=va l=ue"])).unwrap();
        assert_eq!(lines, vec!["B=2", "A=va l=ue"]);
    }

    #[test]
    fn env_lines_reject_what_an_env_file_cannot_carry() {
        for bad in ["NOEQ", "BAD-KEY=x", "K=line\nbreak", "=novalue"] {
            assert!(
                env_file_lines(&body_with_env(vec![bad])).is_err(),
                "expected rejection: {bad:?}"
            );
        }
    }

    #[test]
    fn translates_vm_ports_back_to_windows_ports() {
        // The exact label wslc wrote for the real portprobe experiment
        // (`wslc run -p 8080:80` → moby bound VmPort 20002).
        let label = r#"{"V1":{"Flags":0,"InitProcessFlags":0,"Ports":[{"BindingAddress":"127.0.0.1","ContainerPort":80,"Family":2,"HostPort":8080,"Protocol":6,"VmPort":20002}],"Volumes":[]}}"#;
        let mut containers = vec![bollard::models::ContainerSummary {
            labels: Some(std::collections::HashMap::from([(
                WSLC_METADATA_LABEL.to_string(),
                label.to_string(),
            )])),
            ports: Some(vec![
                bollard::models::PortSummary {
                    private_port: 80,
                    public_port: Some(20002),
                    ..Default::default()
                },
                // A port outside the label's map stays untouched.
                bollard::models::PortSummary {
                    private_port: 81,
                    public_port: Some(9999),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        }];
        translate_summary_ports(&mut containers);
        let ports = containers[0].ports.as_ref().unwrap();
        assert_eq!(ports[0].public_port, Some(8080));
        assert_eq!(ports[1].public_port, Some(9999));
    }

    #[test]
    fn missing_or_garbage_label_leaves_ports_untouched() {
        // The quote-stripped shape PowerShell 5.1 actually produced in the
        // field experiment — must fail to parse, never half-translate.
        let mangled = "{V1:{Flags:0,Ports:[{HostPort:8085,VmPort:20044}]}}";
        for labels in [
            None,
            Some(std::collections::HashMap::from([(
                WSLC_METADATA_LABEL.to_string(),
                mangled.to_string(),
            )])),
        ] {
            let mut containers = vec![bollard::models::ContainerSummary {
                labels,
                ports: Some(vec![bollard::models::PortSummary {
                    private_port: 80,
                    public_port: Some(20044),
                    ..Default::default()
                }]),
                ..Default::default()
            }];
            translate_summary_ports(&mut containers);
            assert_eq!(
                containers[0].ports.as_ref().unwrap()[0].public_port,
                Some(20044)
            );
        }
    }

    #[test]
    fn container_id_is_the_last_nonempty_stdout_line() {
        let id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_container_id(&format!("some warning\n{id}\n")).unwrap(),
            id
        );
        assert!(parse_container_id("").is_err());
        assert!(parse_container_id("Error: no").is_err());
        assert!(parse_container_id("DEADBEEFDEADBEEF").is_err());
    }

    #[cfg(unix)]
    mod spawn {
        use super::super::*;
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        const ID: &str = "aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd";

        /// A stub `wslc`: records each invocation's argv (one arg per line, with
        /// a `--` separator between invocations), copies any `--env-file` to
        /// `<capture>.env` WHILE THE PROCESS RUNS (proving the temp file is
        /// still alive at spawn), and prints a container id.
        fn stub(dir: &Path, capture: &Path, exit: i32) -> std::path::PathBuf {
            let path = dir.join("wslc-stub");
            let mut f = std::fs::File::create(&path).unwrap();
            write!(
                f,
                "#!/bin/sh\nout=\"{cap}\"\nprev=\nfor a in \"$@\"; do\n  printf '%s\\n' \"$a\" >> \"$out\"\n  if [ \"$prev\" = \"--env-file\" ]; then cp \"$a\" \"$out.env\"; fi\n  prev=\"$a\"\ndone\nprintf -- '--\\n' >> \"$out\"\necho {id}\nexit {exit}\n",
                cap = capture.display(),
                id = ID,
                exit = exit
            )
            .unwrap();
            drop(f);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[tokio::test]
        async fn create_then_start_with_env_file_alive_at_spawn() {
            let dir = tempfile::tempdir().unwrap();
            let capture = dir.path().join("capture");
            let program = stub(dir.path(), &capture, 0);

            let body = ContainerCreateBody {
                image: Some("img:1".to_string()),
                env: Some(vec!["FOO=bar".to_string()]),
                ..Default::default()
            };
            let id = create_and_start_with(program.as_os_str(), "cname", &body)
                .await
                .unwrap();
            assert_eq!(id, ID);

            let argv = std::fs::read_to_string(&capture).unwrap();
            let calls: Vec<&str> = argv.split("--\n").collect();
            assert!(calls[0].starts_with("create\n--name\ncname\n"));
            assert!(calls[0].contains("--env-file\n"));
            assert!(calls[0].trim_end().ends_with("img:1"));
            assert_eq!(calls[1], format!("start\n{ID}\n"));
            // The stub copied the env file during `create` — content intact.
            assert_eq!(
                std::fs::read_to_string(capture.with_extension("env")).unwrap(),
                "FOO=bar\n"
            );
        }

        #[tokio::test]
        async fn nonzero_exit_surfaces_the_failure() {
            let dir = tempfile::tempdir().unwrap();
            let program = stub(dir.path(), &dir.path().join("capture"), 7);
            let err = create_and_start_with(
                program.as_os_str(),
                "cname",
                &ContainerCreateBody {
                    image: Some("img:1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("create"), "err: {err}");
        }

        #[tokio::test]
        async fn missing_program_fails_with_the_program_name() {
            let err = create_and_start_with(
                OsStr::new("/nonexistent/wslc-nowhere"),
                "cname",
                &ContainerCreateBody {
                    image: Some("img:1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("wslc-nowhere"), "err: {err}");
        }
    }
}
