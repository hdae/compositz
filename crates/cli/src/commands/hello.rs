//! `hello` — a full container round-trip against the engine: pull → create → start
//! → stream logs → wait → remove. The Phase 0 diagnostic, kept as a real-engine
//! smoke test (parity with the Deno `hello.ts`).

use std::collections::HashMap;

use anyhow::Result;
use compositz_core::{connect, log_stream};
use futures_util::StreamExt;

use crate::cli::short;
use crate::style::{bold, cyan, dim, green, red};

const IMAGE: &str = "alpine:3.20";
const NAME: &str = "compositz-hello";

/// Run the round-trip. Returns 1 (a handled outcome, not an error) if the demo
/// container exits non-zero.
pub async fn run() -> Result<i32> {
    let engine = connect()?;

    println!(
        "{}{}",
        bold("compositz hello"),
        dim(" — container round-trip")
    );

    // Remove any leftover container from a previous run (ignore "not found").
    let _ = engine.remove_container(NAME, true).await;

    println!("→ pull {IMAGE}");
    engine.pull_image(IMAGE).await?;

    println!("→ create {NAME}");
    let mut labels = HashMap::new();
    labels.insert("io.compositz.demo".to_string(), "hello".to_string());
    let cmd = [
        "sh",
        "-c",
        "for i in 1 2 3; do echo \"hello $i from $(hostname)\"; sleep 1; done",
    ];
    let id = engine
        .create_container_simple(IMAGE, &cmd, labels, NAME)
        .await?;
    println!("{}", dim(&format!("  id {}", short(&id, 12))));

    println!("→ start + stream logs");
    engine.start_container(&id).await?;
    // `log_stream` follows to EOF (the container stops), demuxed to plain lines.
    let mut logs = log_stream(&engine, &id);
    while let Some(line) = logs.next().await {
        println!("  {} {}", cyan("[log]"), line?);
    }

    let status = engine.wait_container(&id).await?;
    println!(
        "→ exited {}",
        if status == 0 {
            green("0")
        } else {
            red(&status.to_string())
        }
    );

    println!("→ remove");
    engine.remove_container(&id, true).await?;

    if status == 0 {
        println!(
            "{}",
            green("OK — pull → create → start → logs → wait → remove all succeeded.")
        );
        Ok(0)
    } else {
        println!("{}", red(&format!("FAILED — container exited {status}")));
        Ok(1)
    }
}
