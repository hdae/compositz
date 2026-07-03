//! `up` — build the image if missing, then create + start the instance.

use anyhow::Result;
use compositz_core::{LaunchConfig, connect, install_instance, instance_image_tag, up, web_url};

use crate::cli::{drive_build, resolve_instance, short};
use crate::style::{bold, cyan, dim, green};

/// Bring an instance up: build on demand, create + start, print the web URL.
pub async fn run(instance_id: String) -> Result<i32> {
    let instance = resolve_instance(&instance_id)?;
    let engine = connect()?;

    let tag = instance_image_tag(&instance.manifest, &instance.instance_id);
    if !engine.image_exists(&tag).await? {
        println!("{}", dim("image not built yet — building…"));
        let stream = install_instance(&engine, &instance);
        drive_build(stream, |_| {}).await?;
    }

    println!(
        "{}{}",
        bold(&format!("starting {}", instance.manifest.name)),
        dim(&format!(" ({})", instance.instance_id))
    );
    let result = up(&engine, &instance, &LaunchConfig::default()).await?;
    println!(
        "{}",
        dim(&format!(
            "  container {}  gpu={}",
            short(&result.id, 12),
            if result.used_gpu { "on" } else { "off" }
        ))
    );

    // Build the web URL from the ports actually published (after any conflict bump),
    // not the manifest default.
    let launch = LaunchConfig {
        host_ports: result.host_ports.clone(),
        ..Default::default()
    };
    match web_url(&instance.manifest, &launch) {
        Some(url) => println!("{}{}{}", green("OK — up"), green(" at "), cyan(&url)),
        None => println!("{}", green("OK — up")),
    }
    Ok(0)
}
