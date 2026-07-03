//! `install` — build an instance's image from its Dockerfile + context.

use anyhow::Result;
use compositz_core::{connect, install_instance, instance_image_tag};

use crate::cli::{drive_build, resolve_instance, short};
use crate::style::{bold, dim, green};

/// Build (or pull) the instance's image, streaming build progress to stdout.
pub async fn run(instance_id: String) -> Result<i32> {
    let instance = resolve_instance(&instance_id)?;
    let engine = connect()?;

    println!(
        "{}{}",
        bold(&format!("installing {}", instance.manifest.name)),
        dim(&format!(" ({})", instance.instance_id))
    );

    let stream = install_instance(&engine, &instance);
    drive_build(stream, |id| {
        println!("{}", dim(&format!("  image {}…", short(id, 19))));
    })
    .await?;

    println!(
        "{}",
        green(&format!(
            "OK — built {}",
            instance_image_tag(&instance.manifest, &instance.instance_id)
        ))
    );
    Ok(0)
}
