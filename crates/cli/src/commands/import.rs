//! `import` — ingest a recipe (tar/tar.gz archive, directory, or GitHub) into a
//! new instance, then deconflict its host ports against the other instances.

use anyhow::Result;
use compositz_core::{
    BundleSource, GithubIngestOpts, IngestOpts, Instance, deconflict_host_ports, ingest_bundle,
    ingest_github,
};

use crate::cli::store_dir;
use crate::style::{dim, green, red, yellow};

/// Import from a `github:owner/repo[/subdir][@ref]` source, a directory, or a
/// tar/tar.gz archive file. A missing local path prints a plain `not found: …`
/// (parity with the Deno import — no `error:` prefix) and exits 1.
pub async fn run(source: String) -> Result<i32> {
    let store = store_dir()?;

    let instance = if source.starts_with("github:") {
        ingest_github_blocking(source, store.clone()).await?
    } else {
        // Stat here (not in the blocking task) so a missing path yields the friendly
        // message + exit 1 rather than bubbling to the top-level `error:` handler.
        let Ok(metadata) = std::fs::metadata(&source) else {
            eprintln!("{}", red(&format!("not found: {source}")));
            return Ok(1);
        };
        ingest_path_blocking(source, store.clone(), metadata.is_dir()).await?
    };

    // Reassign any host port that collides with another instance's DEFINED port,
    // and say so (parity with the Deno import's deconflict-and-notify).
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
        green(&format!("OK — imported {}", instance.manifest.name)),
        dim(&format!(" as {}", instance.instance_id))
    );
    println!(
        "{}",
        dim(&format!("  run: compositz up {}", instance.instance_id))
    );
    Ok(0)
}

/// Download + ingest a GitHub source off the async runtime (the whole fetch →
/// gunzip → untar pipeline is blocking).
async fn ingest_github_blocking(source: String, store: String) -> Result<Instance> {
    tokio::task::spawn_blocking(move || -> Result<Instance> {
        Ok(ingest_github(&source, &store, GithubIngestOpts::default())?)
    })
    .await?
}

/// Ingest a directory or an archive file off the async runtime (extraction / copy
/// is blocking). `is_dir` was determined by the caller's stat.
async fn ingest_path_blocking(source: String, store: String, is_dir: bool) -> Result<Instance> {
    tokio::task::spawn_blocking(move || -> Result<Instance> {
        let instance = if is_dir {
            ingest_bundle(
                BundleSource::Dir {
                    dir: source.clone(),
                },
                &store,
                IngestOpts {
                    source: Some(format!("dir:{source}")),
                    ..Default::default()
                },
            )?
        } else {
            // Stream the file through extraction (never buffer it whole in RAM).
            let file = std::fs::File::open(&source)?;
            ingest_bundle(
                BundleSource::Archive {
                    reader: Box::new(file),
                    subdir: None,
                },
                &store,
                IngestOpts {
                    source: Some(format!("file:{source}")),
                    ..Default::default()
                },
            )?
        };
        Ok(instance)
    })
    .await?
}
