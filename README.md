# Compositz

Run each local-AI app as **one isolated Docker container** — Pinokio's one-click UX with
real container isolation and Dockge-style management. Windows desktop app (Tauri 2) +
Linux CLI.

> Status (2026-07): migrated to **Tauri 2 + Rust core (bollard) + React** and at full
> feature parity — recipe import (file / drag-drop / GitHub), trust-gated install with
> live build log, up/down, per-instance settings, runtime logs, delete with volume
> semantics + export safety valve. Pre-release: no packaging/signing yet.

## Documentation

The design docs live in [`docs/`](docs/README.md): [architecture](docs/architecture.md) ·
[roadmap](docs/roadmap.md) · [decisions](docs/decisions.md) ·
[recipe format](docs/recipe-format.md) · [recipe ingestion](docs/recipe-ingestion.md).

## Layout

```
crates/core/        Rust library: bollard engine access, recipe model, ingestion + instance store, operations, views
crates/cli/         `compositz` — Linux-first CLI (also the debugging surface)
crates/desktop/     Tauri 2 desktop backend (IPC commands + push streams)
frontend/           React SPA for the desktop webview (vite-plus, Tailwind, shadcn/Base UI)
recipes/            Sample recipe bundles (compositz.yaml + Dockerfile) to import
spec/               JSON Schema for the manifest (generated from the Rust types)
docs/               Design docs, ADRs, known issues
```

A recipe is **imported** to create a self-contained **instance** (the deployed unit,
keyed by an `instanceId`); there is no shared recipe store
([ADR-017](docs/decisions.md)). The `recipes/` dir holds sample bundles you import.

## Requirements

- **Rust** (stable) for the CLI / core; the desktop crate additionally needs a WebView
  toolchain (on this repo's dev container: `nix develop`, which provides webkit2gtk —
  Windows installers build in CI).
- **Node 24 + pnpm** for `frontend/`.
- **Docker** (Engine API ≥ 1.43). On Windows, Docker Desktop with the WSL2 engine.

## Quick start (CLI)

```sh
cargo build                              # builds core + cli (desktop is CI / nix-shell)
alias compositz='cargo run -q -p compositz-cli --'

compositz doctor                         # ping the engine + print versions
compositz import recipes/hello-web      # ingest a bundle → instance "hello-web-<rand>"
compositz ls                             # list instances in the store
compositz up hello-web-<rand>            # build (if needed) + start; prints the web URL
compositz ps                             # list managed containers
compositz down hello-web-<rand>          # stop + remove the container
compositz export hello-web-<rand> <mount> out.tar   # tar a data mount (safety valve)
compositz rm hello-web-<rand>            # remove instance + data volumes (--keep-data / --purge)
compositz import github:owner/repo[/subdir][@ref]   # ingest straight from GitHub
```

`COMPOSITZ_DOCKER_HOST` overrides the engine endpoint (`tcp://…`, `unix://…`,
`npipe:….`); unset, the platform default is used.

## Desktop / frontend development

```sh
pnpm -C frontend install
pnpm -C frontend dev        # browser dev against a mock backend (no Rust/Docker needed)
pnpm -C frontend check      # format + lint + typecheck
```

The real desktop app (Rust backend + webview) is exercised via the CI-built Windows
installers, or locally with `nix develop -c cargo tauri dev` where a WebView toolchain
exists. See [frontend/README.md](frontend/README.md) for the IPC seam.

The manager process is **trusted**: isolation is enforced at the _container_ boundary,
not the host process, and recipes are trust-gated at import (a Dockerfile build runs
arbitrary code — see [ADR-020](docs/decisions.md)).
