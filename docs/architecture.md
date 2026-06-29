# Architecture

## Overview

Compositz is a single Deno workspace. A TypeScript **core library** owns all Docker and recipe
logic; thin consumers (CLI and the Fresh UI) sit on top.

```
┌─────────────┐      ┌────────────────────────────┐
│   CLI       │      │  ui (Fresh 2 / Vite)        │
│ (Linux-1st) │      │  + desktop (deno desktop)   │
└──────┬──────┘      └─────────────┬──────────────┘
       │                           │  in-process core calls (route handlers)
       └─────────────┬─────────────┘
                     ▼
           ┌───────────────────┐
           │  @compositz/core  │  Engine client · recipes · operations
           └─────────┬─────────┘
                     ▼ transport abstraction
           ┌───────────────────┐
           │   Docker Engine    │  unix socket (Linux) / named pipe (Windows)
           └───────────────────┘
```

Every consumer **calls core directly, in-process**: the CLI from its commands, the UI from its Fresh
route handlers (server-only), and the desktop is that same Fresh app packaged by `deno desktop`. A
Hono API server was prototyped then retired ([ADR-013](decisions.md)) — a headless `compositz serve`
could revive that surface later if needed.

## Components

| Package | Responsibility                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`  | Docker Engine API client, transport abstraction, recipe/manifest model, **bundle ingestion + the instance store**, build, high-level operations (install/up/down)                                              |
| `cli`   | Linux-first command surface and the primary debugging tool                                                                                                                                                     |
| `ui`    | Management UI — **Fresh 2 (Vite)** ([ADR-008](decisions.md)); calls core in-process from route handlers (no separate API server). Packaged as the **desktop** app by `deno desktop` ([ADR-016](decisions.md)). |

## Docker transport abstraction

The seam that keeps Docker-specifics contained (so a future swap to WSL Containers / Podman stays
cheap). Everything above speaks plain HTTP/1.1 over a `DuplexConn`.

- `DuplexConn` — a minimal bidirectional byte stream (`write` / pull-based `read` / `close`).
- Endpoints: `unix` (Linux/macOS, native `Deno.connect`), `npipe` (Windows, via `node:net`), `tcp`
  (fallback). Resolved from `DOCKER_HOST` or a platform default. See
  [`transport.ts`](../packages/core/src/transport.ts).
- **Windows named pipe** is reached through Deno's `node:net` compat layer
  (`net.connect("\\\\.\\pipe\\docker_engine")`). `Deno.connect` does not support Windows named
  pipes; `node:net` does (since Deno 2.6.2).

On top of the transport, a hand-rolled minimal HTTP/1.1 client
([`http.ts`](../packages/core/src/http.ts)):

- One fresh connection per request with `Connection: close` — trivial framing, no keep-alive state,
  and streaming endpoints just stay open until EOF.
- A single buffered `ByteReader` spans the header/body boundary (so a hijacked log stream never
  loses its leading bytes).
- Body framing: `Transfer-Encoding: chunked`, `Content-Length`, or close-delimited.
- Helpers: `collect`, `readText`, `jsonLines` (newline-delimited JSON for build/pull progress).

`EngineClient` ([`engine/client.ts`](../packages/core/src/engine/client.ts)) is the typed surface:
`ping` · `version` · `pull` · `create` · `start` · `stop` · `wait` · `remove` · `inspect` · `logs` ·
`build` · `ps` · `imageExists`. Container logs are demultiplexed from Docker's 8-byte stream framing
([`engine/logs.ts`](../packages/core/src/engine/logs.ts)); TTY containers stream raw and bypass the
demuxer.

## Recipe pipeline

A **recipe** is a directory bundle: `compositz.yaml` (manifest) + `Dockerfile` + assets. It is
**ingested to create an instance** — the self-contained, deployed unit ([ADR-017](decisions.md)).
See [recipe-format.md](recipe-format.md) / [recipe-ingestion.md](recipe-ingestion.md).

```
bundle (tar/tar.gz/dir) ──ingestBundle──▶ extract(secure) + parseManifest(Zod) ─▶ <instanceId>/app/
                                                                                          │
