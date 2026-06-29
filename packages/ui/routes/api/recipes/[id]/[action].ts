import {
  down,
  EngineClient,
  installRecipe,
  loadRecipe,
  RECIPE_ID_PATTERN,
  recipeImageTag,
  up,
  webUrl,
} from "@compositz/core";
import type { Recipe } from "@compositz/core";
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

/**
 * Load the recipe for a URL id, reusing core's id charset (the single source of
 * truth) and reconciling the loaded manifest id with the URL id — so a path-shaped
 * id can neither traverse out of recipesDir nor load an unintended recipe.
 */
async function loadById(id: string): Promise<Recipe> {
  if (!RECIPE_ID_PATTERN.test(id)) throw new CompositzBadRequest(`invalid recipe id: ${id}`);
  const recipe = await loadRecipe(`${recipesDir}/${id}`);
  if (recipe.manifest.id !== id) {
    throw new CompositzBadRequest(
      `recipe id mismatch: url "${id}" vs manifest "${recipe.manifest.id}"`,
    );
  }
  return recipe;
}

/** A 400-worthy bad request (distinct from a 500 engine error). */
class CompositzBadRequest extends Error {}

export const handler = define.handlers({
  async POST(ctx) {
    const { id, action } = ctx.params;

    try {
      switch (action) {
        case "up": {
          const recipe = await loadById(id);
          if (!(await client.imageExists(recipeImageTag(recipe.manifest)))) {
            for await (const _ of installRecipe(client, recipe)) { /* drain build stream */ }
          }
          const result = await up(client, recipe);
          return Response.json({
            ok: true,
            id: result.id,
            usedGpu: result.usedGpu,
            url: webUrl(recipe.manifest, { hostPorts: result.hostPorts }) ?? null,
          });
        }
        case "down": {
          if (!RECIPE_ID_PATTERN.test(id)) {
            throw new CompositzBadRequest(`invalid recipe id: ${id}`);
          }
          await down(client, id);
          return Response.json({ ok: true });
        }
        case "install":
          if (!RECIPE_ID_PATTERN.test(id)) {
            throw new CompositzBadRequest(`invalid recipe id: ${id}`);
          }
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
        const recipe = await loadById(id);
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
