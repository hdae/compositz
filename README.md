# Compositz

Run each local-AI app as **one isolated Docker container** — Pinokio's one-click UX with real
container isolation and Dockge-style management. Windows desktop app + Linux CLI.

> Status (2026-06): Phase 0 & 1 done and verified; Phase 2 (management UI) in progress — Hono API
> done, and **`packages/ui`** (Fresh 2 / Vite) scaffolded with a read-only recipe list (Increment
> 1). Full plan in **[docs/](docs/README.md)**.

## Documentation

The full plan lives in [`docs/`](docs/README.md): [architecture](docs/architecture.md) ·
[roadmap](docs/roadmap.md) · [decisions](docs/decisions.md) ·
[recipe format](docs/recipe-format.md).

## Layout

```
packages/core/      TypeScript library: Docker Engine API client, transports, recipe model
packages/cli/       Linux-first CLI (also the debugging surface) — finished first
packages/server/    Hono backend wrapping core (/api + SSE)
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

# API server: Hono backend wrapping core (REST + SSE). Backs both the desktop UI
# and a future `compositz serve`. Same API the CLI uses.
deno task serve                         # http://localhost:8787  (/api/* + SSE)

# Desktop: build the app, then run the launcher. It brings a recipe up and embeds
# its web UI in a native window (default recipe: hello-web).
deno task desktop                       # builds dist/compositz-cef/
dist\compositz-cef\compositz-cef.bat    # launches the window (CEF backend)
#   COMPOSITZ_RECIPE_DIR=<abs path>     # pick a different recipe
```

The manager process runs **trusted** (`-A`): isolation is enforced at the _container_ boundary, not
the host process. On Windows the named-pipe transport requires `--allow-all` (a Deno node:net
constraint), which is consistent with that model.

> **Desktop backend note:** the default `deno desktop` system-WebView2 backend currently crashes on
> launch (`0xC0000409`) — a version skew between the experimental laufey 0.4.0 backend and
> WebView2 149. We build with `--backend cef` (bundled Chromium, no system dependency), which is
> verified working. Revisit the lighter WebView2 backend once the compat issue is fixed upstream.
> `deno task desktop:webview` builds the (currently broken) WebView2 variant for re-testing.
