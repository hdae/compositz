// @compositz/server — Hono app wrapping @compositz/core over HTTP + SSE.
//
// The SAME API backs both the desktop webview UI and a future `compositz serve`
// (headless). The SPA stays loosely coupled to this over plain HTTP + SSE.

import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { streamSSE } from "@hono/hono/streaming";
import {
  type ContainerSummary,
  down,
  EngineClient,
  installRecipe,
  label,
  listRecipes,
  loadRecipe,
  recipeImageTag,
  up,
  webUrl,
} from "@compositz/core";

export interface ServerOptions {
  recipesDir?: string;
  client?: EngineClient;
}

export function createApp(opts: ServerOptions = {}): Hono {
  const recipesDir = opts.recipesDir ?? "recipes";
  const client = opts.client ?? new EngineClient();
  const managed = { label: [`${label("managed")}=true`] };

  const app = new Hono();
  app.use("/api/*", cors()); // trusted local origin; lets the SPA run in a plain browser too
  app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, 500));

  app.get("/api/health", async (c) => {
    try {
      const v = await client.version();
      return c.json({
        ok: true,
        engine: v.Version,
        api: v.ApiVersion,
        platform: `${v.Os}/${v.Arch}`,
      });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 503);
    }
  });

  app.get("/api/recipes", async (c) => {
    const recipes = await listRecipes(recipesDir);
    const out = await Promise.all(recipes.map(async (r) => ({
      id: r.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description ?? "",
      gpu: r.manifest.gpu,
      web: webUrl(r.manifest) ?? null,
      installed: await client.imageExists(recipeImageTag(r.manifest)),
    })));
    return c.json(out);
  });

  app.get("/api/containers", async (c) => {
    const list = await client.ps({ all: true, filters: managed });
    return c.json(list.map(summarize));
  });

  // Build a recipe's image, streaming the build log as SSE.
  app.get("/api/recipes/:id/install", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      try {
        const recipe = await loadRecipe(`${recipesDir}/${id}`);
        for await (const p of installRecipe(client, recipe)) {
          if (p.stream) await stream.writeSSE({ event: "log", data: p.stream });
        }
        await stream.writeSSE({ event: "done", data: recipeImageTag(recipe.manifest) });
      } catch (e) {
        await stream.writeSSE({ event: "error", data: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  app.post("/api/recipes/:id/up", async (c) => {
    const recipe = await loadRecipe(`${recipesDir}/${c.req.param("id")}`);
    if (!(await client.imageExists(recipeImageTag(recipe.manifest)))) {
      for await (const _ of installRecipe(client, recipe)) { /* drain build */ }
    }
    const r = await up(client, recipe);
    return c.json({ id: r.id, usedGpu: r.usedGpu, url: webUrl(recipe.manifest) ?? null });
  });

  app.post("/api/recipes/:id/down", async (c) => {
    await down(client, c.req.param("id"));
    return c.json({ ok: true });
  });

  // Live container status: poll and push the managed-container list every 2s.
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        const list = await client.ps({ all: true, filters: managed });
        await stream.writeSSE({ event: "containers", data: JSON.stringify(list.map(summarize)) });
        await stream.sleep(2000);
      }
    });
  });

  return app;
}

function summarize(x: ContainerSummary) {
  return {
    id: x.Id,
    name: x.Names[0]?.replace(/^\//, "") ?? x.Id.slice(0, 12),
    state: x.State,
    status: x.Status,
    recipe: x.Labels[label("recipe")] ?? null,
    ports: [
      ...new Set(
        x.Ports.filter((p) => p.PublicPort).map((p) =>
          `${p.PublicPort}->${p.PrivatePort}/${p.Type}`
        ),
      ),
    ],
  };
}
