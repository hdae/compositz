//! Build-context types. A recipe's build context is a Dockerfile plus a few
//! provisioning files, small enough to hold in memory.
//!
//! Ported from `packages/core/src/build.ts`. Only the [`BuildFile`] type is
//! needed by the instance store (Phase 1c); the in-memory tar packing for
//! `POST /build` arrives with ingestion / install (Phase 1e / 1g).

/// One file in a recipe's build context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildFile {
    /// Path within the context root, forward-slash separated (e.g. `Dockerfile`
    /// or `rootfs/run.sh`).
    pub path: String,
    /// The file's raw bytes.
    pub data: Vec<u8>,
}
