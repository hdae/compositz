//! `export` — write one persisted mount's data to a tar file (root dir = the mount
//! name). With no mount name, list the instance's exportable mounts.

use std::io::Write;

use anyhow::Result;
use compositz_core::{connect, export_mount};
use futures_util::StreamExt;

use crate::cli::resolve_instance;
use crate::style::{dim, green};

/// Export a mount to a tar file, or (mount omitted) list the exportable mounts.
/// Works on a stopped instance — the data is read through a throwaway helper
/// container that is never started.
pub async fn run(
    instance_id: String,
    mount: Option<String>,
    out_file: Option<String>,
) -> Result<i32> {
    let instance = resolve_instance(&instance_id)?;

    let Some(mount) = mount else {
        let mounts = &instance.manifest.mounts;
        if mounts.is_empty() {
            println!(
                "no persisted mounts in \"{}\" — nothing to export",
                instance.app_id
            );
            return Ok(0);
        }
        println!("exportable mounts:");
        for mt in mounts {
            println!("  {:<14} {}", mt.name, dim(&mt.target));
        }
        println!(
            "{}",
            dim(&format!(
                "\nrun: compositz export {instance_id} <mount> [outFile]"
            ))
        );
        return Ok(0);
    };

    let engine = connect()?;
    let out_file = out_file.unwrap_or_else(|| format!("{instance_id}-{mount}.tar"));
    let mut stream = export_mount(&engine, &instance, &mount).await?;

    // Stream chunks straight to the file. On any transport or I/O error, remove the
    // partial file so a truncated .tar never lingers looking like a good export.
    let write_result: Result<()> = async {
        let file = std::fs::File::create(&out_file)?;
        let mut writer = std::io::BufWriter::new(file);
        while let Some(chunk) = stream.next().await {
            writer.write_all(&chunk?)?;
        }
        writer.flush()?;
        Ok(())
    }
    .await;
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&out_file);
        return Err(err);
    }

    let size = std::fs::metadata(&out_file)?.len();
    println!(
        "{}{}",
        green(&format!("OK — exported {mount} → {out_file}")),
        dim(&format!(" ({})", format_size(size)))
    );
    Ok(0)
}

/// Human-readable byte size (binary units).
fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::format_size;

    #[test]
    fn bytes_below_one_kib_are_shown_raw() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(1023), "1023 B");
    }

    #[test]
    fn scales_through_binary_units_with_one_decimal() {
        assert_eq!(format_size(1024), "1.0 KiB");
        assert_eq!(format_size(1536), "1.5 KiB");
        assert_eq!(format_size(1024 * 1024), "1.0 MiB");
        assert_eq!(format_size(1024 * 1024 * 1024), "1.0 GiB");
        assert_eq!(format_size(1024_u64.pow(4)), "1.0 TiB");
    }

    #[test]
    fn caps_at_tib_without_overflowing_the_unit_list() {
        // Well past a TiB still reads in TiB (the largest unit), never panics.
        assert_eq!(format_size(5 * 1024_u64.pow(4)), "5.0 TiB");
        assert_eq!(format_size(2048 * 1024_u64.pow(4)), "2048.0 TiB");
    }
}
