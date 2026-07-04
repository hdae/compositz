# Recipe ingestion, storage & launch configuration

> Status: **fully implemented & verified** — manifest v2, ingestion (tar/dir + GitHub),
> instance-centric storage, and the per-instance override (`config.yaml` + Settings tab).
> Decisions in [ADR-014](decisions.md#adr-014--recipe-sourcing-3-tier-storage--manifest-v2--accepted) /
> [ADR-015](decisions.md#adr-015--manifest-v2-core-structured-mounts--createmountpoint-managed-cache-layout--accepted-verified) /
> [ADR-017](decisions.md) / [ADR-021](decisions.md) / [ADR-022](decisions.md); the live
> field reference is [recipe-format.md](recipe-format.md). The implementation lives in
> [`crates/core/src/recipe/`](../crates/core/src/recipe/). This doc holds the design;
> the increment plan at the bottom is a historical record of how it landed.

## Guiding principle — every field maps to a Docker concept

Compositz makes **Docker images easy to deploy**, so the manifest is a thin, single-container layer
over the Engine API, not a parallel config universe:

- Every config field has a **direct Docker runtime meaning** — `image`/`build` → an image, `ports` →
  published ports, `mounts` → binds/volumes, `env` → environment, `gpu` → device requests. We add
  only **light author metadata** (`name` / `description` / `required`) so the install UI can explain
  and collect settings — not a separate settings DSL.
- The **runtime stays single-container** (`docker compose` is not used —
  [ADR-001](decisions.md#adr-001--one-container-per-app-no-compose--accepted) holds). Multi-daemon
  apps use s6-overlay inside one image.

## Storage — instance-centric

> Supersedes ADR-014's three-tier "recipe store". There is **no shared recipe store and no
> app→instances hierarchy** ([ADR-017](decisions.md)): the runtime unit is a self-contained
> **instance**, keyed by a single `instanceId`. A recipe is just the bundle an instance was made
> from, copied inside it.

**app-data** — `appDataDir()`: `$XDG_DATA_HOME/compositz` (Linux/mac) · `%APPDATA%\compositz` (Win)

```
<app-data>/
├── instances/
│   ├── comfyui-a1b2c3/              # instanceId = <appId-slug>-<rand>  ← the single runtime key
│   │   ├── app/                     # extracted bundle = the app definition (immutable after import)
│   │   │   ├── compositz.yaml       #   manifest (id=comfyui, name, version, ports, mounts, cache, env, gpu)
│   │   │   ├── Dockerfile
│   │   │   └── …(build context)
│   │   ├── meta.json                # provenance only: { source, createdAt }  (instanceId = dir name)
│   │   └── config.yaml              # per-instance override (RI-4): hostPorts/env/placement
│   └── comfyui-x7y8z9/              # a duplicate: app/ copied, fresh data
└── settings.yaml                    # global settings (data-root override, …) — future
```

**data-root** — `defaultDataRoot()` (user-configurable): `~/Compositz` (Win
`%USERPROFILE%\Compositz`). Holds **bind**-mount data only, keyed by instanceId:

```
<data-root>/<instanceId>/<mountName>/     # bindHostPath(dataRoot, instanceId, mountName); host-browsable
```

**Docker-managed** (by exact `instanceId` ⇒ self-contained teardown, no refcount):

| Resource        | Name                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| container       | `compositz-<instanceId>` (label `io.compositz.instance=<instanceId>`)                        |
| image (`build`) | `compositz/<instanceId>:<version>` (per-instance; layer/build cache dedups)                  |
| volume mount    | `compositz_<instanceId>_<mountName>` (`placement: volume`)                                   |
| shared caches   | `compositz_uv` (venv subpath `venvs/<instanceId>`), `compositz_hf`, `compositz_cache_<name>` |

- A **bind** mount lands at `<data-root>/<instanceId>/<name>` (host-browsable); a **volume** mount
  uses a per-instance named volume. Host paths are **derived from the mount `name`** — authors never
  write `${...}` paths. Cache mount paths are **injected as env vars** (see `cache[]`), so authors
  read e.g. `$HF_HOME`.

## Recipe sources (ingestion)

A recipe is a directory (`compositz.yaml` + `Dockerfile`/context, or an `image`-only manifest). It
is imported to **create an instance** (`<app-data>/instances/<instanceId>/app/`) from:

- **tar / tar.gz bundle** — the recipe dir packed; uploaded/dropped in the UI. (`.zip` is out of
  scope; GitHub codeload is `.tar.gz` anyway.)
- **local directory** — a recipe dir on disk (dev seed: `compositz import recipes/hello-web`).
- **GitHub** — `owner/repo[/subdir][@ref]` (subdir before ref; an optional `github:`
  prefix; `@ref` omitted ⇒ default branch): download the codeload tarball
  (`codeload.github.com/<owner>/<repo>/tar.gz/<ref|HEAD>`) over HTTPS, extract, validate, create.
  **No `git` binary, no GitHub API** — plain HTTPS ([ADR-027](decisions.md)) + streamed tar
  extraction. Public repos only. CLI: `compositz import github:owner/repo[/subdir][@ref]`; in the
  UI, a "From GitHub" dialog feeds the same trust-gate flow. See [ADR-021](decisions.md).

Ingest = extract (contained: reject absolute / `..` / symlink / hardlink entries) →
**validate the manifest** → mint `instanceId` → **atomically publish** under
`instances/<instanceId>/` (staging dir → single rename, so a failed import never leaves a
half-instance). To run a **second copy**, re-import (or `duplicate`, which copies only `app/`,
never persistent data). Building the image is the separate **Install** step.

## Manifest v2 (implemented in RI-1)

Breaking change from v1 (unreleased → no migration). The authoritative field reference is now
[recipe-format.md](recipe-format.md); the annotated example below shows the shape. Example (full):

```yaml
manifestVersion: 2
id: comfyui # required — the key for image/container/data/labels
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.

build: # build XOR image
  dockerfile: Dockerfile
  args: { CUDA: "12.4" }
# image: ollama/ollama:0.6.0

ports:
  - name: ui # required — button label + override key
    container: 8188
    host: 8188 # default = container; user-overridable; auto-assigned on conflict
    protocol: tcp # default tcp
    web: true # default false; MULTIPLE allowed → one "Open UI" button each
    path: "/" # default "/" — used to build the web URL
    description: "Web UI."

mounts: # declared ⇒ persisted
  - name: output # required — host subdir / volume suffix
    target: /app/output # required
    placement: bind # bind | volume; DEFAULT volume (bind is slow on Windows → opt in)
    description: "Generated images (host-visible)."
  - name: models
    target: /app/models # placement omitted ⇒ volume (compositz_comfyui_models)
    description: "Checkpoints / LoRAs."

cache: # opt-in managed caches; path + env injected by Compositz (no target)
  - type: venv # preset: per-instance uv venv + co-located uv cache (one volume → hardlink-safe)
  - type: huggingface # preset: shared HF cache
  - type: custom # generic
    name: torch
    env: TORCH_HOME # injected = the mount path
    scope: shared # shared | instance

env:
  - name: HF_TOKEN
    description: "HuggingFace token for gated models."
    required: false # default false
    default: "" # suggested/placeholder value — coexists with required

gpu: preferred # required | preferred | none (default preferred)
```

Field rules:

- **`build` XOR `image`** — build from a Dockerfile context, or reference a prebuilt image.
- **`ports[]`**: `name` (required) · `container` (required) · `host` (default = container) ·
  `protocol` (default tcp) · `web` (default **false**; **multiple `true` allowed**) · `path`
  (default `/`) · `description`. Each `web: true` port renders an "Open UI" button at
  `http://localhost:<host><path>`.
- **`mounts[]`**: `name` (required) · `target` (required) · `placement` (`bind`|`volume`, **default
  `volume`**) · `description`. bind ⇒ host `<data-root>/<instanceId>/<name>`; volume ⇒
  `compositz_<instanceId>_<name>`. `placement` is the author's default, **overridable per install**.
- **`cache[]`** (opt-in): presets `venv` (per-instance uv venv + co-located uv cache, one volume;
  injects `VIRTUAL_ENV` + `UV_CACHE_DIR`) and `huggingface` (shared; injects `HF_HOME`); plus
  `custom` (`name` + `env` + `scope: shared|instance`). The venv subpath is **fixed**
  `venvs/<instanceId>` (no per-recipe override — exceptions would explode the matrix).
  `COMPOSITZ_INSTANCE=<instanceId>` is injected, so per-instance caches/venvs isolate per
  deployment.
- **`env[]`**: `name` (required) · `description` · `required` (default false) · `default`.
  `required: true` ⇒ the user must confirm a value; `default` is a suggested/placeholder (the two
  coexist). Resolved to `NAME=value`.

Validation: `build` XOR `image`; `ports[].name` / `mounts[].name` / `env[].name` unique; `cache`
preset duplicates rejected (custom keyed by `name`). Host-port conflicts are resolved **at add
time** against other instances' DEFINITIONS (manifest ⊕ override) — reassigned to a free port,
persisted, and reported (ADR-023); `up` keeps a launch-time auto-bump as a safety net for
externally-held ports.

Minimal manifest (static site — no mounts/cache/env):

```yaml
manifestVersion: 2
id: hello-web
name: Hello Web
version: "0.1.0"
build: { dockerfile: Dockerfile }
ports:
  - { name: web, container: 80, host: 8090, web: true, description: "Static hello page." }
gpu: none
```

## Launch configuration — per-install override

The manifest is the author's **defaults**; the user's customizations live in a separate per-instance
**override** (`<app-data>/instances/<instanceId>/config.yaml`) carrying only **values**: host-port
remaps, env values, and per-mount `placement` (bind/volume). At `up` the effective spec is
**derived** from _manifest ⊕ override_ — the manifest is never mutated (`up` loads `config.yaml` and
merges it, so the CLI and UI both honor it without wiring; see [ADR-022](decisions.md)).

The override schema is a strict **subset** of the in-memory `LaunchConfig`:
`{ hostPorts, env, placement }`, each keyed by the manifest `name`, validated against
the instance's definition on save. **`dataRoot` is intentionally not persisted** here —
it is an install-wide concern (one data-root), deferred to a future `settings.yaml`;
`up` supplies the default. Bind host-paths stay **derived** from the mount name
(`<data-root>/<instanceId>/<name>`) — placement is the only mount override (no
arbitrary host path).

**UI:** a **Settings** tab on each instance edits these three; it loads on open, flags
a host port already used by another instance's DEFINITION and suggests a free one
(client-reactive — it recomputes as you type and catches stopped instances; ADR-023),
requires `required` env values before Save, and **saves only the values that differ**
from the defaults (a minimal `config.yaml`). Saving is **server-confirmed**; the
override applies on the **next start** — after a save while running, a **Restart now**
button (down → up) applies it. A web service's displayed port follows
**live ▷ override ▷ manifest** (ADR-023).

## Increment plan (historical — all delivered)

| Inc.     | Scope                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **RT**   | ✅ Docker `/events` real-time status.                                                                                                                                                                                                                              |
| **RI-1** | ✅ **Manifest v2** + storage layout + data-root + bind/volume mounts (structured `Mounts` + `CreateMountpoint`) + cache provisioning & env injection + effective-spec derivation (manifest ⊕ launch override) in core.                                             |
| **RI-2** | ✅ **Instance store + ingestion** (tar/tar.gz/dir → extract → validate → mint `instanceId` → create instance) + instanceId-threaded naming + `duplicate`. See [ADR-017](decisions.md).                                                                             |
| **RI-3** | ✅ **GitHub ingestion** (`owner/repo[/subdir][@ref]` → codeload tarball → create instance; no `git`/API, public-only) — core + CLI + UI ("From GitHub" dialog → trust gate). See [ADR-021](decisions.md).                                                          |
| **RI-4** | ✅ Per-instance **override** persistence (`config.yaml`, applied at `up`) + **Settings tab** UI (host-port remap w/ free-port suggest, env values, placement). Multi-web "Open UI" done via Services tab. See [ADR-022](decisions.md). dataRoot deferred.          |

## Open details

Resolved in RI-1 (now in [recipe-format.md](recipe-format.md) /
[ADR-015](decisions.md#adr-015--manifest-v2-core-structured-mounts--createmountpoint-managed-cache-layout--accepted-verified)):
the injected-env list per cache type, the in-container `/compositz` layout, per-OS default
data-root + app-data dir, and bind-source creation (daemon-side `CreateMountpoint`).

Still open:

- **Windows bind on Docker Desktop**: `CreateMountpoint` handles source creation, but Docker Desktop
  file-sharing for the data-root drive still needs first-run handling (packaging).
- **RI-4 override — by-design first-cut limits** (ADR-022): **`dataRoot` is not editable** (deferred
  to a global `settings.yaml`); bind mounts toggle placement only (host path stays derived, no
  arbitrary directory); **`required` env is enforced only in the Settings UI** (Save is blocked
  until filled) — `up` itself does not yet hard-block a launch when a required env is unset (it
  would launch with an empty value, the pre-RI-4 behavior). The "Save & restart" convenience has
  since been effectively covered by ADR-023's conditional "Restart now" button.
- ~~**Live cache exercise**~~ — done: `recipes/cocktail` declares `venv`/`huggingface`/`custom` and
  the shared caches were exercised end-to-end on a real GPU host (ADR-024).
- **Authoring helper**: a **reference entrypoint** (uv-sync boilerplate using `$VIRTUAL_ENV` /
  `$UV_CACHE_DIR`) so recipes don't reinvent it — recipe-format appendix (future).
- **RI-3 GitHub — by-design first-cut limits** (ADR-021): **public repos only** (no auth); the spec
  is `owner/repo[/subdir][@ref]` only — **no full-URL paste** (`https://github.com/owner/repo/...`)
  yet; `@` is reserved for the ref, so a subdir cannot contain `@`. (RI-3 itself — core, CLI, and
  the UI "From GitHub" modal — is complete.)
- Multi-instance UI (run N of one recipe) is deferred; the schema is already instance-ready
  (`COMPOSITZ_INSTANCE`, per-instance venv subpath).
