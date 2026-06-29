import { containerName, EngineClient, INSTANCE_ID_PATTERN } from "@compositz/core";
import { define } from "../../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). Streams a RUNNING container's
// stdout/stderr as SSE (`event: log` with {stream, line}), driven by Docker
// `GET /containers/{id}/logs?follow=1`. Like routes/api/events.ts, teardown is driven
// by the stream's cancel() (client disconnect) → an AbortController that closes the
// engine socket, NOT request.signal (deno#29111). Containers are created `Tty:false`,
// so the 8-byte demux path is used (tty:false).

const client = new EngineClient();
const TAIL = 500; // recent lines to backfill before following

export const handler = define.handlers({
  GET(ctx) {
    const { id } = ctx.params;
    if (!INSTANCE_ID_PATTERN.test(id)) {
      return Response.json({ error: `invalid instance id: ${id}` }, { status: 400 });
    }
    const name = containerName(id);
    const aborter = new AbortController();
    const signal = aborter.signal;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

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
        try {
          for await (
            const frame of client.logs(name, { follow: true, tail: TAIL, tty: false, signal })
          ) {
            const line = decoder.decode(frame.data, { stream: true });
            if (line && !send("log", { stream: frame.stream, line })) {
              aborter.abort();
              break;
            }
          }
          if (!signal.aborted) send("end", {});
        } catch (e) {
          // A stopped/absent container makes /logs 404 — report it rather than hang.
          // Named `logerror` (not `error`) so it won't collide with EventSource's own
          // native `error` event on the client.
          if (!signal.aborted) {
            send("logerror", { error: e instanceof Error ? e.message : String(e) });
          }
        } finally {
          try {
            controller.close();
          } catch { /* already closed */ }
        }
      },
      cancel() {
        aborter.abort(); // client disconnected → close the engine log socket
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
