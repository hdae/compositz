# Known issues

Open / being-worked problems. By-design constraints belong in [limitations.md](limitations.md);
settled rationale belongs in [decisions.md](decisions.md).

## UI: `installed` badge can go stale until reload

- **What:** the SSE `snapshot` event ([`routes/api/events.ts`](../packages/ui/routes/api/events.ts))
  carries only `{ containers }`. The island's `installedTags` is seeded from the server render and
  updated only when an install completes (the NDJSON `done` message). If an image is built or
  removed **externally** (`docker build` / `docker rmi`, or another Compositz process), the
  `installed` badge does not reconcile until the page reloads.
- **Scope:** pre-dates the instance-centric work (it is inherent to the Increment-2 SSE shape, which
  pushes container lifecycle, not image existence). RI-2 did not change it.
- **Fix direction:** include `installedTags` in the SSE `snapshot` payload (recompute `imageExists`
  per push), or add a lightweight image-event subscription. Deferred — low impact for a local tool.

## Already-orphaned volumes have no reclaim command

- **What:** deletion now removes an instance's data volumes **by default** (ADR-025; `--keep-data` /
  a UI checkbox opts out, `--purge` adds the data-root bind dir) — but volumes orphaned BEFORE that
  change, or kept deliberately and later regretted, are invisible to the instance list and there is
  no `volumes prune` / "reclaim unused data" action.
- **Fix direction:** enumerate `compositz_<id>_*` volumes against existing instances and prune on
  explicit confirmation (Phase-3 "volumes/GC"; `EngineClient` volume endpoints exist now). The
  venv-subpath variant is the entry below.

## Deleting a venv-preset instance leaves its venv inside the shared uv volume

- **What:** the `venv` cache preset puts each instance's venv at `venvs/<instanceId>` **inside** the
  shared `compositz_uv` volume (co-location is what makes uv's hardlink dedup work, ADR-006). Delete
  keeps volumes (safe default, see above) — but unlike a per-instance named volume, an orphaned venv
  _subpath_ is invisible to volume listing, and there is no tool to enumerate or reclaim it.
- **Fix direction:** the ADR-006 `gc --reclaim` wrapper (Phase-3 "volumes/GC"): enumerate
  `venvs/<id>` subpaths against existing instances (needs a helper container or volume inspection)
  and remove orphans on explicit confirmation. Same phase as the volume-reclaim item above.

## A crashed app is indistinguishable from a clean stop — and `up` destroys the evidence

- **What:** the UI reduces container state to a boolean (`toInstanceRows` keeps only
  `state === "running"`, [`lib/dashboard.ts:232`](../packages/ui/lib/dashboard.ts)), so an
  OOM-killed or crashed app renders as plain "stopped" with a Start button — no crash signal, no
  exit code. Worse, `up()` starts by force-removing the previous container
  ([`operations.ts:76`](../packages/core/src/recipe/operations.ts)), so the restart a confused user
  reaches for destroys the crashed container's logs and exit status before anyone can inspect them.
- **Fix direction:** derive a distinct `crashed` status from the `state` the snapshot already
  carries end-to-end (plus exit code via inspect) and render it on the row. MUST preserve the old
  container's exit info before `up`'s force-remove, or the new status has nothing to show. Companion
  knob: an opt-in manifest `restartPolicy` (roadmap Phase 3 — the `HostConfig.RestartPolicy` type
  exists but `toCreateSpec` never sets it, so nothing survives a host/daemon restart either).

## GPU `preferred` → CPU fallback is invisible in the UI

- **What:** `up()` reports `usedGpu` and the CLI prints it
  ([`up.ts:24`](../packages/cli/commands/up.ts)); the UI route returns it in the POST response
  ([`[action].ts:68`](../packages/ui/routes/api/instances/%5Bid%5D/%5Baction%5D.ts)) but the island
  never reads it — a `gpu: preferred` app whose driver broke silently runs the CPU path with no
  indication.
- **Fix direction:** surface a row badge/notification when `usedGpu === false` for a manifest that
  prefers GPU (the data is already in the response; display-only).

## Build logs are ephemeral island state (lost on reload)

- **What:** the Build-log tab accumulates the install NDJSON in island memory only; a page reload or
  app restart clears it, and nothing persists the build output on disk. After a failed overnight
  build there may be nothing left to read.
- **Fix direction:** persist the last build log per instance (a file under the instance dir, written
  by `installInstance` consumers) and serve it as the tab's initial backfill.

## `image:` recipe pulls show no layer progress

- **What:** `installInstance` yields only two lines (`pulling…`/`pulled`) around `client.pull`,
  whose `onProgress` callback ([`client.ts:64`](../packages/core/src/engine/client.ts)) no caller
  uses — a multi-GB `image:` recipe install sits silent for minutes. Distinct from the run-phase
  readiness issue below (this is the install phase).
- **Fix direction:** thread pull layer progress into the install NDJSON stream the same way build
  log lines flow.

## Runtime-log tab can duplicate lines after an unexpected reconnect

- **What:** the Runtime-log tab streams `/api/instances/:id/logs` (SSE) with a `tail=500` backfill.
  On a **clean** end (container stops → `end`/`logerror`) the client closes the EventSource, so no
  reconnect. But on an unexpected mid-stream drop, the browser's EventSource auto-reconnects and the
  route re-sends the `tail=500` backfill, so the last lines appear twice in the panel.
- **Scope:** rare on a local engine (no network in between); cosmetic (no data loss).
- **Fix direction:** server-side `Last-Event-ID` support so a reconnect resumes via `since=` instead
  of re-backfilling, or have the client reset the buffer on the native `error` (reconnect) event.

## Large uploads show no progress / can't be cancelled

- **What:** importing a very large bundle streams to disk and completes, but the UI only shows
  "Importing…" with no progress or cancel for the duration of a long upload+extract.
- **Fix direction (future):** stream upload progress (or a server-sent extraction progress channel)
  and an abort control. Low priority — real recipe bundles are small.

## First `up` of a slow-first-boot app looks stuck ("starting…" for minutes)

- **What:** Compositz treats a service as ready when its published web port accepts a connection
  (port-based readiness). An app that defers heavy setup to container start shows "starting…" for
  the whole first boot with no progress signal. [`recipes/cocktail`](../recipes/cocktail/Dockerfile)
  is the worst case: its entrypoint runs `uv sync` to install torch/diffusers (several GB) and then
  downloads models **before** the server binds the port, so first `up` sits in "starting…" for
  minutes. Second boot is fast (deps + models persist on the `/workspace` volume).
- **Scope:** inherent to port-based readiness; not specific to one recipe. Most lightweight recipes
  bind their port immediately, so this only bites heavy AI apps on their first launch.
- **Fix direction:** carry container run-phase startup progress into the UI (build progress already
  streams to the log tab; the _run_ phase does not), or support an optional manifest health-probe /
  readiness path so the UI can distinguish "warming up" from "ready". Deferred — to discuss. See the
  related cache-location constraint in [limitations.md](limitations.md).
