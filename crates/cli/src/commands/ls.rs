//! `ls` — list instances in the store (definitions on disk, not containers).

use anyhow::Result;
use compositz_core::list_instances;

use crate::cli::store_dir;
use crate::style::{cyan, dim, green};

/// List every valid instance under the store, sorted by display name. This reads
/// the on-disk definitions — the store view — not the engine (that is `ps`).
pub async fn run() -> Result<i32> {
    let store = store_dir()?;
    let list = list_instances(&store);
    if list.is_empty() {
        println!(
            "{}",
            dim("no instances — import one: compositz import <archive|dir>")
        );
        return Ok(0);
    }

    println!(
        "{}",
        dim(&format!(
            "{:<28}{:<14}{:<10}{:<24}{:<12}{}",
            "INSTANCE", "APP", "VERSION", "NAME", "CREATED", "SOURCE"
        ))
    );
    for instance in &list {
        // Date only — time of day is noise at list granularity (meta.json keeps
        // the full timestamp).
        let created = instance
            .meta
            .created_at
            .as_deref()
            .map(|ts| ts.get(..10).unwrap_or(ts))
            .unwrap_or("-");
        // Pad each colored cell BEFORE coloring, so the escape sequence never
        // counts toward the column width.
        println!(
            "{}{:<14}{:<10}{}{:<12}{}",
            green(&format!("{:<28}", instance.instance_id)),
            instance.app_id,
            instance.manifest.version,
            cyan(&format!("{:<24}", instance.display_name())),
            created,
            dim(instance.meta.source.as_deref().unwrap_or("-")),
        );
    }
    Ok(0)
}
