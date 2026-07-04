// Dev-only IPC mock: lets `vp dev` run in a plain browser with no Tauri backend.
//
// Imported ONLY behind `import.meta.env.DEV` (see installMockIfNeeded), so a
// production `vp build` tree-shakes it away. It is a small STATEFUL fake of the
// backend for the current vertical slice: `list_instance_rows` + the snapshot
// subscription + up/down + the streaming install. Actions mutate the fake state and
// the next snapshot push reflects it — so the browser demo exercises the same
// server-confirmed flow the real backend drives (no optimistic shortcuts to test).
//
// It leans on one @tauri-apps/api mockIPC detail: a `Channel` registers its callback
// in `window.__TAURI_INTERNALS__.callbacks`, keyed by the channel id, expecting
// order-indexed `{ index, message }` / `{ index, end }` envelopes. `channelPusher`
// encapsulates that so the rest reads as ordinary pushes.

import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { deriveServices } from "@/lib/rows";
import type {
  ContainerStatus,
  InstallEvent,
  InstanceRow,
  PublishedPort,
  SnapshotEvent,
  UpView,
  WebPort,
} from "./bindings";

// --- fake instances -------------------------------------------------------

type Def = {
  instanceId: string;
  appId: string;
  name: string;
  version: string;
  description: string;
  webPorts: WebPort[];
};

function webPort(name: string, container: number, host: number, path = "/"): WebPort {
  return { name, container, protocol: "tcp", path, host, description: null };
}

const DEFS: Def[] = [
  {
    instanceId: "comfyui-a1b2c3",
    appId: "comfyui",
    name: "ComfyUI",
    version: "0.3.1",
    description: "Node-based Stable Diffusion UI.",
    webPorts: [webPort("web", 8188, 8188)],
  },
  {
    instanceId: "whisper-0f1e2d",
    appId: "whisper",
    name: "Whisper WebUI",
    version: "1.0.0",
    description: "Speech-to-text transcription UI.",
    webPorts: [webPort("web", 7860, 7861)],
  },
  {
    instanceId: "hello-web-778899",
    appId: "hello-web",
    name: "Hello Web",
    version: "0.1.0",
    description: "A tiny demo web app.",
    webPorts: [webPort("web", 8080, 8090)],
  },
];

type Status = { installed: boolean; running: boolean; accepting: boolean };

const state: Record<string, Status> = {
  "comfyui-a1b2c3": { installed: true, running: false, accepting: false },
  "whisper-0f1e2d": { installed: false, running: false, accepting: false },
  "hello-web-778899": { installed: true, running: true, accepting: true },
};

function def(id: string): Def {
  const d = DEFS.find((x) => x.instanceId === id);
  if (!d) throw new Error(`mock: unknown instance "${id}"`);
  return d;
}

function publishedPorts(id: string): PublishedPort[] {
  const s = state[id]!;
  return def(id).webPorts.map((wp) => ({
    container: wp.container,
    public: wp.host,
    protocol: wp.protocol,
    accepting: s.accepting,
  }));
}

function buildRow(d: Def): InstanceRow {
  const s = state[d.instanceId]!;
  const live = s.running ? publishedPorts(d.instanceId) : [];
  return {
    instanceId: d.instanceId,
    appId: d.appId,
    name: d.name,
    version: d.version,
    description: d.description,
    webPorts: d.webPorts,
    services: deriveServices(d.webPorts, live),
    installed: s.installed,
    running: s.running,
  };
}

function currentContainers(): ContainerStatus[] {
  return DEFS.filter((d) => state[d.instanceId]!.running).map((d) => ({
    instance: d.instanceId,
    state: "running",
    ports: publishedPorts(d.instanceId),
  }));
}

// --- Channel plumbing -----------------------------------------------------

