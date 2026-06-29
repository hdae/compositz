# Compositz

Run each local-AI app as **one isolated Docker container** — Pinokio's one-click UX with real
container isolation and Dockge-style management. Windows desktop app + Linux CLI.

> Status (2026-06): Phase 0 & 1 done and verified; Phase 2 (management UI) in progress —
> **`packages/ui`** (Fresh 2 / Vite) lists recipes with live SSE status and up/down actions, calling
> `@compositz/core` in-process (the standalone Hono server was retired). Full plan in
> **[docs/](docs/README.md)**.

## Documentation

The full plan lives in [`docs/`](docs/README.md): [architecture](docs/architecture.md) ·
[roadmap](docs/roadmap.md) · [decisions](docs/decisions.md) ·
[recipe format](docs/recipe-format.md).

## Layout

```
packages/core/      TypeScript library: Docker Engine API client, transports, recipe model
packages/cli/       Linux-first CLI (also the debugging surface) — finished first
packages/desktop/   Deno Desktop app (Windows-first), embeds container web UIs
recipes/            Recipe definitions (Dockerfile + compositz.yaml manifest)
spec/               Generated manifest JSON Schema
docs/               Plan & design docs
```

## Requirements

- **Deno >= 2.9** (Windows named-pipe transport needs >= 2.6.2; Deno Desktop is 2.9).
- **Docker** (Engine API >= 1.43). On Windows, Docker Desktop with the WSL2 (Linux) engine.

## Quick start

```sh
# Health check: ping the engine + print versions
deno task doctor

# Full container round-trip: pull alpine -> run -> stream logs -> wait -> remove
deno task hello

# Recipes: build an image from recipes/<id>/ and run it.
deno task cli install hello-web   # build compositz/hello-web:0.1.0 from the recipe
deno task cli up hello-web        # start it; prints http://localhost:8090/
deno task cli ps                  # list managed containers
deno task cli down hello-web      # stop + remove

# Management UI: Fresh 2 (Vite) dashboard — recipe list + live status + up/down.
# Calls @compositz/core in-process from route handlers (no separate API server).
deno task ui                      # dev server (prints the local URL)

# Desktop: the same Fresh management UI, packaged as a native window by `deno desktop`
# (framework auto-detection — no separate entrypoint; recipe ops happen in the UI).
deno task desktop:dev                   # run in a CEF window with HMR (dev)
deno task desktop                       # build a native app → dist/compositz.AppImage
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
