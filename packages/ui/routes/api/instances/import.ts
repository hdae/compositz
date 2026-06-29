import {
  CompositzError,
  EngineHttpError,
  ingestBundle,
  type Instance,
  instanceImageTag,
  instancesDir,
} from "@compositz/core";
import { define } from "../../../utils.ts";
import type { InstanceView } from "../../../lib/dashboard.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + filesystem). Accepts a recipe
// bundle as the raw request body (a tar / tar.gz archive) and creates a new instance
// in the store. The body is STREAMED through extraction to disk (never fully
// buffered), so any-size bundle imports without exhausting memory. The island posts
// the chosen File as the body with `?filename=` so the recorded source is meaningful
// (`upload:<filename>`), and gets back the full view to render the new row
// optimistically + the source to show in the trust ("install?") prompt.

const store = instancesDir();

/** Build the dashboard view from a freshly-ingested instance (mirrors routes/index.tsx). */
function toView(instance: Instance): InstanceView {
  const m = instance.manifest;
  return {
    instanceId: instance.instanceId,
    appId: instance.appId,
    name: m.name,
    version: m.version,
    description: m.description ?? "",
    webPorts: m.ports.filter((p) => p.web).map((p) => ({
      name: p.name,
      container: p.container,
      protocol: p.protocol,
      path: p.path,
      description: p.description,
    })),
    imageTag: instanceImageTag(m, instance.instanceId),
  };
}

/** Reduce a user-supplied filename to a short, printable label for `meta.source`. */
function sanitizeFilename(name: string): string {
  const printable = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join("")
    .trim();
  return printable.slice(-120) || "file";
}

export const handler = define.handlers({
  async POST(ctx) {
    const body = ctx.req.body;
    if (!body) {
      return Response.json({ ok: false, error: "empty upload" }, { status: 400 });
    }
    const filename = new URL(ctx.req.url).searchParams.get("filename");
    const source = filename ? `upload:${sanitizeFilename(filename)}` : "upload";
    try {
      const instance = await ingestBundle({ kind: "archive", stream: body }, store, { source });
      return Response.json({
        ok: true,
        view: toView(instance),
        source: instance.meta.source ?? source,
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
