//! Compositz core.
//!
//! The engine-access and recipe layer shared by the CLI and the Tauri desktop
//! backend: [`bollard`]-based Docker engine access (connect, list
//! Compositz-managed containers, create / start / stop / build / pull / remove
//! containers, images, and volumes, and stream logs and system events) plus the
//! recipe model, archive ingestion, the instance store, and the lifecycle
//! operations built on top.
//!
//! The connection target follows `COMPOSITZ_DOCKER_HOST` when set, else
//! bollard's platform-local default (Windows named pipe / unix socket).

pub mod brand;
pub mod build;
mod endpoint;
mod engine;
mod error;
mod model;
pub mod probe;
pub mod recipe;
pub mod storage;
pub mod view;

pub use endpoint::{Endpoint, parse_docker_host};
pub use engine::{BuildProgress, EngineVersion, VolumeSummary};
pub use error::Error;
pub use model::ContainerSummary;
pub use probe::{SnapshotPush, build_snapshot, enrich_with_probes, probe_host};
pub use recipe::config::{Override, same_override, validate_override};
pub use recipe::github::{
    GithubIngestOpts, GithubSpec, github_source, github_tarball_url, ingest_github,
    parse_github_spec,
};
pub use recipe::ingest::{
    BundleSource, IngestOpts, duplicate_instance, extract_archive_to, ingest_bundle,
    random_instance_id,
};
pub use recipe::instance::{
    Instance, InstanceMeta, is_valid_instance_id, list_instances, load_instance,
    load_instance_config, load_launched_config, remove_instance_dir, save_instance_config,
    set_instance_name,
};
pub use recipe::manifest::{
    MANIFEST_VERSION, Manifest, Placement, manifest_json_schema, parse_manifest,
};
pub use recipe::operations::{
    BindDirFailure, PortBump, RemoveDataOpts, RemoveDataResult, UpResult, VolumeFailure,
    deconflict_host_ports, defined_host_ports, down, export_mount, install_instance,
    remove_instance_data, remove_instance_image, remove_superseded_image, up,
};
pub use recipe::run::{
    LaunchConfig, WebEndpoint, effective_host_port, instance_container_name, instance_image_tag,
    merge_launch, persisted_mounts, resolve_host_ports, to_create_spec, web_endpoints, web_url,
};
pub use recipe::update::{UpdatePreview, commit_update, discard_update, prepare_update};
pub use view::{
    ContainerStatus, EngineSnapshot, EnvSetting, InstanceRow, InstanceSettings, InstanceView,
    MountSetting, PortSetting, PublishedPort, Service, WebPort, build_settings,
    to_container_statuses, to_instance_rows, to_instance_view,
};

use bollard::Docker;
use bollard::query_parameters::{
    EventsOptionsBuilder, ListContainersOptionsBuilder, LogsOptionsBuilder,
};
use futures_util::{Stream, StreamExt};
use std::collections::HashMap;

/// Environment variable that overrides the engine endpoint. `COMPOSITZ_DOCKER_HOST`
/// is deliberately namespaced so it never fights over the ambient `DOCKER_HOST`
/// slot. Whether to also honor plain `DOCKER_HOST` as a fallback remains an open
/// decision. When unset, bollard's local default is used.
pub(crate) const DOCKER_HOST_ENV: &str = "COMPOSITZ_DOCKER_HOST";

/// A live handle to the Docker engine. Cheap to clone (bollard's `Docker` is an
/// `Arc` internally), so a single handle can back many concurrent streams.
#[derive(Clone)]
pub struct EngineHandle {
    docker: Docker,
}

impl EngineHandle {
    /// Borrow the underlying bollard client (e.g. for `ping`/`version` in tests).
    pub fn docker(&self) -> &Docker {
        &self.docker
    }
}

