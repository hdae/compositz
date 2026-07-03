# Decision log

ADR-style. Each entry: status, the decision, why, and consequences. Newest concerns last.

---

## ADR-001 — One container per app; no Compose · ✅ Accepted

Each app is a single container. Multiple daemons inside one app use **s6-overlay v3**, not Docker
Compose.

**Why:** WSL-Containers / Podman compose support is unreliable; a single container is the portable
unit. s6-overlay gives real PID1, zombie reaping, and service dependencies.

**Consequences:** recipes describe one container. Multi-process apps ship an s6 service tree.

---

## ADR-002 — Hand-rolled Engine API client over a transport abstraction · ✅ Accepted (verified)

A minimal Docker Engine HTTP client on a `DuplexConn` seam: unix socket (Linux), `node:net` named
pipe (Windows), TCP fallback. Not `dockerode`.

**Why:** Windows named pipes aren't supported by `Deno.connect` but are by `node:net` (Deno ≥
2.6.2). A thin client keeps the dependency surface small and the transport swappable (future WSL
Containers / Podman). Target Engine API ≥ 1.43.

**Consequences:** we own HTTP framing (chunked / length / close), the 8-byte log demux, and the
classic build-stream parser. All verified against a live engine.

---

## ADR-003 — The manager is trusted; isolation is at the container boundary · ✅ Accepted

The CLI / UI / desktop run with broad permissions (`-A`). Security is enforced by putting _apps_ in
containers, not by sandboxing the manager.

**Why:** the manager legitimately needs Docker, filesystem, and network access. On Windows the npipe
transport in fact requires `--allow-all`. Pinokio's problem is uncontainerized _apps_, not manager
privilege.

**Consequences:** acceptable to run `-A`. Document it; don't pretend the manager is sandboxed.

---

## ADR-004 — GPU default-on, tri-state · ✅ Accepted

`gpu: required | preferred | none` in the manifest; default `preferred`. `preferred` tries a GPU and
falls back to CPU.

**Why:** local-AI apps usually want a GPU; opt-out is the right default. Tri-state covers the "nice
to have" middle.

**Consequences:** `--gpus all` shape is `{Driver:"", Count:-1, Capabilities:[["gpu"]]}`. CDI variant
available for Linux. nvidia-vs-CDI auto-detection is Phase 3.

---

## ADR-005 — Manifest = YAML authored, **Zod** validated (single source) · ✅ Accepted

`compositz.yaml` is authored in YAML and validated by a Zod schema that is the single source of
truth for the runtime validator, the inferred TS types, and the generated JSON Schema
(`z.toJSONSchema` → `spec/compositz.schema.json` via `deno task schema`).

**Why:** the user's prior approach (hand-written validator + separately-maintained JSON Schema)
meant two-source drift. Zod 4's `toJSONSchema` collapses them. Strict objects reject unknown keys
(catches typos in LLM-authored manifests). Zod bundles cleanly into `deno desktop`.

**Consequences:** `npm:zod` is a dependency. Manifest is versioned (`manifestVersion`).

---

## ADR-006 — uv runtime model: hardlink + co-located cache/venv + startup sync · ✅ Accepted

Resolve Python deps at container startup (`uv sync --frozen`), `UV_LINK_MODE=hardlink`, uv cache and
per-app venvs co-located on one persistent volume.

**Why (verified):** Astral discourages symlink mode (`uv cache clean` breaks installs). Hardlink +
co-location dedups wheels across apps and survives cache cleaning via inode refcounts. Plain
`uv sync` does not repair dangling links, so symlink self-heal is a myth; hardlink avoids the
problem. See the `compositz-uv-model` design note.

**Consequences:** Compositz provides `repair` / `rebuild` / `gc --reclaim` wrappers (uv has no
venv-aware GC or verify command).

---

## ADR-007 — Desktop = Deno Desktop; CEF backend for now · ✅ Accepted (interim)

The desktop app is Deno Desktop. We build with the **CEF backend** today, not the default system
WebView2.

