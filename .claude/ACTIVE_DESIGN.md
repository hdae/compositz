# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.

## Current focus

**`packages/ui` Increment 1 — ✅ DONE.** Fresh 2 (Vite) workspace member; `routes/index.tsx`'s
**route handler** calls `@compositz/core` `listRecipes()` + `EngineClient.ps()` in-process and
renders a read-only recipe list (installed / running), with an "engine offline" degrade. View-model
derivation is the pure, Docker-free, unit-tested `lib/dashboard.ts` (6 tests). Verified:
`deno task
ui:build`, `ui:check`, full `test` (36) all green; the server-only boundary was
fault-injected (island import of core fails the build). Engine round-trips were **not**
runtime-verified (no Docker here) — that's the first manual check.

**Next: Increment 2** — actions (install / up / down) wired to `@compositz/core` operations from
route handlers / form posts, then a live-status channel (a Fresh route handler streams SSE from
core's async iterables; an island consumes it via `EventSource`). Desktop embedding is later.
`packages/server` (Hono) stays for now (see below).

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
- **`packages/server` (Hono) retained** as headless `compositz serve`; removal from the UI data path
  deferred — revisit once the UI grows its action/SSE paths (Increment 2).

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
  only build / bundle. Hand off runtime checks as numbered manual steps.

## Resume point

`packages/ui` Increment 1 is committed and green. Next action: **Increment 2** — install / up / down
actions from route handlers, then SSE live status (see Current focus). Open the recipe-list code at
`packages/ui/routes/index.tsx` (I/O + page) and `packages/ui/lib/dashboard.ts` (pure view-model).
First manual check still pending: run the UI against a live Docker engine and confirm installed /
running render correctly (couldn't run here — no Docker).
