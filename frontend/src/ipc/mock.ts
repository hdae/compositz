// Dev-only IPC mock: lets `vp dev` run in a plain browser with no Tauri backend.
//
// This module is imported ONLY behind `import.meta.env.DEV` (see installMock in
// ./index.ts), so a production `vp build` tree-shakes it away entirely.
//
// It leans on one implementation detail of @tauri-apps/api's mockIPC: a Channel
// serializes to the string "__CHANNEL__:<id>" and its registered callback (in
// window.__TAURI_INTERNALS__.callbacks) expects order-indexed envelopes shaped
// { index, message } / { index, end }. This is the exact fragility the plan
// flags; the "Channel delivers messages under mockIPC" test is its tripwire.

import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ContainerSummary } from "./types";

const FIXTURE_CONTAINERS: ContainerSummary[] = [
  {
    id: "a1b2c3d4e5f6",
    name: "compositz-comfyui-a1b2c3",
    state: "running",
    image: "compositz/comfyui-a1b2c3:latest",
    ports: ["8188->8188/tcp"],
  },
  {
    id: "0f1e2d3c4b5a",
    name: "compositz-whisper-0f1e2d",
    state: "exited",
    image: "compositz/whisper-0f1e2d:latest",
    ports: [],
  },
  {
    id: "9988776655aa",
    name: "compositz-sd-webui-998877",
    state: "created",
    image: "compositz/sd-webui-998877:latest",
    ports: ["7860->7860/tcp", "8080->80/tcp"],
  },
];

/**
 * Recover a Channel's numeric callback id from whatever mockIPC handed us. Under
 * mockIPC the arg is the live Channel object (its public `id` IS the callback
 * id); a serialized "__CHANNEL__:<id>" string is also accepted for robustness.
 */
export function channelCallbackId(arg: unknown): number | undefined {
  if (typeof arg === "object" && arg !== null && "id" in arg) {
    const id = (arg as { id: unknown }).id;
    if (typeof id === "number") return id;
  }
  if (typeof arg === "string" && arg.startsWith("__CHANNEL__:")) {
    const id = Number(arg.slice("__CHANNEL__:".length));
    if (Number.isFinite(id)) return id;
  }
  return undefined;
}

/**
 * Resolve the raw callback a Channel registered under mockIPC and return a
 * pusher that emits correctly-indexed { index, message } envelopes (and a
 * matching `end`). Returns undefined when the arg is not a resolvable channel.
 */
export function channelPusher(
  arg: unknown,
): { push: (message: string) => void; end: () => void } | undefined {
  const id = channelCallbackId(arg);
  if (id === undefined) return undefined;
  const callback = window.__TAURI_INTERNALS__?.callbacks?.get(id);
  if (!callback) return undefined;

  let index = 0;
  return {
    push: (message: string) => callback({ index: index++, message }),
    end: () => callback({ index, end: id }),
  };
}

const LOG_LINES = [
  "Loading model weights from /compositz/huggingface ...",
  "Startup time: 4.2s",
  "Running on http://0.0.0.0:8188",
  "GET /queue 200 OK",
  "POST /prompt 200 OK",
];

const EVENT_LINES = [
  "container start comfyui-a1b2c3 (image=compositz/comfyui-a1b2c3:latest)",
  "container health_status: healthy comfyui-a1b2c3",
  "image pull compositz/whisper-0f1e2d:latest",
  "container die whisper-0f1e2d (image=compositz/whisper-0f1e2d:latest)",
];

/** Timers started by the mock, cleared by the returned disposer. */
const timers = new Set<ReturnType<typeof setInterval>>();

/**
 * Install the browser-dev IPC mock. Idempotent-enough for HMR: registers a
 * single mockIPC handler that serves fixture containers and streams fake
 * log/event lines on a timer. Returns a disposer that stops all timers.
 */
/** Read a named field from an invoke payload. `InvokeArgs` is a union (record
 * or binary); only the record form carries named args, so anything else yields
 * undefined. */
function field(payload: InvokeArgs | undefined, key: string): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

export function installBrowserMock(): () => void {
  mockIPC((cmd: string, payload?: InvokeArgs) => {
    switch (cmd) {
      case "list_containers":
        return FIXTURE_CONTAINERS;

      case "stream_logs": {
        const pusher = channelPusher(field(payload, "onLog"));
        if (pusher) {
          let i = 0;
          const rawId = field(payload, "containerId");
          const containerId = typeof rawId === "string" ? rawId : "unknown";
          pusher.push(`--- streaming logs for ${containerId} (mock) ---`);
          const timer = setInterval(() => {
            pusher.push(LOG_LINES[i % LOG_LINES.length]!);
            i += 1;
          }, 1200);
          timers.add(timer);
        }
        return null;
      }

      case "stream_events": {
        const pusher = channelPusher(field(payload, "onEvent"));
        if (pusher) {
          let i = 0;
          const timer = setInterval(() => {
            pusher.push(EVENT_LINES[i % EVENT_LINES.length]!);
            i += 1;
          }, 2500);
          timers.add(timer);
        }
        return null;
      }

      default:
        throw new Error(`mock: unhandled command "${cmd}"`);
    }
  });

  return () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  };
}

/** Exposed for tests that assert list rendering from known fixture data. */
export { FIXTURE_CONTAINERS };