/// Connect to the Docker engine.
///
/// Uses `COMPOSITZ_DOCKER_HOST` when set (tcp/unix/npipe), otherwise bollard's
/// platform-local defaults. NOTE: connecting is NOT uniformly lazy — a `tcp`
/// endpoint defers the socket until the first request, but bollard's `unix`
/// helper eagerly checks the socket path exists and fails here if it doesn't. So
/// callers that want to report a reachability failure gracefully (e.g. `doctor`)
/// must treat a `connect()` error the same as a first-request error, and derive
/// the endpoint label from [`resolved_endpoint_description`] rather than a handle.
pub fn connect() -> Result<EngineHandle, Error> {
    let docker = match std::env::var(DOCKER_HOST_ENV) {
        Ok(raw) if !raw.is_empty() => connect_endpoint(parse_docker_host(&raw)?)?,
        _ => Docker::connect_with_local_defaults()?,
    };
    Ok(EngineHandle { docker })
}

/// The resolved engine endpoint as a `DOCKER_HOST`-style string, WITHOUT connecting
/// — so `doctor` can print it even when the engine is unreachable (the case where
/// `connect` itself fails on a missing unix socket). Reads the same env
/// [`connect`] does: `COMPOSITZ_DOCKER_HOST` when set, else the platform local
/// default. An unparseable value is echoed verbatim (connect surfaces the real
/// error).
pub fn resolved_endpoint_description() -> String {
    match std::env::var(DOCKER_HOST_ENV) {
        Ok(raw) if !raw.is_empty() => match parse_docker_host(&raw) {
            Ok(endpoint) => describe_endpoint(&endpoint),
            Err(_) => raw,
        },
        _ => local_default_endpoint(),
    }
}

/// Render an [`Endpoint`] as a `DOCKER_HOST`-style string, for the `doctor`
/// diagnostic.
fn describe_endpoint(endpoint: &Endpoint) -> String {
    match endpoint {
        Endpoint::Unix { path } => format!("unix://{path}"),
        Endpoint::Npipe { path } => format!("npipe://{path}"),
        Endpoint::Tcp { host, port } => format!("tcp://{host}:{port}"),
    }
}

/// Describe bollard's platform local default (used when `COMPOSITZ_DOCKER_HOST` is
/// unset). The exact target bollard picks isn't exposed, so this reports the
/// platform's conventional socket/pipe with a `(local default)` marker.
fn local_default_endpoint() -> String {
    if cfg!(windows) {
        "npipe:////./pipe/docker_engine (local default)".to_string()
    } else {
        "unix:///var/run/docker.sock (local default)".to_string()
    }
}

fn connect_endpoint(endpoint: Endpoint) -> Result<Docker, Error> {
    // API_DEFAULT_VERSION is bollard's negotiated-baseline version; the engine
    // upgrades it on the first ping. DEFAULT_TIMEOUT matches bollard's own
    // helper defaults.
    use bollard::API_DEFAULT_VERSION;
    const DEFAULT_TIMEOUT: u64 = 120;
    let docker = match endpoint {
        Endpoint::Tcp { host, port } => {
            let addr = format!("tcp://{host}:{port}");
            Docker::connect_with_http(&addr, DEFAULT_TIMEOUT, API_DEFAULT_VERSION)?
        }
        // The transport-specific bollard helpers are platform-gated:
        // `connect_with_unix` is `#[cfg(unix)]`, `connect_with_named_pipe` is
        // `#[cfg(windows)]`. A cross-platform endpoint (npipe on Unix, unix
        // socket on Windows) is a user misconfiguration → fail loudly.
        #[cfg(unix)]
        Endpoint::Unix { path } => {
            Docker::connect_with_unix(&path, DEFAULT_TIMEOUT, API_DEFAULT_VERSION)?
        }
        #[cfg(windows)]
        Endpoint::Npipe { path } => {
            Docker::connect_with_named_pipe(&path, DEFAULT_TIMEOUT, API_DEFAULT_VERSION)?
        }
        #[cfg(not(unix))]
        Endpoint::Unix { path } => {
            return Err(Error::UnsupportedDockerHost(format!(
                "unix socket endpoint {path:?} is not supported on this platform"
            )));
        }
        #[cfg(not(windows))]
        Endpoint::Npipe { path } => {
            return Err(Error::UnsupportedDockerHost(format!(
                "named-pipe endpoint {path:?} is not supported on this platform"
            )));
        }
    };
    Ok(docker)
}

