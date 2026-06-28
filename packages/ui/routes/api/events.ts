import { EngineClient, label } from "@compositz/core";
import { define } from "../../utils.ts";
import { toContainerStatuses } from "../../lib/dashboard.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). Never import this from an
// island. Streams the managed-container snapshot as Server-Sent Events, polled
// every POLL_MS. The client island (islands/RecipeList.tsx) consumes it via
// EventSource and re-derives running status with the shared `toRecipeRows`.

const POLL_MS = 2000;
const client = new EngineClient();
const managed = { label: [`${label("managed")}=true`] };
const recipeLabelKey = label("recipe");

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
    const encoder = new TextEncoder();
    // Drive teardown off the stream's own lifecycle, not request.signal: Deno's
    // legacy request.signal aborts on a *successful response* (deno#29111), which
    // for a streaming body would fire immediately. The stream's cancel() instead
    // runs exactly when the client disconnects.
    const aborter = new AbortController();
    const signal = aborter.signal;

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

        while (!signal.aborted) {
          try {
            const list = await client.ps({ all: true, filters: managed });
            if (!send("snapshot", { containers: toContainerStatuses(list, recipeLabelKey) })) break;
          } catch (e) {
            if (!send("offline", { error: e instanceof Error ? e.message : String(e) })) break;
          }
          await sleep(POLL_MS, signal);
        }

        try {
          controller.close();
        } catch { /* already closed */ }
      },
      cancel() {
        aborter.abort(); // client disconnected → stop polling
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
