# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.

## Current focus

**`packages/ui` Increments 1 & 2 — ✅ DONE.** Fresh 2 (Vite) workspace member. The recipe list is an
island (`islands/RecipeList.tsx`) that renders from a server-side initial snapshot and
**live-updates over SSE** (`routes/api/events.ts`, polls `EngineClient.ps` every 2s), with up/down
via POST (`routes/api/recipes/[id]/[action].ts`). `@compositz/core` is imported only in route
handlers; the island holds the pure `lib/dashboard.ts` (`toRecipeRows` / `toContainerStatuses`) —
type-only on core. Verified: `ui:build`, `ui:check`, full `test` (41) green; server-only boundary
fault-injected (island core import fails the build); runtime-smoked on the offline-degrade path
(index lists hello-web + "engine offline", SSE emits `offline` events) — engine _online_ round-trips
still need manual Docker checks. SSE teardown uses `ReadableStream.cancel()`, not `request.signal`
(deno#29111).

**Increment 2c — ✅ DONE.** Explicit Install button streams the build log:
`POST
/api/recipes/:id/install` emits NDJSON (`{type:"log",line}` …
`{type:"done",tag}`/`{type:"error"}`), the island reads it via a `fetch` stream reader, shows an
auto-scrolling log, and optimistically marks installed on done. POST-stream (not EventSource/GET) so
a reconnect can't re-trigger the build.

**Next (Phase 2 remainder):** **recipe ingestion** is on hold — the user wants to refine the spec
first (load a recipe file in-app → save to a persistent data dir that becomes `recipesDir`). Then
the **desktop shell** (list/launch recipes, embed each web UI). No code on either until
specced/agreed.

## Decisions recently settled

- **ADR-008 (settled): UI framework = Fresh 2 (Vite).** All 3 candidates (Start / Fresh / SvelteKit)
  empirically spiked on Deno 2.9.0; all feasible for in-process `@compositz/core` with a clean
  client boundary; Fresh chosen for Deno-nativeness + cleanest `deno desktop`. See
  `docs/decisions.md`.
- **ADR-011: project-local `bin/deno` (2.9.0, gitignored)** because devbox Deno caps at 2.8.3.
- **ADR-012 (verified): `packages/ui` is a workspace member; root `nodeModulesDir: "auto"`.**
  Fresh's Vite plugin _requires_ membership (errors otherwise), which closed the workspace-name
  resolution residual; `auto` (not the scaffold's `manual`) is needed so the pure-Deno packages keep
  type-checking. One hoisted root `node_modules/` (gitignored).
- **ADR-013: `packages/server` (Hono) retired** — the UI calls core in-process, desktop already did,
  nothing imported the server. Reversible ("一旦"): revive a thin headless `compositz serve` later
  if needed. Live status / build logs now stream from **Fresh route handlers** (Increment 2).

## Pitfalls index

- **Engine calls are server-only.** In Fresh, import `@compositz/core` in route handlers, never in
  islands / client code — `fresh:check-imports` fails the build if `node:net` reaches the client
  (fault-injected and confirmed). Mirror of Start's `*.server.ts` / SvelteKit's `$lib/server` rule.
- **UI runs from `packages/ui` cwd**: `recipesDir` defaults to `../../recipes` (repo-root recipes/);
  the `deno task ui` / `ui:build` wrappers set the cwd. Override with `COMPOSITZ_RECIPES_DIR`.
- **`deno desktop` needs Deno ≥ 2.9** → invoke `/home/developer/workspace/compositz/bin/deno`
  (2.9.0). It is experimental in 2.9.0; the default WebView2 backend is broken on Windows (fix
  #35566 canary-only) — use `--backend cef`.
- **No `docker` in this dev env** → engine round-trips and `deno desktop` _launch_ can't run here,
  only build / bundle. The offline-degrade path _is_ runtime-smokable (built server + curl). Hand
  off the engine-online checks as numbered manual steps.
- **SSE in Fresh: don't tear down off `request.signal`** — Deno's legacy behavior aborts it on a
  _successful response_ (deno#29111), which fires immediately for a streaming body. Drive teardown
  from `ReadableStream.cancel()` (client disconnect) via an `AbortController`. See
  `routes/api/events.ts`.

## Resume point

`packages/ui` Increments 1, 2, 2c are committed and green (recipe list + live SSE status + up/down +
install-with-build-log). Next action: **discuss the recipe-ingestion spec** (file load → persistent
data dir → `recipesDir`) before coding it; desktop embedding after. Key files:
`islands/RecipeList.tsx` (live UI, actions, install-log reader), `routes/api/events.ts` (status
SSE), `routes/api/recipes/[id]/[action].ts` (up/down + install NDJSON stream), `lib/dashboard.ts`
(pure, shared). Manual check still pending against a live Docker engine: install build-log
streaming, up / down / "Open UI", and the button "…"→state transition (only offline paths were
smokable here).
