# Plan — Slice C: user-facing build args + opt-in `--no-cache` rebuild

> **STATUS: PROPOSAL (未承認)** — planned 2026-07-14, not yet approved for
> implementation. Re-ground every `file:line` against live code before starting;
> the open decisions at the bottom need user answers at approval time.

## Established facts (verified against code at planning time)

1. **Manifest v2 already has build args** — `BuildSpec.args: Option<BTreeMap<String, String>>`
   (`crates/core/src/recipe/manifest.rs:112-117`), in the JSON Schema, and in live use
   (`recipes/cocktail/compositz.yaml` `COCKTAIL_REF` pin). No manifest extension required.
2. **Validation gap**: `Manifest::validate` checks env/cache names against `ENV_NAME` but not
   `build.args` keys — close it in this slice.
3. **roadmap's "`BuildOptions.noCache` is wired in core" was STALE** (Deno-era): the Rust
   `engine.build_image` (`crates/core/src/engine.rs:208-228`) passes no `nocache`. bollard 0.21's
   `BuildImageOptionsBuilder` has `.nocache(bool)`. Wiring is new work (small).
4. **Single build path**: `install_instance` (`operations.rs:37-58`) is the only build entry;
   loading the override inside it (ADR-022's "one road" principle) updates all 5 call sites for free.
5. **Restart-needed precedent** (ADR-023): `.launched.yaml` written at `up`, compared via
   `same_override`. The build version of this is `.built.yaml`.
6. **Pitfall found**: adding `buildArgs` to `Override` naively makes editing a build arg light up
   the RESTART button (`.launched.yaml` stores the whole override). A `launch_scope()` that strips
   buildArgs from the launch comparison is REQUIRED, with a unit test pinning the non-regression.
7. Duplicate (`ingest.rs:181-185` struct spread) and in-place update (config.yaml survives,
   ADR-029) inherit the new field with zero changes.
8. `instance_up` only builds when the image is missing — args changes never rebuild implicitly,
   hence the explicit "rebuild needed" state.

## Chosen approach (A) — config.yaml `buildArgs` + `.built.yaml` marker + `InstallOpts`

- Declaration = the existing manifest `build.args` map (a declared default makes an arg
  user-facing). No breaking manifest change.
- `Override.build_args` — same strict-subset validation family as ports/env/placement (ADR-022).
- Truth source for `rebuild_needed`: on build SUCCESS record the EFFECTIVE args
  (manifest ⊕ override) to `.built.yaml`; `rebuild_needed = marker exists && effective(saved) ≠ recorded`.
  A record of a past fact — the same legitimate category as `.launched.yaml`, not derivable state.
  Purely fs-based, so `get_config` stays engine-independent (Settings works offline; hermetic tests).
- `InstallOpts { no_cache: bool }` on `install_instance`; `.nocache()` wired in `engine.build_image`.

Rejected: (B) manifest `Vec<BuildArgSpec>` — description display only, breaks every recipe;
(C) image-label truth source — makes `get_config` engine-dependent, untestable hermetically.

## Commits

1. **core foundations (engine-free)**: `Override.build_args` + normalize/validate (`ENV_NAME` keys)
   + `launch_scope` (strip buildArgs from `.launched.yaml` write AND both compare sides) +
   manifest `build.args` key validation + `.built.yaml` save/load (own small struct, atomic_write)
   + pure `effective_build_args(&Manifest, &Override)` + tests (config/instance/manifest suites)
   + re-exports.
2. **build-path wiring**: `engine.build_image(no_cache)` + `InstallOpts` on `install_instance`
   (load config → effective args → build; write `.built.yaml` ONLY on clean stream completion;
   pull path writes no marker) + CLI `install --no-cache` + gated E2E assertion on the marker.
3. **desktop IPC**: `BuildArgSetting` (mirror of `EnvSetting`), `InstanceSettings.build_args` +
   `rebuild_needed`, `SetConfigView.rebuild_needed`, `assert_known_keys` for buildArgs,
   `instance_install(no_cache)` + **bindings.ts regeneration** (required — types change).
4. **frontend**: Settings "Build arguments" section (delta-only save, mirror of Environment) +
   `rebuildNeeded` state + "Rebuild now to apply" footer button + ⋯menu "Rebuild (no cache)"
   (build-based instances only — surface `hasBuild` honestly via the view) + mock parity.
5. **docs**: ADR (build cache stays ON by default — user decision), roadmap stale-line fix,
   recipe-format note ("secrets MUST NOT go in build args — they persist in image history").

Out of scope: `secret:` flagging, CLI `config` parity, per-run `--build-arg` CLI overrides,
row-level rebuild badge.

## Open decisions (answer at approval)

1. `.built.yaml` records effective args (**recommended** — catches manifest-side arg changes after
   update) vs raw override.
2. Manifest declaration stays the plain map (**recommended**) vs description-bearing spec (breaking).
3. "Rebuild now" = rebuild only, vs **rebuild → auto-restart chain (recommended;** brief service
   interruption).
4. no-cache entry point: ⋯menu only (**recommended**) vs also in Settings footer.
5. Empty build-arg value: **fall back to default (recommended,** same as env) vs distinguishable
   empty-string ARG.
