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
(Phase 4). `deno task desktop` builds CEF; `deno task desktop:webview` builds the (currently broken)
system-webview variant for re-testing.

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
  store; build stays the separate Install step.
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
