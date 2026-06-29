# Known issues

Open / being-worked problems. By-design constraints belong in [limitations.md](limitations.md) (when
it exists); settled rationale belongs in [decisions.md](decisions.md).

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

## Deleting an instance leaves its named volumes (no reclaim)

- **What:** the UI Delete now removes the container **and the per-instance built image**
  (`compositz/<instanceId>:<version>`, via `removeInstanceImage`), but still KEEPS the per-instance
  named volumes (`compositz_<instanceId>_*`) and data-root dir — a deliberately safe default (never
  silently destroy user data). `compositz rm` (CLI) does not yet remove the image. There is no
  command to reclaim now-orphaned volumes.
- **Fix direction (future):** a `compositz volumes prune` / "reclaim unused data" action that lists
  volumes whose `<instanceId>` no longer exists and removes them on explicit confirmation. Needs
  Engine **volume** endpoints (`GET/DELETE /volumes`) the `EngineClient` does not implement yet.
  Part of Phase-3 "volumes/GC".

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
