# Recipe format

> This documents the **live v1 manifest**. A breaking **v2** (mounts/cache/multi-web ports + author
> metadata) is agreed and lands in increment **RI-1** — see
> [recipe-ingestion.md](recipe-ingestion.md#manifest-v2-target-spec--implemented-in-ri-1). This file
> flips to v2 when RI-1 does.

A **recipe** is a directory under `recipes/<id>/` containing:

```
recipes/hello-web/
  compositz.yaml      # the manifest (this spec)
  Dockerfile          # how to build the image
  index.html          # any build-context assets
```

The manifest is authored in YAML and validated by a Zod schema
([`manifest.ts`](../packages/core/src/recipe/manifest.ts)), which is also the source of the
machine-readable JSON Schema at [`spec/compositz.schema.json`](../spec/compositz.schema.json)
(regenerate with `deno task schema`). Unknown keys are rejected.

## Fields

| Field              | Type                        | Req | Default      | Notes                                                       |
| ------------------ | --------------------------- | --- | ------------ | ----------------------------------------------------------- |
| `manifestVersion`  | `1`                         | ✅  | —            | Format version.                                             |
| `id`               | string                      | ✅  | —            | `^[a-z0-9][a-z0-9-]{0,62}$`. Image/container naming key.    |
| `name`             | string                      | ✅  | —            | Display name.                                               |
| `version`          | string                      | ✅  | —            | Recipe/image version (quote it: `"0.1.0"`).                 |
| `description`      | string                      |     | —            | One line.                                                   |
| `build.dockerfile` | string                      |     | `Dockerfile` | Dockerfile path within the recipe dir.                      |
| `build.args`       | map<string,string>          |     | —            | Docker build args.                                          |
| `web.port`         | int 1–65535                 |     | —            | Container port serving the web UI.                          |
| `web.hostPort`     | int 1–65535                 |     | = `web.port` | Host port to publish it on.                                 |
| `web.path`         | string                      |     | `/`          | UI path; used to build the open URL.                        |
| `ports[]`          | list                        |     | `[]`         | Additional ports: `{container, host?, protocol: tcp\|udp}`. |
| `env[]`            | list<string>                |     | `[]`         | `NAME=value` strings.                                       |
| `volumes[]`        | list                        |     | `[]`         | `{name, target}` → Compositz-managed named volume.          |
| `gpu`              | `required\|preferred\|none` |     | `preferred`  | GPU policy (see below).                                     |

## GPU policy

- `required` — always attach a GPU; fail to start if none is available.
- `preferred` — try with a GPU; **fall back to CPU** if attaching fails.
- `none` — never attach a GPU.

## Derived names

For a recipe `id: comfyui`, `version: "0.2.0"` (from `brand.ts`):

- image tag: `compositz/comfyui:0.2.0`
- container: `compositz-comfyui`
- a volume `models` → `compositz_comfyui_models`
- labels: `io.compositz.recipe=comfyui`, `io.compositz.managed=true`, `io.compositz.version=0.2.0`

## Example

```yaml
# recipes/hello-web/compositz.yaml
manifestVersion: 1
id: hello-web
name: Hello Web
version: "0.1.0"
description: Minimal static site that exercises the build -> run -> open flow.
web:
  port: 80
  hostPort: 8090
gpu: none
```

```dockerfile
# recipes/hello-web/Dockerfile
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
```

A fuller example (GPU app with volumes and build args):

```yaml
manifestVersion: 1
id: comfyui
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.
build:
  dockerfile: Dockerfile
  args:
    CUDA: "12.4"
web:
  port: 8188
env:
  - HF_HOME=/cache/huggingface
volumes:
  - name: models
    target: /root/.cache/huggingface
gpu: preferred
```

## Lifecycle

```sh
compositz install <id>   # build the image from the recipe
compositz up <id>        # build if needed, create + start; prints the web URL
compositz ps             # list managed containers
compositz down <id>      # stop + remove
```

## Build context

The whole recipe directory (minus the manifest and dotfiles) is packed into a tar and sent to
`POST /build`. The Dockerfile referenced by `build.dockerfile` must exist in the context. Recipes
are expected to be small; large contexts and `.dockerignore` support are a future enhancement.

## Notes for recipe authors (incl. LLM agents)

- Quote `version` so YAML doesn't coerce it to a number.
- Keep one container per recipe; use **s6-overlay v3** inside the image for multiple daemons.
- Pin base and CUDA image tags (no `:latest`) — a versioning policy is coming (Phase 3).
- `web:` is what the desktop app and `up` use to open/embed the UI; set it for anything with a
  browser UI.
