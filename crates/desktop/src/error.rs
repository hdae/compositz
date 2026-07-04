//! The IPC error surface.
//!
//! Core's `thiserror` enum is reduced to a serde adjacently-tagged enum the frontend
//! consumes as a discriminated union `{ kind, message }`. `badRequest` = the request
//! was malformed (bad id / unknown mount / unknown override key / bad recipe or
//! override input) — the UI's fault; `internal` = an engine / OS failure — ours.

use compositz_core::Error as CoreError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    BadRequest(String),
    Internal(String),
}

impl AppError {
    /// A malformed-request error (invalid id, unknown mount / override key, …).
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    /// An internal / engine / OS error whose source is not a `CoreError`.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl From<CoreError> for AppError {
    fn from(err: CoreError) -> Self {
        let message = err.to_string();
        match err {
            // Bad recipe / override / spec / id input — the client's fault.
            CoreError::Manifest(_)
            | CoreError::Config(_)
            | CoreError::Recipe(_)
            | CoreError::Instance(_)
            | CoreError::Github(_) => Self::BadRequest(message),
            // Engine / env / OS failure — ours.
            CoreError::Engine(_)
            | CoreError::UnsupportedDockerHost(_)
            | CoreError::HomeDirUnresolved(_)
            | CoreError::Io(_) => Self::Internal(message),
        }
    }
}

impl From<std::io::Error> for AppError {
    /// A local filesystem failure (e.g. writing the user-chosen export destination)
    /// is ours — matches `CoreError::Io` → `Internal`. Lets `?` flow directly in the
    /// commands that touch `std::fs` (export writes the mount tar to `dest`).
    fn from(err: std::io::Error) -> Self {
        Self::Internal(err.to_string())
    }
}
