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
