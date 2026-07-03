//! Compositz engine-access core — the *write* surface.
//!
//! Where `lib.rs` holds the read-only skeleton (connect / list / log+event
//! streams), this module adds the mutating Docker operations the CLI and desktop
//! app drive: create/start/stop/remove containers, pull/build/inspect/remove
//! images, list/remove volumes, and tar-download a container path. Ported from
//! the Deno `packages/core` transport calls (Phase 1h).
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
    /// NOT removed (`v` stays false, matching the Deno `client.remove(name,
    /// {force})`): a recipe's `VOLUME`-declared anon volume must survive a
    /// `down`/restart — only [`Self::remove_volume`], driven by the explicit delete
    /// path, reclaims per-instance data.
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
        let raw = self.docker().list_containers(Some(options)).await?;
        Ok(raw
            .into_iter()
            .map(crate::ContainerSummary::from_bollard)
            .collect())
    }

    /// Every host port currently published by a RUNNING container, as a set — the
    /// launch-time collision basis for `resolve_host_ports`. Reads the raw port
    /// mappings, which the display-oriented [`crate::ContainerSummary`] flattens
    /// away, so it stays a dedicated query rather than parsing formatted strings.
    pub async fn published_host_ports(&self) -> Result<HashSet<u32>, crate::Error> {
        let options = ListContainersOptionsBuilder::new().all(false).build();
        let containers = self.docker().list_containers(Some(options)).await?;
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
    /// pull; otherwise draining to the end means the pull finished. The
    /// `image` reference is passed whole via `from_image` — the daemon parses the
    /// optional `:tag`/`@digest` itself, so there is no need to pre-split it.
    pub async fn pull_image(&self, image: &str) -> Result<(), crate::Error> {
        let options = CreateImageOptionsBuilder::new().from_image(image).build();
        let mut stream = self.docker().create_image(Some(options), None, None);
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

    /// Remove an image, forcing removal even if it is tagged/referenced so a
    /// cleanup does not stall on lingering tags.
    pub async fn remove_image(&self, image: &str) -> Result<(), crate::Error> {
        let options = RemoveImageOptionsBuilder::new().force(true).build();
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
    /// rather than be yanked out from under a running container).
    pub async fn remove_volume(&self, name: &str) -> Result<(), crate::Error> {
        // bollard's `None` option arm is generic (`Option<impl Into<…>>`), so the
        // element type is unconstrained without an explicit build of an empty
        // options value; pass a defaulted options struct instead of a bare `None`.
        let options = RemoveVolumeOptionsBuilder::new().build();
        self.docker().remove_volume(name, Some(options)).await?;
        Ok(())
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
}

/// Map one bollard `BuildInfo` record into the owned [`BuildProgress`] view.
///
/// Without the `buildkit` feature (this workspace builds bollard with
/// `http`/`pipe`/`ssl` only), `aux` is an `ImageId` whose `id` is the built
/// image reference. The failure text comes from `error_detail.message` — bollard
/// exposes no flat `error` string on `BuildInfo` in this version.
fn build_progress_from_bollard(info: bollard::models::BuildInfo) -> BuildProgress {
    BuildProgress {
        stream: info.stream,
        aux_id: info.aux.and_then(|aux| aux.id),
        error: info.error_detail.and_then(|detail| detail.message),
    }
}
