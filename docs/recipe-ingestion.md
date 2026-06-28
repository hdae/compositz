# Recipe ingestion, storage & launch configuration

> Status: **manifest v2 + storage + effective-spec are implemented & verified (RI-1 done)** —
> decisions in
> [ADR-014](decisions.md#adr-014--recipe-sourcing-3-tier-storage--manifest-v2--accepted) /
> [ADR-015](decisions.md#adr-015--manifest-v2-core-structured-mounts--createmountpoint-managed-cache-layout--accepted-verified),
> live manifest in [recipe-format.md](recipe-format.md). **Ingestion (RI-2/3) and the override UI
> (RI-4) are still planned** — this doc holds their design plus the increment plan.

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

## Storage — three tiers

| Tier              | Location                                                             | Holds                                                           |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| **App-data**      | `$XDG_DATA_HOME/compositz` (Linux/mac) · `%APPDATA%\compositz` (Win) | recipe store (`recipes/<id>/`), per-install overrides, settings |
| **Data-root**     | configurable; default `~/Compositz` (Win `%USERPROFILE%\Compositz`)  | per-app **host-visible** data (outputs) for **bind** mounts     |
| **Named volumes** | Docker-managed (`compositz_<id>_<name>` / shared cache volumes)      | everything else — large/internal data and caches                |

- A **bind** mount lands at `<data-root>/<id>/<name>` (host-browsable). A **volume** mount uses a
  per-mount named volume. Cache volumes are Compositz-managed (shared across apps where it makes
  sense). The host path is **derived from the mount `name`** — authors never write `${...}` paths.
- Cache mount paths are **injected as env vars** (see `cache[]`), so authors read e.g. `$HF_HOME`
  rather than hard-coding or configuring a path.

## Recipe sources (ingestion)

A recipe is a directory (`compositz.yaml` + `Dockerfile`/context, or an `image`-only manifest). It
is sourced into the **recipe store** (`<app-data>/recipes/<id>/`) from:

- **tar/zip bundle** — the recipe dir packed; uploaded/dropped in the UI.
- **GitHub** — `owner/repo[@ref][/subdir]`: download the codeload tarball over HTTPS, extract the
  (sub)dir, validate, store. **No `git` binary** — plain HTTP + `@std/tar`.
- **local dir** (dev) — the repo `recipes/`, importable / seeded.

Ingest = extract → **Zod-validate** → store. Building the image is the separate **Install** step.

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
  `volume`**) · `description`. bind ⇒ host `<data-root>/<id>/<name>`; volume ⇒
  `compositz_<id>_<name>`. `placement` is the author's default, **overridable per install**.
- **`cache[]`** (opt-in): presets `venv` (per-instance uv venv + co-located uv cache, one volume;
  injects `VIRTUAL_ENV` + `UV_CACHE_DIR`) and `huggingface` (shared; injects `HF_HOME`); plus
  `custom` (`name` + `env` + `scope: shared|instance`). The venv subpath is **fixed**
  `venvs/<id>/<instance>` (no per-recipe override — exceptions would explode the matrix).
  `COMPOSITZ_INSTANCE` is injected (default `default`), so per-instance caches/venvs are
  multi-instance-ready with no manifest change.
- **`env[]`**: `name` (required) · `description` · `required` (default false) · `default`.
  `required: true` ⇒ the user must confirm a value; `default` is a suggested/placeholder (the two
  coexist). Resolved to `NAME=value`.

Validation: `build` XOR `image`; `ports[].name` / `mounts[].name` / `env[].name` unique; `cache`
preset duplicates rejected (custom keyed by `name`); host-port conflicts resolved at install by
**auto-incrementing to a free port**, checked against existing instances.

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

The manifest is the author's **defaults**; the user's customizations live in a separate per-install
**override** (`<app-data>/config/<id>.yaml`) carrying only **values**: host-port remaps, env values,
per-mount `placement` (bind/volume) and bind host-path, and the data-root. At `up` the effective
spec is **derived** from _manifest ⊕ override_ — the manifest is never mutated.

## Increment plan

| Inc.     | Scope                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **RT**   | ✅ Docker `/events` real-time status (done & verified).                                                                                                                                                                                                            |
| **RI-1** | ✅ **Manifest v2** (Zod + recipe-format) + storage layout + data-root + bind/volume mounts (structured `Mounts` + `CreateMountpoint`) + cache provisioning & env injection + effective-spec derivation (manifest ⊕ launch override) in core. Done & live-verified. |
| **RI-2** | Recipe **store** + **tar/zip ingestion** (UI upload → extract → validate → store).                                                                                                                                                                                 |
| **RI-3** | **GitHub ingestion** (`owner/repo[@ref][/subdir]` → tarball → store).                                                                                                                                                                                              |
| **RI-4** | Per-install **override UI** (host-port remap w/ auto-suggest, env values, placement) + multi-web "Open UI" buttons.                                                                                                                                                |

## Open details

Resolved in RI-1 (now in [recipe-format.md](recipe-format.md) /
[ADR-015](decisions.md#adr-015--manifest-v2-core-structured-mounts--createmountpoint-managed-cache-layout--accepted-verified)):
the injected-env list per cache type, the in-container `/compositz` layout, per-OS default
data-root + app-data dir, and bind-source creation (daemon-side `CreateMountpoint`).

Still open for later increments:

- **Windows bind on Docker Desktop**: `CreateMountpoint` handles source creation, but Docker Desktop
  file-sharing for the data-root drive still needs first-run handling (RI-4 / packaging).
- **Live cache exercise**: no shipped recipe uses `venv`/`huggingface` yet, so those volumes/env are
  unit-tested but not yet machine-run end-to-end.
- **Authoring helper**: a **reference entrypoint** (uv-sync boilerplate using `$VIRTUAL_ENV` /
  `$UV_CACHE_DIR`) so recipes don't reinvent it — recipe-format appendix (future).
- RI-3: GitHub auth for private repos (public-only first cut).
- Multi-instance UI (run N of one recipe) is deferred; the schema is already instance-ready
  (`COMPOSITZ_INSTANCE`, per-instance venv subpath).