/** Recover a Channel's numeric callback id from whatever mockIPC handed us. */
function channelCallbackId(arg: unknown): number | undefined {
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

/** A resolved Channel: push correctly-indexed envelopes to its registered callback. */
type Pusher<T> = { push: (message: T) => void; end: () => void };

function channelPusher<T>(arg: unknown): Pusher<T> | undefined {
  const id = channelCallbackId(arg);
  if (id === undefined) return undefined;
  const callback = window.__TAURI_INTERNALS__?.callbacks?.get(id);
  if (!callback) return undefined;
  let index = 0;
  return {
    push: (message: T) => callback({ index: index++, message }),
    end: () => callback({ index, end: id }),
  };
}

/** Read a named field from an invoke payload (only the record form carries args). */
function field(payload: InvokeArgs | undefined, key: string): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

// --- subscriptions --------------------------------------------------------

let nextSubscriptionId = 1;
/** Live snapshot subscribers — every state change re-pushes to all of them. */
const snapshotPushers = new Map<number, Pusher<SnapshotEvent>>();
/** Disposers for every subscription id (snapshot pumps + install streams). */
const disposers = new Map<number, () => void>();

function broadcastSnapshot(): void {
  const event: SnapshotEvent = { type: "snapshot", containers: currentContainers() };
  for (const pusher of snapshotPushers.values()) pusher.push(event);
}

/** Simulate an app "warming up": Docker publishes the port at start, the probe only
 *  goes green a moment later — so `ready` transitions after the row is already live. */
function scheduleWarming(id: string): void {
  setTimeout(() => {
    if (state[id]?.running) {
      state[id]!.accepting = true;
      broadcastSnapshot();
    }
  }, 2500);
}

const INSTALL_LOG = [
  "Step 1/6 : FROM python:3.12-slim",
  "Step 2/6 : RUN pip install -r requirements.txt",
  " ---> Running in a9f3c1e2",
  "Collecting torch, transformers, accelerate ...",
  "Step 5/6 : COPY . /app",
  'Step 6/6 : CMD ["python", "app.py"]',
  "Successfully built the image",
];

let installed = false;

/**
 * Install the dev mock. Idempotent and page-lifetime: the mock is a global singleton
 * (its `mockIPC` handler + subscription registry live in this module), so it is
 * installed ONCE and never torn down — a reload clears everything.
 *
 * The returned disposer is intentionally a NO-OP. An earlier version cleared the
 * global `snapshotPushers` on dispose, which raced badly with React StrictMode: the
 * throwaway first mount's async mock-import can resolve AFTER the second mount has
 * already subscribed, and its late cleanup then wiped the live subscription — leaving
 * zero pushers, so `up`/`down` snapshots reached nobody. Per-subscription teardown is
 * the store's job (via `unsubscribe`), not a global reset.
 */
export function installBrowserMock(): () => void {
  if (installed) return () => {};
  installed = true;
  mockIPC((cmd: string, payload?: InvokeArgs) => {
    switch (cmd) {
      case "list_instance_rows":
        return DEFS.map(buildRow);

      case "subscribe_instances": {
        const pusher = channelPusher<SnapshotEvent>(field(payload, "onEvent"));
        const id = nextSubscriptionId++;
        if (pusher) {
          snapshotPushers.set(id, pusher);
          pusher.push({ type: "snapshot", containers: currentContainers() });
          disposers.set(id, () => snapshotPushers.delete(id));
        }
        return id;
      }

      case "instance_up": {
        const id = String(field(payload, "id"));
        const s = state[id];
        if (s) {
          s.installed = true; // `up` builds silently if missing
          s.running = true;
          s.accepting = false;
          scheduleWarming(id);
          broadcastSnapshot();
        }
        const d = def(id);
        const url = d.webPorts[0]
          ? `http://localhost:${d.webPorts[0].host}${d.webPorts[0].path}`
          : null;
        return { id, usedGpu: false, url } satisfies UpView;
      }

      case "instance_down": {
        const id = String(field(payload, "id"));
        const s = state[id];
        if (s) {
          s.running = false;
          s.accepting = false;
          broadcastSnapshot();
        }
        return null;
      }

      case "instance_install": {
        const id = String(field(payload, "id"));
        const pusher = channelPusher<InstallEvent>(field(payload, "onProgress"));
        const subId = nextSubscriptionId++;
        if (pusher) {
          let i = 0;
          const timer = setInterval(() => {
            if (i < INSTALL_LOG.length) {
              pusher.push({ type: "log", line: INSTALL_LOG[i]! });
              i += 1;
              return;
            }
            clearInterval(timer);
            disposers.delete(subId);
            if (state[id]) state[id]!.installed = true;
            pusher.push({ type: "done", tag: `compositz/${id}:latest` });
            broadcastSnapshot();
          }, 350);
          disposers.set(subId, () => clearInterval(timer));
        }
        return subId;
      }

      case "unsubscribe": {
        const subId = Number(field(payload, "subscriptionId"));
        disposers.get(subId)?.();
        disposers.delete(subId);
        return null;
      }

      case "open_service_url": {
        const url = String(field(payload, "url"));
        window.open(url, "_blank", "noopener");
        return null;
      }

      default:
        throw new Error(`mock: unhandled command "${cmd}"`);
    }
  });

  return () => {};
}

/** Exposed for tests that assert list rendering from known fixture data. */
export { DEFS };
