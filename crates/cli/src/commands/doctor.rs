//! `doctor` — resolve the endpoint, ping the engine, print versions.

use anyhow::Result;
use compositz_core::{connect, resolved_endpoint_description};

use crate::style::{bold, dim, green, red};

/// Health check: describe the endpoint, ping, print the engine version + platform.
/// Returns 1 (not an error) when the engine is unreachable, so the top-level
/// handler doesn't double-print — the diagnostic owns its failure message.
///
/// The header + endpoint line print BEFORE connecting: `connect()` is not lazy for
/// a unix socket (bollard checks the path exists eagerly), so a "Docker not
/// running" failure surfaces at `connect`, not at `ping`. Deriving the endpoint
/// label from the env (not a live handle) and folding a connect error into the same
/// FAILED path is what keeps the friendly diagnostic intact in exactly the case
/// `doctor` exists for.
pub async fn run() -> Result<i32> {
    println!("{}", bold("compositz doctor"));
    println!(
        "{}",
        dim(&format!("  endpoint: {}", resolved_endpoint_description()))
    );

    match probe().await {
        Ok(()) => Ok(0),
        Err(err) => {
            println!("{}", red(&format!("FAILED — {err}")));
            println!(
                "{}",
                dim("  Is Docker running? On Windows, Docker Desktop must be started.")
            );
            Ok(1)
        }
    }
}

/// The reachable-engine path: connect + ping + version, each line printed as it
/// resolves. Any failure (connect or request) propagates to the FAILED branch.
async fn probe() -> Result<()> {
    let engine = connect()?;

    let pong = engine.ping().await?;
    println!("  ping:     {}", green(&pong));

    let version = engine.version().await?;
    let field = |value: Option<String>| value.unwrap_or_else(|| "?".to_string());
    println!(
        "  engine:   Docker {}  (API {}, min {})",
        field(version.version),
        field(version.api_version),
        field(version.min_api_version),
    );
    println!(
        "  platform: {}/{}",
        version.os.unwrap_or_default(),
        version.arch.unwrap_or_default()
    );
    println!("{}", green("OK — engine reachable."));
    Ok(())
}
