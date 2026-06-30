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

| Doc                                        | What's in it                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)         | Components, the Docker transport, the recipe pipeline, GPU, the uv runtime model, verified foundations |
| [roadmap.md](roadmap.md)                   | Phase 0–4 with current status and concrete next steps                                                  |
| [decisions.md](decisions.md)               | Decision log (ADR-style) with rationale and evidence                                                   |
| [recipe-format.md](recipe-format.md)       | The `compositz.yaml` manifest spec + authoring guide                                                   |
| [recipe-ingestion.md](recipe-ingestion.md) | Recipe sourcing (tar/GitHub), instance-centric storage, launch config + increment plan                 |
| [known-issues.md](known-issues.md)         | Open / being-worked problems                                                                           |

## Status at a glance (2026-06-30)

| Component       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | ✅ Implemented + tested. Docker Engine client, transports, recipe model (Zod), **bundle ingestion + instance store** (instance-centric, [ADR-017](decisions.md)), build, operations                                                                                                                                                                                                                                                                 |
| `packages/cli`  | ✅ `doctor` / `import` / `ls` / `duplicate` / `install` / `up` / `down` / `rm` / `ps` / `hello` — verified against the live engine                                                                                                                                                                                                                                                                                                                  |
| `packages/ui`   | 🔄 **Fresh 2 (Vite): instance list + live SSE status + up/down + install-with-build-log + recipe-bundle import** — all via in-process `@compositz/core` from route handlers (see [ADR-008](decisions.md#adr-008--ui-framework-fresh-2-vite--accepted) / [ADR-013](decisions.md#adr-013--retire-packagesserver-hono-the-ui-calls-core-in-process--accepted-reversible)). Packaged as the **desktop** app by `deno desktop` ([ADR-016](decisions.md)) |

| Phase                                                                                    | Status                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundations PoC** (Docker control on Win+Linux; Deno Desktop window)               | ✅ Done, empirically verified                                                                                                                                                                                                                                               |
| **1 — Recipe → build → run**                                                             | ✅ Core flow done, verified                                                                                                                                                                                                                                                 |
| **2 — Management UI**                                                                    | 🔄 In progress — `packages/ui` (Fresh 2/Vite): instance list + live status + up/down + install build-log + **RI-2 tar/tar.gz/dir ingestion** + **RI-3 GitHub sourcing** done (core + CLI + UI "From GitHub" modal, ADR-021). Next: RI-4 override UI. Hono retired (ADR-013) |
| **3 — Hardening** (shared cache, volumes/GC, GPU detection, s6 multi-daemon, versioning) | ⏳ Planned                                                                                                                                                                                                                                                                  |
| **4 — Packaging & distribution** (signing, update, catalog, recipe tooling)              | ⏳ Planned                                                                                                                                                                                                                                                                  |

## Quick start

```sh
deno task doctor                       # ping the engine, print versions
deno task hello                        # full container round-trip
deno task cli import recipes/hello-web # ingest a bundle → instance "hello-web-<rand>"
deno task cli up hello-web-<rand>      # build + run it; prints http://localhost:8090/
deno task ui                           # management UI (instance list + import)
deno task desktop                      # build the CEF desktop app bundle → dist/compositz/
```

Requires **Deno ≥ 2.9** and **Docker** (Engine API ≥ 1.43; on Windows, Docker Desktop with the WSL2
Linux engine).

## Repository layout

```
packages/core/      TypeScript library: Engine API client, transports, recipe model, ingestion + instance store, operations
packages/cli/       Linux-first CLI (also the debugging surface)
packages/ui/        Management UI (Fresh 2 / Vite) — in-process @compositz/core; packaged as the desktop app by `deno desktop`
recipes/            Sample recipe bundles (compositz.yaml + Dockerfile + assets) to import
spec/               Generated JSON Schema for the manifest
scripts/            Dev scripts (e.g. schema generation)
docs/               This documentation
```