**Why (verified):** the default WebView2/laufey backend crashes on window creation (`0xC0000409`) —
a laufey 0.4.0 ↔ WebView2 149 skew, fixed upstream in
[denoland/deno#35566](https://github.com/denoland/deno/pull/35566) — merged 2026-06-27 but **not in
the released 2.9.0**; no 2.9.1/2.9.2 exists yet (canary-only as of 2026-06-28), so the earlier
"expected 2.9.1/2.9.2" is an unconfirmed guess. This does not affect us: `--backend cef` bundles its
own Chromium (~440 MB), bypasses WebView2 entirely, and renders the container UI on **stable 2.9.0**
(machine-verified). Core's npipe transport works inside the desktop runtime (and `node:net`
named-pipe connect is confirmed implemented since 2.6.2 — deno#28332 closed 2025-12-19); build-time
`-A` is baked in.

**Consequences:** ship CEF for now; **revisit the lightweight WebView2 backend** once the fix lands
(Phase 4). `deno task desktop` / `desktop:dev` build with CEF
([ADR-016](#adr-016--desktop-app--the-fresh-ui-packaged-by-deno-desktop-framework-detection--accepted-verified));
re-test the WebView2 backend by swapping `--backend webview` on those tasks.

---

## ADR-008 — UI framework: Fresh 2 (Vite) · ✅ Accepted

`packages/ui` is built with **Fresh 2 on the Vite path** (`@fresh/plugin-vite`, Fresh's default;
`--builder` is the non-Vite opt-out).

**Why:** all three candidates (TanStack Start, Fresh, SvelteKit) were empirically spiked on Deno
2.9.0 (isolated scratch dirs, project-local `bin/deno`). The decisive criterion — a server route
handler imports the real `@compositz/core` (→ `node:net` / `Deno.connect` / jsr `@std/*`), bundles
**server-only**, the client stays clean, and `deno desktop` packages it — **passed for all three**,
so the choice turned on Deno-nativeness vs ecosystem familiarity, not raw feasibility. Fresh won on:

- **Least toolchain friction**: `@fresh/plugin-vite` resolves the jsr / import-map deps natively —
  no `@deno/vite-plugin` bridge that both Start and SvelteKit required.
- **Cleanest `deno desktop`**: detected out of the box and consumes `_fresh/` directly with no
  output-path shim (Start needs a `.output/server/index.mjs` re-export; SvelteKit needs a
  `svelte.config.js` to be detected at all), and the lightest bundle (73 MB vs 228 / 107 MB
  node_modules).
- **Deno alignment**: Fresh is Deno's own framework (powers deno.com), the best odds of tracking
  future `deno desktop` / Deno changes. The islands model makes the server/client boundary
  structural, and `fresh:check-imports` **fails the build** when `node:*` reaches client code
  (verified by fault injection — the mirror of Start's Import Protection and SvelteKit's
  `$lib/server`).
- The user is Preact-experienced; Vite is Fresh 2's default/recommended path.

**Consequences:**

- `packages/ui` = Fresh 2 (Vite), a workspace member. Engine calls live in **route handlers**
  (server-only) and **never** in islands / client code. `@compositz/core` is imported by its
  workspace name.
- `packages/server` (Hono) was retained here as a standalone headless API, then **retired** once the
  UI proved in-process core calls — see
  [ADR-013](#adr-013--retire-packagesserver-hono-the-ui-calls-core-in-process--accepted-reversible).
- `deno desktop` is **experimental** in Deno 2.9.0 — pin the toolchain and re-verify on upgrades.
- The spike-era residual (workspace-name resolution of `@compositz/core` in Fresh's Vite SSR) is now
  **resolved** — confirmed on the first real `packages/ui` build. Workspace integration specifics
  (mandatory membership, root `nodeModulesDir: "auto"`) are recorded in
  [ADR-012](#adr-012--packagesui-joins-the-deno-workspace-root-nodemodulesdir-auto--accepted-verified).
- `deno desktop` needs Deno ≥ 2.9; the devbox Deno here caps at 2.8.3, so a project-local `bin/deno`
  is used — see [ADR-011](#adr-011--project-local-deno-29-binary-bindeno--accepted).

---

## ADR-009 — Classic builder via `POST /build` · ✅ Accepted (verified)

Build images with the plain Engine API `POST /build` (classic builder), parsing the `{stream}` /
`{aux.ID}` stream.

**Why (verified):** plain `POST /build` returns the classic stream even with `DOCKER_BUILDKIT`
default — confirmed on the dev machine. Simpler than wiring a BuildKit session. Optional BuildKit is
a Phase 3 nicety.

---

## ADR-010 — Centralize the (tentative) name · ✅ Accepted

`compositz` is a working title. Project name, manifest filename, label namespace, and image
namespace live only in `packages/core/src/brand.ts`.

**Why:** the name will likely change; a rename must be a one-file edit, not a repo-wide grep.

---

## ADR-011 — Project-local Deno 2.9 binary (`bin/deno`) · ✅ Accepted

`deno desktop` is a Deno 2.9 feature, but this dev box's devbox-global Deno caps at **2.8.3**. We
keep an official Deno **2.9.0** linux-x64 binary at `bin/deno` (SHA256-verified, **gitignored**) and
invoke it by absolute path for any 2.9 feature (`deno desktop`, the `packages/ui` build). The PATH
Deno (2.8.3) stays fine for everything else.

**Why:** unblock the desktop / UI work locally without waiting on devbox to ship ≥ 2.9.

**Consequences:** temporary — once the environment provides Deno ≥ 2.9, drop `bin/deno` and its
`.gitignore` entry. CI must pin Deno ≥ 2.9 independently.

---

## ADR-012 — `packages/ui` joins the Deno workspace; root `nodeModulesDir: "auto"` · ✅ Accepted (verified)

The Fresh 2 (Vite) UI is a **member of the root Deno workspace**, and the workspace root sets
`"nodeModulesDir": "auto"`.

**Why (verified on first real build, overturning the spike-era residual):**

- **Membership is mandatory, not optional.** Fresh's Vite plugin (`@deno/loader`) walks up to the
  repo-root `deno.json`, and if the project isn't listed in its `workspace` array it hard-errors
  (`Config file must be a member of the workspace`). The scratch spikes never hit this (no parent
  workspace), which is why they mapped `@compositz/core` by file path. As a real member, the import
  resolves by **workspace name** in Fresh Vite SSR with no import-map entry — the prior "confirm
  workspace-name resolution" residual is **closed**.
- **`nodeModulesDir` is a workspace-root-only setting**, so the Vite member's need for a real local
  `node_modules` forces the choice on every member. `"auto"` (not the scaffold's `"manual"`) is
  required: `"manual"` makes the pure-Deno packages fail typecheck on transitive type deps they
  never list (e.g. `npm:@types/node`); `"auto"` lets Deno materialize the shared root `node_modules`
  for all members. Both the UI build and `deno check` of core/cli/server/desktop pass under
  `"auto"`.

**Consequences:** one hoisted `node_modules/` at the repo root (gitignored); `deno install` (or any
`deno` run under `auto`) populates it. The server-only boundary is enforced by Fresh's
`fresh:check-imports` — importing `@compositz/core` (→ `node:net`) from an **island** fails the
build (fault-injected and confirmed). Engine code therefore lives only in route handlers, never
islands. See [roadmap.md Phase 2](roadmap.md#phase-2--management-ui-).

---

## ADR-013 — Retire `packages/server` (Hono); the UI calls core in-process · ✅ Accepted (reversible)

The Hono backend (`packages/server`, the `/api` + SSE layer) is **removed**. The management UI talks
to `@compositz/core` **directly from Fresh route handlers** (the engine-online proof from ADR-008 /
ADR-012); the desktop shell already called core directly. No process speaks to the engine over an
internal HTTP hop anymore.

**Why:** with in-process core calls working in Fresh, the Hono API was a redundant indirection — a
second data path to keep in sync with core, for no consumer that needed it (grep confirmed nothing
imported `@compositz/server`; CLI and desktop use core directly). Deleting it removes the
`@hono/hono` dependency and a whole package's worth of drift surface. Live status / build-log
streaming move to **Fresh route handlers that stream SSE** (Phase 2 / Increment 2), reusing core's
async iterables — the SSE _contract_ survives, only its host changes from Hono to Fresh.

**Consequences:** no standalone headless API or `deno task serve` for now. **Reversible** (this is a
"一旦" decision): a future headless `compositz serve` can re-add a thin server over the same core —
the deleted code lives in git history (last present at the commit before this ADR). The
cross-cutting "keep the `/api` contract stable" note now applies to the Fresh SSE endpoints.

---

## ADR-014 — Recipe sourcing, 3-tier storage & manifest v2 · ✅ Accepted

How recipes are ingested, where data lives, and how launches are customized. Full spec:
[recipe-ingestion.md](recipe-ingestion.md).

> Supersedes this ADR's first draft, which framed the config as "borrow Docker **Compose**
> vocabulary, no settings schema". A later design round moved to a Compositz manifest where every
> field still maps to a Docker concept but carries **light author metadata**
> (`name`/`description`/`required`) for the install UI — recorded below.

**Decisions (from a design round with the user):**

- **Every manifest field maps to a Docker concept.** `image`/`build` → image, `ports` → published
  ports, `mounts` → binds/volumes, `env` → environment, `gpu` → device requests — plus only **light
  author metadata** (`name`/`description`/`required`) so the install UI can explain and collect
  settings. NOT a separate settings DSL and NOT verbatim Compose. The runtime stays
  **single-container** ([ADR-001](#adr-001--one-container-per-app-no-compose--accepted) holds — no
  `docker compose`).
- **Manifest v2** (breaking; unreleased → no migration), shape in
  [recipe-ingestion.md](recipe-ingestion.md#manifest-v2-target-spec--implemented-in-ri-1): `build`
  **XOR** `image`; `ports[]` with `name` + `web` (default false, **multiple allowed** → one "Open
  UI" button each) + host port **auto-assigned on conflict**; `mounts[]` with `name` + `placement`
  (`bind`|`volume`, **default volume** — bind is slow on Windows); `cache[]` opt-in presets (`venv`
  = per-instance uv venv + co-located uv cache on **one** volume for hardlink dedup; `huggingface`)
  - a `custom` form, paths **env-injected** (not author-set), venv subpath fixed; `env[]` objects
    with `required` + `default` (they coexist).
- **Three storage tiers:** app-data (recipe store + per-install overrides + settings); a
  configurable **data-root** (default `~/Compositz`) for **bind** mounts (host-visible outputs);
  **named volumes** for everything else (`compositz_<id>_<name>` per-mount + Compositz-managed
  shared caches). bind host paths are **derived from the mount `name`** (`<data-root>/<id>/<name>`)
  — no author-written `${}`; cache paths are **env-injected**.
- **Ingestion sources:** a **tar/zip bundle** (upload) and **GitHub** (`owner/repo[@ref][/subdir]`
  via codeload tarball — no `git` binary, reuse `@std/tar`). Ingest = extract + Zod-validate +
  store; build stays the separate Install step. (The GitHub spec grammar was later amended to
  **`owner/repo[/subdir][@ref]`** — subdir before ref — to disambiguate slashed branch names; see
  [ADR-021](#adr-021--github-ingestion-ri-3--spec-grammar--codeload-over-https--accepted).)
- **Launch customization** is a per-install **override of values** (`<app-data>/config/<id>.yaml`):
  host-port remaps, env values, per-mount placement/host-path, data-root. Merged over manifest
  defaults at `up` → effective spec **derived each launch**, never written back.
- **Real-time status (done):** `EngineClient.events()` streams Docker `GET /events`; the Fresh SSE
  handler is event-driven. Verified against the real engine.

**Why:** the user's outputs must land on the host where they're reachable (v1's named-volume-only
persistence — [run.ts](../packages/core/src/recipe/run.ts) — hides them); and keeping every field a
direct Docker concept makes the tool a thin, learnable layer over Docker rather than a new DSL.

**Consequences:** `manifest.ts` (Zod) + recipe-format + the example recipe all move to v2 in RI-1;
`recipesDir` becomes the app-data recipe store (env-overridable as today). Sequenced as **RT(done) →
RI-1…RI-4** in [recipe-ingestion.md](recipe-ingestion.md#increment-plan). Deferred: private-repo
GitHub auth, multi-instance UI (schema is already instance-ready), a reference uv entrypoint helper,
Windows bind-path handling.

## ADR-015 — Manifest v2 core: structured Mounts + CreateMountpoint, managed cache layout · ✅ Accepted (verified)

The implementation decisions settled while building RI-1 (the "Open details" ADR-014 deferred).
Code: [manifest.ts](../packages/core/src/recipe/manifest.ts),
[run.ts](../packages/core/src/recipe/run.ts), [storage.ts](../packages/core/src/storage.ts).

- **Mounts, not legacy `Binds`.** Every mount/cache goes through `HostConfig.Mounts`
  (`Type: bind|volume`, `Source`, `Target`), which is unambiguous on Windows (a `C:\…` bind source
  has a colon that breaks `Binds` splitting) and expresses bind vs named-volume uniformly.
- **Bind mounts set `BindOptions.CreateMountpoint: true`.** DECIDED after a live 400 from the
  daemon: unlike `Binds`, a `Mounts` bind does **not** auto-create a missing host source.
  CreateMountpoint (API 1.44+) makes the **daemon** create `<data-root>/<id>/<name>` — required
  because the source is on the daemon host, which a remote `DOCKER_HOST` cannot reach from the core
  process. Verified against engine 29.5.3 / API 1.54.
- **Managed cache layout (the in-container authoring contract):** root `/compositz`. `venv` → volume
  `compositz_uv` at `/compositz/uv` injecting `UV_CACHE_DIR=/compositz/uv/cache` +
  `VIRTUAL_ENV=/compositz/uv/venvs/<id>/<instance>` (venv + uv cache on one volume ⇒ hardlink-safe,
  [ADR-006](#adr-006--uv-venv-hardlink-constraint--accepted)); `huggingface` → `compositz_hf` at
  `/compositz/hf` injecting `HF_HOME`; `custom` → `compositz_cache_<name>` at
  `/compositz/cache/<name>` injecting `<env>` (shared = that path; instance = a `<id>/<instance>`
  subpath).
- **Managed env wins deterministically.** Env is assembled in a `Map` keyed by name (user values
  first, then cache vars, then `COMPOSITZ_INSTANCE`), so a managed var overrides a colliding user
  var regardless of Docker's undefined duplicate-key precedence.
- **Names are charset-constrained** (`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`; env names are POSIX). Mount
  and cache names flow into host paths and volume names, so this blocks path traversal out of the
  data-root and keeps volume names valid. Mount `target` must be absolute.
- **Host-port auto-increment** is a pure helper (`resolveHostPorts`) fed by the host ports already
  published by running containers (read via `ps` in `up`, after removing the prior instance).
  Best-effort (it can't see non-Docker listeners; small TOCTOU before create).

**Consequences:** `EngineClient.Mount` gains `BindOptions`; consumers (cli/ui/desktop) were
unchanged because the breaking surface is the manifest YAML + internal derivation, while `webUrl` /
`up` / `recipeImageTag` / `installRecipe` kept compatible signatures (`webUrl` = the first web
port). Still open for later increments: live HF/venv cache exercise (no shipped recipe uses them
yet), Docker Desktop Windows file-sharing for bind sources, and the reference uv entrypoint helper.

## ADR-016 — Desktop app = the Fresh UI packaged by `deno desktop` (framework detection) · ✅ Accepted (verified)

The desktop window shows the **Compositz management UI**, which **is** the Fresh app
(`packages/ui`). `deno desktop` auto-detects the Fresh project and embeds its built `_fresh/` into
one native binary — there is **no separate desktop entrypoint**. Refines
[ADR-007](#adr-007--desktop--deno-desktop-cef-backend-for-now--accepted-interim) (CEF backend) and
realizes the [ADR-008](#adr-008--ui-framework-fresh-2-vite--accepted) "cleanest `deno desktop`:
consumes `_fresh/` directly" criterion.

- **`packages/desktop` deleted.** The Phase-0 PoC was a hand-written `Deno.BrowserWindow` launcher
  that `up`'d one recipe and navigated to its web UI. That model is wrong for the management UI: a
  compiled `deno desktop` bundle has no source tree / `deno task`, so a launcher that _spawns_ the
  UI server cannot work once packaged. Recipe install/up/down now happen **inside** the Fresh UI
  (core in-process —
  [ADR-013](#adr-013--retire-packagesserver-hono-the-ui-calls-core-in-process--accepted-reversible)).
- **Tasks live in `packages/ui`** (so `deno desktop` runs with that cwd) and **both build `_fresh/`
  first**: `desktop` = `build` then `deno desktop --output …`; `desktop:dev` = `build` then
  `deno desktop --hmr …` (runs Fresh's Vite dev server, the webview connects live). Root delegates.
- **PITFALL — `_fresh/` MUST exist before `deno desktop`, even for `--hmr`.** Detection picks the
  **first** matching framework: with `_fresh/` present it detects **Fresh**; without it,
  `vite.config.ts` makes it detect the generic **Vite** SSR framework (wrong) and the build then
  fails. `deno desktop` does NOT run the framework build, so the tasks `build` first. (This is why
  `desktop:dev` "didn't work" until a build had run.)
- **PITFALL — options MUST precede any positional entrypoint.**
  `deno desktop . --backend cef
  --output X` silently swallows `--backend`/`--output` as _script
  args_ (everything after `.` is `SCRIPT_ARG`), so it built a default-WebView2 bundle into
  `packages/ui/ui/`. Fix: **omit the entrypoint** (cwd auto-detect) and pass flags only.
- **`--output` extension selects the package format, and it is OS-specific.** A platform extension
  (`.msi` Windows · `.AppImage`/`.deb` Linux · `.dmg`/`.app` macOS) produces an **installer**; a
  no/invalid extension produces a **portable bundle directory** at that path (e.g.
  `dist/compositz/`, runnable on the host OS). Because one task can't pick a per-OS extension,
  `deno task desktop` outputs the **directory** (uniform on every OS — on Windows it is a folder,
  not an `.msi`); building a signed installer per platform is Phase 4.

**Verified:** with `_fresh/` built, `deno desktop` (run from `packages/ui`, flags-first) detects
Fresh, embeds `_fresh/`, and writes the output to `dist/` (a CEF `.AppImage` installer **or** the
`dist/compositz/` directory bundle) with no source-tree pollution. `packages/desktop` removed from
the workspace + `deno task check`; the Fresh app is type-checked by `ui:check`. Remaining: the live
CEF **window** (can't run headless here — manual `--hmr`), signed per-OS installers, and embedding
each running app's web UI as secondary windows (multi-window).

## ADR-017 — Instance-centric storage: drop the recipe store, the instance owns everything · ✅ Accepted

Reframes ADR-014's three-tier "recipe store" and ADR-015's deferred multi-instance plumbing. There
is **no shared recipe store and no app→instances hierarchy**. The unit of everything at runtime is
an **instance** (one deployment), keyed by a single `instanceId`; a **recipe** is merely the bundle
an instance was created from, copied inside it. Settled in a design round with the user.

**Decisions:**

- **The instance is self-contained and flat.** `<app-data>/instances/<instanceId>/` holds the
  extracted bundle (`app/` = manifest + Dockerfile + context) plus instance files (`meta.json`
  provenance; `config.yaml` per-install override, RI-4). Every runtime resource keys off the
  **single** `instanceId`: container `compositz-<instanceId>`, per-mount volume
  `compositz_<instanceId>_<name>`, bind host path `<data-root>/<instanceId>/<name>`, venv subpath
  `venvs/<instanceId>`, label `io.compositz.instance=<instanceId>`. No `recipeId × instanceId`
  nesting and no `"default"` special case — both removed from RI-1's `run.ts`.
- **No recipe catalog; the source IS the catalog.** To run a second copy of an app you re-import its
  bundle, or `duplicate` an instance — which copies only `app/`, **never the persistent data**. A
  Pinokio-style local library of not-yet-installed apps would be a future, separate catalog tier.
- **Per-instance image** `compositz/<instanceId>:<version>` for a `build` recipe. Self-contained ⇒
  teardown removes exactly that instance's resources by exact name, **no refcount**; duplicate
  builds hit Docker's layer/build cache, so storage barely grows. An `image`-based recipe still
  references its prebuilt image directly (shared, external — not per-instance).
- **`instanceId = <appId>-<rand>`** minted at import (a `crypto` base36 suffix — **no dependency**).
  Always suffixed ⇒ no uniqueness check needed, and `docker ps` stays legible (which app + which
  instance). The manifest **`id` survives only as a non-unique slug**: the instanceId prefix,
  image/container readability, and the **update-detection group key**. `appId` + `version` both live
  in each instance's manifest already; only the bundle **`source`** is extra (in `meta.json`),
  enabling a later "is there a newer bundle for this app?" check.
- **Bundle stored extracted, not packed.** `app/` is a plain directory (so `loadRecipe` reads it
  unchanged); there was no benefit to keeping an `app.tar.gz`.

**Why:** the `recipeId × instanceId` hierarchy turned every resource name into a conditional and
reintroduced a `"default"` special case. Making the instance the flat, self-owning unit deletes that
complexity, makes the import duplicate-id question **vanish** (no shared namespace to collide in),
and yields a teardown that touches only one instance's exactly-named resources — directly serving
the managed-only / reversible Docker-safety constraint.

**Consequences:** RI-2's scope shifts from "recipe store + ingestion" to **instance store +
ingestion + instanceId-threaded naming** (brand / run / operations / loader / storage / cli / ui).
`toCreateSpec(m, instanceId, opts)`; `DEFAULT_INSTANCE` and `LaunchConfig.instance` are removed;
`recipeContainerName` / `recipeImageTag` → `instanceContainerName` / `instanceImageTag`. ADR-014's
recipe store + per-recipe `config/<id>.yaml` and ADR-015's `venvs/<id>/<instance>` are superseded by
this flat layout. Full instance **deletion** (removing per-instance volumes + host data) needs
Engine volume endpoints the client lacks today — deferred; `down` + removing the instance directory
(keeping data) is the RI-2 cleanup. Tar extraction is **security-hardened** (reject absolute / `..`
/ symlink / hardlink entries). Layout reference:
[recipe-ingestion.md](recipe-ingestion.md#storage--instance-centric).

## ADR-018 — UI component library: Shadcn + Base UI via preact/compat · ✅ Accepted (spike-verified)

The Fresh UI adopts the house standard — Shadcn UI on the **Base UI** primitive layer (not Radix) —
running on Preact through `preact/compat`. Refines
[ADR-008](#adr-008--ui-framework-fresh-2-vite--accepted).

- **Why it works on Preact:** Radix reaches into React internals and breaks under `preact/compat`;
  **Base UI** (by MUI) uses only public React APIs, so it survives the compat layer, and Shadcn
  added a Base UI backend in 2025. Verified by an in-project spike (Fresh 2 / Preact 10.29 /
  Tailwind v4): a cva `Button` + a Base UI `AlertDialog` (portal + focus-trap) compile, type-check,
  bundle, and run (manual click-test: open / focus-trap / Esc / Cancel) with no type errors.
- **Setup:** alias `react`/`react-dom` → `preact/compat` and `react/jsx-runtime` →
  `preact/jsx-runtime` in **both** the Vite `resolve.alias` and the deno import map. Deps:
  `@base-ui-components/react`, `class-variance-authority`, `clsx`, `tailwind-merge`. Foundation:
  `lib/utils.ts` (`cn`) + `components/ui/` — own the component source (house rule: extend by
  wrapping, never hand-write a primitive).
- **Why not the `shadcn` CLI (verified, CLI 4.12.0):** its default `@shadcn` registry serves
  **Radix**-backed components (`@shadcn/tooltip` → `radix-ui` + `"use client"` + React) that break
  under preact/compat; there is **no built-in Base UI registry** (`@base-ui` is unknown; presets
  only cover theme/font), and the CLI targets React projects (components.json + framework
  detection), not Deno/Fresh/Preact. So components are **vendored from the canonical source**:
  `button`/`card` are byte-identical to upstream; `alert-dialog`/`tooltip`/`tabs` are upstream's
  structure re-backed on Base UI. (A custom Base-UI registry URL could later be wired into a
  `components.json` to drive `shadcn add` — but the default registry is unusable here.) This is the
  Shadcn "you own the code" model, not a lookalike.
- **Conventions:** style Base UI parts via **`className`** (its documented styling prop, merged into
  each part); make buttons **`forwardRef`** so Base UI's `render={<Button/>}` composition can attach
  refs. The server-only boundary holds — Base UI is a client lib and islands never import
  `@compositz/core` as a value (type-only import in `lib/dashboard.ts`).
- **Build note:** Rollup emits benign warnings — `"use client"` directives ignored, and a
  `__require` (use-sync-external-store CJS shim) export warning — both verified harmless at runtime.

**Consequences:** the UI's current raw Tailwind color classes (`bg-gray-50`, `text-white`, …) should
migrate to Shadcn **semantic tokens** (`bg-background` / `text-foreground` / `muted` /
`destructive`) defined as CSS variables, to enable theming. **Next UI task:** dark mode with default
**Auto** (follow `prefers-color-scheme`), a light/dark/auto **mode selector to follow**. (Done in
[ADR-019](#adr-019--dark-mode-class-based-with-a-no-flash-boot-script-default-auto--accepted).)

## ADR-019 — Dark mode: class-based with a no-flash boot script, default Auto · ✅ Accepted

Implements the dark-mode consequence of
[ADR-018](#adr-018--ui-component-library-shadcn--base-ui-via-preactcompat--accepted-spike-verified).
The chrome migrates to Shadcn semantic tokens; the **Auto** mechanism was the one real fork.

**Decisions:**

- **Tokens.** Shadcn neutral palette (oklch) in `styles.css` as CSS variables: light on `:root`,
  dark on `.dark`, mapped via `@theme inline` (`--color-*` → `var(--*)`) so a `.dark` override
  re-themes every `bg-background` / `text-foreground` / `muted` / `destructive` / `border` / `ring`
  utility. `color-scheme` set per mode (native controls/scrollbars follow).
- **Auto = class + no-flash boot script (the fork: chosen over pure `@media`).**
  `@custom-variant dark (&:where(.dark, .dark *))` binds `dark:` to the `.dark` class; an inline
  `<head>` script in `_app.tsx` toggles `.dark` from `matchMedia("(prefers-color-scheme: dark)")`
  before first paint, and re-applies on live OS changes. The script already honors a stored
  `compositz-theme` (`"light"|"dark"|"system"`), so the deferred **mode selector is purely
  additive** (UI + `localStorage`, no CSS restructure). `<html>` is outside every island ⇒ no
  hydration mismatch.
- **Chromatic status colors are NOT tokenized.** Meaning-bearing colors (green=running, amber=engine
  offline, blue=link/drop-zone, red=error→`destructive`) keep explicit hues with `dark:` variants;
  the install-log panel stays intentionally always-dark (terminal-style).

**Why class+boot over pure `@media (prefers-color-scheme)`:** the selector is a confirmed follow-up,
so the canonical Shadcn class infrastructure (built once) makes it additive, where a pure-media
setup would have to be rebuilt (CSS structure + `dark:` strategy + the boot script anyway) when the
selector lands. Cost now is ~one 12-line inline script.

**Consequences:** `react-no-danger` is disabled file-wide in `_app.tsx` (the only
`dangerouslySetInnerHTML` is the static-literal boot script; deno lint does not honor a per-element
`{/* deno-lint-ignore */}` in JSX). The light/dark/auto **selector remains deferred**. Adjacent (not
addressed here): the repo `fmt` config has no `exclude`, so `recipes/hello-web/index.html` (sample
bundle) fails `deno fmt --check` on `main` (`<!doctype>` → `<!DOCTYPE>`).

## ADR-020 — Trust-gated import + per-instance image cleanup on delete · ✅ Accepted

A UX increment over the instance-centric flow (ADR-017): a recipe is built only after an explicit
trust decision, and deleting an instance now reclaims its built image. Settled with the user.

**Decisions:**

- **Trust gate at import.** Importing a bundle ingests it to the store (the instance exists on disk)
  and then opens a **non-dismissable** "Trust the source and install?" dialog. **Yes** adds the row
  and builds immediately (the build log streams into the row's panel); **No** deletes the instance
  entirely (nothing was built). The dialog can't be dismissed (Esc/outside-click ignored) so the
  decision is deliberate. A build **failure** keeps the instance with its build log + an Install
  (retry) button — `installed` stays false (the user chose "残して再試行可"). So the Install button
  only appears on the failure/dismiss path, not the happy path.
- **"Provider" = recipe identity + filename.** A local file import has no real provider, so the
  dialog shows the recipe's name/version/appId and records `meta.source = upload:<filename>` (the
  client sends `?filename=`). A meaningful provider (`github:owner/repo`) lands with RI-3.
- **Delete reclaims the per-instance image.** `removeInstanceImage` removes ONLY the per-instance
  build tag `compositz/<instanceId>:<version>` and is a **no-op for an `image`-based recipe** (its
  image is shared/external — never removed). The new build-on-import flow makes "build then delete"
  common, so leaking a unique per-instance image each time was unacceptable. Volumes/data-root are
  still kept (the safe default). Honors the Docker-safety constraint: managed-only, exact-tag,
  reversible-by-reimport.
- **Open UI → Services tab.** The single "Open UI" button is replaced by a tabbed per-row panel
  (Build log / Runtime log / Services). Services lists **all** `web: true` ports, resolving each URL
  against the **running container's live published port** (`ps` `PublicPort`), not the manifest's
  declared port — the declared host port can be auto-bumped on conflict, so only the live binding is
  authoritative. Runtime logs stream from a new `/api/instances/:id/logs` SSE route over the
  existing `EngineClient.logs()`.

**Why:** building arbitrary recipe Dockerfiles is the privileged step; gating it behind an explicit
trust choice (rather than a separate, easy-to-miss Install click) makes the security boundary
legible. Image cleanup closes the storage leak the gate's "build immediately" behavior introduces.

**Consequences:** the dashboard view-model gains `webPorts[]` (replacing the single `web` string)
and `ContainerStatus.ports[]`; the join (declared web port × live published port) is a pure helper
in `lib/dashboard.ts`. `EngineClient` gains `removeImage` and a `logs({ signal })` follow-abort hook
(the latter also fixes an abort-during-`#open()` socket leak shared with `events()`). Tooltip/Tabs
join the Base-UI component set (ADR-018); icon-button tooltips wrap the control in a `<span>` so
they still show while the button is disabled.

## ADR-021 — GitHub ingestion (RI-3): spec grammar + codeload over HTTPS · ✅ Accepted

Implements RI-3 (GitHub sourcing) over the existing instance-centric ingestion (ADR-017). Amends
ADR-014's source-spec grammar. Settled with the user (candidates ①B/②A/③A).

**Decisions:**

- **Spec grammar amended to `owner/repo[/subdir][@ref]`** (subdir BEFORE ref). ADR-014 wrote
  `owner/repo[@ref][/subdir]`, but that order is ambiguous once a branch name contains `/`
  (`feature/login`) and a subdir is also present — the parser can't tell where the ref ends. With
  the ref delimited **last** by `@`, it MAY itself contain `/`, and the subdir sits between repo and
  `@ref`, so a slashed ref and a subdir coexist with no guessing. An optional `github:` scheme
  prefix is accepted (mirrors `meta.source`); a pasted trailing `.git` on the repo is tolerated. `@`
  is reserved for the ref (not usable inside a subdir).
- **Codeload tarball over HTTPS, no `git` and no GitHub API.**
  `https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}` with `ref` defaulting to **`HEAD`** (the
  repo's default branch — verified). Codeload needs no token and no rate budget, and resolves
  slashed refs as a literal path (`…/tar.gz/releases/v1` — verified). The GitHub _API_ would add a
  redirect hop and a rate limit for no gain on the **public-only** first cut. A bad repo/ref is a
  clean 404.
- **Reuse the streaming `ingestBundle` unchanged.** `fetch(url).body` is piped straight into
  `{ kind: "archive", stream, subdir }` — same gzip auto-detect, same security-hardened extraction,
  same Zod-validate + atomic publish as upload/dir. `subdir` support is added to `locateBundleRoot`:
  after unwrapping the single codeload wrapper `<repo>-<ref>/`, it descends into the (validated,
  escape-checked) subdir. One shared core entrypoint `ingestGithub(spec, dir, opts)` is the single
  path used by the CLI now and the UI in the next increment.
- **CLI surface = a `github:` prefix on `compositz import`.**
  `import github:owner/repo[/subdir][@ref]` selects GitHub; it's unambiguous against a relative path
  (`recipes/hello-web`) and mirrors the `meta.source` string, so no new subcommand is needed.

**Why:** subdir-before-ref is the only ordering that keeps the parse pure and unambiguous while
supporting both slashed refs and subdirs; codeload (not the API) needs no auth and no rate budget
for public repos; threading `fetch().body` through the existing `ingestBundle` means GitHub recipes
get byte-identical extraction/validation/atomic-publish to every other source (no second path to
drift).

**Consequences:** new `recipe/github.ts` (`parseGithubSpec` / `githubTarballUrl` / `githubSource` /
`ingestGithub`); `BundleSource` archive gains an optional `subdir`; `locateBundleRoot` gains a
subdir descent (behavior-preserving when absent). `meta.source = github:owner/repo[/subdir][@ref]`
round-trips through the parser. Verified: 17 hermetic unit tests + 2 opt-in live-codeload
integration tests (`COMPOSITZ_NET_TESTS=1`). The **UI entry** is also done: a "From GitHub" modal
(spec input) → the existing **trust gate** opens with `github:owner/repo` as the provider — the same
**server-confirmed** ingest-then-trust flow as a file upload (no new optimistic UI). The view-model
mapping `toInstanceView` was extracted to one shared server-only module so the file-import route,
GitHub route, and initial render can't drift. **Deferred** (see
[recipe-ingestion.md](recipe-ingestion.md#open-details)): private-repo auth, full-URL paste
(`https://github.com/owner/repo/...`), and `@` inside a subdir.

## ADR-022 — Per-instance launch override (RI-4): config.yaml persistence + Settings UI · ✅ Accepted

Implements RI-4 over RI-1's effective-spec derivation (manifest ⊕ launch override). RI-1 already had
the in-memory merge (`toCreateSpec` / `resolveHostPorts` / `LaunchConfig`); RI-4 adds the
**persistence** and the **editor**. Settled with the user (candidates ①3-fields / ②Settings-tab /
③explicit-Save-server-confirmed / ④on-demand-fetch).

**Decisions:**

- **Persisted override = a strict subset of `LaunchConfig`: `{ hostPorts, env, placement }`** (Zod
  `OverrideSchema`), keyed by manifest `name`, stored at `instances/<instanceId>/config.yaml`.
  **`dataRoot` is intentionally excluded** — it is an install-wide concern (one data-root), deferred
  to a future `settings.yaml`; `up` supplies the default. Bind mounts toggle **placement only**; the
  host path stays derived (`<data-root>/<instanceId>/<name>`), never an arbitrary directory.
- **`up` loads `config.yaml` and merges it under the in-memory `launch` arg** (`mergeLaunch`, a pure
  per-sub-key overlay where the arg wins; `dataRoot` is only set when supplied so an absent value
  never clobbers the default). Loading in `up` (which has `instance.dir`) means the **CLI and UI
  both honor the saved override with no caller wiring** — one shared path, not two that could
  diverge. The override is **derived each launch, never written back** to the manifest.
- **Settings tab, not a modal.** The editor is a 4th tab on the existing per-instance DetailPanel
  (Build log / Runtime log / Services / **Settings**), so per-instance detail stays in one place and
  the form can grow without modal stacking. It **fetches on tab-open**
  (`GET /api/instances/:id/config` → manifest ⊕ override view-model + a free-port suggestion); Base
  UI unmounts inactive panels, so each open is fresh.
- **Server-confirmed Save, delta-only.** Save **PUTs only the values that differ** from the manifest
  defaults (a minimal `config.yaml`); the route Zod-validates and **cross-checks keys against
  manifest names** (an unknown port/env/mount key ⇒ 400). No optimistic UI ([feedback]: the user
  dislikes it) — the form reflects the saved state, and the override **applies on the next start**.
  `required` env is enforced in the UI (Save blocked until filled).

**Why:** RI-1's merge already produced the effective spec, so RI-4 is deliberately a thin
persistence layer — putting the load in `up` keeps a single application path for CLI + UI; the
subset schema matches what is genuinely per-instance (dataRoot is not); delta-only persistence keeps
`config.yaml` legible (only what the user changed); server-confirmed save fits the user's stated
preference and the "derived each launch" model.

**Consequences:** new `recipe/config.ts` (`OverrideSchema` / `parseOverride` / `serializeOverride`);
`instance.ts` gains `CONFIG_FILE` + `loadInstanceConfig` / `saveInstanceConfig`; `run.ts` gains the
pure `mergeLaunch`; `up` loads + merges. UI: `GET`/`PUT /api/instances/:id/config`, a Settings tab +
form, and the Settings view-model types in `lib/dashboard.ts`. Verified: core unit tests
(parse/serialize/load/save/merge) + a real-engine smoke (a saved `config.yaml` host-port remap is
published by `up`) + the route data-path on a real instance. **Deferred** (see
[recipe-ingestion.md](recipe-ingestion.md#open-details)): editable `dataRoot`, arbitrary bind host
paths, hard-blocking `up` on an unset required env, and a "Save & restart" convenience — the last
has since been effectively covered by ADR-023's conditional "Restart now" button (shown only when a
restart would change something); what remains is a literal one-button save+restart, negligible
polish.

## ADR-023 — Definition-driven ports: add-time deconfliction + display precedence · ✅ Accepted

A refinement of how host ports are resolved and shown, settled with the user after RI-4. Amends
ADR-015 (auto-increment) and ADR-020 (Services from the live port). The goal: make the
**definition** (manifest ⊕ override) the source of truth for ports while keeping the convenience of
auto-assignment — "reduce surprise and keep convenience" (the user).

**Decisions:**

- **Web display port = `live published ▷ override ▷ manifest`** (per web port). The LIVE port wins
  when known because it is what the container is ACTUALLY on — this is correct when an override was
  saved but the instance not yet restarted (still on the old port), and when `up` auto-bumped. When
  no live binding is in `ps` yet (the starting window), fall back to the DEFINED port so the row
  shows the _expected_ endpoint (with `ready: false`) instead of a blank. Supersedes ADR-020's
  live-`PublicPort`-only resolution.
- **Conflicts are resolved at ADD time, against DEFINITIONS, with a notification — not silently at
  launch.** On import / GitHub / duplicate, `deconflictHostPorts` checks the new instance's ports
  against the host ports DEFINED (manifest ⊕ persisted override) by all OTHER instances — engine-
  independent, so it catches **stopped** instances. A colliding port is reassigned to the next free
  one, **persisted to the instance's `config.yaml`** (so the assignment is stable and editable in
  Settings), and **reported** so the UI/CLI can say "8090 was in use → 8091". This is the user's
  "変えておいた" — a remap the user is told about, not a silent one.
- **`up`'s launch-time auto-bump (ADR-015) stays, as a safety net.** Add-time deconfliction keeps
  managed instances from colliding by definition; `up`'s `resolvePorts` remains for ports held by
  **non-managed (external)** processes at launch. Its effect is visible via the live-first display
  precedence above (no silent divergence).
- **The Settings conflict warning is definition-based and client-reactive.** `GET /config` returns
  `takenByOthers` (other instances' defined host ports); the form flags a conflict and suggests a
  free port **as the user types** — fixing the prior bugs (it only saw _running_ containers, and the
  warning was computed once at load so it never cleared). After a save while running, a **"Restart
  now"** button applies the override (down → up).

**Why:** with RI-4 the user can set ports explicitly, so port-conflict handling should be a
**predictable, visible, definition-level** concern rather than a silent runtime bump; live-first
display is the one ordering that stays correct across the save→restart window AND an
external-conflict bump; keeping `up`'s bump as a net avoids a hard launch failure on an external
port grab.

**Consequences:** core gains `effectiveHostPort` / `definedHostPorts` / `deconflictHostPorts`
(+`PortBump`); the dashboard `WebPort` carries the effective `host`, `toInstanceView` loads the
override (now async), `instanceServices` takes the live-▷-defined precedence and `Service` always
has `port`/`url` + a `ready` flag; import routes deconflict via a shared `finalizeImport` and
surface bumps in the trust prompt; the Settings route returns `takenByOthers`; the CLI
`import`/`duplicate` print the reassignment. Because services now resolve from the definition, the
**Services list is shown even when the instance is stopped** (badge `stopped`/`starting…`/`ready`)
so the web entry points are visible before start; each opens in a new window OR the **OS default
browser** via a server route (`POST /api/open`, restricted to local http(s) URLs — the webview can't
reach the system default itself). The Settings **"Restart now"** prompt shows ONLY when a restart
would change something: `up` records the launched override to `.launched.yaml`, and the route
returns `restartNeeded = running && saved-config ≠ launched` (`sameOverride`) — so it doesn't linger
after a restart or a no-op save. Verified: hermetic core tests (deconflict honors others' overrides;
precedence cases; `sameOverride`; launched-marker independence) + CLI/real-engine end-to-end
(reassign 8090→8091→8092 persisted; restart-needed false→true→false across edit + relaunch).
**Deferred:** hard-blocking `up` on an external port still occupied at launch (currently the
safety-net bump or a Docker error).

---

## ADR-024 — Forced cache sharing: preset env injection beats the image's own layout · ✅ Accepted

The cocktail dogfood surfaced the question: what happens when an app's own Dockerfile centralizes
its caches under its data dir (`HF_HOME=/workspace/models`, `UV_CACHE_DIR=/workspace/.uv-cache`, …)?
The user's call: **force sharing** — patching recipes / overriding env is acceptable.
`docs/limitations.md` previously claimed presets would "split the cache in two" against such apps;
that was wrong for env-driven apps and is retracted (narrowed to two carve-outs).

**Decisions:**

- **The forcing mechanism is the existing create-time env injection.** Measured on the live engine
  (29.5.3): container-create `Env` overrides image `ENV`, and image `ENV` survives when no `Env` is
  passed (both directions verified). cocktail is fully env-driven (pydantic-settings binds `HF_HOME`
  / `WEIGHTS_DIR` / `IMAGES_DIR`; the entrypoint's `uv sync` reads `UV_*`), so declaring presets
  suffices — no new mechanism. Carve-outs (build-time-baked paths; env-deaf apps) live in
  `docs/limitations.md`.
- **venv preset repaired: also inject `UV_PROJECT_ENVIRONMENT` (= `VIRTUAL_ENV`) and
  `UV_PYTHON_INSTALL_DIR`.** Measured (uv 0.10.10 + official docs): uv _project_ operations
  (`uv sync` / `uv run`) ignore `VIRTUAL_ENV` (warn, use `.venv`) and honor only
  `UV_PROJECT_ENVIRONMENT` — the old preset silently lost persistence for every `uv sync`-style app
  (no shipped recipe used it yet, so no damage occurred). Managed interpreters co-locate on the same
  volume so the venv's `pyvenv.cfg home` never points across volumes. Honest caveats: shared
  `UV_PYTHON_INSTALL_DIR` concurrency rests on uv's _implementation_ lock (`managed.rs`), not a
  documented guarantee; apps that hard-code `.venv`-relative paths are incompatible (noted in the
  schema description). The equivalent per-recipe fix (entrypoint
  `export UV_PROJECT_ENVIRONMENT="$VIRTUAL_ENV"`) was rejected: the preset's contract is core's to
  keep, and every uv-sync recipe would need the same wrapper.
- **No global default-on injection.** Rejected not as unnecessary but as harmful: it would mount
  shared writable volumes into every app unasked (widening the cache-poisoning channel — see the
  threat model in `docs/limitations.md`) and inject `VIRTUAL_ENV` into non-uv apps (breaking
  pip/poetry flows). Recipe-level declaration IS the forcing lever while recipes are first-party; a
  per-instance user-side cache opt-in (a `config.yaml` extension) is the future path for third-party
  recipes, not default-on.
- **Deferred: `target:` graft for env-deaf apps** — mounting a shared cache volume at the app's own
  path (nested mounts). Verified live: the engine mounts `/nest` + `/nest/inner` correctly
  regardless of specification order — but that ordering is moby's `sortMounts` _implementation
  behavior_, not API-guaranteed, so an implementation MUST sort mounts by target depth itself. Not
  needed yet (cocktail is env-driven end to end).

**Consequences:** cocktail declares `cache: [venv, huggingface, custom(cocktail-weights)]`; a
duplicated instance re-downloads nothing on first boot (previously torch + Python + HF models +
weights, 10+GB). `/workspace` shrinks to generated images. Deleting a venv-preset instance orphans
`venvs/<instanceId>` inside the shared volume — recorded in `docs/known-issues.md`, to be reclaimed
by the Phase-3 GC. Existing instances keep the old layout until re-imported. Preset vars cannot be
overridden from the Settings tab (precedence documented in `docs/limitations.md`).

## ADR-025 — Instance deletion removes data volumes by default; export is the safety valve · ✅ Accepted

Settled with the user (2026-07-03) in the feature-gap session, closing the "keep vs delete" open
point recorded in known-issues.

**Context:** deleting an instance kept its named volumes (a blanket-safe default), silently
accumulating orphans that only `docker volume rm` could reclaim — and the volume names derive from
the instance definition, so once the definition was gone the orphans became invisible. Meanwhile the
CLI `rm` didn't even reclaim the per-instance image (the UI delete did — pure asymmetry).

**Decisions:**

- **Named volumes are removed BY DEFAULT on delete** (CLI `rm`, UI delete checkbox pre-checked).
  Rationale (the user's own): data worth persisting belongs in a `bind` mount — host-browsable under
  the data-root — so volumes hold reproducible/derived state. Opt-outs: `--keep-data` / the
  unchecked box.
- **The data-root bind dir is KEPT by default**; `--purge` / an opt-in checkbox removes
  `<data-root>/<instanceId>` too. Bind data is exactly the "persist-worthy" class, so its default is
  conservative. NOTE: removed with local fs APIs — correct for a local daemon; over a remote
  `DOCKER_HOST` the files live on that host and stay.
- **Volume names derive from the definition** (`manifest.mounts × volumeName`), for EVERY mount
  regardless of current placement (a placement flip may have left data in both forms). Shared cache
  volumes (`compositz_uv`/`_hf`/`_cache_*`) are structurally out of reach — different naming scheme,
  never enumerated. Docker's volume name filter is a SUBSTRING match, so existence is confirmed by
  exact-name comparison, never by filter hit alone.
- **A volume that can't be removed (409, still mounted) is reported, never forced — and the instance
  definition is KEPT** so a retry can re-derive the volume names. Removing the definition anyway
  would manufacture invisible orphans, the exact failure class this ADR closes.
- **Export before delete is the escape hatch** (same session): `compositz export <id> [mount]` / a
  Settings-tab Export button streams one mount's data as a tar — via a **never-started helper
  container** and `GET /containers/{id}/archive` (works on a created container; no code executes).
  The mount-name → source derivation is shared with `toCreateSpec` (`persistedMounts`) so export
  reads exactly what the app runs with. Absent volume ⇒ fail loud (no silently-empty tar). The UI
  triggers the download through the OS default browser (`/api/open` path) — the webview can't save
  files. Helper teardown completes BEFORE the stream reports closed (a consumer may exit the process
  the moment `pipeTo` resolves — measured leak, fixed).
- **CLI `rm` reclaims the per-instance image** (parity with the UI delete; `image`-based recipes'
  shared images stay untouched, as before).

**Consequences:** `EngineClient` gains `listVolumes` / `removeVolume` / `archive` — the base for the
remaining Phase-3 volume work (`volumes prune` for pre-existing orphans, venv-subpath GC). `run.ts`
gains `persistedMounts` (the single mount-source derivation). Live-verified on the real engine:
default delete / `--keep-data` / busy-volume 409 → definition kept → retry; shared caches untouched
throughout.

## ADR-026 — Action-driven tab flow + connection-based readiness (amends ADR-023) · ✅ Accepted

User-requested (2026-07-03): the detail panel should follow the lifecycle — **add → build log
(existing), build done → Settings, starting → runtime log, ready → Services.**

**The blocker, measured:** implementing "ready → Services" on the existing `ready` flag would fire
the instant a container starts, because (a) Docker reports the published mapping in `ps` at
container start — minutes before a heavy AI app listens — and (b) a bare **TCP connect is useless as
a probe: docker-proxy itself accepts** the connection even with nothing listening in the container
(both verified against the live engine). ADR-023's "ready" badge therefore meant "container
running", not "app answering" — and the known-issues text that described it as accept-based was
wrong about the implementation (retracted; it is accurate NOW).

**Decisions:**

- **Readiness = an HTTP probe against the published web port** (server-side, `lib/probe.ts`): any
  HTTP response (200/404/401/30x) ⇒ `accepting: true`; refused / reset-by-proxy / timeout (800 ms) ⇒
  `false`. Probes target ONLY the manifest's `web: true` ports (browser UIs — http by the product's
  own URL scheme); other published ports pass through unprobed, so a non-HTTP port can neither fake
  readiness nor spin the poll. Probe host = the Docker daemon's host (loopback for unix/npipe, the
  remote host for a TCP `DOCKER_HOST`).
- **`ready` is strict:** live binding AND `accepting === true`. A missing/failed probe degrades to a
  visible "starting…", never to a false "ready".
- **Warming fast-poll:** no Docker event fires when a booting app finally listens, so while any
  probed port is `accepting: false` the SSE snapshot loop re-pushes every 2 s (15 s backstop
  otherwise). Self-terminating: the fast poll stops the moment everything answers.
- **Tab flow:** Start opens the panel on the runtime log (the app's own startup output IS the
  progress signal); a successful build switches to Settings (a FAILED build keeps the build log in
  view); the ready TRANSITION switches to Services — seeded from a baseline snapshot so an
  already-ready app never steals the tab on page load, and a background transition only pre-sets the
  tab of a CLOSED panel (no popup). Manual tab picks are respected between transitions.

**Consequences:** `PublishedPort` gains `accepting?: boolean`; `instanceServices` requires it for
`ready`; the events route reads the instance store each push to know the web ports (cheap, local).
The "first `up` looks stuck" known-issue is resolved for the UI: the badge is now honest and the
runtime log opens on start. Residual: an https-only or non-HTTP "web" UI would never probe ready
(none exist; the product's service URLs are http) — the Phase-3 manifest `healthcheck` field stays
the declarative escape hatch. The Settings "Restart now" also lands on the runtime log (it IS a
start) — flagged for user feedback.

## ADR-027 — GitHub codeload download uses ureq (rustls/ring), not reqwest · ✅ Accepted

Decided during the Tauri migration's Phase 1e (user-approved, 2026-07-04). The Rust port needs a
blocking HTTP client for the codeload tarball download (`ingest_github`); the migration plan named
`reqwest`.

**The blocker:** `reqwest` 0.13 removed the cheap rustls-over-**ring** path — its `rustls` feature
now pulls **aws-lc-rs**, a second C-built crypto backend. The rest of the stack is deliberately on
**rustls + ring, no extra C / no openssl** (bollard is configured exactly so; the lock already has
ring 0.17, aws-lc-rs absent). Adding reqwest would have meant either a second crypto backend
alongside ring, or a fragile `rustls-no-provider` + manual provider-install dance.

**Decision:** use **`ureq` (2.x, `default-features=false`, `features=["tls"]`)** — rustls over ring
(reuses bollard's existing rustls 0.23), webpki bundled roots, blocking-native (no tokio runtime to
spin up), redirect-follow, per-read timeout. It satisfies every requirement the plan attached to
reqwest (blocking / rustls / no-openssl / redirect / read-timeout) while keeping the whole tree on a
single crypto provider.

**Consequences:** one HTTP client dep (`ureq` + `webpki-roots`), zero new crypto backends, no
openssl, no aws-lc-rs C build. `ingest_github` matches on `ureq::Error::{Status, Transport}` (ureq
treats a non-2xx as an error, so a 404 is a clean match). The download is verified end-to-end against
real codeload (opt-in `COMPOSITZ_NET_TESTS=1`). Supersedes the migration plan's `reqwest` line for
this use; a later need for an async multi-request client (unlikely in core) would reopen the choice.
