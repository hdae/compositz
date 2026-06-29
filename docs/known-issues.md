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

- **What:** `compositz rm` / the UI Delete remove the container + the instance definition but KEEP
  the per-instance named volumes (`compositz_<instanceId>_*`) and data-root dir — a deliberately
  safe default (never silently destroy user data). There is no command to reclaim now-orphaned
  volumes.
- **Fix direction (future):** a `compositz volumes prune` / "reclaim unused data" action that lists
  volumes whose `<instanceId>` no longer exists and removes them on explicit confirmation. Needs
  Engine **volume** endpoints (`GET/DELETE /volumes`) the `EngineClient` does not implement yet.
  Part of Phase-3 "volumes/GC".

## Large uploads show no progress / can't be cancelled

- **What:** importing a very large bundle streams to disk and completes, but the UI only shows
  "Importing…" with no progress or cancel for the duration of a long upload+extract.
- **Fix direction (future):** stream upload progress (or a server-sent extraction progress channel)
  and an abort control. Low priority — real recipe bundles are small.
