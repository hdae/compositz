# Compositz

Run each local-AI app as **one isolated Docker container** — Pinokio's one-click UX with real
container isolation and Dockge-style management. Windows desktop app + Linux CLI.

> Status (2026-06): Phase 0 & 1 done and verified; Phase 2 (management UI) in progress —
> **`packages/ui`** (Fresh 2 / Vite) lists **instances** with live SSE status, up/down, and
> recipe-bundle import, calling `@compositz/core` in-process (the standalone Hono server was
> retired). Recipes are ingested into self-contained instances ([ADR-017](docs/decisions.md)). Full
> plan in **[docs/](docs/README.md)**.

## Documentation

The full plan lives in [`docs/`](docs/README.md): [architecture](docs/architecture.md) ·
[roadmap](docs/roadmap.md) · [decisions](docs/decisions.md) ·
[recipe format](docs/recipe-format.md).

## Layout

```
packages/core/      TypeScript library: Engine API client, transports, recipe model, ingestion + instance store
packages/cli/       Linux-first CLI (also the debugging surface) — finished first
packages/ui/        Fresh 2 (Vite) management UI; packaged as the desktop app by `deno desktop`
recipes/            Sample recipe bundles (Dockerfile + compositz.yaml) to import
spec/               Generated manifest JSON Schema
docs/               Plan & design docs
```

A recipe is **imported** to create a self-contained **instance** (the deployed unit, keyed by an
`instanceId`); there is no shared recipe store ([ADR-017](docs/decisions.md)). The `recipes/` dir
holds sample bundles you import.

## Requirements

- **Deno >= 2.9** (Windows named-pipe transport needs >= 2.6.2; Deno Desktop is 2.9).
- **Docker** (Engine API >= 1.43). On Windows, Docker Desktop with the WSL2 (Linux) engine.

## Quick start

```sh
# Health check: ping the engine + print versions
deno task doctor

# Full container round-trip: pull alpine -> run -> stream logs -> wait -> remove
deno task hello

# Instances: import a recipe bundle (dir or tar/tar.gz) → create an instance, then run it.
deno task cli import recipes/hello-web   # → instance "hello-web-<rand>"; prints the id
deno task cli ls                         # list instances in the store
deno task cli up hello-web-<rand>        # build (if needed) + start; prints http://localhost:8090/
deno task cli ps                         # list managed containers
deno task cli down hello-web-<rand>      # stop + remove the container
deno task cli rm   hello-web-<rand>      # remove the instance (container + definition; data kept)

# Management UI: Fresh 2 (Vite) dashboard — instance list + live status + up/down + bundle import.
# Calls @compositz/core in-process from route handlers (no separate API server).
deno task ui                      # dev server (prints the local URL)

# Desktop: the same Fresh management UI, packaged as a native window by `deno desktop`
# (framework auto-detection — no separate entrypoint; recipe ops happen in the UI).
deno task desktop:dev                   # build _fresh/ + run in a CEF window with HMR (dev)
deno task desktop                       # build a native app bundle → dist/compositz/ (a folder)
#   for a signed installer add a per-OS extension: --output …/compositz.msi (Win) / .AppImage (Linux)
```

The manager process runs **trusted** (`-A`): isolation is enforced at the _container_ boundary, not
the host process. On Windows the named-pipe transport requires `--allow-all` (a Deno node:net
constraint), which is consistent with that model.

> **Desktop app:** the desktop **is** the Fresh management UI (`packages/ui`) — `deno desktop`
> auto-detects the Fresh project and embeds its built `_fresh/` into one native binary (no separate
> entrypoint). See [ADR-016](docs/decisions.md).
>
> **Backend note:** the default `deno desktop` system-WebView2 backend currently crashes on launch
> (`0xC0000409`) — a laufey 0.4.0 ↔ WebView2 149 skew. We use `--backend cef` (bundled Chromium, no
> system dependency), verified working. Revisit the lighter WebView2 backend once fixed upstream
> (swap `--backend webview` on the desktop tasks to re-test).
