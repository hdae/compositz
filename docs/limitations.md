# Limitations

Intentional, by-design constraints — spec / compatibility / architecture choices that are **not
bugs**. Open bugs live in [known-issues.md](known-issues.md); the rationale behind a choice lives in
[decisions.md](decisions.md).

## Managed cache presets force sharing — but only for env-driven apps

An earlier version of this section claimed a preset would conflict with an app's own cache `ENV` and
"split the cache in two". That was wrong for env-driven apps and is retracted (ADR-024): the preset
path is injected as **container-create `Env`, which overrides the image's Dockerfile `ENV`**
(measured on the live engine). Declaring a preset therefore _forces_ the shared location even when
the app's Dockerfile centralizes caches elsewhere — this is how
[`recipes/cocktail`](../recipes/cocktail/compositz.yaml) shares venv / uv cache / HF hub / weights.
What genuinely remains out of reach:

- **Build-time-baked paths:** a Dockerfile `RUN` that downloads into `$HF_HOME` / `$UV_CACHE_DIR` at
  build time bakes those files into an image layer; the create-time override only moves the
  _runtime_ cache, leaving a dead baked copy and a cold shared cache.
- **Env-deaf apps:** an app that hard-codes paths in code/config ignores the injected env entirely.
  Declare a plain per-instance `mounts:` volume for those; a `target:` graft (mount the shared cache
  volume at the app's own path) is sketched in ADR-024 but not implemented.
- **Precedence (by design):** preset vars > user per-instance env override (Settings tab) > manifest
  `env` default > image `ENV` ([`run.ts`](../packages/core/src/recipe/run.ts) builds the env map in
  that order). NOTE: the Settings tab **cannot** override a preset-injected variable — opting out of
  a preset means editing the recipe.

## Shared caches are a cooperative namespace, not an isolation boundary

- **What:** the `venv` / `huggingface` volumes are shared across ALL declaring apps, and a `custom`
  cache volume is keyed by its bare `name` — any recipe declaring the same name mounts the same
  volume. `scope: instance` only namespaces a _subpath_; the whole volume is still mounted writable.
  None of these are security boundaries between apps.
- **Threat model (accepted for now):** a shared writable cache is a lateral write channel between
  otherwise-isolated apps — a malicious trusted recipe could poison the HF cache (pickled model) or
  the uv cache (wheel) that other apps then load. uv/HF locking is a _concurrency_ guarantee, not an
  adversarial-integrity one. Accepted while recipes are first-party and trust-gated at import
  (ADR-020); MUST be revisited before third-party recipes. Phase-3 hardening candidates: read-only
  consumer mounts + manager-driven prefetch, per-app volume keying, content verification.
- **Corruption is likewise shared:** a broken shared cache degrades every app using it (uv/HF
  recover by re-downloading; the remedy is wiping the cache volume, never partial in-place edits).

## Bundle extraction has no size cap (a decompression bomb can fill the disk)

- **What:** `ingest_bundle` streams every archive entry to disk with NO size cap
  ([`ingest.ts`](../packages/core/src/recipe/ingest.ts) / `crates/core/src/recipe/ingest.rs`) — a
  gzip bomb or a petabyte-sized tar entry fills the local disk. Extraction is otherwise fully
  contained (no path escape / no link planting — proven by a differential fuzz in Phase 1e), so the
  worst case is a **recoverable local disk-fill**, never a traversal.
- **Threat model (accepted, but narrowing):** the module doc declares resource-exhaustion bombs out
  of scope because recipes were first-party and trust-gated at import (ADR-020). **RI-3 GitHub
  ingestion widened this** — `import github:some/repo` streams an *untrusted third party's* tarball
  through the same uncapped path, so a malicious repo is a disk-fill vector against the user's
  machine. The same exposure exists in the Deno original (parity), so the Rust port did not change it.
- **Fix direction (deferred, needs a decision):** a configurable extracted-size / entry-count cap
  that aborts and cleans the staging dir, surfaced as a clear error. Parallels the shared-cache
  "revisit before third-party recipes" caveat above; both are the same third-party-trust theme.
