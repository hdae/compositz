//! Derive a Docker container spec (the "effective spec") from a validated manifest
//! plus the instance id and an optional per-install launch override:
//! `manifest ⊕ instanceId ⊕ launch → ContainerCreateBody`. Every runtime resource
//! (image / container / volume / bind / venv / labels) keys off the instance id —
//! one flat namespace, no recipe×instance nesting (ADR-017).
//!
//! The spec type is bollard's own [`ContainerCreateBody`] (the Docker-API shape),
//! so the lifecycle ops hand it straight to `create_container` with no translation
//! layer — and [`persisted_mounts`] is the SINGLE mount-name →
//! source derivation shared by create and the data operations (export / deletion),
//! so they can never silently diverge on which volume or bind a mount name means.

use std::collections::{BTreeMap, HashMap, HashSet};

use bollard::models::{
    ContainerCreateBody, DeviceRequest, HostConfig, Mount, MountBindOptions, MountType, PortBinding,
};

use crate::Error;
use crate::brand::{
    self, cache_volume_name, container_name, env_var, image_tag, label, volume_name,
};
use crate::recipe::manifest::{CacheSpec, Manifest, Placement, PortMapping};
use crate::storage::bind_host_path;

/// The user's per-install customizations, layered over the manifest's author
/// defaults. Carries only VALUES — the manifest is never mutated. (`config.yaml`'s
/// persisted [`crate::recipe::config::Override`] is a strict subset of this; `up`
/// adds `data_root` and resolves env values before building the spec.)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchConfig {
    /// Host data-root for bind mounts (required only when a bind mount is effective).
    pub data_root: Option<String>,
    /// Host-port remap, keyed by port `name`.
    pub host_ports: BTreeMap<String, u32>,
    /// Resolved env values, keyed by env `name` (overrides the manifest default).
    pub env: BTreeMap<String, String>,
    /// Placement override, keyed by mount `name`.
    pub placement: BTreeMap<String, Placement>,
}

/// Layer one launch override over another, per sub-key — `over` wins. Used to
/// overlay an in-memory override (e.g. a CLI flag) on top of the persisted
/// `config.yaml`. `data_root` is only set when one side actually supplies it, so an
/// absent value never clobbers the default `up` fills in.
pub fn merge_launch(base: &LaunchConfig, over: &LaunchConfig) -> LaunchConfig {
    let mut host_ports = base.host_ports.clone();
    host_ports.extend(over.host_ports.clone());
    let mut env = base.env.clone();
    env.extend(over.env.clone());
    let mut placement = base.placement.clone();
    placement.extend(over.placement.clone());
    LaunchConfig {
        data_root: over.data_root.clone().or_else(|| base.data_root.clone()),
        host_ports,
        env,
        placement,
    }
}

/// The image an instance runs: a prebuilt `image` (shared, external), or the
/// per-instance tag we build it to (`compositz/<instanceId>:<version>`).
pub fn instance_image_tag(m: &Manifest, instance_id: &str) -> String {
    m.image
        .clone()
        .unwrap_or_else(|| image_tag(instance_id, &m.version))
}

pub fn instance_container_name(instance_id: &str) -> String {
    container_name(instance_id)
}

/// The effective host port a named port is DEFINED to publish on: override remap ▷
/// manifest `host` ▷ container port. This is the definition (manifest ⊕ override),
/// NOT the live published port — the engine may auto-bump it on a launch conflict.
pub fn effective_host_port(p: &PortMapping, host_ports: &BTreeMap<String, u32>) -> u32 {
    host_ports
        .get(&p.name)
        .copied()
        .or(p.host)
        .unwrap_or(p.container)
}

/// A browser-UI endpoint (one per `web: true` port).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebEndpoint {
    pub name: String,
    pub url: String,
}

/// Every browser-UI endpoint (one per `web: true` port), in declaration order.
pub fn web_endpoints(m: &Manifest, launch: &LaunchConfig) -> Vec<WebEndpoint> {
    m.ports
        .iter()
        .filter(|p| p.web)
        .map(|p| WebEndpoint {
            name: p.name.clone(),
            url: format!(
                "http://localhost:{}{}",
                effective_host_port(p, &launch.host_ports),
                p.path
            ),
        })
        .collect()
}

/// The primary (first) web UI URL, if the recipe publishes one.
pub fn web_url(m: &Manifest, launch: &LaunchConfig) -> Option<String> {
    web_endpoints(m, launch).into_iter().next().map(|e| e.url)
}

