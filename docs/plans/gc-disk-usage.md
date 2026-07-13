# Plan — Volume lifecycle & GC + read-only Disk Usage view

> **STATUS: PROPOSAL (未承認)** — planned 2026-07-14, not yet approved for
> implementation. Re-ground every `file:line` against live code before starting;
> the open decisions at the bottom need user answers at approval time.

## Design risks discovered (these shape the whole plan)

1. **The `compositz_cache_*` trap**: shared-cache names parse as `InstanceData` under the naive
   `compositz_<id>_<mount>` split (`cache` is a valid id shape; instance ids never contain `_` so
   the split itself is unique). A naive GC would orphan-classify the user's shared caches.
   → A `classify_volume` function in `brand.rs` MUST evaluate the shared-cache denylist FIRST,
   pinned by tests (`compositz_cache_torch` must NEVER classify as instance data).
2. **bollard 0.21 `/system/df` response is the API 1.53-rc shape**: against an older daemon every
   field silently deserializes to `None`. Destructive decisions must NEVER depend on df.
3. Existing volumes/images carry **no labels** (created implicitly via Mount specs) — name-pattern
   classification is the only key for existing objects. (Label-stamping new ones is a Phase-3
   hardening option, needs its own approval — it touches the create path.)

## Chosen approach (B) — typed hybrid reads + two-phase plan/apply GC + read-only first

- **Sizes** (display only): images via `list_images(reference=compositz/*, shared-size)` (typed,
  cheap); volume sizes via `df(type=volume)` joined by name, degrading EXPLICITLY to
  "size unavailable" when df is unusable (old daemon / shape mismatch). df risk is contained to a
  display column.
- **Orphan/stale judgments** (destructive input) depend ONLY on `list_volumes`/`list_images`/
  `list_containers` + the store — never df.
- **GC = `gc_plan` (read-only enumeration) → confirm dialog (full listing of what dies) →
  `gc_apply` (server-side REVALIDATION of every target at apply time, then one-by-one
  `remove_volume`/`remove_image`, never prune APIs)** — the ADR-029 prepare/commit shape plus
  ADR-025 sink self-validation.
- Orphan volume = instance-data-classified AND (id absent from store OR mount absent from current
  manifest), minus in-use (container MountPoints). Stale image = `compositz/<id>:<tag>` outside the
  protected set (every instance's current `instance_image_tag` ∪ current versions), minus
  container-referenced. Leaked export helpers by `io.compositz.role` label.
- Dangling `<none>` images: OUT of v1 scope (unattributable without labels).

## Phases / commits

**Phase 1 — read-only (no destructive code exists yet)**
1. `feat(core)`: `brand.rs` `classify_volume` + `parse_instance_image_repo` + exhaustive pin tests.
2. `feat(core)`: engine `list_images` / `volume_usage()` (df wrapped, `Ok(None)` degradation)
   + read-only integration tests.
3. `feat(core)`: new `gc.rs` — `collect_gc_inputs` + PURE `plan_gc(inputs) -> GcPlan` +
   `disk_usage()` view (per-instance, shared caches, candidates embedded read-only).
4. `feat(desktop)`: `get_disk_usage` command (NOT in the snapshot pump — dialog-open/refresh only)
   + bindings regeneration.
5. `feat(ui)`: header "Disk usage" dialog — sizes + candidates listed WITHOUT delete buttons
   (misclassification is user-verifiable before any destructive code ships).
6. `feat(cli)`: `compositz df`.

**Phase 2 — destructive reclaim**
7. `feat(core)`: `apply_gc(targets)` — re-classify + re-plan per target at apply time (TOCTOU
   defense; SharedCache/NotManaged targets REJECTED), per-item `GcReport {removed, failed, skipped}`.
8. `feat(desktop)`: `gc_plan`/`gc_apply` + confirm dialog (DeleteDialog pattern) + reloadRows
   (server-confirmed only) + bindings.
9. `feat(cli)`: `compositz gc` (default dry-run; `--reclaim` + confirm/`--yes`).
10. `docs`: known-issues resolutions + ADR (judgment criteria, denylist, plan/apply revalidation).

**Phase 3 (separate, low priority)**: venv-subpath GC (`compositz_uv`/venvs/<id> — requires a
helper container, new design decision on helper image) + uv repair/rebuild wrappers + optional
label-stamping hardening.

## Test plan

- Pure unit: classify_volume exhaustive pins; plan_gc branches on fake inputs; apply_gc rejection
  paths (a SharedCache name smuggled into targets MUST be refused).
- Read-only integration (existing `COMPOSITZ_DOCKER_HOST` gate): list_images/df resolve; shape
  degradation.
- Destructive E2E (`COMPOSITZ_E2E=1` + `#[ignore]`, `compositz-test-*`): orphan-volume round trip;
  stale-tag round trip; **live denylist decoy** — create `compositz_cache_gc-e2e-<rand>`, assert it
  NEVER appears in a plan, tear it down by exact name. Never touch real `compositz_uv`/`compositz_hf`.

## Open decisions (answer at approval)

1. UI placement: header button → dialog (**recommended**) vs persistent panel.
2. df degradation policy: "size unavailable" + keep working (**recommended**).
3. Phase 1 shows orphan/stale candidates read-only (**recommended**) vs sizes only.
4. Confirm granularity: bulk approve vs per-item checkboxes.
5. CLI parity timing: same-phase (**recommended** — core carries everything) vs later.
6. Remote-engine/store-mismatch (another store's volumes look orphaned): accept with full listing
   + limitations.md note (**recommended**) vs extra guards.
7. bind-dir (data-root) size display: include (local-only accuracy) vs exclude in v1.
8. Label-stamping hardening: bundle into Phase 2 vs separate approval (**recommended: separate**).
9. Dangling `<none>` images: v1 out of scope (**recommended**), revisit after labels.
