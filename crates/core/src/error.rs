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

    /// A recipe manifest failed to parse or validate. The message already carries
    /// the `manifest.<path> …` prefixes (mirrors the Deno `CompositzError` text).
    #[error("{0}")]
    Manifest(String),

    /// The host home directory could not be resolved (the platform's home env
    /// var — `USERPROFILE` on Windows, else `HOME` — was unset).
    #[error("cannot resolve home directory ({0} unset)")]
    HomeDirUnresolved(String),

    /// A per-instance override (`config.yaml`) failed to parse or validate. The
    /// message carries the `config.<path> …` prefixes (mirrors the Deno text).
    #[error("{0}")]
    Config(String),

    /// A recipe bundle could not be loaded (missing manifest, or a declared
    /// Dockerfile absent from the build context).
    #[error("{0}")]
    Recipe(String),

    /// An instance-store operation was given an invalid argument (a malformed
    /// instance id or directory), refused before touching the filesystem.
    #[error("{0}")]
    Instance(String),

    /// An underlying filesystem operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
