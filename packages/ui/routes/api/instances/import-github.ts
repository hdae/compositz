import { CompositzError, EngineHttpError, ingestGithub, instancesDir } from "@compositz/core";
import { define } from "../../../utils.ts";
import { toInstanceView } from "../../../lib/instance-view.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + fetch + filesystem). Accepts a
// GitHub source spec (`owner/repo[/subdir][@ref]`, optional `github:` prefix) as JSON
// `{ spec }`, downloads the codeload tarball over HTTPS, and ingests it into the store
// — the SAME instance-creation + trust-gate flow as a file upload, just a different
// source (ADR-021). Public repos only. The spec is parsed/validated in core; the
// instance is created on disk here, then the island opens the trust ("install?") prompt
// showing `github:owner/repo` as the provider.

const store = instancesDir();

export const handler = define.handlers({
  async POST(ctx) {
    const body = await ctx.req.json().catch(() => null) as { spec?: unknown } | null;
    const spec = typeof body?.spec === "string" ? body.spec.trim() : "";
    if (!spec) {
      return Response.json({ ok: false, error: "missing GitHub spec" }, { status: 400 });
    }
    try {
      const instance = await ingestGithub(spec, store);
      return Response.json({
        ok: true,
        view: toInstanceView(instance),
        source: instance.meta.source ?? spec,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // A bad spec / bad repo-ref (404) / bad bundle / invalid manifest is the client's
      // fault → 400; an engine/OS fault (EngineHttpError extends CompositzError) → 500.
      const status = e instanceof EngineHttpError ? 500 : e instanceof CompositzError ? 400 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  },
});
