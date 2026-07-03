//! Managed application state.

use compositz_core::EngineHandle;

/// The engine handle + the instance store path, shared by every command. Phase 3d
/// adds the live-stream registry (AbortHandle map) for stream lifecycle here.
pub struct AppState {
    pub engine: EngineHandle,
    pub store: String,
}
