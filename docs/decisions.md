# Decision log

ADR-style. Each entry: status, the decision, why, and consequences. Newest concerns last.

---

## ADR-001 — One container per app; no Compose · ✅ Accepted

Each app is a single container. Multiple daemons inside one app use **s6-overlay v3**, not Docker
Compose.

**Why:** WSL-Containers / Podman compose support is unreliable; a single container is the portable
unit. s6-overlay gives real PID1, zombie reaping, and service dependencies.

**Consequences:** recipes describe one container. Multi-process apps ship an s6 service tree.

---

## ADR-002 — Hand-rolled Engine API client over a transport abstraction · ✅ Accepted (verified)

A minimal Docker Engine HTTP client on a `DuplexConn` seam: unix socket (Linux), `node:net` named
pipe (Windows), TCP fallback. Not `dockerode`.

**Why:** Windows named pipes aren't supported by `Deno.connect` but are by `node:net` (Deno ≥
2.6.2). A thin client keeps the dependency surface small and the transport swappable (future WSL
Containers / Podman). Target Engine API ≥ 1.43.

**Consequences:** we own HTTP framing (chunked / length / close), the 8-byte log demux, and the
classic build-stream parser. All verified against a live engine.

---

## ADR-003 — The manager is trusted; isolation is at the container boundary · ✅ Accepted

The CLI / server / desktop run with broad permissions (`-A`). Security is enforced by putting _apps_
in containers, not by sandboxing the manager.

**Why:** the manager legitimately needs Docker, filesystem, and network access. On Windows the npipe
transport in fact requires `--allow-all`. Pinokio's problem is uncontainerized _apps_, not manager
privilege.

**Consequences:** acceptable to run `-A`. Document it; don't pretend the manager is sandboxed.

---

## ADR-004 — GPU default-on, tri-state · ✅ Accepted

`gpu: required | preferred | none` in the manifest; default `preferred`. `preferred` tries a GPU and
falls back to CPU.

**Why:** local-AI apps usually want a GPU; opt-out is the right default. Tri-state covers the "nice
to have" middle.

**Consequences:** `--gpus all` shape is `{Driver:"", Count:-1, Capabilities:[["gpu"]]}`. CDI variant
available for Linux. nvidia-vs-CDI auto-detection is Phase 3.

---

## ADR-005 — Manifest = YAML authored, **Zod** validated (single source) · ✅ Accepted

`compositz.yaml` is authored in YAML and validated by a Zod schema that is the single source of
truth for the runtime validator, the inferred TS types, and the generated JSON Schema
(`z.toJSONSchema` → `spec/compositz.schema.json` via `deno task schema`).

**Why:** the user's prior approach (hand-written validator + separately-maintained JSON Schema)
meant two-source drift. Zod 4's `toJSONSchema` collapses them. Strict objects reject unknown keys
(catches typos in LLM-authored manifests). Zod bundles cleanly into `deno desktop`.

**Consequences:** `npm:zod` is a dependency. Manifest is versioned (`manifestVersion`).

---

## ADR-006 — uv runtime model: hardlink + co-located cache/venv + startup sync · ✅ Accepted

Resolve Python deps at container startup (`uv sync --frozen`), `UV_LINK_MODE=hardlink`, uv cache and
per-app venvs co-located on one persistent volume.

**Why (verified):** Astral discourages symlink mode (`uv cache clean` breaks installs). Hardlink +
co-location dedups wheels across apps and survives cache cleaning via inode refcounts. Plain
`uv sync` does not repair dangling links, so symlink self-heal is a myth; hardlink avoids the
problem. See the `compositz-uv-model` design note.

**Consequences:** Compositz provides `repair` / `rebuild` / `gc --reclaim` wrappers (uv has no
venv-aware GC or verify command).

---

## ADR-007 — Desktop = Deno Desktop; CEF backend for now · ✅ Accepted (interim)

The desktop app is Deno Desktop. We build with the **CEF backend** today, not the default system
WebView2.

**Why (verified):** the default WebView2/laufey backend crashes on window creation (`0xC0000409`) —
a laufey 0.4.0 ↔ WebView2 149 skew, fixed upstream in
[denoland/deno#35566](https://github.com/denoland/deno/pull/35566) (expected Deno 2.9.1/2.9.2). CEF
bundles its own Chromium (~440 MB), no system dependency, and renders the container UI today
(machine-verified). Core's npipe transport works inside the desktop runtime; build-time `-A` is
baked in.

**Consequences:** ship CEF for now; **revisit the lightweight WebView2 backend** once the fix lands
(Phase 4). `deno task desktop` builds CEF; `deno task desktop:webview` builds the (currently broken)
system-webview variant for re-testing.

---

## ADR-008 — UI framework · ❓ Under reconsideration

**Not yet decided.** The first evaluation leaned toward a React+Vite SPA + the standalone Hono API,
but that evaluation was **biased**: it judged fullstack frameworks (Fresh, TanStack Start) by "can
they do SPA," which is the wrong question and stacked the deck. Recorded here honestly rather than
locked in.

**Current state:**

- **TanStack Start** is the front-runner to evaluate. It is fullstack React on Vite/Nitro, **runs on
  Deno** (Nitro targets Deno; Deno's docs list it), and **`deno desktop` auto-detects it** (build,
  then `deno desktop .`; `--hmr` for dev). Its **server functions / loaders can call
  `@compositz/core` in-process** — which could remove the separate Hono API and fetch-client layer
  entirely. The user uses TanStack daily and wants to try it.
- The earlier argument that "the CLI reuses the same HTTP API" is weak — the CLI already calls core
  directly and does not need the HTTP API. So loose-HTTP-coupling is not a decisive reason for a
  separate API.
- **Fallback:** React + Vite SPA (TanStack Router + Query) consuming the existing Hono API over
  HTTP + SSE.
- Toolchain note: React + Vite on Deno needs `nodeModulesDir: "auto"` (the zero-node_modules
  Deno-native resolver does not support React).

**Open action:** spike TanStack Start on Deno **in an isolated environment** and decide. The npm
scaffold (`create-tsrouter-app`) hung when run directly on the dev machine — do heavy npm
scaffolding in isolation, not on the host.

**If we adopt Start:** the Hono server (`packages/server`) stays useful as a standalone headless API
(`compositz serve`) but may not be the desktop UI's data path.

---

## ADR-009 — Classic builder via `POST /build` · ✅ Accepted (verified)

Build images with the plain Engine API `POST /build` (classic builder), parsing the `{stream}` /
`{aux.ID}` stream.

**Why (verified):** plain `POST /build` returns the classic stream even with `DOCKER_BUILDKIT`
default — confirmed on the dev machine. Simpler than wiring a BuildKit session. Optional BuildKit is
a Phase 3 nicety.

---

## ADR-010 — Centralize the (tentative) name · ✅ Accepted

`compositz` is a working title. Project name, manifest filename, label namespace, and image
namespace live only in `packages/core/src/brand.ts`.

**Why:** the name will likely change; a rename must be a one-file edit, not a repo-wide grep.
