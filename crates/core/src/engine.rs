//! Compositz engine-access core — the *write* surface.
//!
//! Where `lib.rs` holds the read-only entry points (connect / list / log+event
//! streams), this module adds the mutating Docker operations the CLI and desktop
//! app drive: create/start/stop/remove containers, pull/build/inspect/remove
//! images, list/remove volumes, and tar-download a container path.
//!
//! Everything here is a thin, typed pass-through to [`bollard`]: option builders
//! set only the fields the callers use, and errors flow through `?` into
//! [`crate::Error::Engine`]. The result of each call is either `()`, a small
//! owned view type (so callers never depend on bollard's model surface for these
//! paths), or a `'static` byte/progress stream.

use crate::EngineHandle;
use bollard::query_parameters::{
    BuildImageOptionsBuilder, CreateContainerOptionsBuilder, CreateImageOptionsBuilder,
    DownloadFromContainerOptionsBuilder, ListContainersOptionsBuilder, ListVolumesOptionsBuilder,
    RemoveContainerOptionsBuilder, RemoveImageOptionsBuilder, RemoveVolumeOptionsBuilder,
    StopContainerOptionsBuilder,
};
use futures_util::{Stream, StreamExt};
use std::collections::{HashMap, HashSet};

/// One progress record from an image build, distilled from bollard's `BuildInfo`.
///
/// A build stream interleaves human-readable log lines (`stream`), the final
/// image id emitted once at the end (`aux_id`), and any hard failure (`error`).
/// Callers render `stream`, capture `aux_id` as the built image reference, and
/// treat a non-`None` `error` as a build failure. Kept as an owned view so the
/// UI/IPC layer never depends on bollard's model types for the build path.
#[derive(Debug, Clone)]
pub struct BuildProgress {
    /// A build log fragment (may carry several lines or a partial one).
    pub stream: Option<String>,
    /// The built image id, present only on the terminal `aux` record.
    pub aux_id: Option<String>,
    /// A build failure message, present only when the daemon reported an error.
    pub error: Option<String>,
}

/// A volume as the prune/cleanup paths consume it — just its name, since that is
/// all the callers (list-by-prefix, then remove) act on.
#[derive(Debug, Clone)]
pub struct VolumeSummary {
    /// The volume name (bollard reports this as a non-optional `String`).
    pub name: String,
}

/// The engine's self-reported version, distilled from bollard's `SystemVersion`.
///
/// An owned view (every field `Option`, matching the daemon's optional response)
/// so the `doctor` diagnostic never depends on bollard's model surface. Exposes
/// `{ Version, ApiVersion, MinAPIVersion, Os, Arch }`.
#[derive(Debug, Clone)]
pub struct EngineVersion {
    pub version: Option<String>,
    pub api_version: Option<String>,
    pub min_api_version: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
}

impl EngineHandle {
    /// Create a container from a fully-formed spec, returning its id.
    ///
    /// The spec (image, env, host config, labels, …) is built by the caller;
    /// this only attaches the desired `name`.
    pub async fn create_container(
        &self,
        spec: bollard::models::ContainerCreateBody,
        name: &str,
    ) -> Result<String, crate::Error> {
        let options = CreateContainerOptionsBuilder::new().name(name).build();
        let response = self.docker().create_container(Some(options), spec).await?;
        Ok(response.id)
    }

    /// Start a previously-created container by id (or name).
    pub async fn start_container(&self, id: &str) -> Result<(), crate::Error> {
        // No start options are needed (no detach-keys / checkpoint); pass None.
        self.docker().start_container(id, None).await?;
        Ok(())
    }

    /// Stop a running container, optionally overriding the grace period.
    ///
    /// `timeout_secs` is the seconds to wait before SIGKILL. bollard's builder
    /// takes an `i32`, so the caller-facing `i64` is narrowed here; a negative or
    /// absurd value is the caller's contract to avoid (the engine clamps it).
    pub async fn stop_container(
        &self,
        name: &str,
        timeout_secs: Option<i64>,
    ) -> Result<(), crate::Error> {
        let options =
            timeout_secs.map(|secs| StopContainerOptionsBuilder::new().t(secs as i32).build());
        self.docker().stop_container(name, options).await?;
        Ok(())
    }

    /// Remove a container. `force` kills a running one first. Anonymous volumes are
    /// NOT removed (`v` stays false): a recipe's `VOLUME`-declared anon volume must
    /// survive a `down`/restart — only [`Self::remove_volume`], driven by the
    /// explicit delete path, reclaims per-instance data.
    pub async fn remove_container(&self, name: &str, force: bool) -> Result<(), crate::Error> {
        let options = RemoveContainerOptionsBuilder::new().force(force).build();
        self.docker().remove_container(name, Some(options)).await?;
        Ok(())
    }

