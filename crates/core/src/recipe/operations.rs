//! High-level instance operations shared by the CLI and desktop UI: install the
//! image (build per-instance, or pull for an `image`-based recipe), bring the
//! container up (GPU tri-state + host-port auto-increment), tear it down, and
//! remove data / images. Everything keys off the instance id (ADR-017).
//!
//! The engine-touching functions take the concrete [`EngineHandle`] (verified by
//! the gated E2E round-trip); [`deconflict_host_ports`] and [`defined_host_ports`]
//! are engine-free and unit-tested.

use std::collections::{HashMap, HashSet};
use std::pin::Pin;

use bollard::models::{ContainerCreateBody, HostConfig, Mount, MountType};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};

use crate::brand::{container_name, image_tag, label, volume_name};
use crate::build::tar_context;
use crate::recipe::config::Override;
use crate::recipe::instance::{
    Instance, list_instances, load_instance_config, save_instance_config, save_launched_config,
};
use crate::recipe::manifest::{GpuMode, Manifest};
use crate::recipe::run::{
    LaunchConfig, effective_host_port, instance_container_name, instance_image_tag, merge_launch,
    persisted_mounts, resolve_host_ports, to_create_spec,
};
use crate::storage::{HostPlatform, default_data_root};
use crate::{BuildProgress, EngineHandle, Error};

// --- install ---------------------------------------------------------------

/// Make the instance's image available, streaming progress. A `build`-based recipe
/// builds its context to the per-instance tag `compositz/<instanceId>`; an
/// `image`-based recipe pulls the referenced (shared) image (coarse progress —
/// a start/done line — for now).
pub fn install_instance(
    engine: &EngineHandle,
    instance: &Instance,
) -> Pin<Box<dyn Stream<Item = Result<BuildProgress, Error>> + Send>> {
    let m = &instance.manifest;
    if let Some(image) = m.image.clone() {
        return Box::pin(pull_progress(engine.clone(), image));
    }
    // A recipe without `image` has `build` (the manifest XOR is validated at parse).
    let build = m
        .build
        .as_ref()
        .expect("a recipe without `image` has `build`");
    let tag = instance_image_tag(m, &instance.instance_id);
    let dockerfile = build.dockerfile.clone();
    let build_args: HashMap<String, String> =
        build.args.clone().unwrap_or_default().into_iter().collect();
    match tar_context(&instance.context) {
        Ok(tar) => Box::pin(engine.build_image(tar, tag, dockerfile, build_args)),
        Err(e) => Box::pin(futures_util::stream::once(async move { Err(e) })),
    }
}

fn progress_line(text: String) -> BuildProgress {
    BuildProgress {
        stream: Some(text),
        aux_id: None,
        error: None,
    }
}

/// `pulling …` → pull → `pulled …` as a stream, so the caller sees the first line
/// BEFORE the (blocking) pull, then the result. A pull error surfaces as one `Err`.
fn pull_progress(
    engine: EngineHandle,
    image: String,
) -> impl Stream<Item = Result<BuildProgress, Error>> + Send {
    #[derive(Clone, Copy)]
    enum Phase {
        Announce,
        Pull,
        Done,
    }
    futures_util::stream::unfold(
        (engine, image, Phase::Announce),
        |(engine, image, phase)| async move {
            match phase {
                Phase::Announce => Some((
                    Ok(progress_line(format!("pulling {image}…\n"))),
                    (engine, image, Phase::Pull),
                )),
                Phase::Pull => match engine.pull_image(&image).await {
                    Ok(()) => Some((
                        Ok(progress_line(format!("pulled {image}\n"))),
                        (engine, image, Phase::Done),
                    )),
                    Err(e) => Some((Err(e), (engine, image, Phase::Done))),
                },
                Phase::Done => None,
            }
        },
    )
}

// --- up --------------------------------------------------------------------

/// The result of bringing an instance up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpResult {
    pub id: String,
    pub used_gpu: bool,
    /// Host ports actually published, keyed by port name (after conflict bumping).
    pub host_ports: std::collections::BTreeMap<String, u32>,
}

