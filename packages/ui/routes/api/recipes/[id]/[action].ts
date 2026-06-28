import {
  down,
  EngineClient,
  installRecipe,
  loadRecipe,
  recipeImageTag,
  up,
  webUrl,
} from "@compositz/core";
import { define } from "../../../../utils.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net). POST actions for a recipe:
//   up      build-if-needed + run, returns JSON
//   down    stop + remove, returns JSON
//   install build the image, streaming the build log as NDJSON (one JSON object
//           per line: {type:"log",line} … then {type:"done",tag} or {type:"error",error})
// The island posts here and lets the SSE channel (routes/api/events.ts) reflect
// up/down state; install reads the streamed body directly for live build output.

const recipesDir = Deno.env.get("COMPOSITZ_RECIPES_DIR") ?? "../../recipes";
const client = new EngineClient();

// Recipe ids flow into a filesystem path and container operations — keep them to
// a safe charset (no path traversal), even though the manager runs trusted.
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

export const handler = define.handlers({
  async POST(ctx) {
    const { id, action } = ctx.params;
    if (!SAFE_ID.test(id)) {
      return Response.json({ ok: false, error: `invalid recipe id: ${id}` }, { status: 400 });
    }

    try {
      switch (action) {
        case "up": {
          const recipe = await loadRecipe(`${recipesDir}/${id}`);
          if (!(await client.imageExists(recipeImageTag(recipe.manifest)))) {
            for await (const _ of installRecipe(client, recipe)) { /* drain build stream */ }
          }
          const result = await up(client, recipe);
          return Response.json({
            ok: true,
            id: result.id,
            usedGpu: result.usedGpu,
            url: webUrl(recipe.manifest) ?? null,
          });
        }
        case "down": {
          await down(client, id);
          return Response.json({ ok: true });
        }
        case "install":
          return installStream(id);
        default:
          return Response.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, {
        status: 500,
      });
    }
  },
});

/** Build the recipe's image, streaming the build log as newline-delimited JSON. */
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
        const recipe = await loadRecipe(`${recipesDir}/${id}`);
        const tag = recipeImageTag(recipe.manifest);
        for await (const progress of installRecipe(client, recipe)) {
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