Manifest ⊕ instanceId ──toCreateSpec──▶ ContainerCreateSpec ─▶ create+start ◀────────────┤
Dockerfile + assets ──tarContext(@std/tar)──▶ tar ──▶ POST /build ─▶ compositz/<instanceId> image
```

- **Manifest** ([`recipe/manifest.ts`](../packages/core/src/recipe/manifest.ts)) is a Zod schema —
  the single source of truth for the runtime validator, the inferred TS types, and the generated
  JSON Schema (`deno task schema` → [`spec/`](../spec/compositz.schema.json)).
- **Ingestion** ([`recipe/ingest.ts`](../packages/core/src/recipe/ingest.ts)) securely extracts a
  bundle (rejecting absolute / `..` / symlink / hardlink entries), Zod-validates it, mints an
  `instanceId` (`<appId>-<rand>`), and writes `<instancesDir>/<instanceId>/app/`.
  `duplicateInstance` copies only the bundle (not the data).
- **Instance store** ([`recipe/instance.ts`](../packages/core/src/recipe/instance.ts)) loads/lists
  instances from app-data ([`storage.ts`](../packages/core/src/storage.ts) `instancesDir()`); a
  **bundle loader** ([`recipe/loader.ts`](../packages/core/src/recipe/loader.ts)) reads the
  manifest + build context of one bundle into memory.
- **Build** ([`build.ts`](../packages/core/src/build.ts)) packs the context into a tar and
  `EngineClient.build` streams the classic `POST /build` log.
- **Run mapping** ([`recipe/run.ts`](../packages/core/src/recipe/run.ts)) translates the manifest +
  `instanceId` into a container spec (ports, env, volumes, GPU, labels) and derives the per-instance
  image tag / container name / web URL.
- **Operations** ([`recipe/operations.ts`](../packages/core/src/recipe/operations.ts)):
  `installInstance` (build/pull), `up` (create+start, GPU tri-state), `down` (stop+remove).

## Naming & branding

All externally-visible names live in [`brand.ts`](../packages/core/src/brand.ts) and key off the
**instance id** ([ADR-017](decisions.md)): image tag `compositz/<instanceId>:<version>` (a `build`
recipe; `image` recipes use the referenced image), container `compositz-<instanceId>`, volume
`compositz_<instanceId>_<name>`, labels `io.compositz.{instance,recipe,managed,version}` (`recipe`
carries the app id). Tentative — change here only.

## GPU model

GPU is **default-on (opt-out)**. The manifest declares `gpu: required | preferred | none`.

- `required` — always attach a GPU; fail if unavailable.
- `preferred` — try with GPU, **transparently fall back to CPU** on failure.
- `none` — never attach.

Attachment uses `HostConfig.DeviceRequests`. The canonical `--gpus all` shape is
`{ Driver: "", Count: -1, Capabilities: [["gpu"]] }` (empty driver; the daemon picks). A Linux CDI
variant (`{ Driver: "cdi", DeviceIDs: ["nvidia.com/gpu=all"] }`) is provided for Docker 28.3+ on
Linux. Runtime detection (nvidia vs CDI) is a Phase 3 item.

## Isolation & threat model

- The **app** runs in its own container — that is the isolation boundary, and the whole point vs
  Pinokio.
- The **manager** (the CLI and the Fresh UI / desktop) is **trusted** and runs with broad
  permissions. On Windows the `node:net` named-pipe transport in fact requires `--allow-all` (a Deno
  constraint); this is consistent with the model — the manager legitimately needs to spawn Docker,
  read/write files, and use the network.
- Per-recipe **strict isolation** (copy-mode caches, per-app volumes) is a deferred opt-out for
  troubleshooting (Phase 3).

## Python AI apps: the uv runtime model

For Python apps (most local-AI tools), dependency resolution uses **uv** with a verified model (see
the `compositz-uv-model` design note):

- Slim image; resolve at **container startup** (`uv sync --frozen`), not baked into the image.
- `UV_LINK_MODE=hardlink`, with the uv cache and per-app venvs **co-located on one persistent
  volume** so hardlinks dedup wheels across apps and survive `uv cache clean`.
- Repair is an explicit fallback (`uv sync --reinstall` only on a guarded import check).
- Multi-daemon containers use **s6-overlay v3** (real PID1, reaping, service deps) rather than
  compose — WSL-Containers compose support is unreliable, hence the single-container rule.

## Verified foundations (empirical, on the dev machine 2026-06-28)

These were proven against a live Docker Desktop (Engine API 1.54), not just designed:

- **Windows npipe → Engine HTTP** via `node:net` works (`/_ping` → 200). The previously feared
  Windows blocker is gone. Requires `--allow-all`.
- **Full container round-trip** (pull → create → start → streamed multiplexed logs → wait → remove)
  works through the hand-rolled client.
- **`POST /build`** with an `@std/tar` context returns the **classic builder** stream (`{stream}` +
  terminal `{aux.ID}`), not BuildKit — the parser matches.
- **Deno Desktop**: `deno desktop` **auto-detects the Fresh app** (`packages/ui`) and embeds its
  built `_fresh/` into one native binary ([ADR-016](decisions.md)); core's npipe transport works
  _inside_ the desktop runtime; `npm:zod` bundles in. The default **WebView2 backend crashes**
  (`0xC0000409`, a laufey 0.4.0 ↔ WebView2 149 skew, fixed upstream in
  [denoland/deno#35566](https://github.com/denoland/deno/pull/35566), canary-only); the **CEF
  backend renders** today (verified: builds `dist/compositz.AppImage`, and the PoC read back the
  served page `document.title`).
