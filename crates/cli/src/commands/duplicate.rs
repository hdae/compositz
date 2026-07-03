//! `duplicate` — derive a fresh instance from an existing one (copies the bundle,
//! not the data), then deconflict the copy's host ports.

use anyhow::Result;
use compositz_core::{Instance, deconflict_host_ports, duplicate_instance, is_valid_instance_id};

use crate::cli::store_dir;
use crate::style::{dim, green, yellow};

/// Duplicate an instance's definition under a new id. The source id is validated at
/// the boundary (★ F5) before it flows into the copy (which loads + walks the
/// source dir).
pub async fn run(instance_id: String) -> Result<i32> {
    if !is_valid_instance_id(&instance_id) {
        anyhow::bail!("invalid instance id: \"{instance_id}\"");
    }
    let store = store_dir()?;

    let source = instance_id.clone();
    let store_for_copy = store.clone();
    let instance: Instance = tokio::task::spawn_blocking(move || -> Result<Instance> {
        Ok(duplicate_instance(&store_for_copy, &source)?)
    })
    .await??;

    // A duplicate shares the source recipe's ports, so it always collides — reassign
    // + report.
    for bump in deconflict_host_ports(&store, &instance)? {
        println!(
            "{}",
            yellow(&format!(
                "  note: {} port {} in use → reassigned to {}",
                bump.name, bump.from, bump.to
            ))
        );
    }

    println!(
        "{}{}",
        green("OK — duplicated"),
        dim(&format!(" {} → {}", instance_id, instance.instance_id))
    );
    println!(
        "{}",
        dim(&format!("  run: compositz up {}", instance.instance_id))
    );
    Ok(0)
}