    /// List containers (optionally including stopped ones via `all`) under the
    /// given label/name/status `filters`, mapped to the crate view type.
    pub async fn list_containers(
        &self,
        all: bool,
        filters: HashMap<String, Vec<String>>,
    ) -> Result<Vec<crate::ContainerSummary>, crate::Error> {
        let options = ListContainersOptionsBuilder::new()
            .all(all)
            .filters(&filters)
            .build();
        let raw = self.list_raw_summaries(options).await?;
        Ok(raw
            .into_iter()
            .map(crate::ContainerSummary::from_bollard)
            .collect())
    }

    /// THE single container-listing fetch: every list path goes through here so
    /// the wslc port translation (VM-side public port → Windows-side port, from
    /// wslc's metadata label) can never be skipped by one caller — display,
    /// launch-time conflict checks and the readiness probe must all see the
    /// namespace the user can actually reach (ADR-031).
    async fn list_raw_summaries(
        &self,
        options: bollard::query_parameters::ListContainersOptions,
    ) -> Result<Vec<bollard::models::ContainerSummary>, crate::Error> {
        let mut raw = self.docker().list_containers(Some(options)).await?;
        if self.is_wslc() {
            crate::wslc_cli::translate_summary_ports(&mut raw);
        }
        Ok(raw)
    }

    /// Managed containers (running + stopped) as RAW bollard summaries — the
    /// dashboard snapshot ([`crate::probe::build_snapshot`]) needs the container
    /// labels and the structured port mappings that the display-oriented
    /// [`crate::ContainerSummary`] flattens away. Filtered by the managed
    /// (`io.compositz.instance`) label, so it never reads unmanaged containers.
    pub async fn list_managed_raw(
        &self,
    ) -> Result<Vec<bollard::models::ContainerSummary>, crate::Error> {
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert("label".to_string(), vec![crate::brand::label("instance")]);
        let options = ListContainersOptionsBuilder::new()
            .all(true)
            .filters(&filters)
            .build();
        self.list_raw_summaries(options).await
    }

    /// Every host port currently published by a RUNNING container, as a set — the
    /// launch-time collision basis for `resolve_host_ports`. Reads the raw port
    /// mappings, which the display-oriented [`crate::ContainerSummary`] flattens
    /// away, so it stays a dedicated query rather than parsing formatted strings.
    pub async fn published_host_ports(&self) -> Result<HashSet<u32>, crate::Error> {
        let options = ListContainersOptionsBuilder::new().all(false).build();
        let containers = self.list_raw_summaries(options).await?;
        let mut ports = HashSet::new();
        for container in containers {
            for port in container.ports.unwrap_or_default() {
                if let Some(public) = port.public_port {
                    ports.insert(public as u32);
                }
            }
        }
        Ok(ports)
    }

    /// Pull an image, draining the pull-progress stream to completion.
    ///
    /// We only care about success/failure here (progress is not surfaced to
    /// callers on this path), so any stream item that is an `Err` aborts the
    /// pull; otherwise draining to the end means the pull finished.
    ///
    /// The ref is split into name + tag ([`split_image_ref`]): a bare `from_image`
    /// with no `tag` makes `POST /images/create`
    /// pull EVERY tag of the repository, so an untagged ref (e.g. `image: python`,
    /// valid per the manifest regex) must default to `:latest`.
    pub async fn pull_image(&self, image: &str) -> Result<(), crate::Error> {
        let (name, tag) = split_image_ref(image);
        let builder = CreateImageOptionsBuilder::new().from_image(name);
        let builder = if tag.is_empty() {
            builder // digest-pinned (`@sha256:…`): the digest travels inside `name`
        } else {
            builder.tag(tag)
        };
        let mut stream = self
            .docker()
            .create_image(Some(builder.build()), None, None);
        while let Some(item) = stream.next().await {
            // Propagate the first transport/daemon error; ignore the progress
            // payload on success.
            item?;
        }
        Ok(())
    }