/// Create + start the instance's container, replacing any prior container for this
/// instance. Host ports that collide with already-published ports are auto-bumped.
/// GPU tri-state: `required` insists on GPU, `none` never attaches it, `preferred`
/// tries with GPU and transparently falls back to CPU on failure.
pub async fn up(
    engine: &EngineHandle,
    instance: &Instance,
    launch: &LaunchConfig,
) -> Result<UpResult, Error> {
    let m = &instance.manifest;
    let name = instance_container_name(&instance.instance_id);

    // Remove the prior container first so its own host ports free up before we pick
    // ports for the new one.
    let _ = engine.remove_container(&name, true).await;

    // The persisted per-instance override (config.yaml) is the base; the in-memory
    // `launch` arg overlays it, so every caller honors the saved override.
    let override_cfg = load_instance_config(&instance.dir)?;
    let merged = merge_launch(&launch_from_override(&override_cfg), launch);

    // Resolve host ports ONCE (the GPU retry reuses them) and return them so callers
    // build the web URL from the port actually published, not the manifest default.
    let host_ports = resolve_ports(engine, m, &merged).await?;
    let data_root = match merged.data_root.clone() {
        Some(root) => root,
        None => default_data_root(&HostPlatform)?,
    };
    let effective = LaunchConfig {
        data_root: Some(data_root),
        host_ports: host_ports.clone(),
        env: merged.env.clone(),
        placement: merged.placement.clone(),
    };

    let (id, used_gpu) = match m.gpu {
        GpuMode::None => (
            start_with(engine, m, instance, &name, &effective, false).await?,
            false,
        ),
        GpuMode::Required => (
            start_with(engine, m, instance, &name, &effective, true).await?,
            true,
        ),
        GpuMode::Preferred => {
            match start_with(engine, m, instance, &name, &effective, true).await {
                Ok(id) => (id, true),
                Err(_) => {
                    // Failed with GPU — clean up the half-created container and retry on CPU.
                    let _ = engine.remove_container(&name, true).await;
                    (
                        start_with(engine, m, instance, &name, &effective, false).await?,
                        false,
                    )
                }
            }
        }
    };

    // Record what we launched WITH (the user-level override) so the UI can tell when
    // the saved config has since diverged and a restart is needed. Best-effort.
    let _ = save_launched_config(&instance.dir, &override_cfg);

    Ok(UpResult {
        id,
        used_gpu,
        host_ports,
    })
}

async fn start_with(
    engine: &EngineHandle,
    m: &Manifest,
    instance: &Instance,
    name: &str,
    effective: &LaunchConfig,
    with_gpu: bool,
) -> Result<String, Error> {
    let spec = to_create_spec(m, &instance.instance_id, effective, Some(with_gpu))?;
    let id = engine.create_container(spec, name).await?;
    engine.start_container(&id).await?;
    Ok(id)
}

/// Resolve each port's host port, auto-bumping any that collide with ports already
/// published by other RUNNING containers. Best-effort (it can't see non-Docker
/// listeners, and there is a small TOCTOU window before create).
async fn resolve_ports(
    engine: &EngineHandle,
    m: &Manifest,
    launch: &LaunchConfig,
) -> Result<std::collections::BTreeMap<String, u32>, Error> {
    if m.ports.is_empty() {
        return Ok(std::collections::BTreeMap::new());
    }
    let desired: Vec<(String, u32)> = m
        .ports
        .iter()
        .map(|p| {
            let host = launch
                .host_ports
                .get(&p.name)
                .copied()
                .or(p.host)
                .unwrap_or(p.container);
            (p.name.clone(), host)
        })
        .collect();
    // An engine list failure falls back to the desired ports unchanged.
    let taken = engine.published_host_ports().await.unwrap_or_default();
    let desired_refs: Vec<(&str, u32)> = desired.iter().map(|(n, h)| (n.as_str(), *h)).collect();
    resolve_host_ports(&desired_refs, &taken)
}

// --- deconfliction (engine-free) -------------------------------------------

/// A host port reassigned away from a collision: `name`'s desired `from` → `to`.
/// Serialized to the desktop trust prompt (which notifies the user of any
/// reassignment), so it crosses the IPC boundary as a `specta::Type`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PortBump {
    pub name: String,
    pub from: u32,
    pub to: u32,
}

