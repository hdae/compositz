# Compositz — Plan & Design Docs

> **Working title.** `compositz` is a tentative name; the project name, manifest filename
> (`compositz.yaml`), and Docker label namespace (`io.compositz.*`) may change. They are centralized
> in [`packages/core/src/brand.ts`](../packages/core/src/brand.ts) so a rename is a one-file edit.

Compositz runs each local-AI app as **one isolated Docker container** — combining Pinokio's
one-click install UX with real container isolation and Dockge-style management. **Windows desktop
app + Linux CLI.**

The differentiator vs Pinokio: Pinokio runs apps uncontainerized, directly on the host (a security
risk). Compositz puts every app in its own container, so the isolation boundary is structural. The
_manager_ is trusted; the _apps_ are sandboxed.

## Documents

| Doc                                  | What's in it                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)   | Components, the Docker transport, the recipe pipeline, GPU, the uv runtime model, verified foundations |
| [roadmap.md](roadmap.md)             | Phase 0–4 with current status and concrete next steps                                                  |
| [decisions.md](decisions.md)         | Decision log (ADR-style) with rationale and evidence                                                   |
| [recipe-format.md](recipe-format.md) | The `compositz.yaml` manifest spec + authoring guide                                                   |

## Status at a glance (2026-06-28)

| Component          | Status                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | ✅ Implemented + tested (30 unit tests). Docker Engine client, transports, recipe model (Zod), build, operations                                                                 |
| `packages/cli`     | ✅ `doctor` / `install` / `up` / `down` / `ps` / `hello` — verified against the live engine                                                                                      |
| `packages/server`  | ✅ Hono `/api` + SSE — verified against the live engine                                                                                                                          |
| `packages/desktop` | ✅ Deno Desktop (CEF) recipe-driven launch — renders a recipe's web UI (machine-verified). WebView2 backend blocked on an upstream Deno fix                                      |
| `packages/ui`      | ⏳ Not started — **UI framework decision in progress** (TanStack Start is the front-runner; see [decisions.md ADR-008](decisions.md#adr-008-ui-framework-under-reconsideration)) |

| Phase                                                                                    | Status                                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **0 — Foundations PoC** (Docker control on Win+Linux; Deno Desktop window)               | ✅ Done, empirically verified                                    |
| **1 — Recipe → build → run**                                                             | ✅ Core flow done, verified                                      |
| **2 — Management UI**                                                                    | 🔄 In progress (Hono server done; UI pending framework decision) |
| **3 — Hardening** (shared cache, volumes/GC, GPU detection, s6 multi-daemon, versioning) | ⏳ Planned                                                       |
| **4 — Packaging & distribution** (signing, update, catalog, recipe tooling)              | ⏳ Planned                                                       |

## Quick start

```sh
deno task doctor                  # ping the engine, print versions
deno task hello                   # full container round-trip
deno task cli install hello-web   # build an image from recipes/hello-web/
deno task cli up hello-web        # run it; prints http://localhost:8090/
deno task serve                   # Hono API + SSE on :8787
deno task desktop                 # build the CEF desktop app (run dist/compositz-cef/compositz-cef.bat)
```

Requires **Deno ≥ 2.9** and **Docker** (Engine API ≥ 1.43; on Windows, Docker Desktop with the WSL2
Linux engine).

## Repository layout

```
packages/core/      TypeScript library: Engine API client, transports, recipe model, operations
packages/cli/       Linux-first CLI (also the debugging surface)
packages/server/    Hono backend wrapping core (/api + SSE) — shared by desktop & a future `compositz serve`
packages/desktop/   Deno Desktop app (Windows-first); embeds container web UIs in a native window
packages/ui/        Management UI SPA (planned)
recipes/            Recipe definitions (compositz.yaml + Dockerfile + assets)
spec/               Generated JSON Schema for the manifest
scripts/            Dev scripts (e.g. schema generation)
docs/               This documentation
```
