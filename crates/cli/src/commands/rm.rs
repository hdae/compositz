//! `rm` — remove instance(s): the container, the per-instance built image, the DATA
//! VOLUMES (default), then the definition.
//!
//! `--keep-data` keeps the volumes (the old safe behavior); `--purge` also removes
//! the host-browsable data-root dir. When a volume can't be removed (still mounted),
//! the DEFINITION IS KEPT so a retry can still derive the volume names. Continues
//! past a failing id and exits non-zero if any failed.

use anyhow::Result;
use compositz_core::{
    EngineHandle, RemoveDataOpts, connect, down, is_valid_instance_id, load_instance,
    remove_instance_data, remove_instance_dir, remove_instance_image,
};

use crate::cli::store_dir;
use crate::style::{dim, green, red, yellow};

/// Remove each id in turn (clap enforces `--keep-data`/`--purge` mutual exclusion
/// and ≥1 id). A per-id failure is reported and counted but never aborts the rest;
/// the exit code is non-zero iff any id failed.
pub async fn run(keep_data: bool, purge: bool, instance_ids: Vec<String>) -> Result<i32> {
    let engine = connect()?;
    let store = store_dir()?;
    let mut failures = 0u32;

    for id in &instance_ids {
        match remove_one(&engine, &store, id, keep_data, purge, &mut failures).await {
            Ok(()) => {}
            Err(err) => {
                failures += 1;
                eprintln!("{}", red(&format!("failed to remove {id}: {err}")));
            }
        }
    }

    Ok(if failures == 0 { 0 } else { 1 })
}

/// Remove one instance. `failures` is bumped for the partial-outcome paths that
/// print their own message (a volume that won't remove, a bind dir that won't
/// remove) instead of returning `Err`; a genuine error returns `Err` and the caller
/// counts + prints it. A volume-removal failure KEEPS the definition (returns early,
/// before [`remove_instance_dir`]) so the volume names can be re-derived on retry.
async fn remove_one(
    engine: &EngineHandle,
    store: &str,
    id: &str,
    keep_data: bool,
    purge: bool,
    failures: &mut u32,
) -> Result<()> {
    // Ids flow into filesystem paths — a path-shaped "id" must never reach the
    // recursive delete (remove_instance_dir guards too; this fails earlier, per-id).
    if !is_valid_instance_id(id) {
        anyhow::bail!("invalid instance id: \"{id}\"");
    }

    // Load best-effort BEFORE removal to know the image tag + volume names; a
    // missing/corrupt instance still gets its dir removed (mirrors the UI delete).
    let instance = load_instance(&format!("{store}/{id}")).ok();
    down(engine, id, None).await?;

    let mut notes: Vec<String> = Vec::new();
    match &instance {
        Some(inst) => {
            remove_instance_image(engine, inst).await?;
            notes.push("image removed".to_string());
        }
        None => {
            // Without a readable definition neither the image tag nor the volume
            // names can be derived — say so instead of claiming a clean removal.
            notes.push(
                "definition was unreadable — image and data volumes (if any) left as-is"
                    .to_string(),
            );
        }
    }

    if let Some(inst) = &instance {
        if !keep_data {
            let data = remove_instance_data(
                engine,
                inst,
                RemoveDataOpts {
                    bind_data: purge,
                    ..Default::default()
                },
            )
            .await?;

            if !data.volumes_failed.is_empty() {
                *failures += 1;
                for failure in &data.volumes_failed {
                    eprintln!(
                        "{}",
                        red(&format!(
                            "failed to remove volume {}: {}",
                            failure.name, failure.error
                        ))
                    );
                }
                eprintln!(
                    "{}",
                    red(&format!(
                        "kept {id}'s definition — retry `compositz rm {id}`"
                    ))
                );
                // Keep the definition: without it the volume names can't be re-derived.
                return Ok(());
            }
            if !data.volumes_removed.is_empty() {
                notes.push(format!(
                    "{} data volume(s) removed",
                    data.volumes_removed.len()
                ));
            }
            if data.bind_dir_removed.is_some() {
                notes.push("bind data removed".to_string());
            }
            if let Some(bind_failure) = &data.bind_dir_failed {
                // The volumes above are already gone — disclose the partial outcome
                // instead of failing as if nothing happened.
                *failures += 1;
                eprintln!(
                    "{}",
                    yellow(&format!(
                        "bind data NOT removed ({}) — remove manually: {}",
                        bind_failure.error, bind_failure.path
                    ))
                );
            }
        } else {
            notes.push("data volumes kept".to_string());
        }
    }

    remove_instance_dir(store, id)?;
    println!(
        "{}{}",
        green(&format!("OK — removed {id}")),
        dim(&format!(" ({})", notes.join(", ")))
    );
    Ok(())
}
