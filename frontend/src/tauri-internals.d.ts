// @tauri-apps/api types __TAURI_EVENT_PLUGIN_INTERNALS__ on Window but not the
// core __TAURI_INTERNALS__ object. We touch it in two narrow spots — detecting a
// real backend and driving Channel callbacks in the dev mock / smoke test — so
// declare the minimal surface we rely on. NOTE: `callbacks` is only present
// while a mockIPC handler is installed (it replaces transformCallback); under a
// real Tauri webview it is absent, hence optional.

export {};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      callbacks?: Map<number, (data: unknown) => void>;
    };
  }
}
