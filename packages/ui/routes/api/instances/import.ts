import { ingestBundle, instancesDir } from "@compositz/core";
import { define } from "../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + filesystem). Accepts a recipe
// bundle as the raw request body (a tar / tar.gz archive), extracts + Zod-validates
// it, and creates a new instance in the store. The island posts the chosen File as
// the body; on success it reloads to show the new instance.

const store = instancesDir();

export const handler = define.handlers({
  async POST(ctx) {
    try {
      const bytes = new Uint8Array(await ctx.req.arrayBuffer());
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
      // Ingestion failures (bad archive, traversal entry, invalid manifest) are the
      // client's bad input → 400.
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, {
        status: 400,
      });
    }
  },
});
