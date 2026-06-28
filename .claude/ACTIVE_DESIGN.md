# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.

## Current focus

**Build `packages/ui` — Increment 1.** Fresh 2 (Vite) as a new workspace member. First feature is
read-only: a Fresh **route handler** calls `@compositz/core` `listRecipes()` + `EngineClient.ps()`
in-process and renders a recipe list (installed / running) on `routes/index.tsx`. up/down, SSE live
status, and desktop embedding are later increments (explicitly out of scope for Increment 1).

Planned steps: scaffold `deno run -Ar jsr:@fresh/init . --tailwind` into `packages/ui/` → add
`./packages/ui` to the root `deno.json` workspace array + `ui` / `ui:build` tasks → import
`@compositz/core` by workspace name → recipe-list route → `deno task check` + build green. Keep
`packages/server` (Hono).

## Decisions recently settled

- **ADR-008 (settled): UI framework = Fresh 2 (Vite).** All 3 candidates (Start / Fresh / SvelteKit)
  empirically spiked on Deno 2.9.0; all feasible for in-process `@compositz/core` with a clean client
  boundary; Fresh chosen for Deno-nativeness + cleanest `deno desktop`. See `docs/decisions.md`.
- **ADR-011: project-local `bin/deno` (2.9.0, gitignored)** because devbox Deno caps at 2.8.3.
- **`packages/server` (Hono) retained** as headless `compositz serve`; removal from the UI data path
  deferred — revisit once `packages/ui` is real.

## Pitfalls index

- **Engine calls are server-only.** In Fresh, import `@compositz/core` in route handlers, never in
  islands / client code — `fresh:check-imports` fails the build if `node:net` reaches the client
  (verified). Mirror of Start's `*.server.ts` / SvelteKit's `$lib/server` rule.
- **Residual to confirm**: workspace-name resolution of `@compositz/core` in Fresh Vite SSR (spikes
  used a file-path import-map entry). Confirm on the first `packages/ui` build.
- **`deno desktop` needs Deno ≥ 2.9** → invoke `/home/developer/workspace/compositz/bin/deno`
  (2.9.0). It is experimental in 2.9.0; the default WebView2 backend is broken on Windows (fix
  #35566 canary-only) — use `--backend cef`.
- **No `docker` in this dev env** → engine round-trips and `deno desktop` *launch* can't run here,
  only build / bundle. Hand off runtime checks as numbered manual steps.

## Resume point (post-compact)

Decision made: **Fresh 2 (Vite)** for `packages/ui`. Next action: scaffold `packages/ui` per the
Increment 1 plan above and wire it into the root workspace. Throwaway spikes live in the session
scratchpad; the 3-way comparison is in memory (`compositz-ui-framework-spikes`).
