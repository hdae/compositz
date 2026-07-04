//! Managed application state + the live-stream registry.

use std::collections::HashMap;
use std::sync::Mutex;

use compositz_core::EngineHandle;
use tokio::task::AbortHandle;

/// The engine handle, the instance store path, and the live-stream registry shared
/// by every command.
pub struct AppState {
    pub engine: EngineHandle,
    pub store: String,
    /// Live push-stream tasks (snapshot / logs / install), keyed by subscription id
    /// so the frontend can `unsubscribe` and window teardown can stop them all. This
    /// explicit lifecycle prevents a still-live pump from leaking past its consumer.
    pub streams: Mutex<StreamRegistry>,
}

/// Maps subscription ids to the `AbortHandle` of their pump task. A dropped receiver
/// (webview gone) already ends a pump via a failed `Channel::send`; this adds
/// EXPLICIT cancellation (an `unsubscribe` command + window-destroy teardown) so a
/// still-live pump never outlives its consumer.
#[derive(Default)]
pub struct StreamRegistry {
    next_id: u32,
    handles: HashMap<u32, AbortHandle>,
}

impl StreamRegistry {
    /// Register a pump task and return its subscription id.
    pub fn register(&mut self, handle: AbortHandle) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.handles.insert(id, handle);
        id
    }

    /// Abort + forget one subscription (idempotent — an unknown/finished id is a
    /// no-op, as is aborting an already-finished task).
    pub fn abort(&mut self, id: u32) {
        if let Some(handle) = self.handles.remove(&id) {
            handle.abort();
        }
    }

    /// Abort every live stream (window teardown).
    pub fn abort_all(&mut self) {
        for (_, handle) in self.handles.drain() {
            handle.abort();
        }
    }
}
