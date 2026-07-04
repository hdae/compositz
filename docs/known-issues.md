# Known issues

Open / being-worked problems. By-design constraints belong in [limitations.md](limitations.md);
settled rationale belongs in [decisions.md](decisions.md).

Resolved along the way (for the record): the non-atomic `config.yaml` write (closed
structurally — every store write is temp+fsync+rename), the GitHub `repo=".."`
dot-segment spec hole (rejected at parse), and the SSE-reconnect duplicate-log-lines
issue (the SSE transport itself was retired with the Tauri migration, [ADR-028](decisions.md)).

## UI: `installed` badge can go stale until refresh

- **What:** the snapshot push ([`SnapshotEvent`](../crates/desktop/src/stream.rs))
  carries only container state; the frontend seeds `installed` from the initial
  `list_instance_rows` and flips it when an install completes. If an image is built or
  removed **externally** (`docker build` / `docker rmi`, or another Compositz process),
  the badge does not reconcile until the next full refresh.
- **Fix direction:** include image existence in the snapshot payload (recompute per
  push), or subscribe to image events. Deferred — low impact for a local tool.

## Already-orphaned volumes have no reclaim command

- **What:** deletion removes an instance's data volumes **by default** (ADR-025;
  `--keep-data` / a UI checkbox opts out, `--purge` adds the data-root bind dir) — but
  volumes orphaned before that change, or kept deliberately and later regretted, are
  invisible to the instance list and there is no `volumes prune` / "reclaim unused
  data" action.
- **Fix direction:** enumerate `compositz_<id>_*` volumes against existing instances
  and prune on explicit confirmation (Phase-3 "volumes/GC"; the engine volume
  endpoints exist in core). The venv-subpath variant is the entry below.

## A missed superseded-image removal at update time is never retried

- **What:** an in-place update reclaims the OLD per-instance image tag at commit
  ([ADR-029](decisions.md)), but a removal that is skipped or fails — a crash between
  the commit and the reclaim, an in-use 409 (e.g. a leaked export helper still
  referencing it), or a pre-commit build finishing late and re-creating the old tag —
  is permanent: no later code path removes that tag again. Disk waste only (multi-GB
  for GPU images); shared/external images and cache volumes stay structurally
  unreachable.
- **Fix direction:** the Phase-3 GC: enumerate `compositz/<instanceId>:<version>` tags
  against each instance's CURRENT manifest version and reclaim stale ones on explicit
  confirmation — same shape as the volume prune above.

## Deleting a venv-preset instance leaves its venv inside the shared uv volume

- **What:** the `venv` cache preset puts each instance's venv at `venvs/<instanceId>`
  **inside** the shared `compositz_uv` volume (co-location is what makes uv's hardlink
  dedup work, ADR-006). Delete keeps shared caches (correctly — they're shared), but an
  orphaned venv _subpath_ is invisible to volume listing and there is no tool to
  enumerate or reclaim it.
- **Fix direction:** the ADR-006 `gc --reclaim` wrapper (Phase-3 "volumes/GC"):
  enumerate `venvs/<id>` subpaths against existing instances (needs a helper container)
  and remove orphans on explicit confirmation.

## A crashed app is indistinguishable from a clean stop — and `up` destroys the evidence

- **What:** the UI reduces container state to a boolean
  ([`view.rs`](../crates/core/src/view.rs) keeps only `state == "running"`), so an
  OOM-killed or crashed app renders as plain "stopped" with a Start button — no crash
  signal, no exit code. Worse, `up`
  ([`operations.rs`](../crates/core/src/recipe/operations.rs)) starts by force-removing
  the previous container, so the restart a confused user reaches for destroys the
  crashed container's logs and exit status before anyone can inspect them.
- **Fix direction:** derive a distinct `crashed` status from the state the snapshot
  already carries (plus exit code via inspect) and render it on the row. MUST preserve
  the old container's exit info before `up`'s force-remove, or the new status has
  nothing to show. Companion knob: an opt-in manifest `restartPolicy`
  ([roadmap](roadmap.md) Phase 3).

## GPU `preferred` → CPU fallback is invisible in the UI

- **What:** `up` reports `used_gpu` end-to-end — the CLI prints it, and the desktop
  command returns it ([`commands.rs`](../crates/desktop/src/commands.rs)) — but the
  React UI never reads it: a `gpu: preferred` app whose driver broke silently runs the
  CPU path with no indication.
- **Fix direction:** a row badge/notification when `used_gpu == false` for a manifest
  that prefers GPU (the data is already in the response; display-only).

## Build logs are ephemeral UI state (lost on app restart)

- **What:** the Build-log tab accumulates the install stream in the frontend store
  only; restarting the app clears it, and nothing persists build output on disk. After
  a failed overnight build there may be nothing left to read.
- **Fix direction:** persist the last build log per instance (a file under the
  instance dir, written by `install_instance` consumers) and serve it as the tab's
  initial backfill.

## `image:` recipe pulls show no layer progress

- **What:** `install_instance` yields only two lines (`pulling…` / `pulled`) around the
  engine pull — a multi-GB `image:` recipe install sits silent for minutes. Distinct
  from run-phase readiness (this is the install phase).
- **Fix direction:** thread pull layer progress into the install stream the same way
  build log lines flow.

## An export helper leaked by a killed process lingers until the next delete

- **What:** `export_mount`'s helper container is removed when its stream ends; a
  process killed mid-export (CLI Ctrl-C, app exit) leaks it. Deletion sweeps the
  instance's helpers before removing volumes (label-scoped), but a leaked helper still
  sits in `ps -a` until that delete happens.
- **Fix direction:** opportunistic stale-helper sweep in the Phase-3 GC pass (same
  enumeration), plus optionally a SIGINT handler for best-effort cleanup.

## Large imports show no progress and can't be cancelled

- **What:** importing a large bundle (file or GitHub) streams to disk and completes,
  but the UI only shows "Importing…" with no progress or cancel for the duration of the
  download + extraction.
- **Fix direction (future):** an extraction/download progress channel and an abort
  control. Low priority — real recipe bundles are small; the uncapped-size flip side is
  tracked in [limitations.md](limitations.md).