/// List Compositz-managed containers (running and stopped), filtered by the
/// presence of the `io.compositz.instance` label, mapped to [`ContainerSummary`].
///
/// NOTE: this lists CONTAINERS (the `ps`/`ls` engine view), not store instances —
/// [`list_instances`] (re-exported from `recipe::instance`) reads the on-disk
/// instance definitions. The two are deliberately distinct: the engine container
/// view versus the on-disk instance list.
pub async fn list_managed_containers(
    handle: &EngineHandle,
) -> Result<Vec<ContainerSummary>, Error> {
    let mut filters: HashMap<String, Vec<String>> = HashMap::new();
    // `label=<key>` matches on presence of the key regardless of value.
    // `brand::label` is the single source of truth for the managed-object marker.
    filters.insert("label".to_string(), vec![brand::label("instance")]);

    let options = ListContainersOptionsBuilder::new()
        .all(true)
        .filters(&filters)
        .build();

    let raw = handle.docker.list_containers(Some(options)).await?;
    Ok(raw
        .into_iter()
        .map(ContainerSummary::from_bollard)
        .collect())
}

/// Stream a container's logs as plain lines (follow, last 200 lines, stdout +
/// stderr demuxed). Each yielded item is one line with no trailing newline.
pub fn log_stream(
    handle: &EngineHandle,
    container_id: &str,
) -> impl Stream<Item = Result<String, Error>> + Send + Unpin + 'static {
    let options = LogsOptionsBuilder::new()
        .follow(true)
        .stdout(true)
        .stderr(true)
        .tail("200")
        .build();

    let raw = handle.docker.logs(container_id, Some(options));
    // `LogOutput`'s Display strips the stream-frame header and yields the raw
    // payload bytes; splitting on '\n' turns a demuxed chunk into lines.
    line_split(raw.map(|item| item.map(|out| out.to_string()).map_err(Error::from)))
}

/// Stream the daemon's system events as compact one-line summaries, e.g.
/// `container start comfyui-a1b2c3 (image=...)`.
pub fn event_stream(
    handle: &EngineHandle,
) -> impl Stream<Item = Result<String, Error>> + Send + Unpin + 'static {
    let options = EventsOptionsBuilder::new().build();
    // `Box::pin` makes the returned stream `Unpin`, so the desktop pump can call
    // `.next().await` on it by value (`StreamExt::next` requires `Self: Unpin`).
    Box::pin(
        handle
            .docker
            .events(Some(options))
            .map(|item| item.map(model::summarize_event).map_err(Error::from)),
    )
}

