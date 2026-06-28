// Headless entrypoint: serve the Compositz API. Used by `deno task serve` and
// (later) the `compositz serve` CLI command and the desktop shell.
import { createApp } from "./mod.ts";

const port = Number(Deno.env.get("COMPOSITZ_PORT") ?? 8787);
const recipesDir = Deno.env.get("COMPOSITZ_RECIPES_DIR") ?? "recipes";

if (import.meta.main) {
  const app = createApp({ recipesDir });
  Deno.serve({ port }, app.fetch);
}
