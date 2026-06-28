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

// SERVER-ONLY: imports @compositz/core (→ node:net). POST actions for a recipe.
// `up` builds the image first if it is missing (build log is drained here;
// streaming it to the client is a later increment). The island posts to this and
// lets the SSE channel (routes/api/events.ts) reflect the new state.

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
