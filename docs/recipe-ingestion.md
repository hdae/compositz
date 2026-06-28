# Recipe ingestion, storage & launch configuration

> Status: **agreed direction** (decisions in
> [ADR-014](decisions.md#adr-014--recipe-sourcing-3-tier-storage--compose-aligned-launch-config--accepted)).
> This doc is the detailed spec + increment plan. Shapes marked "(RI-1)" are settled when that
> increment is built.

## Guiding principle — stay on Docker's rails

Compositz's job is to make **Docker images easy to deploy**, not to invent a parallel config
universe. So:

- Recipe and launch config **borrow Docker Compose vocabulary and conventions** — `environment`,
  `ports`, `volumes` syntax and `${VAR}` interpolation — rather than Compositz-specific concepts. No
  custom "settings schema".
- But the **runtime stays single-container** via the Engine API: we do **not** run `docker compose`
  or a `compose.yaml` orchestration
  ([ADR-001](decisions.md#adr-001--one-container-per-app-no-compose--accepted) is unchanged). We
  borrow Compose's _config language_, not its orchestrator. Multi-daemon apps still use s6-overlay
  inside one image.

## Storage — three tiers

| Tier             | Location                                                             | Holds                                                                              |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **App-data**     | `$XDG_DATA_HOME/compositz` (Linux/mac) · `%APPDATA%\compositz` (Win) | recipe store (`recipes/<id>/`), per-install overrides, settings                    |
| **Data-root**    | configurable; default `~/Compositz` (Win `%USERPROFILE%\Compositz`)  | per-app **persistent host data** (outputs/models the user wants), **bind-mounted** |
| **Shared cache** | Compositz-managed **named volume** (Phase 3)                         | big cross-app caches (HF_HOME, etc.); not meant to be browsed                      |

The data-root is small-config in app-data but the **data itself lives on the host** where the user
can open it. Per-install override of the data-root is allowed.

Built-in interpolation variables Compositz injects:

- `${COMPOSITZ_DATA}` → `<data-root>/<id>` (host path; bind target lands here)
- `${COMPOSITZ_CACHE}` → the shared cache named volume

## Recipe sources (ingestion)

A recipe is a directory (`compositz.yaml` + `Dockerfile` + context). It is sourced into the **recipe
store** (`<app-data>/recipes/<id>/`) from:

- **tar/zip bundle** — the recipe dir packed; uploaded/dropped in the UI.
- **GitHub** — `owner/repo[@ref][/subdir]`: download the codeload tarball over HTTPS, extract the
  (sub)dir, validate, store. **No `git` binary** — plain HTTP + `@std/tar` (already a core dep).
- **local dir** (dev) — the repo `recipes/`, importable / seeded.

Ingest = extract → **Zod-validate** the manifest → store under `recipes/<id>/`. Building the image
is the separate existing **Install** step (so a freshly-added recipe shows as _not installed_).

## Launch configuration — Compose-style override overlay

- The **manifest** is the author's immutable **defaults** (a template).
- A **per-install override** is a small **Compose-style fragment** stored in app-data
  (`<app-data>/config/<id>.yaml`): `environment`, `ports`, `volumes`. At `up` time the effective
  spec is **derived** from _manifest defaults ⊕ override_ — the manifest is never mutated (no
  derivable state kept in a second place).
- **Volumes**: Compose mount syntax decides bind vs named volume — a path source is a bind mount, a
  bare name is a named volume. Portable host binds use `${COMPOSITZ_DATA}`:
  `- "${COMPOSITZ_DATA}/outputs:/app/output"` (bind) vs `- "models:/root/.cache"` (named volume).
- **Ports**: `"host:container[/proto]"`. **Environment**: `KEY=value`.

## Manifest evolution (breaking — project is unreleased, no migration)

To share one vocabulary between author defaults and user overrides, the manifest's `ports` / `env` /
`volumes` move toward **Compose string syntax + `${VAR}` interpolation**. Compositz metadata (`id` /
`name` / `version` / `description` / `gpu` / `web`) stays. Exact shape is settled in **RI-1**; no
custom `kind` field, no settings schema.

## Increment plan

| Inc.     | Scope                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RT**   | **Docker `/events` real-time status** — add `EngineClient.events()`, switch `/api/events` from 2s poll to event-driven (with a long safety refresh + reconnect). Independent; do first. |
| **RI-1** | Storage layout + data-root setting + **bind-mount support** + Compose-style mounts/`${VAR}` + effective-spec derivation (manifest ⊕ override). The persistence foundation.              |
| **RI-2** | Recipe **store** + **tar/zip ingestion** (UI upload → extract → validate → store).                                                                                                      |
| **RI-3** | **GitHub ingestion** (`owner/repo[@ref][/subdir]` → tarball → store).                                                                                                                   |
| **RI-4** | Per-install **override UI** (Compose-style `environment` / `ports` / `volumes` editor).                                                                                                 |

## Open details (resolve when the increment lands)

- RI-1: exact Compose-aligned manifest shape; Windows bind-mount path handling (Docker Desktop file
  sharing); per-OS default data-root + first-run setup.
- RI-3: GitHub auth for private repos (out of scope first cut — public only).
- Shared cache wiring (`${COMPOSITZ_CACHE}`) overlaps Phase 3's shared-model-cache item.