    /// Build an image from an in-memory tar context, streaming build progress.
    ///
    /// The `tar` is the whole build context (Dockerfile + provisioning files);
    /// `dockerfile` names the Dockerfile *within* that context; `build_args`
    /// become `--build-arg` values. `rm(true)` removes intermediate containers on
    /// success, matching `docker build`'s default and avoiding dangling
    /// intermediates.
    ///
    /// The returned stream is `'static`: bollard's `build_image` signature ties
    /// its stream to `&self`'s lifetime, but its body actually owns cloned `Arc`
    /// handles (see `process_request`). An `async_stream` generator owns the
    /// cloned `Docker` in its body and `yield`s each mapped item, so the owned
    /// handle lives exactly as long as the stream — severing the `&self` borrow
    /// without a self-referential struct. `Box::pin` makes it `Unpin` for
    /// by-value `.next().await` (mirrors `log_stream`/`event_stream`).
    pub fn build_image(
        &self,
        tar: Vec<u8>,
        tag: String,
        dockerfile: String,
        build_args: HashMap<String, String>,
    ) -> impl Stream<Item = Result<BuildProgress, crate::Error>> + Send + Unpin + 'static {
        let docker = self.docker().clone();
        Box::pin(async_stream::stream! {
            let options = BuildImageOptionsBuilder::new()
                .t(&tag)
                .dockerfile(&dockerfile)
                .buildargs(&build_args)
                .rm(true)
                .build();
            let mut inner = docker.build_image(options, None, Some(bollard::body_full(tar.into())));
            while let Some(item) = inner.next().await {
                yield item.map(build_progress_from_bollard).map_err(crate::Error::from);
            }
        })
    }

    /// Whether an image exists locally, via `inspect_image`.
    ///
    /// A successful inspect means present. The daemon answers "not found" with a
    /// 404 `DockerResponseServerError`, which we map to `Ok(false)` — only that
    /// exact shape, so a transport failure or any other status still surfaces as
    /// an error rather than being misread as "absent".
    pub async fn image_exists(&self, image: &str) -> Result<bool, crate::Error> {
        match self.docker().inspect_image(image).await {
            Ok(_) => Ok(true),
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(false),
            Err(other) => Err(crate::Error::from(other)),
        }
    }

    /// Remove an image — UNFORCED. An unforced delete leaves the image intact if a
    /// container still references it, so a stale/running instance is never left
    /// pointing at a vanished image; the delete path calls `down` first. Forcing
    /// here would untag it out from under a live container — a safety guard this
    /// MUST NOT drop.
    pub async fn remove_image(&self, image: &str) -> Result<(), crate::Error> {
        let options = RemoveImageOptionsBuilder::new().build();
        self.docker()
            .remove_image(image, Some(options), None)
            .await?;
        Ok(())
    }

    /// List volumes, optionally filtered to those whose name matches
    /// `name_filter` (Docker's `name` filter is a substring match).
    pub async fn list_volumes(
        &self,
        name_filter: Option<&str>,
    ) -> Result<Vec<VolumeSummary>, crate::Error> {
        let options = name_filter.map(|name| {
            let mut filters: HashMap<String, Vec<String>> = HashMap::new();
            filters.insert("name".to_string(), vec![name.to_string()]);
            ListVolumesOptionsBuilder::new().filters(&filters).build()
        });
        let response = self.docker().list_volumes(options).await?;
        Ok(response
            .volumes
            .unwrap_or_default()
            .into_iter()
            .map(|volume| VolumeSummary { name: volume.name })
            .collect())
    }

    /// Remove a volume by name (no force — a volume still in use should fail loudly
    /// rather than be yanked out from under a running container). A 404 is tolerated
    /// as success: the delete path checks existence first, so a 404 here means the
    /// volume vanished in a
    /// TOCTOU race — which is exactly the "already gone" outcome we wanted.
    pub async fn remove_volume(&self, name: &str) -> Result<(), crate::Error> {
        // bollard's `None` option arm is generic (`Option<impl Into<…>>`), so the
        // element type is unconstrained without an explicit build of an empty
        // options value; pass a defaulted options struct instead of a bare `None`.
        let options = RemoveVolumeOptionsBuilder::new().build();
        match self.docker().remove_volume(name, Some(options)).await {
            Ok(()) => Ok(()),
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(()),
            Err(other) => Err(crate::Error::from(other)),
        }
    }

    /// Stream a tar archive of `path` inside container `id` as raw byte chunks.
    ///
    /// Like [`Self::build_image`], the returned stream is `'static`: the owned
    /// `Docker` clone lives inside the `async_stream` generator body that drives
    /// the underlying bollard stream, so nothing borrows `&self`.
    pub fn download_from_container(
        &self,
        id: &str,
        path: &str,
    ) -> impl Stream<Item = Result<bytes::Bytes, crate::Error>> + Send + Unpin + 'static {
        let docker = self.docker().clone();
        let id = id.to_string();
        let path = path.to_string();
        Box::pin(async_stream::stream! {
            let options = DownloadFromContainerOptionsBuilder::new().path(&path).build();
            let mut inner = docker.download_from_container(&id, Some(options));
            while let Some(item) = inner.next().await {
                yield item.map_err(crate::Error::from);
            }
        })
    }

    /// Ping the engine (`GET /_ping`). Returns the daemon's ping payload (`"OK"` on a
    /// healthy engine). The first call that actually opens the socket, so a bad
    /// endpoint surfaces here — used by `doctor` as the reachability probe.
    pub async fn ping(&self) -> Result<String, crate::Error> {
        Ok(self.docker().ping().await?)
    }

    /// The engine's version info (`GET /version`), as the owned [`EngineVersion`]
    /// view. Backs the `doctor` diagnostic's version/platform lines.
    pub async fn version(&self) -> Result<EngineVersion, crate::Error> {
        let v = self.docker().version().await?;
        Ok(EngineVersion {
            version: v.version,
            api_version: v.api_version,
            min_api_version: v.min_api_version,
            os: v.os,
            arch: v.arch,
        })
    }

    /// Block until a container exits, returning its exit status code.
    ///
    /// The `/wait` endpoint (default condition `not-running`) returns immediately
    /// with the exit code if the container has already stopped — so `hello`'s
    /// "stream logs to EOF, then wait" ordering reads the real exit code without
    /// racing. The stream yields one terminal response; we return its `status_code`
    /// (0 if the daemon somehow yielded nothing, which it does not in practice).
    pub async fn wait_container(&self, name: &str) -> Result<i64, crate::Error> {
        let mut stream = self.docker().wait_container(name, None);
        let mut status = 0i64;
        while let Some(item) = stream.next().await {
            status = item?.status_code;
        }
        Ok(status)
    }

    /// Create a container from a MINIMAL owned spec (image + cmd + labels, no TTY).
    ///
    /// For diagnostics/round-trips (`hello`) that don't need the full launch
    /// machinery of [`crate::to_create_spec`]. Keeps the caller free of bollard's
    /// model surface — the same boundary [`Self::create_container`]'s callers get
    /// via the higher-level `up` path.
    pub async fn create_container_simple(
        &self,
        image: &str,
        cmd: &[&str],
        labels: HashMap<String, String>,
        name: &str,
    ) -> Result<String, crate::Error> {
        let spec = bollard::models::ContainerCreateBody {
            image: Some(image.to_string()),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
            tty: Some(false),
            labels: Some(labels),
            ..Default::default()
        };
        self.create_container(spec, name).await
    }
}

