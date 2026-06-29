import {
  down,
  EngineClient,
  installInstance,
  type Instance,
  INSTANCE_ID_PATTERN,
  instanceImageTag,
  instancesDir,
  loadInstance,
  removeInstanceDir,
  up,
  webUrl,
} from "@compositz/core";
import { join } from "@std/path";
import { define } from "../../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). POST actions for an instance:
//   up      build-if-needed + run, returns JSON
//   down    stop + remove, returns JSON
//   install build the image, streaming the build log as NDJSON (one JSON object
//           per line: {type:"log",line} … then {type:"done",tag} or {type:"error",error})
// The island posts here and lets the SSE channel (routes/api/events.ts) reflect
// up/down state; install reads the streamed body directly for live build output.

const store = instancesDir();
const client = new EngineClient();

/** A 400-worthy bad request (distinct from a 500 engine error). */
class CompositzBadRequest extends Error {}

/**
 * Load an instance for a URL id, validating against the id charset (the single
 * source of truth) and reconciling the loaded id with the URL id — so a path-shaped
 * id can neither traverse out of the store nor load an unintended instance.
 */
async function loadById(id: string): Promise<Instance> {
  assertValidId(id);
  const instance = await loadInstance(join(store, id));
  if (instance.instanceId !== id) {
    throw new CompositzBadRequest(
      `instance id mismatch: url "${id}" vs loaded "${instance.instanceId}"`,
    );
  }
  return instance;
}

function assertValidId(id: string): void {
  if (!INSTANCE_ID_PATTERN.test(id)) throw new CompositzBadRequest(`invalid instance id: ${id}`);
}

export const handler = define.handlers({
  async POST(ctx) {
    const { id, action } = ctx.params;

    try {
      switch (action) {
        case "up": {
          const instance = await loadById(id);
          const tag = instanceImageTag(instance.manifest, instance.instanceId);
          if (!(await client.imageExists(tag))) {
            for await (const _ of installInstance(client, instance)) { /* drain build stream */ }
          }
          const result = await up(client, instance);
          return Response.json({
            ok: true,
            id: result.id,
            usedGpu: result.usedGpu,
            url: webUrl(instance.manifest, { hostPorts: result.hostPorts }) ?? null,
          });
        }
        case "down": {
          assertValidId(id);
          await down(client, id);
          return Response.json({ ok: true });
        }
        case "delete": {
          // Stop+remove the container, then delete the instance definition.
          // Persisted data (named volumes + data-root) is KEPT, matching `compositz rm`.
          assertValidId(id);
          await down(client, id);
          await removeInstanceDir(store, id);
          return Response.json({ ok: true });
        }
        case "install":
          assertValidId(id);
          return installStream(id);
        default:
          return Response.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
      }
    } catch (e) {
      const status = e instanceof CompositzBadRequest ? 400 : 500;
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, {
        status,
      });
    }
  },
});

/** Build the instance's image, streaming the build log as newline-delimited JSON. */
function installStream(id: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown): boolean => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          return true;
        } catch {
          return false; // client gone mid-write
        }
      };
      try {
        const instance = await loadById(id);
        const tag = instanceImageTag(instance.manifest, instance.instanceId);
        for await (const progress of installInstance(client, instance)) {
          if (progress.stream && !send({ type: "log", line: progress.stream })) return;
        }
        send({ type: "done", tag });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        try {
          controller.close();
        } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
