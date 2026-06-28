import { page } from "fresh";
import { EngineClient, label, listRecipes, recipeImageTag, webUrl } from "@compositz/core";
import { define } from "../utils.ts";
import { type Dashboard, type RecipeView, toRecipeRows } from "../lib/dashboard.ts";

// Where recipe definitions live, relative to the UI server's cwd (packages/ui).
// `deno task ui` / `ui:build` run from here, so the repo-root recipes/ is two up.
const recipesDir = Deno.env.get("COMPOSITZ_RECIPES_DIR") ?? "../../recipes";

// IMPORTANT: this whole module is server-only — it imports `@compositz/core`,
// whose transport reaches `node:net` / `Deno.connect`. Fresh only bundles
// islands for the client, so a route's imports never reach the browser; the
// `fresh:check-imports` build guard fails if `node:net` ever does. Never import
// `@compositz/core` from an island.
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
    let dashboard: Dashboard;
    try {
      const client = new EngineClient();
      const managed = { label: [`${label("managed")}=true`] };
      const containers = await client.ps({ all: true, filters: managed });
      const installedTags = new Set<string>();
      await Promise.all(views.map(async (v) => {
        if (await client.imageExists(v.imageTag)) installedTags.add(v.imageTag);
      }));
      dashboard = {
        recipes: toRecipeRows(views, { containers, installedTags }, label("recipe")),
        engineOnline: true,
        engineError: null,
      };
    } catch (e) {
      dashboard = {
        recipes: toRecipeRows(views, null, label("recipe")),
        engineOnline: false,
        engineError: e instanceof Error ? e.message : String(e),
      };
    }

    return page(dashboard);
  },
});

export default define.page<typeof handler>(function Dashboard({ data }) {
  const { recipes, engineOnline, engineError } = data;
  return (
    <div class="min-h-screen bg-gray-50 text-gray-900">
      <div class="max-w-screen-lg mx-auto px-6 py-10">
        <header class="flex items-baseline justify-between border-b border-gray-200 pb-4">
          <h1 class="text-2xl font-bold">Compositz</h1>
          <EngineBadge online={engineOnline} error={engineError} />
        </header>

        {recipes.length === 0
          ? <p class="mt-10 text-gray-500">No recipes found.</p>
          : (
            <ul class="mt-6 divide-y divide-gray-200">
              {recipes.map((r) => (
                <li key={r.id} class="flex items-center gap-4 py-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold">{r.name}</span>
                      <span class="text-xs text-gray-400">{r.version}</span>
                    </div>
                    <p class="text-sm text-gray-500 truncate">{r.description}</p>
                  </div>
                  <StatusPills installed={r.installed} running={r.running} />
                  {r.web
                    ? (
                      <a
                        href={r.web}
                        class="text-sm text-blue-600 hover:underline whitespace-nowrap"
                      >
                        Open UI
                      </a>
                    )
                    : null}
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
});

function EngineBadge({ online, error }: { online: boolean; error: string | null }) {
  if (online) {
    return <span class="text-sm text-green-600">● engine online</span>;
  }
  return (
    <span class="text-sm text-amber-600" title={error ?? undefined}>
      ● engine offline
    </span>
  );
}

function StatusPills({ installed, running }: { installed: boolean | null; running: boolean }) {
  return (
    <div class="flex items-center gap-2 whitespace-nowrap">
      {running
        ? <Pill tone="green">running</Pill>
        : installed === null
        ? <Pill tone="gray">unknown</Pill>
        : installed
        ? <Pill tone="blue">installed</Pill>
        : <Pill tone="gray">not installed</Pill>}
    </div>
  );
}

function Pill({ tone, children }: { tone: "green" | "blue" | "gray"; children: string }) {
  const tones = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}
