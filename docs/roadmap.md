# Roadmap

Status legend: ✅ done & verified · 🔄 in progress · ⏳ planned · ❓ open decision

## Phase 0 — Foundations PoC ✅

De-risk the two load-bearing unknowns before building.

- ✅ Core Engine API client over the transport abstraction: build → run → logs → stop on **Windows
  (node:net npipe)**. (Linux unix-socket path is code-symmetric; verify on a real Linux/CI host.)
- ✅ Deno Desktop opens a window and navigates to a running container's web UI.
- ✅ Permissions, chunked HTTP, multiplexed log framing characterized empirically.

## Phase 1 — Recipe → build → run ✅

- ✅ Manifest model (`compositz.yaml`) as a **Zod** schema → validator + types + generated JSON
  Schema.
- ✅ Recipe loader + in-memory tar build context (`@std/tar`).
- ✅ `EngineClient.build` (classic `POST /build`, streamed log).
- ✅ `toCreateSpec` (ports / env / volumes / GPU / labels) + `up` / `down` with GPU tri-state
  fallback.
- ✅ CLI `install` / `up` / `down` / `ps`; example recipe `recipes/hello-web`.
- ⏳ Build hardening: stream large contexts (not in-memory), honor `.dockerignore`, optional
  BuildKit. (Deferred — classic builder is sufficient for now.)

## Phase 2 — Management UI 🔄

- ✅ **Hono API server** (`packages/server`): `/api/health|recipes|containers`, `POST …/up|down`,
  SSE `/api/events` (live status) + install build-log stream. Verified live.
- ✅ **UI framework decided: Fresh 2 (Vite).** All three candidates (Start / Fresh / SvelteKit) were
  spiked on Deno 2.9.0; all are feasible for in-process `@compositz/core` with a clean client
  boundary, so the choice turned on Deno-nativeness. Fresh won (no `@deno/vite-plugin` bridge,
  cleanest `deno desktop` fit, Deno-aligned). See
  [decisions.md ADR-008](decisions.md#adr-008--ui-framework-fresh-2-vite--accepted).
- ✅ **`packages/ui` scaffolded (Increment 1)**: Fresh 2 (Vite) workspace member; a route handler
  calls `listRecipes()` + `EngineClient.ps()` **in-process** and renders a read-only recipe list
  (installed / running), degrading to an "engine offline" badge when Docker is unreachable.
  View-model derivation is a pure, Docker-free, unit-tested function. Workspace integration
  (membership mandatory, root `nodeModulesDir: "auto"`, server-only boundary fault-tested) in
  [decisions.md ADR-012](decisions.md#adr-012--packagesui-joins-the-deno-workspace-root-nodemodulesdir-auto--accepted-verified).
- ⏳ Build out the management UI (Increment 2+): install/up/down actions, live status, "open web
  UI", streamed build/run logs.
- ⏳ Desktop shell: list/launch recipes, embed each app's web UI (multi-window).
- ⏳ Live status channel: a Fresh route handler streams SSE (container status / build logs) from
  core's async-iterable streams; islands consume it via `EventSource`.

## Phase 3 — Hardening ⏳

- ⏳ **Shared model cache**: one named volume (HF_HOME / ~/.cache/huggingface / ~/.ollama) mounted
  into every container.
- ⏳ **Volume lifecycle & GC**: per-app named volumes; `gc --reclaim`; uv `repair` / `rebuild`
  wrappers (uv has no venv-aware GC or verify — Compositz wraps it).
- ⏳ **GPU runtime detection**: choose nvidia vs CDI from `/info` / `/version`.
- ⏳ **s6-overlay v3** multi-daemon recipe pattern + an example recipe.
- ⏳ **Strict isolation** opt-out per recipe (copy-mode cache, per-app cache) for troubleshooting.
- ⏳ **Version-pinning policy** (committed): uv.lock hash pin; base/CUDA image tags pinned (no
  `:latest`); Deno version pinned in CI; manifest `manifestVersion` with a min-platform gate.

## Phase 4 — Packaging & distribution ⏳

- ⏳ Windows packaging & **code signing** (`signtool` on the backend `.exe` + `denort.dll`).
- ⏳ **Auto-update**: Deno's updater is unix-only — an external updater is required on Windows (the
  primary platform).
- ⏳ Revisit the **WebView2 backend** once the upstream crash fix lands (Deno 2.9.1/2.9.2) to drop
  the ~440 MB CEF bundle for the lightweight system webview.
- ⏳ **Catalog**: static `index.json` generated from the recipe repo, served via CDN/GitHub.
- ⏳ **Recipe authoring tooling** for LLM agents (deferred; core currently just consumes recipes).

## Cross-cutting / always-on

- Keep the `/api` + SSE contract stable and versioned — it is the durable interface for the UI and a
  future headless `compositz serve`.
- Verify the Linux unix-socket path on a real Linux host / CI (only Windows is exercised today).
- Pin the Deno toolchain in CI (≥ 2.9).
