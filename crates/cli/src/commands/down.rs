//! `down` — stop and remove an instance's container (by instance id).

use anyhow::Result;
use compositz_core::{connect, down, is_valid_instance_id};

use crate::style::green;

/// Stop + remove the instance's container. The id is validated at the boundary
/// (★ F5) before it flows into the engine op — the core `down` takes a raw `&str`.
pub async fn run(instance_id: String) -> Result<i32> {
    if !is_valid_instance_id(&instance_id) {
        anyhow::bail!("invalid instance id: \"{instance_id}\"");
    }
    let engine = connect()?;
    down(&engine, &instance_id, None).await?;
    println!(
        "{}",
        green(&format!("OK — {instance_id} stopped & removed"))
    );
    Ok(0)
}
