# Roadmap

Status legend: ✅ done & verified · 🔄 in progress · ⏳ planned · 💡 idea

## Done — foundations through migration

The project reached feature parity twice: first on the Deno/Fresh prototype stack
(where the recipe model, instance-centric storage, trust gate, deletion/export
semantics, and definition-driven ports were designed and live-verified — ADR-001…027),
then ported wholesale to **Tauri 2 + Rust core + React** ([ADR-028](decisions.md)) and
re-verified on Windows. Highlights of what ships today:

- ✅ **Recipe → instance pipeline**: manifest v2, contained tar/tar.gz extraction,
  GitHub sourcing (`owner/repo[/subdir][@ref]`), atomic publish, per-instance images.
- ✅ **Full CLI** (`doctor` / `hello` / `import` / `ls` / `duplicate` / `install` /
  `up` / `down` / `rm` / `ps` / `export`) with boundary id validation on every
  destructive path.
- ✅ **Desktop app**: typed IPC (generated bindings), live snapshots over Channels,
  trust-gated import (file / drag-drop / GitHub), install with streamed build log,
  runtime logs, Settings (ports / env / placement, restart-needed detection), delete
  with volume semantics + export safety valve, duplicate, dark mode.
- ✅ **Shared caches** (`venv` / `huggingface` / `custom` presets) via create-time env
  injection, exercised end-to-end on a real GPU host ([ADR-024](decisions.md)).
- ✅ **Readiness** = HTTP probe + action-driven tab flow ([ADR-026](decisions.md)).

## Phase 3 — Hardening ⏳ (current)

- ⏳ **In-place instance update** (user wish; frozen during the migration, now the
  headline item): re-ingest a new ref/commit into the SAME instance (`meta.source`
  already round-trips `github:owner/repo[/subdir][@ref]`) keeping instanceId / volumes /
  `config.yaml`, behind a **re-trust gate** (new code = new trust, ADR-020) + image
  rebuild. Companions: provenance display (below), user-facing **build args** (a
  "rebuild needed" state next to ADR-023's "restart needed"), and an opt-in
  `--no-cache` rebuild action (build cache stays ON by default — user decision;
  `BuildOptions.noCache` is wired in core but nothing sets it).
- ⏳ **Instance label + provenance display**: `meta.source`/`createdAt` are persisted
  but shown only in the trust dialog. Surface source/ref/age in `ls` and the UI row,
  and let the user edit the per-instance display name (`meta.name` exists — duplicates
  set it to "<name> (copy)" — but there is no rename UI yet). The display prerequisite
  for in-place update.
- ⏳ **Volume lifecycle & GC**: `volumes prune` for already-orphaned volumes (see
  [known-issues.md](known-issues.md)); `gc --reclaim` for venv-subpath orphans; uv
  `repair` / `rebuild` wrappers. A read-only **disk-usage view** (images / volumes /
  shared caches — tens of GB with cocktail-class apps) stages BEFORE any destructive
  reclaim UI.
- ⏳ **CLI parity — `config` + `logs`**: the per-instance override and log streaming
  are desktop-only; core has everything — headless Linux needs thin
  `compositz config` / `compositz logs [-f]` wrappers.
- ⏳ **Manifest expressiveness for AI workloads**: `shmSize` (Docker's 64 MB `/dev/shm`
  default OOM-kills multi-worker PyTorch DataLoaders; `ipc: host` is **rejected** — it
  punches an isolation hole), `healthcheck` (declarative readiness for non-HTTP apps),
  `stopGracePeriod`/`stopSignal` (`down` SIGKILLs after Docker's 10 s default — deadly
  mid-checkpoint; `stop_container`'s timeout plumbing exists with zero callers), opt-in
  `restartPolicy` (nothing survives a host reboot today), `secret: true` env flag
  (presentation-only: masked Settings input, excluded from future export/share —
  `HF_TOKEN`-class tokens are first-class in local AI; OS-keychain integration is NOT
  planned), memory/CPU limits (speculative — only on demand).
- ⏳ **Ops visibility**: crashed ≠ stopped status, GPU-fallback badge, pull layer
  progress, persistent build logs (all tracked in [known-issues.md](known-issues.md)).
- ⏳ **GPU runtime detection**: choose nvidia vs CDI from `/info` / `/version`.
- ⏳ **s6-overlay v3** multi-daemon recipe pattern + an example recipe.
- ⏳ **Strict isolation** opt-out per recipe (copy-mode cache, per-app cache) for
  troubleshooting.
- ⏳ **Version-pinning policy** (committed): uv.lock hash pin; base/CUDA image tags
  pinned (no `:latest`); toolchains pinned in CI; manifest `manifestVersion` with a
  min-platform gate.

## Phase 4 — Packaging & distribution ⏳

- ⏳ Windows **code signing** (CI already builds unsigned NSIS/MSI installers;
  SmartScreen warns until signed).
- ⏳ **Auto-update** via the Tauri updater plugin (needs a signing key — deferred to
  release prep).
- ⏳ **Catalog**: static `index.json` generated from a recipe repo, served via
  CDN/GitHub.
- ⏳ **Recipe authoring tooling** for LLM agents (the JSON Schema at `spec/` is the
  seed; core currently just consumes recipes).
- 💡 **Multi-window**: embed a running app's web UI as a secondary Tauri window
  instead of jumping to the browser.
- 💡 **Remote sharing via tunnel** (user wish): expose a running app's web port through
  e.g. a Cloudflare Tunnel — `cloudflared` as a manager-run sidecar keeps recipes
  tunnel-agnostic. MUST NOT ship without an auth story (a bare tunnel publishes the app
  to the internet) plus a visible "this instance is public" indicator.

## Cross-cutting / always-on

- The UI ⇄ backend contract is the **generated** `bindings.ts` — keep
  `export_bindings` / `export_schema` outputs committed and fresh (a CI freshness gate
  is still pending).
- Verify the Linux unix-socket path on a real Linux host (CI exercises it read-only;
  only Windows gets full manual verification today).
- The frontend has no unit tests yet (`passWithNoTests`) — decide the testing story
  when the UI stabilizes.
