import { CompositzError, ingestBundle, instancesDir, MAX_BUNDLE_BYTES } from "@compositz/core";
import { define } from "../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + filesystem). Accepts a recipe
// bundle as the raw request body (a tar / tar.gz archive), extracts + Zod-validates
// it, and creates a new instance in the store. The island posts the chosen File as
// the body; on success it reloads to show the new instance.
//
// The body is read with a hard size cap (streaming, never fully buffered) so a
// huge upload can't exhaust memory before ingestion's own caps apply.

const store = instancesDir();

class PayloadTooLarge extends Error {}

export const handler = define.handlers({
  async POST(ctx) {
    try {
      const bytes = await readCappedBody(ctx.req, MAX_BUNDLE_BYTES);
      if (bytes.byteLength === 0) {
        return Response.json({ ok: false, error: "empty upload" }, { status: 400 });
      }
      const instance = await ingestBundle({ kind: "archive", bytes }, store, { source: "upload" });
      return Response.json({
        ok: true,
        instanceId: instance.instanceId,
        appId: instance.appId,
        name: instance.manifest.name,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // Bad input (oversized / bad archive / traversal / invalid manifest) is the
      // client's fault; an unexpected OS/engine error is ours.
      const status = e instanceof PayloadTooLarge ? 413 : e instanceof CompositzError ? 400 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  },
});

/** Read a request body into memory, aborting once it exceeds `max` bytes. */
async function readCappedBody(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new PayloadTooLarge(`upload exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
