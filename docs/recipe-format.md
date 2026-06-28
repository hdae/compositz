# Recipe format

> This documents the **live v2 manifest** (`manifestVersion: 2`), implemented in increment RI-1. v1
> is gone (the project is unreleased — breaking, no migration). The ingestion/storage/launch design
> around it is in [recipe-ingestion.md](recipe-ingestion.md); the decisions are
> [ADR-014](decisions.md#adr-014--recipe-sourcing-3-tier-storage--manifest-v2--accepted) /
> [ADR-015](decisions.md#adr-015--manifest-v2-core-structured-mounts--createmountpoint-managed-cache-layout--accepted-verified).

A **recipe** is a directory under `recipes/<id>/` containing:

```
recipes/hello-web/
  compositz.yaml      # the manifest (this spec)
  Dockerfile          # how to build the image (omit for an image-based recipe)
  index.html          # any build-context assets
```

The manifest is authored in YAML and validated by a Zod schema
([`manifest.ts`](../packages/core/src/recipe/manifest.ts)), which is also the source of the
machine-readable JSON Schema at [`spec/compositz.schema.json`](../spec/compositz.schema.json)
(regenerate with `deno task schema`). Unknown keys are rejected.

Every field maps to a Docker runtime concept plus light author metadata (`name` / `description` /
`required`) — not a parallel config DSL.

## Fields

| Field             | Type                        | Req | Default     | Notes                                                                              |
| ----------------- | --------------------------- | --- | ----------- | ---------------------------------------------------------------------------------- |
| `manifestVersion` | `2`                         | ✅  | —           | Format version.                                                                    |
| `id`              | string                      | ✅  | —           | `^[a-z0-9][a-z0-9-]{0,62}$`. Image/container/data/label key.                       |
| `name`            | string                      | ✅  | —           | Display name.                                                                      |
| `version`         | string                      | ✅  | —           | Recipe/image version (quote it: `"0.1.0"`).                                        |
| `description`     | string                      |     | —           | One line.                                                                          |
| `build`           | object                      | ⬩   | —           | Build from a Dockerfile. **XOR `image`.** `dockerfile` (def `Dockerfile`), `args`. |
| `image`           | string                      | ⬩   | —           | Run a prebuilt image. **XOR `build`.**                                             |
| `ports[]`         | list                        |     | `[]`        | See [Ports](#ports).                                                               |
| `mounts[]`        | list                        |     | `[]`        | Persisted data. See [Mounts](#mounts).                                             |
| `cache[]`         | list                        |     | `[]`        | Opt-in managed caches. See [Caches](#caches).                                      |
| `env[]`           | list                        |     | `[]`        | See [Env](#env).                                                                   |
| `gpu`             | `required\|preferred\|none` |     | `preferred` | GPU policy (see below).                                                            |

⬩ Exactly one of `build` / `image` is required.

Names (`ports[].name`, `mounts[].name`, custom `cache.name`) are `^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`
— they flow into host paths and volume names, so dots and slashes are rejected (no traversal). Env
names are POSIX (`^[A-Za-z_][A-Za-z0-9_]*$`). `version` is constrained to the Docker image-tag
charset. Within a recipe, port/mount/env **names** are unique, and mount **targets** are unique
(including against the managed cache paths under `/compositz`); `ports[].path` and `mounts[].target`
must be absolute (start with `/`).

### Ports

`{ name, container, host?, protocol?, web?, path?, description? }`

| Key           | Req | Default       | Notes                                                                   |
| ------------- | --- | ------------- | ----------------------------------------------------------------------- |
| `name`        | ✅  | —             | Stable key: UI label + per-install override key.                        |
| `container`   | ✅  | —             | Port the app listens on inside the container.                           |
| `host`        |     | = `container` | Host port to publish on; **auto-bumped** if already in use.             |
| `protocol`    |     | `tcp`         | `tcp` \| `udp`.                                                         |
| `web`         |     | `false`       | Serves a browser UI → an "Open UI" button. **Multiple `true` allowed.** |
| `path`        |     | `/`           | UI path, used to build the open URL.                                    |
| `description` |     | —             | Author note.                                                            |

### Mounts

`{ name, target, placement?, description? }` — declaring a mount makes that data **persist**.

| Key           | Req | Default  | Notes                                                                                                                                                   |
| ------------- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | ✅  | —        | Host subdir / volume suffix.                                                                                                                            |
| `target`      | ✅  | —        | In-container mount path (absolute).                                                                                                                     |
| `placement`   |     | `volume` | `bind` → host `<data-root>/<id>/<name>` (browsable, slow on Windows); `volume` → managed named volume `compositz_<id>_<name>`. Overridable per install. |
| `description` |     | —        | Author note.                                                                                                                                            |

### Caches

Opt-in, Compositz-managed. The **path is injected as an env var** — authors never set it. Cache
volumes are shared across apps where it makes sense (uv/HF), giving cross-app dedup.

| Entry                                 | Volume                   | In-container path         | Injects                                                                                           |
| ------------------------------------- | ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `{ type: venv }`                      | `compositz_uv`           | `/compositz/uv`           | `UV_CACHE_DIR=/compositz/uv/cache`, `VIRTUAL_ENV=/compositz/uv/venvs/<id>/<instance>`             |
| `{ type: huggingface }`               | `compositz_hf`           | `/compositz/hf`           | `HF_HOME=/compositz/hf`                                                                           |
| `{ type: custom, name, env, scope? }` | `compositz_cache_<name>` | `/compositz/cache/<name>` | `<env>` = that path (`scope: shared`, default) or a `<id>/<instance>` subpath (`scope: instance`) |

The `venv` preset keeps the uv venv **and** the uv cache on one volume so uv's hardlink dedup works
([ADR-006](decisions.md#adr-006--uv-venv-hardlink-constraint--accepted)). At most one of each
preset; `custom` is keyed by `name`.

### Env

`{ name, description?, required?, default? }` — resolved to `NAME=value` at launch.

- `required: true` (default false) ⇒ the user must confirm a value before launch (enforced by the
  override UI in RI-4).
- `default` ⇒ a suggested/placeholder value (coexists with `required`).
- Managed cache/instance vars (e.g. `HF_HOME`, `COMPOSITZ_INSTANCE`) **override** a colliding user
  var.

## GPU policy

- `required` — always attach a GPU; fail to start if none is available.
- `preferred` — try with a GPU; **fall back to CPU** if attaching fails.
- `none` — never attach a GPU.

## Derived names

For a recipe `id: comfyui`, `version: "0.2.0"`:

- image tag: `compositz/comfyui:0.2.0` (a `build` recipe) — an `image` recipe runs that reference
  as-is.
- container: `compositz-comfyui`
- a `volume` mount `models` → `compositz_comfyui_models`; a `bind` mount `output` → host
  `<data-root>/comfyui/output`
- labels: `io.compositz.recipe=comfyui`, `io.compositz.managed=true`, `io.compositz.version=0.2.0`,
  `io.compositz.instance=default`
- every container also gets `COMPOSITZ_INSTANCE=<instance>` (default `default`;
  multi-instance-ready).

## Example

```yaml
# recipes/hello-web/compositz.yaml
manifestVersion: 2
id: hello-web
name: Hello Web
version: "0.1.0"
description: Minimal static site that exercises the build -> run -> open flow.
build: {}
ports:
  - name: web
    container: 80
    host: 8090
    web: true
    description: Static hello page.
gpu: none
```

```dockerfile
# recipes/hello-web/Dockerfile
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
```

A fuller example (GPU app with mounts, caches, build args, env):

```yaml
manifestVersion: 2
id: comfyui
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.
build:
  dockerfile: Dockerfile
  args:
    CUDA: "12.4"
ports:
  - name: ui
    container: 8188
    web: true
    description: Web UI.
mounts:
  - name: output
    target: /app/output
    placement: bind # host-visible generated images
    description: Generated images.
  - name: models
    target: /app/models # placement omitted => managed volume
    description: Checkpoints / LoRAs.
cache:
  - type: venv # injects VIRTUAL_ENV + UV_CACHE_DIR
  - type: huggingface # injects HF_HOME
env:
  - name: HF_TOKEN
    description: HuggingFace token for gated models.
    required: false
gpu: preferred
```

An image-based recipe (no Dockerfile, no build context):

```yaml
manifestVersion: 2
id: ollama
name: Ollama
version: "0.6.0"
image: ollama/ollama:0.6.0
ports:
  - name: api
    container: 11434
gpu: preferred
```

## Lifecycle

```sh
compositz install <id>   # build the image (or pull, for an image-based recipe)
compositz up <id>        # build/pull if needed, create + start; prints the web URL
compositz ps             # list managed containers
compositz down <id>      # stop + remove the container (persisted mounts survive)
```

## Build context

The whole recipe directory (minus the manifest and dotfiles) is packed into a tar and sent to
`POST /build`. The Dockerfile referenced by `build.dockerfile` must exist in the context. An
`image`-based recipe has no build context. Recipes are expected to be small; large contexts and
`.dockerignore` support are a future enhancement.

## Notes for recipe authors (incl. LLM agents)

- Quote `version` so YAML doesn't coerce it to a number.
- Keep one container per recipe; use **s6-overlay v3** inside the image for multiple daemons.
- Pin base and CUDA image tags (no `:latest`) — a versioning policy is coming (Phase 3).
- Set `web: true` on every port with a browser UI; the desktop app / `up` open or embed it.
- Don't bake Python packages or CUDA into the image — add `cache: [{ type: venv }]` and let uv
  populate the shared venv/cache at runtime via `$VIRTUAL_ENV` / `$UV_CACHE_DIR` (a reference
  entrypoint helper is planned).
