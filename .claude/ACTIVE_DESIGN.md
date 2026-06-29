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

**Instance-centric storage (ADR-017) + RI-2 — ✅ DONE, hardened & verified.** Reframes ADR-014: **no
recipe store, no app→instances hierarchy.** The runtime unit is a self-contained **instance** keyed
by one `instanceId` (`<appId>-<rand>`); a recipe is just the bundle copied inside it
(`<app-data>/instances/<instanceId>/app/`). Every resource keys off `instanceId` (container
`compositz-<instanceId>`, volume `compositz_<instanceId>_<name>`, bind
`<data-root>/<instanceId>/<name>`, venv `venvs/<instanceId>`, **per-instance image**
`compositz/<instanceId>`). RI-1's `DEFAULT_INSTANCE="default"` + `<id>/<instance>` nesting are
removed. Second copy = re-import or `duplicate` (copies `app/` only, not data). Ingestion is
security- and memory-hardened (see Resume point). Layout:
[recipe-ingestion.md](../../docs/recipe-ingestion.md#storage--instance-centric).

**Next (sequenced):** **RI-3** (GitHub sourcing → `ingestBundle`) → **RI-4** (per-instance override
UI + multi-web "Open UI" buttons).

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
- **ADR-017: instance-centric storage** — no recipe store; the instance owns everything keyed by one
  `instanceId`. (RI-2; see resume point.)
- **ADR-018: UI components = Shadcn + Base UI via `preact/compat`** — Base UI (not Radix) survives
  the compat layer; spike-verified. Style via `className`, buttons `forwardRef`.
- **ADR-019: dark mode = class-based + no-flash boot script, default Auto.** Shadcn semantic tokens
  (`:root`/`.dark`/`@theme inline`/`@custom-variant dark`); `_app.tsx` `<head>` script toggles
  `.dark` from `prefers-color-scheme`. Selector deferred but additive (chosen over pure `@media` so
  it needs no rebuild). Chromatic status colors keep `dark:` variants.

## Pitfalls index

- **Engine calls are server-only.** In Fresh, import `@compositz/core` in route handlers, never in
  islands / client code — `fresh:check-imports` fails the build if `node:net` reaches the client
  (fault-injected and confirmed). Mirror of Start's `*.server.ts` / SvelteKit's `$lib/server` rule.
- **Instance store is in app-data** (ADR-017): `instancesDir()` = `COMPOSITZ_INSTANCES_DIR` ??
  `appDataDir()/instances` (absolute — no longer cwd-relative). The shipped `recipes/` dir is now
  only a **sample bundle to import** (`compositz import recipes/hello-web`), not the live store. No
  auto-seed.
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
- **`lucide-preact` does NOT tree-shake by default in this build.** The Deno resolver doesn't
  surface its `sideEffects:false` to Rollup, so any barrel import pulls all ~1700 icons (+460 kB
  into the client island), and its `exports` map blocks per-icon deep imports. The fix is a tiny
  Vite plugin in `vite.config.ts` marking only `/lucide-preact/` modules side-effect-free. Add icons
  via `lib/icons.ts` (barrel re-export — fine with the plugin); **don't remove the plugin** or
  import the barrel elsewhere. Re-check the island chunk size on lucide upgrades.

## Resume point

**RI-2 (instance-centric store + ingestion) — ✅ DONE & verified.** core (`storage.instancesDir` +
`recipe/instance.ts` + `recipe/ingest.ts` + `duplicate`) + instanceId-threaded naming
(`brand`/`run`/`operations`); CLI (`import`/`ls`/`duplicate`/`rm <id...>` + adapted
`up`/`down`/`install`/`ps`). The shipped `recipes/hello-web` is now a **sample to
`compositz import`**.

**Ingestion is STREAMING, no size caps (DECIDED, threat-model).** The earlier gzip-bomb/cap
machinery (byteLimiter, MAX_*, single-in-flight) was **removed** — the manager is trusted and
recipes are the user's (ADR-003), so resource-exhaustion is out of scope.
`extractArchiveTo(ReadableStream)` streams the upload straight to disk (any size, no RAM blow-up;
fixed the 14 GB "Importing…" hang). **Kept:** secure extraction (reject
absolute/`..`/symlink/hardlink/device) + atomic `.pub-`-dir publish.

**Phase-3 UI — ✅ DONE.** Full-window drag-drop import (dragover + watchdog, robust to ESC-cancel),
a header **Import** button, per-row **Delete** (Base UI AlertDialog confirm →
`POST
/api/instances/:id/delete`, data volumes kept). **UI library = Shadcn + Base UI via
`preact/compat` (ADR-018)** — spike + manual click-test confirmed; foundation `lib/utils.ts`(`cn`),
`components/ui/{button(forwardRef),alert-dialog(className),card}`, vite/deno `react→preact/compat`
aliases. 108 tests green; `delete` live-verified on a real Fresh server.

**UI tidy (cards + Lucide icon buttons) — ✅ DONE.** Each row is a Shadcn `Card`; actions are
**Lucide icon buttons** (`lucide-preact`, via `lib/icons.ts`): Open UI=ExternalLink, Start=Play,
Stop=Square, Install=Download, Delete=Trash2, busy=LoaderCircle, Import=Upload+text — all with
`aria-label`+`title`. The visible page title was removed (app name shows in the window bar); an
`sr-only` `<h1>` + `<main>` landmark stay for AT. Multi-lens adversarial review (10 findings, all
low) folded in. See the lucide tree-shake pitfall below.

**Dark mode (theming) — ✅ DONE (ADR-019).** Shadcn neutral semantic tokens (oklch) in `styles.css`
(`:root` light / `.dark` dark / `@theme inline` + `@custom-variant dark`); chrome migrated to
tokens, chromatic status colors (green/amber/blue/`destructive`) kept with `dark:` variants, install
log intentionally always-dark. **Default = Auto** via a no-flash `<head>` boot script in `_app.tsx`
(`matchMedia` → `.dark`, live OS-change tracking, already honors a stored `compositz-theme`). The
light/dark/auto **mode selector is deferred** and now **purely additive** (UI + `localStorage`, no
CSS restructure). `react-no-danger` is disabled file-wide in `_app.tsx` (sole static-literal boot
script). 104 tests green; ui:build/ui:check/lint clean.

**NEXT — RI-3** (GitHub ingestion: `owner/repo[@ref][/subdir]` → codeload `.tar.gz` over HTTPS →
`ingestBundle`; no `git` binary) → **RI-4** (per-instance override UI + multi-web "Open UI"
buttons). Small deferred UI follow-up: the light/dark/auto **mode selector** (writes
`compositz-theme`, the boot script already applies it).

**Deferred:** light/dark/auto mode selector (additive over ADR-019); unused-volume reclaim + full
data deletion (needs Engine volume endpoints the client lacks); large-upload progress/cancel;
`installed`-badge SSE staleness — all in [known-issues.md](../../docs/known-issues.md). **Adjacent
(out of scope, flagged):** repo `fmt` has no `exclude`, so `recipes/hello-web/index.html` fails
`deno fmt --check` on `main` (`<!doctype>`→`<!DOCTYPE>`) — decide exclude `recipes/` vs reformat.
Verify Docker via `DOCKER_HOST=tcp://host.docker.internal:2375` ([[compositz-docker-tcp-debug]] —
managed-only + reversible).
