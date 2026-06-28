import { EngineClient, label } from "@compositz/core";
import { define } from "../../utils.ts";
import { toContainerStatuses } from "../../lib/dashboard.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). Never import from an island.
// Streams managed-container snapshots as SSE, driven by Docker's `GET /events`
// (push on each lifecycle change) instead of polling. A slow safety refresh
// covers any missed event and flips back to "online" after the engine recovers.
// The island (islands/RecipeList.tsx) consumes this via EventSource.

const SAFETY_REFRESH_MS = 15_000; // re-push regardless, as a backstop
const RECONNECT_MS = 2_000; // retry the events stream after it ends/errors

const client = new EngineClient();
const managed = `${label("managed")}=true`;
const recipeLabelKey = label("recipe");
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
        const pushSnapshot = async (): Promise<boolean> => {
          try {
            const list = await client.ps({ all: true, filters: psFilters });
            return send("snapshot", { containers: toContainerStatuses(list, recipeLabelKey) });
          } catch (e) {
            return send("offline", { error: e instanceof Error ? e.message : String(e) });
          }
        };

        if (!await pushSnapshot()) { // initial paint
          aborter.abort();
        }

        // Backstop: re-push on a slow timer so a missed event or engine recovery
        // can't leave the UI stale.
        const refreshLoop = (async () => {
          while (!signal.aborted) {
            await sleep(SAFETY_REFRESH_MS, signal);
            if (!signal.aborted && !await pushSnapshot()) aborter.abort();
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
