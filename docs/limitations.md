# Limitations

Intentional, by-design constraints — spec / compatibility / architecture choices that are **not
bugs**. Open bugs live in [known-issues.md](known-issues.md); the rationale behind a choice lives in
[decisions.md](decisions.md).

## Managed caches assume Compositz owns the cache location

- **What:** the manifest `cache:` presets inject a Compositz-chosen path into the container —
  `huggingface` sets `HF_HOME`, `venv` sets `VIRTUAL_ENV` + `UV_CACHE_DIR`, and `custom` injects its
  path into a named env var (see [`manifest.ts`](../packages/core/src/recipe/manifest.ts)
  `CacheSchema`). Compositz picks the mount point; the app is expected to read the injected env var.
- **Constraint:** an app that **hard-codes its own cache layout** — e.g. its own Dockerfile sets
  `HF_HOME=/workspace/models` and `UV_CACHE_DIR=/workspace/.uv-cache`, centralizing everything under
  one directory — cannot use the presets without a conflict: the preset would inject a _different_
  path than the app's own ENV, splitting the cache in two. For such apps, declare a **single plain
  `mounts:` volume** at the app's cache root instead. This is what
  [`recipes/cocktail`](../recipes/cocktail/compositz.yaml) does with `/workspace`.
- **Why by-design:** the presets exist to _share_ a cache across instances/apps (one HuggingFace hub
  cache for every app), which requires Compositz to control the location. An app that owns its own
  layout is opting out of that sharing, and a plain mount is the correct tool. Revisit only if we
  later want to "adopt an app's existing cache dir as a shared cache" — that would need a manifest
  way to point a shared cache at an app-chosen path. Surfaced while authoring the `cocktail` recipe
  (a GPU app that funnels venv / uv cache / HF models / weights / images all under `/workspace`).
