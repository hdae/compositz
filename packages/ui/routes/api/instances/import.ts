import { CompositzError, EngineHttpError, ingestBundle, instancesDir } from "@compositz/core";
import { define } from "../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + filesystem). Accepts a recipe
// bundle as the raw request body (a tar / tar.gz archive) and creates a new instance
// in the store. The body is STREAMED through extraction to disk (never fully
// buffered), so any-size bundle imports without exhausting memory. The island posts
// the chosen File as the body; on success it reloads to show the new instance.

const store = instancesDir();

export const handler = define.handlers({
  async POST(ctx) {
    const body = ctx.req.body;
    if (!body) {
      return Response.json({ ok: false, error: "empty upload" }, { status: 400 });
    }
    try {
      const instance = await ingestBundle({ kind: "archive", stream: body }, store, {
        source: "upload",
      });
      return Response.json({
        ok: true,
        instanceId: instance.instanceId,
        appId: instance.appId,
        name: instance.manifest.name,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // A bad-input CompositzError (bad archive / traversal / invalid manifest) is
      // the client's fault → 400; an engine/OS fault (incl. EngineHttpError, which
      // extends CompositzError) is ours → 500.
      const status = e instanceof EngineHttpError ? 500 : e instanceof CompositzError ? 400 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  },
});
