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

**RT — ✅ DONE & verified.** `EngineClient.events()` streams Docker `GET /events`; `/api/events` is
event-driven (push per container lifecycle change) with a 15 s safety refresh + 2 s
reconnect/offline fallback. The 2 s poll is gone. **Verified against the real engine**
(DOCKER_HOST=tcp): a down→up cycle streamed `running→exited→[]→created→running` live. Increments
1/2/2c online paths (engine-online list, install build-log NDJSON, up/down POST) also verified the
same way.

**RI-1 — ✅ DONE & verified.** Manifest **v2** in core (breaking; unreleased) — Zod schema, storage
layer, bind/volume mounts, cache provisioning + env injection, effective-spec derivation (manifest ⊕
launch override). Full spec in [docs/recipe-format.md](../../docs/recipe-format.md) /
[docs/recipe-ingestion.md](../../docs/recipe-ingestion.md) /
[ADR-014](../../docs/decisions.md)+[ADR-015](../../docs/decisions.md). Mounts use structured
`HostConfig.Mounts` with `BindOptions.CreateMountpoint` (daemon creates the bind source — a `Mounts`
bind does NOT auto-create it, unlike legacy `Binds`). Managed cache root `/compositz`
(`venv`→`compositz_uv` injects `VIRTUAL_ENV`+`UV_CACHE_DIR`; `huggingface`→`compositz_hf` injects
`HF_HOME`; `custom`→`compositz_cache_<name>`). Names charset-constrained (no path traversal).
Consumers (cli/ui/desktop) needed only a 1-line change each: `up()` now returns the resolved
`hostPorts` (after conflict bumping) and callers pass them to `webUrl(m, { hostPorts })` so an
auto-bumped port shows the right URL. `webUrl` = first web port; `recipeImageTag`/`installRecipe`
unchanged. **Live-verified** on engine 29.5.3 (hello-web up/down with the v2 spec; a bind+volume
create accepted via CreateMountpoint).

**Desktop = the Fresh UI packaged by `deno desktop` (ADR-016).** There is **no `packages/desktop`**
— `deno desktop` auto-detects the Fresh project (`packages/ui`) and embeds its built `_fresh/` into
one native CEF binary; recipe ops happen in that UI (core in-process, ADR-013). Tasks live in
`packages/ui` (run from there so detection fires); **both build `_fresh/` first** (else detection
falls to generic "Vite", not Fresh): `deno task desktop:dev` (HMR — Fresh's Vite dev server +
webview) and `deno task desktop` (→ `dist/compositz/` bundle **directory**). The earlier
hand-written `Deno.BrowserWindow` launcher (and the subprocess-spawn variant) were wrong: a packaged
bundle has no `deno task`/source tree. Verified on Linux; the live window + signed per-OS installers
(`.msi`/`.AppImage`) are manual/Phase-4.

**Next (sequenced):** **RI-2…RI-4** (recipe ingestion + override UI). RI-2/3 = tar/zip + GitHub
sourcing into the app-data recipe store; RI-4 = per-install override UI + multi-web "Open UI"
buttons (the schema already supports multiple `web: true`).

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
- **`deno desktop` gotchas (see ADR-016):** (1) `_fresh/` MUST exist before running — without it
  detection picks generic **Vite** (via `vite.config.ts`), not Fresh, and fails; so the tasks
  `build` first (even `--hmr`). (2) Flags MUST precede any positional entrypoint —
  `deno desktop . --backend
  cef …` swallows the flags as _script args_ and builds a
  default-WebView2 bundle into `packages/ui/ui/`; omit the entrypoint (cwd auto-detect), flags only.
  (3) `--output` extension is OS-specific: a platform ext (`.msi`/`.AppImage`/`.dmg`) → installer,
  no ext → portable bundle **directory** (`dist/compositz/`). The `desktop` task uses the directory
  (uniform cross-OS).
- **Docker IS reachable over TCP** (no CLI/socket here):
  `export
  DOCKER_HOST=tcp://host.docker.internal:2375` (the user exposed the daemon;
  `localhost:2375` does NOT work from WSL, `host.docker.internal` does). Real
  `up`/`down`/`install`/`/events` were verified this way. Only `deno desktop` _launch_ still can't
  run here. See [[compositz-docker-tcp-debug]] in memory.
- **SSE in Fresh: don't tear down off `request.signal`** — Deno's legacy behavior aborts it on a
  _successful response_ (deno#29111), which fires immediately for a streaming body. Drive teardown
  from `ReadableStream.cancel()` (client disconnect) via an `AbortController`. See
  `routes/api/events.ts`.
- **`HostConfig.Mounts` bind ≠ legacy `Binds`** — a `Mounts` `Type:"bind"` does NOT auto-create a
  missing host source; the daemon returns `400 bind source path does not exist`. Set
  `BindOptions.CreateMountpoint:true` so the **daemon** creates it (the source is on the daemon
  host, unreachable from core over a remote `DOCKER_HOST`). See `run.ts` / ADR-015.

## Resume point

UI Increments 1/2/2c + RT + **RI-1 (manifest v2 in core)** are committed, green (full suite), and
live-verified. Next action: **RI-2** — the recipe **store** + **tar/zip ingestion** (UI upload →
extract via `@std/tar` → Zod-validate → store under the app-data recipe store). `appDataDir()` /
`bindHostPath()` / `defaultDataRoot()` already exist in `packages/core/src/storage.ts`; `recipesDir`
(today repo-root `recipes/`, env-overridable) becomes the app-data store. Then RI-3 (GitHub
sourcing) and RI-4 (override UI + multi-web buttons). Verify Docker paths with
`DOCKER_HOST=tcp://host.docker.internal:2375` (see [[compositz-docker-tcp-debug]] — keep actions
managed-only + reversible).
