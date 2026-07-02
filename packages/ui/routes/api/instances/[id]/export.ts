import {
  EngineClient,
  exportMount,
  INSTANCE_ID_PATTERN,
  instancesDir,
  loadInstance,
} from "@compositz/core";
import { join } from "@std/path";
import { define } from "../../../../utils.ts";

// SERVER-ONLY: stream one persisted mount's data as a tar download. The heavy lifting
// (helper container + archive API) lives in core `exportMount`; this route adds
// id/mount validation and the download headers. It is a GET so the OS default browser
// can be pointed straight at it (the in-app webview can't save files — same reasoning
// as /api/open, which the island uses to trigger the download).

const store = instancesDir();
const client = new EngineClient();

export const handler = define.handlers({
  async GET(ctx) {
    const { id } = ctx.params;
    const mount = new URL(ctx.req.url).searchParams.get("mount") ?? "";
    try {
      if (!INSTANCE_ID_PATTERN.test(id)) {
        return fail(400, `invalid instance id: ${id}`);
      }
      const instance = await loadInstance(join(store, id));
      if (instance.instanceId !== id) {
        return fail(400, `instance id mismatch: url "${id}" vs loaded "${instance.instanceId}"`);
      }
      if (!instance.manifest.mounts.some((mt) => mt.name === mount)) {
        const names = instance.manifest.mounts.map((mt) => mt.name).join(", ") || "(none)";
        return fail(400, `unknown mount "${mount}" — available: ${names}`);
      }
      const stream = await exportMount(client, instance, mount);
      // Mount names are charset-constrained by the manifest schema (no quotes/controls),
      // so the filename is header-safe as-is.
      return new Response(stream, {
        headers: {
          "content-type": "application/x-tar",
          "content-disposition": `attachment; filename="${id}-${mount}.tar"`,
          "cache-control": "no-cache",
        },
      });
    } catch (e) {
      return fail(500, e instanceof Error ? e.message : String(e));
    }
  },
});

function fail(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