/// Every host port DEFINED (manifest ⊕ persisted override) by instances in the
/// store, optionally excluding one. Engine-independent (no `ps`) — so it reflects
/// stopped instances too. The source of truth for "which host ports are spoken for".
pub fn defined_host_ports(
    instances_dir: &str,
    exclude_instance_id: Option<&str>,
) -> Result<Vec<u32>, Error> {
    let mut ports = Vec::new();
    for inst in list_instances(instances_dir) {
        if Some(inst.instance_id.as_str()) == exclude_instance_id {
            continue;
        }
        let override_cfg = load_instance_config(&inst.dir)?;
        let host_ports = override_cfg.host_ports.unwrap_or_default();
        for p in &inst.manifest.ports {
            ports.push(effective_host_port(p, &host_ports));
        }
    }
    Ok(ports)
}

/// Deconflict a freshly-created instance's host ports against the DEFINED host ports
/// of all OTHER instances (manifest ⊕ persisted override — engine-independent, so it
/// catches stopped instances too). Each colliding port is reassigned to the next
/// free one, PERSISTED to this instance's `config.yaml`, and reported so the caller
/// can NOTIFY the user (reducing the surprise of a silent remap).
pub fn deconflict_host_ports(
    instances_dir: &str,
    instance: &Instance,
) -> Result<Vec<PortBump>, Error> {
    let taken: HashSet<u32> = defined_host_ports(instances_dir, Some(&instance.instance_id))?
        .into_iter()
        .collect();

    let override_cfg = load_instance_config(&instance.dir)?;
    let host_ports = override_cfg.host_ports.clone().unwrap_or_default();
    let desired: Vec<(String, u32)> = instance
        .manifest
        .ports
        .iter()
        .map(|p| (p.name.clone(), effective_host_port(p, &host_ports)))
        .collect();
    let desired_refs: Vec<(&str, u32)> = desired.iter().map(|(n, h)| (n.as_str(), *h)).collect();
    let resolved = resolve_host_ports(&desired_refs, &taken)?;

    let bumps: Vec<PortBump> = desired
        .iter()
        .filter_map(|(name, from)| {
            let to = resolved[name.as_str()];
            (to != *from).then(|| PortBump {
                name: name.clone(),
                from: *from,
                to,
            })
        })
        .collect();

    if !bumps.is_empty() {
        let mut new_host_ports = host_ports;
        for bump in &bumps {
            new_host_ports.insert(bump.name.clone(), bump.to);
        }
        save_instance_config(
            &instance.dir,
            &Override {
                host_ports: Some(new_host_ports),
                ..override_cfg
            },
        )?;
    }
    Ok(bumps)
}

// --- export ----------------------------------------------------------------

/// In-container path the export helper mounts the target data under.
const EXPORT_MOUNT_ROOT: &str = "/compositz-export";