/// Re-chunk a stream of arbitrary text fragments into complete lines.
///
/// A single log chunk from the engine may carry several lines or a partial one;
/// this buffers across chunks and emits one item per newline-terminated line
/// (trailing newline stripped), flushing any final unterminated remainder at EOF.
fn line_split<S>(source: S) -> impl Stream<Item = Result<String, Error>> + Send + Unpin + 'static
where
    S: Stream<Item = Result<String, Error>> + Send + 'static,
{
    // `stream::unfold` produces a `!Unpin` stream (its in-progress future is held
    // inline). `Box::pin` makes it `Unpin` so callers — notably the desktop pump —
    // can `.next().await` it by value; the `+ Unpin` bound above makes that
    // guarantee part of every consumer's contract, not an accident of this body.
    Box::pin(futures_util::stream::unfold(
        (Box::pin(source), String::new(), Vec::<String>::new(), false),
        move |(mut src, mut buf, mut pending, mut done)| async move {
            loop {
                // Drain any already-split lines first.
                if !pending.is_empty() {
                    let line = pending.remove(0);
                    return Some((Ok(line), (src, buf, pending, done)));
                }
                if done {
                    if buf.is_empty() {
                        return None;
                    }
                    // Emit the final unterminated remainder once.
                    let last = std::mem::take(&mut buf);
                    return Some((Ok(last), (src, buf, pending, true)));
                }
                match src.next().await {
                    Some(Ok(chunk)) => {
                        buf.push_str(&chunk);
                        while let Some(idx) = buf.find('\n') {
                            let mut line: String = buf.drain(..=idx).collect();
                            // Strip the trailing '\n' (and a paired '\r').
                            line.pop();
                            if line.ends_with('\r') {
                                line.pop();
                            }
                            pending.push(line);
                        }
                    }
                    Some(Err(e)) => {
                        return Some((Err(e), (src, buf, pending, done)));
                    }
                    None => {
                        done = true;
                    }
                }
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    /// Collect a `line_split` stream to completion, driving it exactly the way a
    /// consumer does: `.next().await` on the value (which requires `Unpin`).
    async fn split_all(chunks: Vec<Result<String, Error>>) -> Vec<String> {
        let mut stream = line_split(stream::iter(chunks));
        let mut lines = Vec::new();
        while let Some(item) = stream.next().await {
            lines.push(item.expect("no error injected in these fixtures"));
        }
        lines
    }

    #[tokio::test]
    async fn partial_line_reassembles_across_chunk_boundary() {
        // "hel" + "lo\nworld\n" must yield the two logical lines, proving the
        // buffer carries the partial "hel" fragment into the next chunk.
        let lines = split_all(vec![Ok("hel".to_string()), Ok("lo\nworld\n".to_string())]).await;
        assert_eq!(lines, vec!["hello".to_string(), "world".to_string()]);
    }

    #[tokio::test]
    async fn crlf_is_stripped_to_bare_line() {
        let lines = split_all(vec![Ok("alpha\r\nbeta\r\n".to_string())]).await;
        assert_eq!(lines, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[tokio::test]
    async fn unterminated_final_line_is_flushed_at_eof() {
        // The last fragment has no trailing '\n'; it must still surface once.
        let lines = split_all(vec![Ok("done\n".to_string()), Ok("tail".to_string())]).await;
        assert_eq!(lines, vec!["done".to_string(), "tail".to_string()]);
    }

    #[tokio::test]
    async fn bare_lone_cr_without_lf_is_preserved() {
        // A '\r' not paired with a following '\n' is ordinary content, not a
        // line terminator — it must NOT be stripped or split on.
        let lines = split_all(vec![Ok("a\rb\n".to_string())]).await;
        assert_eq!(lines, vec!["a\rb".to_string()]);
    }

    /// Compile-level proof that `log_stream`'s return type is `Unpin`: this drives
    /// it with the *exact* by-value `.next().await` pattern the desktop pump uses
    /// (crates/desktop/src/lib.rs). If the stream were `!Unpin` this would not
    /// compile — which is the regression this test guards.
    ///
    /// With `COMPOSITZ_DOCKER_HOST` unset the handle uses bollard's local defaults
    /// and no socket opens until first poll; polling a nonexistent container then
    /// yields an `Err` item (or `None`) without our test targeting a real engine.
    /// The integration run sets `COMPOSITZ_DOCKER_HOST`, so we only assert the
    /// poll behavior when the endpoint is the local default; either way the body
    /// compiles, which is the point.
    #[tokio::test]
    async fn log_stream_is_unpin_and_pollable_like_the_desktop_pump() {
        let host_overridden = std::env::var(DOCKER_HOST_ENV).is_ok_and(|v| !v.is_empty());
        let Ok(handle) = connect() else {
            // No local engine reachable to even construct a client — the compile
            // proof (that this by-value `.next().await` typechecks) already holds.
            return;
        };
        let mut stream = log_stream(&handle, "nonexistent");
        let first = stream.next().await;
        if !host_overridden {
            // Local default with no engine: an Err item or a closed stream, never
            // a successful log line from a container that does not exist.
            assert!(
                matches!(first, Some(Err(_)) | None),
                "expected an error or end-of-stream, got a log line: {first:?}"
            );
        }
    }
}
