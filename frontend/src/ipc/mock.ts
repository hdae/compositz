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
  DeleteView,
  EnvSetting,
  ImportView,
  InstallEvent,
  InstanceRow,
  InstanceSettings,
  InstanceView,
  LogEvent,
  MountSetting,
  Override,
  PortBump,
  PortSetting,
  PublishedPort,
  SetConfigView,
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
    description:
      "The most powerful and modular diffusion model GUI, with a graph/nodes interface for designing and executing advanced Stable Diffusion pipelines — supports SD1.x/SD2.x/SDXL/Flux, ControlNet, LoRAs, and fully offline local inference.",
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

// --- structural mutations (import / duplicate / delete) -------------------

let importCounter = 0;

function viewOf(d: Def): InstanceView {
  return {
    instanceId: d.instanceId,
    appId: d.appId,
    name: d.name,
    version: d.version,
    description: d.description,
    webPorts: d.webPorts,
    imageTag: `compositz/${d.instanceId}:${d.version}`,
  };
}

/** Ingest a synthetic recipe from an import source (a file path or a `github:` spec). */
function synthImport(source: string): ImportView {
  importCounter += 1;
  const short = importCounter.toString(16).padStart(6, "0");
  const isGithub = source.startsWith("github:");
  const raw = isGithub ? (source.slice("github:".length).split("@")[0] ?? "") : "";
  const repo = raw.split("/").filter(Boolean).slice(0, 2).join("-");
  const appId =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "recipe";
  const instanceId = `${appId}-${short}`;
  const d: Def = {
    instanceId,
    appId,
    name: repo || "Imported recipe",
    version: "0.1.0",
    description: `Imported from ${source}.`,
    webPorts: [webPort("web", 8000, 9000 + importCounter)],
  };
  DEFS.push(d);
  state[instanceId] = { installed: false, running: false, accepting: false };
  return { view: viewOf(d), bumps: [] };
}

// --- settings + runtime logs (for the detail tabs) ------------------------

/** Per-instance saved launch override (mirrors config.yaml) — drives get/set_config. */
const savedOverrides: Record<string, Override> = {};

/** Synthesize a Settings view-model: ports from the def + a sample env var + a mount. */
function settingsOf(id: string): InstanceSettings {
  const d = def(id);
  const over = savedOverrides[id] ?? {};
  const ports: PortSetting[] = d.webPorts.map((wp) => ({
    name: wp.name,
    container: wp.container,
    web: true,
    description: `Web UI on container port ${wp.container}.`,
    manifestHost: wp.host,
    override: over.hostPorts?.[wp.name] ?? null,
  }));
  const env: EnvSetting[] = [
    {
      name: "LOG_LEVEL",
      description: "Logging verbosity (debug | info | warn | error).",
      required: false,
      default: "info",
      override: over.env?.["LOG_LEVEL"] ?? null,
    },
  ];
  const mounts: MountSetting[] = [
    {
      name: "data",
      target: "/data",
      description: "Persistent application data.",
      manifestPlacement: "volume",
      override: over.placement?.["data"] ?? null,
    },
  ];
  // Host ports DEFINED by OTHER instances (their override ▷ manifest host).
  const takenByOthers = DEFS.filter((x) => x.instanceId !== id).flatMap((x) =>
    x.webPorts.map((wp) => savedOverrides[x.instanceId]?.hostPorts?.[wp.name] ?? wp.host),
  );
  return { ports, env, mounts, takenByOthers, restartNeeded: false };
}

const RUNTIME_LOG = [
  "[boot] loading configuration from /app/config.yaml",
  "[boot] initializing model registry",
  "[server] listening on http://0.0.0.0",
  "[server] ready — waiting for requests",
];

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

      case "import_recipe":
        return synthImport(String(field(payload, "source")));

      case "import_github":
        return synthImport(`github:${String(field(payload, "spec"))}`);

      case "instance_duplicate": {
        const id = String(field(payload, "id"));
        const src = def(id);
        importCounter += 1;
        const short = importCounter.toString(16).padStart(6, "0");
        const dupId = `${src.appId}-${short}`;
        const bumps: PortBump[] = [];
        const webPorts: WebPort[] = src.webPorts.map((wp) => {
          const to = 10000 + importCounter * 10 + (wp.container % 10);
          bumps.push({ name: wp.name, from: wp.host, to });
          return { ...wp, host: to };
        });
        // Mirror the core: a duplicate's display name is the source's "<name> (copy)".
        const dupDef: Def = { ...src, instanceId: dupId, name: `${src.name} (copy)`, webPorts };
        DEFS.push(dupDef);
        state[dupId] = { installed: false, running: false, accepting: false };
        return { view: viewOf(dupDef), bumps } satisfies ImportView;
      }

      case "instance_delete": {
        const id = String(field(payload, "id"));
        const idx = DEFS.findIndex((d) => d.instanceId === id);
        if (idx >= 0) DEFS.splice(idx, 1);
        delete state[id];
        broadcastSnapshot(); // reflect it leaving the running set, if it was up
        return { warning: null } satisfies DeleteView;
      }

      case "export_mount":
        // The browser mock can't write files — the real backend streams the tar to `dest`.
        return null;

      case "get_config":
        return settingsOf(String(field(payload, "id")));

      case "set_config": {
        const id = String(field(payload, "id"));
        savedOverrides[id] = (field(payload, "over") as Override | undefined) ?? {};
        // A running instance needs a restart to apply; a stopped one applies on next up.
        return { restartNeeded: !!state[id]?.running } satisfies SetConfigView;
      }

      case "stream_logs": {
        const id = String(field(payload, "id"));
        const pusher = channelPusher<LogEvent>(field(payload, "onLog"));
        const subId = nextSubscriptionId++;
        if (pusher) {
          if (!state[id]?.running) {
            pusher.push({ type: "end" });
          } else {
            let i = 0;
            const timer = setInterval(() => {
              if (i < RUNTIME_LOG.length) {
                pusher.push({ type: "log", line: RUNTIME_LOG[i]! });
                i += 1;
                return;
              }
              clearInterval(timer); // streamed the startup log; go quiet (stays open)
              disposers.delete(subId); // drop the now-dead disposer (matches instance_install)
            }, 500);
            disposers.set(subId, () => clearInterval(timer));
          }
        }
        return subId;
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