/// Export one persisted mount's data as a tar stream (root dir = the mount name).
/// Works whether or not the instance is running: a throwaway helper container is
/// CREATED (never started) with only that mount attached read-only, the data is read
/// via the archive API, and the helper is removed once the stream ends (or errors).
/// Requires the instance image locally (the helper reuses it — nothing is pulled).
///
/// NOTE: if the consumer DROPS the stream mid-way (cancel), the helper is not torn
/// down eagerly here — it is reclaimed by `remove_instance_data`'s label-scoped
/// helper sweep, which exists as exactly this backstop.
pub async fn export_mount(
    engine: &EngineHandle,
    instance: &Instance,
    mount_name: &str,
) -> Result<Pin<Box<dyn Stream<Item = Result<Bytes, Error>> + Send>>, Error> {
    let m = &instance.manifest;
    let mount_index = m
        .mounts
        .iter()
        .position(|mt| mt.name == mount_name)
        .ok_or_else(|| {
            let names = if m.mounts.is_empty() {
                "(none)".to_string()
            } else {
                m.mounts
                    .iter()
                    .map(|mt| mt.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            Error::Recipe(format!(
                "no mount \"{mount_name}\" in \"{}\" — available: {names}",
                m.id
            ))
        })?;

    // Same derivation as `up` (persisted_mounts): the effective placement (override ▷
    // manifest) decides WHICH data the app actually uses, so that is what exports.
    let override_cfg = load_instance_config(&instance.dir)?;
    let data_root = default_data_root(&HostPlatform)?;
    let source = persisted_mounts(
        m,
        &instance.instance_id,
        Some(&data_root),
        &override_cfg.placement.clone().unwrap_or_default(),
    )?
    .swap_remove(mount_index);

    // Fail loud on absent data rather than exporting a silently-empty tar: a missing
    // volume would be auto-created empty at helper create (Docker semantics), so check
    // it first (the name filter is a substring match — compare exactly).
    if source.typ == Some(MountType::VOLUME) {
        let vol_name = source.source.clone().unwrap_or_default();
        let exists = engine
            .list_volumes(Some(&vol_name))
            .await?
            .iter()
            .any(|v| v.name == vol_name);
        if !exists {
            return Err(Error::Recipe(format!(
                "mount \"{mount_name}\" has no volume \"{vol_name}\" yet — nothing to export (never started?)"
            )));
        }
    }

    let image = instance_image_tag(m, &instance.instance_id);
    if !engine.image_exists(&image).await? {
        return Err(Error::Recipe(format!(
            "image {image} is not available locally — install the instance first (the export helper reuses it)"
        )));
    }

    let export_path = format!("{EXPORT_MOUNT_ROOT}/{mount_name}");
    let helper_name = format!(
        "{}-export-{}",
        container_name(&instance.instance_id),
        short_random_suffix()
    );
    let helper = ContainerCreateBody {
        image: Some(image),
        // Never started — the Cmd only satisfies image configs without a default command.
        cmd: Some(vec!["compositz-export-noop".to_string()]),
        labels: Some(HashMap::from([
            (label("managed"), "true".to_string()),
            (label("instance"), instance.instance_id.clone()),
            (label("role"), "export-helper".to_string()),
        ])),
        host_config: Some(HostConfig {
            mounts: Some(vec![Mount {
                typ: source.typ,
                source: source.source,
                target: Some(export_path.clone()),
                read_only: Some(true),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    };
    let id = engine.create_container(helper, &helper_name).await?;

    // Stream the archive, tearing the helper down when consumption ends (or errors).
    // Cleanup completes (awaited) BEFORE the stream reports closed, so a CLI that
    // exits right after `pipe`-completion never races the helper's DELETE.
    let inner = Box::pin(engine.download_from_container(&id, &export_path));
    Ok(Box::pin(futures_util::stream::unfold(
        (engine.clone(), id, inner, false),
        |(engine, id, mut inner, done)| async move {
            if done {
                return None;
            }
            match inner.next().await {
                Some(Ok(chunk)) => Some((Ok(chunk), (engine, id, inner, false))),
                Some(Err(e)) => {
                    let _ = engine.remove_container(&id, true).await;
                    Some((Err(e), (engine, id, inner, true)))
                }
                None => {
                    let _ = engine.remove_container(&id, true).await;
                    None
                }
            }
        },
    )))
}

// --- teardown --------------------------------------------------------------

/// Stop and remove an instance's container (no-op if absent). Persisted mounts survive.
pub async fn down(
    engine: &EngineHandle,
    instance_id: &str,
    stop_timeout_secs: Option<i64>,
) -> Result<(), Error> {
    let name = container_name(instance_id);
    let _ = engine.stop_container(&name, stop_timeout_secs).await;
    let _ = engine.remove_container(&name, true).await;
    Ok(())
}

/// Options for [`remove_instance_data`]. `volumes` defaults to true, `bind_data` false.
#[derive(Debug, Clone)]
pub struct RemoveDataOpts {
    pub volumes: bool,
    pub bind_data: bool,
    pub data_root: Option<String>,
}

impl Default for RemoveDataOpts {
    fn default() -> Self {
        Self {
            volumes: true,
            bind_data: false,
            data_root: None,
        }
    }
}

/// A per-instance volume that could not be removed (e.g. still mounted — 409).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeFailure {
    pub name: String,
    pub error: String,
}

/// The data-root bind dir could not be removed (typically EACCES — a root-owned
/// tree the app wrote). Carries the PATH (not a volume name) as `{ path, error }`,
/// so a future IPC serialization stays contract-faithful.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindDirFailure {
    pub path: String,
    pub error: String,
}

/// The result of removing an instance's persisted data.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoveDataResult {
    pub volumes_removed: Vec<String>,
    pub volumes_failed: Vec<VolumeFailure>,
    pub bind_dir_removed: Option<String>,
    pub bind_dir_failed: Option<BindDirFailure>,
}

/// Remove an instance's PERSISTED DATA — irreversible. Per-instance named volumes are
/// removed for EVERY manifest mount regardless of its current placement (a placement
/// flip may have left data in both forms); names derive from the definition
/// (`volume_name(id, mount)`), so the shared cache volumes are structurally out of
/// reach. With `bind_data`, the instance's data-root dir is removed too. Call `down`
/// first: a volume still mounted fails (409) and is REPORTED, never forced.
pub async fn remove_instance_data(
    engine: &EngineHandle,
    instance: &Instance,
    opts: RemoveDataOpts,
) -> Result<RemoveDataResult, Error> {
    let mut result = RemoveDataResult::default();

    if opts.volumes {
        // Sweep leftover export helpers first: a helper leaked by a killed process
        // still references the volumes and would turn every removal into a permanent
        // 409. Label-scoped to THIS instance's helpers — cannot touch anything else.
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert(
            "label".to_string(),
            vec![
                format!("{}=export-helper", label("role")),
                format!("{}={}", label("instance"), instance.instance_id),
            ],
        );
        if let Ok(helpers) = engine.list_containers(true, filters).await {
            for helper in helpers {
                let _ = engine.remove_container(&helper.id, true).await;
            }
        }

        for mt in &instance.manifest.mounts {
            let name = volume_name(&instance.instance_id, &mt.name);
            // Docker's name filter is a substring match — confirm exactly before
            // counting a removal (a 404-tolerant delete couldn't tell removed/absent).
            let exists = engine
                .list_volumes(Some(&name))
                .await?
                .iter()
                .any(|v| v.name == name);
            if !exists {
                continue;
            }
            match engine.remove_volume(&name).await {
                Ok(()) => result.volumes_removed.push(name),
                Err(e) => result.volumes_failed.push(VolumeFailure {
                    name,
                    error: e.to_string(),
                }),
            }
        }
    }

    if opts.bind_data {
        let data_root = match opts.data_root {
            Some(root) => root,
            None => default_data_root(&HostPlatform)?,
        };
        let dir = std::path::Path::new(&data_root)
            .join(&instance.instance_id)
            .to_string_lossy()
            .into_owned();
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => result.bind_dir_removed = Some(dir),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // Report instead of throwing: the volume removals above already happened
            // irreversibly — a throw here would discard that fact from the report.
            Err(e) => {
                result.bind_dir_failed = Some(BindDirFailure {
                    path: dir,
                    error: e.to_string(),
                })
            }
        }
    }

    Ok(result)
}

/// Remove the per-instance built image (`compositz/<instanceId>:<version>`) on
/// delete. No-op for an `image`-based recipe — its image is shared/external and MUST
/// never be removed. Best-effort: a missing image is fine, and an unforced delete
/// leaves it intact if a container still references it (call `down` first).
pub async fn remove_instance_image(
    engine: &EngineHandle,
    instance: &Instance,
) -> Result<(), Error> {
    if instance.manifest.image.is_some() {
        return Ok(()); // shared external image — never remove
    }
    // MUST use the brand `image_tag` (the per-instance build tag), NOT
    // `instance_image_tag` — the latter returns `m.image` for an image-based recipe.
    // The guard above and this tag are two halves of one invariant; keep them together.
    let tag = image_tag(&instance.instance_id, &instance.manifest.version);
    let _ = engine.remove_image(&tag).await;
    Ok(())
}

// --- helpers ---------------------------------------------------------------

/// The persisted override (config.yaml) as a launch overlay base (no data_root).
fn launch_from_override(o: &Override) -> LaunchConfig {
    LaunchConfig {
        data_root: None,
        host_ports: o.host_ports.clone().unwrap_or_default(),
        env: o.env.clone().unwrap_or_default(),
        placement: o.placement.clone().unwrap_or_default(),
    }
}

/// 8 hex chars from the OS CSPRNG — a collision tag for a throwaway helper name.
fn short_random_suffix() -> String {
    let mut bytes = [0u8; 4];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
