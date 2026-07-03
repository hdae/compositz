//! Core error type. Phase 0 keeps it minimal; the structured, serde-tagged enum
//! that crosses the Tauri boundary arrives in Phase 3 (see the migration plan).

use thiserror::Error;

/// Errors surfaced by the engine-access core.
#[derive(Debug, Error)]
pub enum Error {
    /// The engine rejected or failed a request (connect, list, stream, …).
    #[error("docker engine error: {0}")]
    Engine(#[from] bollard::errors::Error),

    /// `COMPOSITZ_DOCKER_HOST` had an unrecognized scheme or malformed authority.
    #[error("unsupported COMPOSITZ_DOCKER_HOST: {0}")]
    UnsupportedDockerHost(String),
}
