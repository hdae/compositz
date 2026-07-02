import { EngineClient, instancesDir, label, listInstances } from "@compositz/core";
import { define } from "../../utils.ts";
import { toContainerStatuses } from "../../lib/dashboard.ts";
import { probeAccepting, probeHost } from "../../lib/probe.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). Never import from an island.
// Streams managed-container snapshots as SSE, driven by Docker's `GET /events`
// (push on each lifecycle change) instead of polling. A slow safety refresh
// covers any missed event and flips back to "online" after the engine recovers.
// Each snapshot's published ports carry an `accepting` TCP-probe result; while a
// running port is not yet accepting ("warming" — the app is still booting), the
// refresh loop polls FAST so `ready` flips promptly when the app starts listening
// (no Docker event fires at that moment). The island consumes this via EventSource.

const SAFETY_REFRESH_MS = 15_000; // re-push regardless, as a backstop
const WARMING_TICK_MS = 2_000; // refresh-loop tick; pushes at this rate while warming
const RECONNECT_MS = 2_000; // retry the events stream after it ends/errors

const client = new EngineClient();
const acceptHost = probeHost(client.endpoint);
const store = instancesDir();

/** instanceId → the manifest's `web: true` container ports (what the probe targets). */
async function webPortsByInstance(): Promise<Map<string, Set<number>>> {
  const map = new Map<string, Set<number>>();
  try {
    for (const inst of await listInstances(store)) {
      map.set(
        inst.instanceId,
        new Set(inst.manifest.ports.filter((p) => p.web).map((p) => p.container)),
      );
    }
  } catch {
    // store unreadable → probe nothing this round (ready degrades to "starting…")
  }
  return map;
}
const managed = `${label("managed")}=true`;
const instanceLabelKey = label("instance");
const psFilters = { label: [managed] };
// Container lifecycle actions that change `ps` output (engine-side filtered).
const eventFilters = {
  type: ["container"],
  label: [managed],
  event: [
    "create",
    "start",
    "restart",
    "unpause",
    "pause",
    "stop",
    "kill",
    "die",
    "destroy",
    "rename",
  ],
};

/** A `setTimeout` that also resolves immediately when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const handler = define.handlers({
  GET(_ctx) {
    // Teardown is driven by the stream's cancel() (client disconnect), not
    // request.signal (deno#29111 aborts it on a successful streaming response).
    const aborter = new AbortController();
    const signal = aborter.signal;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown): boolean => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
            return true;
          } catch {
            return false; // client gone mid-write
          }
        };

        // Push the current managed-container snapshot (or an offline notice).
        let warming = false; // a running port not yet accepting → poll fast
        let lastPush = 0;
        const doPush = async (): Promise<boolean> => {
          try {
            const list = await client.ps({ all: true, filters: psFilters });
            const containers = await probeAccepting(
              toContainerStatuses(list, instanceLabelKey),
              acceptHost,
              await webPortsByInstance(),
            );
            // Warming counts only PROBED ports (accepting === false) — an unprobed
            // port must not spin the fast poll forever.
            warming = containers.some(
              (c) => c.state === "running" && c.ports.some((p) => p.accepting === false),
            );
            lastPush = Date.now();
            return send("snapshot", { containers });
          } catch (e) {
            warming = false;
            lastPush = Date.now();
            return send("offline", { error: e instanceof Error ? e.message : String(e) });
          }
        };

        // Serialize + coalesce: the event loop and the refresh loop both push, and
        // doPush awaits inside (ps + probes) — two interleaved reads could enqueue
        // an OLDER snapshot after a newer one (stale-wins). One push at a time; a
        // push requested mid-push runs exactly one more round with fresh data.
        let inFlight: Promise<boolean> | null = null;
        let queued = false;
        const pushSnapshot = (): Promise<boolean> => {
          if (inFlight) {
            queued = true;
            return inFlight;
          }
          inFlight = (async () => {
            let ok = true;
            do {
              queued = false;
              ok = await doPush();
            } while (ok && queued && !signal.aborted);
            inFlight = null;
            return ok;
          })();
          return inFlight;
        };

        if (!await pushSnapshot()) { // initial paint
          aborter.abort();
        }

        // Backstop + warming poll: tick fast, but push only while warming (so
        // `ready` flips promptly once the booting app listens — no Docker event
        // fires at that moment) or when the slow safety interval elapses.
        const refreshLoop = (async () => {
          while (!signal.aborted) {
            await sleep(WARMING_TICK_MS, signal);
            const due = warming || Date.now() - lastPush >= SAFETY_REFRESH_MS;
            if (!signal.aborted && due && !await pushSnapshot()) aborter.abort();
          }
        })();

        // Event-driven: re-push on every relevant container event; reconnect when
        // the stream ends or the engine is unreachable.
        const eventLoop = (async () => {
          while (!signal.aborted) {
            try {
              for await (const _ev of client.events({ filters: eventFilters, signal })) {
                if (!await pushSnapshot()) {
                  aborter.abort();
                  break;
                }
              }
            } catch (e) {
              if (signal.aborted) break;
              send("offline", { error: e instanceof Error ? e.message : String(e) });
            }
            if (!signal.aborted) await sleep(RECONNECT_MS, signal);
          }
        })();

        await Promise.all([refreshLoop, eventLoop]);
        try {
          controller.close();
        } catch { /* already closed */ }
      },
      cancel() {
        aborter.abort(); // client disconnected → stop both loops + the events stream
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  },
});
