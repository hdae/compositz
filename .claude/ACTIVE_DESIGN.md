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

**Next (sequenced):** the **RI-1..4 ingestion/override arc is complete** (RI-4 = `config.yaml` +
Settings tab, ADR-022). Remaining UI polish: the light/dark/auto **mode selector** (additive). Then
**Phase 3 — Hardening** (shared-cache live exercise, volumes/GC + full data deletion, GPU detection,
versioning).

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
- **ADR-020: trust-gated import + delete reclaims the per-instance image.** Import → non-dismissable
  "install?" dialog (Yes builds / No deletes / fail keeps + retry); delete removes
  `compositz/<id>:<ver>` (no-op for shared `image` recipes). "Open UI" → tabbed panel (build/runtime
  log + Services, the latter joined to the container's live `PublicPort`). Tooltip/Tabs added.
- **ADR-021: GitHub ingestion (RI-3).** Grammar **amended** to `owner/repo[/subdir][@ref]`
  (subdir-before-ref disambiguates slashed refs). Codeload tarball over HTTPS (no `git`/API,
  public-only, `HEAD`=default branch); reuses `ingestBundle` via a new `subdir?` on the archive
  source + a subdir descent in `locateBundleRoot`. One shared `ingestGithub`; CLI `import github:…`;
  UI "From GitHub" modal → existing trust gate (server-confirmed). Complete (core+CLI+UI).
- **ADR-022: per-instance override (RI-4).** Persisted `{ hostPorts, env, placement }`
  (`config.yaml`, strict subset of `LaunchConfig`, **no dataRoot** — deferred to global
  settings.yaml). `up` loads + merges it (`mergeLaunch`) so CLI+UI honor it with no caller wiring.
  UI = a **Settings tab** (4th DetailPanel tab): fetch-on-open `GET /config`, free-port suggest,
  required-env enforced, **delta-only PUT** with manifest-name key validation, server-confirmed,
  applies next start. Complete (core+UI).

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
- **An abort listener registered AFTER an `await` can miss a one-shot abort.** In the streaming
  engine methods (`logs()`, `events()`) the pattern is
  `const conn = await this.#open(); signal?.addEventListener("abort", () => conn.close())`. If the
  signal aborts DURING `#open()`, the (one-shot) `abort` has already fired, so the listener never
  runs and the follow socket leaks. Both methods re-check
  `if (signal?.aborted) { conn.close(); return; }` right after registering. Replicate that guard in
  any new streaming method.
- **`lucide-preact` does NOT tree-shake by default in this build.** The Deno resolver doesn't
  surface its `sideEffects:false` to Rollup, so any barrel import pulls all ~1700 icons (+460 kB
  into the client island), and its `exports` map blocks per-icon deep imports. The fix is a tiny
  Vite plugin in `vite.config.ts` marking only `/lucide-preact/` modules side-effect-free. Add icons
  via `lib/icons.ts` (barrel re-export — fine with the plugin); **don't remove the plugin** or
  import the barrel elsewhere. Re-check the island chunk size on lucide upgrades.
- **GitHub codeload (RI-3, ADR-021), empirically verified:**
  `codeload.github.com/<o>/<r>/tar.gz/<ref>` needs **no token and no GitHub API** for public repos;
  `<ref>=HEAD` ⇒ the default branch; a **slashed ref** resolves as a literal path
  (`…/tar.gz/releases/v1`); a bad repo/ref ⇒ clean **404**. The tarball's single wrapper dir is
  `<repo>-<ref>/` (`/`→`-` in ref) — unnamed-dependent, so `locateBundleRoot` unwraps by structure,
  not name.
- **`deno lint no-control-regex` forbids `\x00-\x1f` literals in a RegExp.** To reject control
  chars/whitespace, test **char codes** (`ch.charCodeAt(0) <= 0x20 || === 0x7f`), not a regex class
  — same idiom as `sanitizeFilename`. Bit both `github.ts` `validateRef` and the import route.

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

**Trust import + tabbed panel (ADR-020) — ✅ DONE.** Import opens a **non-dismissable** trust
("install?") dialog: Yes builds now (log streams to the panel), No deletes the instance entirely; a
build failure keeps it with an Install (retry) button. `views` is now island state (optimistic
add/remove, no reload); `meta.source = upload:<filename>`. Delete reclaims the per-instance image
(`removeInstanceImage`, no-op for `image` recipes; volumes kept). The single "Open UI" button became
a per-row **tabbed panel** (Build log / Runtime log / Services); **Services** lists every `web` port
resolved against the running container's **live** `PublicPort` (`lib/dashboard.ts` join). Runtime
log streams `/api/instances/:id/logs` (SSE). **Tooltip + Tabs** added to the Base-UI set; icon
tooltips wrap the control in a `<span>` so they show while disabled. Multi-lens review (9 findings;
2 med = abort-during-`#open()` socket leak + disabled-trigger tooltip, fixed) folded in. **Follow-up
fixes (user feedback):** Services now lists **from the manifest definition** with a reachability
**badge** (`ready`/`starting…`, no blank window post-start); Tooltip aligned to upstream Shadcn
tokens (`bg-foreground text-background`); the trust `<input accept>` picker → File System Access API
(single combined filter, was tar-only); delete is now **optimistic** (row removed on confirm,
rollback on failure) so a running row's `starting…` panel doesn't linger. NOTE: the user **dislikes
optimistic UI** ([[feedback-avoid-optimistic-ui]]) — accepted for now; prefer server-confirmed for
new actions. 110 tests green.

**RI-3 GitHub ingestion — ✅ DONE (core + CLI + UI; ADR-021).** Spec grammar **amended** to
`owner/repo[/subdir][@ref]` (subdir BEFORE ref, so a slashed branch like `@releases/v1` and a subdir
coexist unambiguously; optional `github:` prefix; `.git` tolerated). New `recipe/github.ts`
(`parseGithubSpec` / `githubTarballUrl` / `githubSource` / `ingestGithub`): `fetch` the codeload
tarball `codeload.github.com/<o>/<r>/tar.gz/<ref|HEAD>` → pipe `res.body` into the existing
`ingestBundle({kind:"archive", stream, subdir})`. `BundleSource` archive gained `subdir?`;
`locateBundleRoot` gained a subdir descent (behavior-preserving when absent). CLI `import github:…`.
`meta.source = github:owner/repo[/subdir][@ref]` (round-trips). No `git`, no GitHub API,
public-only. **UI:** a "From GitHub" action-bar button opens a **dismissable** modal (existing
`AlertDialog` reused as the frame + a native `<input>` — no new Shadcn component) for the spec;
submit → `POST /api/instances/import-github` → `ingestGithub` → the existing **trust gate** opens
with `github:owner/repo` as the provider. **Server-confirmed** (ingest before trust) — no new
optimistic UI ([[feedback-avoid-optimistic-ui]]). The view mapping `toInstanceView` was extracted to
one **server-only** `lib/instance-view.ts` shared by the file-import route, the GitHub route, and
the index render (was duplicated). **Verified:** 17 core unit + 2 opt-in live-codeload tests + 5
`toInstanceView` tests; 133 tests green; ui:check / lint / fmt / **ui:build** (client-bundle guard:
`instance-view.ts` stays server-only) clean. NOTE: runtime UI behavior (modal submit / Enter-to-
submit / trust hand-off) not machine-verifiable here — see manual steps in the report.

**RI-4 per-instance override — ✅ DONE (core + UI; ADR-022).** Persisted override
`{ hostPorts, env,
placement }` (`config.yaml`, strict subset of `LaunchConfig`; **dataRoot
excluded** — deferred global settings.yaml). New `recipe/config.ts` (`OverrideSchema` /
`parseOverride` / `serializeOverride`); `instance.ts` `CONFIG_FILE` + `loadInstanceConfig` /
`saveInstanceConfig`; `run.ts` pure `mergeLaunch`; **`up` loads + merges `config.yaml`** (so CLI+UI
honor it, no caller wiring) — manifest never mutated, derived each launch. **UI:** a **Settings**
tab (4th DetailPanel tab) — fetch-on-open `GET /api/instances/:id/config` (manifest⊕override +
free-port suggest), edit host-port / env (required enforced) / placement(bind|volume `<select>`),
**delta-only `PUT`** (only values ≠ default; route Zod-validates + rejects keys not in the manifest
= 400), **server-confirmed**, applies next start. **Verified:** core unit tests
(parse/serialize/load/save/merge) + real-engine smoke (saved host-port remap is published by `up`) +
route data-path on a real instance; 148 tests green; ui:check / lint / fmt / **ui:build** clean.
NOTE: the Settings **form** runtime (input → PUT → next start) is not machine-verifiable here —
manual steps in the report. **Known limits** (ADR-022): dataRoot not editable; bind = placement only
(derived path); `required` env enforced UI-only (`up` doesn't hard-block yet); no "Save & restart".

**NEXT — UI polish + Phase 3.** Light/dark/auto **mode selector** (writes `compositz-theme`; boot
script already applies it) is the small remaining UI follow-up. Then **Phase 3 — Hardening**:
shared-cache live exercise, **volumes/GC + full data deletion** (needs Engine volume endpoints the
client lacks), GPU detection, versioning.

**Deferred:** **Shadcn components → vendor verbatim from upstream** (`shadcn-ui/ui`
`apps/v4/registry/bases/base/ui/`) instead of the current hand-adapted ones — a migration (dep
`@base-ui-components/react@1.0.0-rc.0` → `@base-ui/react@1.6` + vendor a shadcn v4 style-theme CSS
for the `cn-*` classes + island adjustments). User chose 現状維持 for now; rule + mechanism in
memory [[shadcn-vendor-from-upstream]]. Also: light/dark/auto mode selector (additive over ADR-019);
unused-volume reclaim + full data deletion (needs Engine volume endpoints the client lacks);
large-upload progress/cancel; `installed`-badge SSE staleness — all in
[known-issues.md](../../docs/known-issues.md). **Adjacent (out of scope, flagged):** repo `fmt` has
no `exclude`, so `recipes/hello-web/index.html` fails `deno fmt --check` on `main`
(`<!doctype>`→`<!DOCTYPE>`) — decide exclude `recipes/` vs reformat. Verify Docker via
`DOCKER_HOST=tcp://host.docker.internal:2375` ([[compositz-docker-tcp-debug]] — managed-only +
reversible).