/// Shift any host ports that collide with `taken` up to the next free port, keeping
/// the rest as-is. Pure — the caller supplies the taken set (e.g. ports already
/// published by other containers). Returns a name→port map for `LaunchConfig.host_ports`.
pub fn resolve_host_ports(
    ports: &[(&str, u32)],
    taken: &HashSet<u32>,
) -> Result<BTreeMap<String, u32>, Error> {
    let mut used = taken.clone();
    let mut out = BTreeMap::new();
    for (name, want) in ports {
        let mut host = *want;
        while used.contains(&host) {
            host += 1;
            if host > 65535 {
                return Err(Error::Recipe(format!(
                    "no free host port for \"{name}\" at or above {want}"
                )));
            }
        }
        out.insert((*name).to_string(), host);
        used.insert(host);
    }
    Ok(out)
}

/// Derive the Docker mounts for the manifest's persisted `mounts:` — effective
/// placement (override ▷ manifest) plus the derived source (named volume / data-root
/// bind path). THE single mount-name → source derivation, shared by
/// [`to_create_spec`] and the data operations (export / data deletion) so they can
/// never silently diverge on which volume or bind dir a mount name refers to.
pub fn persisted_mounts(
    m: &Manifest,
    instance_id: &str,
    data_root: Option<&str>,
    placement: &BTreeMap<String, Placement>,
) -> Result<Vec<Mount>, Error> {
    let mut mounts = Vec::new();
    for mt in &m.mounts {
        let effective = placement.get(&mt.name).copied().unwrap_or(mt.placement);
        match effective {
            Placement::Bind => {
                let Some(data_root) = data_root else {
                    return Err(Error::Recipe(format!(
                        "mount \"{}\" of recipe \"{}\" is a bind mount but no dataRoot was supplied",
                        mt.name, m.id
                    )));
                };
                // CreateMountpoint: the daemon must create the host source if absent
                // — a `Mounts` bind does not auto-create it (unlike legacy `Binds`),
                // and from a remote DOCKER_HOST the core cannot touch the host FS.
                mounts.push(Mount {
                    typ: Some(MountType::BIND),
                    source: Some(bind_host_path(data_root, instance_id, &mt.name)),
                    target: Some(mt.target.clone()),
                    bind_options: Some(MountBindOptions {
                        create_mountpoint: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                });
            }
            Placement::Volume => {
                mounts.push(Mount {
                    typ: Some(MountType::VOLUME),
                    source: Some(volume_name(instance_id, &mt.name)),
                    target: Some(mt.target.clone()),
                    ..Default::default()
                });
            }
        }
    }
    Ok(mounts)
}

/// Build the full container-create spec: `manifest ⊕ instanceId ⊕ launch`. GPU is
/// attached when `with_gpu` is set, else when the manifest asks for one
/// (`gpu != none`).
pub fn to_create_spec(
    m: &Manifest,
    instance_id: &str,
    launch: &LaunchConfig,
    with_gpu: Option<bool>,
) -> Result<ContainerCreateBody, Error> {
    // --- ports: keyed by container/proto; APPEND host bindings so two ports on the
    // same container port publish to BOTH host ports (not one silently winning).
    // `exposed_ports` is a de-duplicated set of keys (a container port declared
    // twice is exposed once). ---
    let mut exposed: Vec<String> = Vec::new();
    let mut bindings: HashMap<String, Vec<PortBinding>> = HashMap::new();
    for p in &m.ports {
        let key = format!("{}/{}", p.container, p.protocol.as_str());
        if !exposed.contains(&key) {
            exposed.push(key.clone());
        }
        bindings.entry(key).or_default().push(PortBinding {
            host_port: Some(effective_host_port(p, &launch.host_ports).to_string()),
            ..Default::default()
        });
    }

    // --- mounts (persisted) + caches ----------------------------------------
    let mut mounts = persisted_mounts(
        m,
        instance_id,
        launch.data_root.as_deref(),
        &launch.placement,
    )?;

    // --- env: insertion-ordered with in-place update, so a managed cache/instance
    // var deterministically overrides a colliding user var (a list with duplicate
    // keys has undefined precedence). --
    let mut env = OrderedEnv::new();
    for ev in &m.env {
        let value = launch
            .env
            .get(&ev.name)
            .cloned()
            .or_else(|| ev.default.clone())
            .unwrap_or_default();
        env.set(ev.name.clone(), value);
    }
    for c in &m.cache {
        let provision = cache_provision(c, instance_id);
        // Shared cache volumes (venv/hf) mount once even if referenced repeatedly.
        if !mounts
            .iter()
            .any(|x| x.source == provision.mount.source && x.target == provision.mount.target)
        {
            mounts.push(provision.mount);
        }
        for (k, v) in provision.vars {
            env.set(k, v);
        }
    }
    env.set(env_var("INSTANCE"), instance_id.to_string());

    // Two mounts (or a mount and a managed cache) on one in-container target is a
    // daemon-invalid spec — fail loud rather than let one silently shadow the other.
    let mut targets: HashSet<&str> = HashSet::new();
    for mt in &mounts {
        let target = mt.target.as_deref().unwrap_or_default();
        if !targets.insert(target) {
            return Err(Error::Recipe(format!(
                "recipe \"{}\": duplicate mount target \"{target}\" (a mount collides with another mount or a managed cache)",
                m.id
            )));
        }
    }

    // --- host config --------------------------------------------------------
    let host_config = HostConfig {
        port_bindings: (!bindings.is_empty())
            .then(|| bindings.into_iter().map(|(k, v)| (k, Some(v))).collect()),
        mounts: (!mounts.is_empty()).then_some(mounts),
        device_requests: with_gpu
            .unwrap_or(m.gpu != crate::recipe::manifest::GpuMode::None)
            .then(|| vec![gpu_all_nvidia()]),
        ..Default::default()
    };

    let env = env.into_env();
    Ok(ContainerCreateBody {
        image: Some(instance_image_tag(m, instance_id)),
        env: (!env.is_empty()).then_some(env),
        exposed_ports: (!exposed.is_empty()).then_some(exposed),
        tty: Some(false),
        labels: Some(HashMap::from([
            // `recipe` carries the app id (provenance / "which app is this");
            // `instance` is the unique runtime key.
            (label("recipe"), m.id.clone()),
            (label("managed"), "true".to_string()),
            (label("version"), m.version.clone()),
            (label("instance"), instance_id.to_string()),
        ])),
        host_config: Some(host_config),
        ..Default::default()
    })
}

/// A managed cache: one mount plus the env var(s) carrying its in-container path.
struct CacheMount {
    mount: Mount,
    vars: Vec<(String, String)>,
}

fn cache_provision(c: &CacheSpec, instance_id: &str) -> CacheMount {
    let root = brand::MANAGED_MOUNT_ROOT;
    match c {
        // venv + uv cache + managed interpreters co-located on ONE volume so uv's
        // hardlink dedup works and the venv's `pyvenv.cfg home` never points across
        // volumes. Shared across instances; per-instance venv subpath.
        CacheSpec::Venv => {
            let target = format!("{root}/uv");
            let venv = format!("{target}/venvs/{instance_id}");
            CacheMount {
                mount: volume_mount(cache_volume_name("uv"), &target),
                vars: vec![
                    ("UV_CACHE_DIR".to_string(), format!("{target}/cache")),
                    // Both names, same path: activation-style entrypoints read
                    // VIRTUAL_ENV, but uv PROJECT ops (`uv sync`, `uv run`) ignore it
                    // and only honor UV_PROJECT_ENVIRONMENT — omitting it silently
                    // loses persistence for every `uv sync`-style app (ADR-024).
                    ("VIRTUAL_ENV".to_string(), venv.clone()),
                    ("UV_PROJECT_ENVIRONMENT".to_string(), venv),
                    (
                        "UV_PYTHON_INSTALL_DIR".to_string(),
                        format!("{target}/python"),
                    ),
                ],
            }
        }
        CacheSpec::Huggingface => {
            let target = format!("{root}/hf");
            CacheMount {
                mount: volume_mount(cache_volume_name("hf"), &target),
                vars: vec![("HF_HOME".to_string(), target)],
            }
        }
        CacheSpec::Custom { name, env, scope } => {
            let target = format!("{root}/cache/{name}");
            let path = match scope {
                crate::recipe::manifest::CacheScope::Instance => format!("{target}/{instance_id}"),
                crate::recipe::manifest::CacheScope::Shared => target.clone(),
            };
            CacheMount {
                mount: volume_mount(cache_volume_name(&format!("cache_{name}")), &target),
                vars: vec![(env.clone(), path)],
            }
        }
    }
}

fn volume_mount(source: String, target: &str) -> Mount {
    Mount {
        typ: Some(MountType::VOLUME),
        source: Some(source),
        target: Some(target.to_string()),
        ..Default::default()
    }
}

/// `--gpus all` for NVIDIA: `Count: -1` = all GPUs, `Capabilities: [["gpu"]]`.
fn gpu_all_nvidia() -> DeviceRequest {
    DeviceRequest {
        driver: Some(String::new()),
        count: Some(-1),
        capabilities: Some(vec![vec!["gpu".to_string()]]),
        ..Default::default()
    }
}

/// A tiny insertion-ordered string map with JS-`Map`-`set` semantics: setting an
/// existing key updates its value IN PLACE (keeping its position); a new key
/// appends. This makes the emitted `Env` deterministic while letting a managed
/// cache/instance var override a colliding user var at the user var's position.
struct OrderedEnv(Vec<(String, String)>);

impl OrderedEnv {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn set(&mut self, key: String, value: String) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.0.push((key, value));
        }
    }

    fn into_env(self) -> Vec<String> {
        self.0
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect()
    }
}