/// Map one bollard `BuildInfo` record into the owned [`BuildProgress`] view.
///
/// Without the `buildkit` feature (this workspace builds bollard with
/// `http`/`pipe`/`ssl` only), `aux` is an `ImageId` whose `id` is the built image
/// reference. NOTE: a hard build failure surfaces as a stream `Err` (bollard folds
/// it before this maps a record), so consumers MUST treat a stream `Err` as failure;
/// `error` here is only a best-effort inline `error_detail.message` and is usually
/// `None`.
fn build_progress_from_bollard(info: bollard::models::BuildInfo) -> BuildProgress {
    BuildProgress {
        stream: info.stream,
        aux_id: info.aux.and_then(|aux| aux.id),
        error: info.error_detail.and_then(|detail| detail.message),
    }
}

/// Split an image reference into `(name, tag)`.
/// A digest-pinned ref (`repo@sha256:…`) keeps the whole ref as `name` with an empty
/// tag; a `repo:tag` splits on the LAST colon after the last `/` (so a registry-port
/// `host:5000/repo` is not mistaken for a tag); a bare `repo` defaults to `latest`.
fn split_image_ref(image_ref: &str) -> (&str, &str) {
    if image_ref.contains('@') {
        return (image_ref, ""); // digest-pinned
    }
    let slash = image_ref.rfind('/');
    match image_ref.rfind(':') {
        // The colon is a tag only when it follows the last path separator.
        Some(colon) if slash.is_none_or(|s| colon > s) => {
            (&image_ref[..colon], &image_ref[colon + 1..])
        }
        _ => (image_ref, "latest"),
    }
}

#[cfg(test)]
mod tests {
    use super::split_image_ref;

    #[test]
    fn split_image_ref_defaults_and_edges() {
        assert_eq!(split_image_ref("python"), ("python", "latest"));
        assert_eq!(split_image_ref("python:3.11"), ("python", "3.11"));
        assert_eq!(
            split_image_ref("ollama/ollama:0.6.0"),
            ("ollama/ollama", "0.6.0")
        );
        // A registry-port colon before the last `/` is NOT a tag.
        assert_eq!(split_image_ref("reg:5000/img"), ("reg:5000/img", "latest"));
        assert_eq!(split_image_ref("reg:5000/img:v2"), ("reg:5000/img", "v2"));
        // Digest-pinned: whole ref as name, empty tag.
        assert_eq!(
            split_image_ref("python@sha256:abc"),
            ("python@sha256:abc", "")
        );
    }
}
