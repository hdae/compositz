import { page } from "fresh";
import { EngineClient, label, listRecipes, recipeImageTag, webUrl } from "@compositz/core";
import { define } from "../utils.ts";
import { type ContainerStatus, type RecipeView, toContainerStatuses } from "../lib/dashboard.ts";
import RecipeList from "../islands/RecipeList.tsx";

// Where recipe definitions live, relative to the UI server's cwd (packages/ui).
// `deno task ui` / `ui:build` run from here, so the repo-root recipes/ is two up.
const recipesDir = Deno.env.get("COMPOSITZ_RECIPES_DIR") ?? "../../recipes";

type Initial = {
  containers: ContainerStatus[];
  installedTags: string[];
  engineOnline: boolean;
  engineError: string | null;
};

// SERVER-ONLY: this route module imports @compositz/core (→ node:net). It loads
// the initial dashboard snapshot server-side and hands it to the RecipeList
// island, which then live-updates via SSE. Engine code stays in routes, never
// islands (the `fresh:check-imports` build guard enforces this).
export const handler = define.handlers({
  async GET(_ctx) {
    const recipes = await listRecipes(recipesDir);
    const views: RecipeView[] = recipes.map((r) => ({
      id: r.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description ?? "",
      web: webUrl(r.manifest) ?? null,
      imageTag: recipeImageTag(r.manifest),
    }));

    // Best-effort engine read: the UI must still render when Docker is down.
    let initial: Initial;
    try {
      const client = new EngineClient();
      const managed = { label: [`${label("managed")}=true`] };
      const list = await client.ps({ all: true, filters: managed });
      const installedTags: string[] = [];
      await Promise.all(views.map(async (v) => {
        if (await client.imageExists(v.imageTag)) installedTags.push(v.imageTag);
      }));
      initial = {
        containers: toContainerStatuses(list, label("recipe")),
        installedTags,
        engineOnline: true,
        engineError: null,
      };
    } catch (e) {
      initial = {
        containers: [],
        installedTags: [],
        engineOnline: false,
        engineError: e instanceof Error ? e.message : String(e),
      };
    }

    return page({ views, initial });
  },
});

export default define.page<typeof handler>(function Dashboard({ data }) {
  return (
    <div class="min-h-screen bg-gray-50 text-gray-900">
      <div class="max-w-screen-lg mx-auto px-6 py-10">
        <header class="border-b border-gray-200 pb-4">
          <h1 class="text-2xl font-bold">Compositz</h1>
        </header>
        <div class="mt-6">
          <RecipeList views={data.views} initial={data.initial} />
        </div>
      </div>
    </div>
  );
});
