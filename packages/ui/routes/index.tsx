import { page } from "fresh";
import { EngineClient, instancesDir, label, listInstances } from "@compositz/core";
import { define } from "../utils.ts";
import { type ContainerStatus, type InstanceView, toContainerStatuses } from "../lib/dashboard.ts";
import { toInstanceView } from "../lib/instance-view.ts";
import InstanceList from "../islands/InstanceList.tsx";

// The instance store (app-data; COMPOSITZ_INSTANCES_DIR overrides) — absolute,
// independent of the UI server's cwd.
const store = instancesDir();

type Initial = {
  containers: ContainerStatus[];
  installedTags: string[];
  engineOnline: boolean;
  engineError: string | null;
};

// SERVER-ONLY: this route module imports @compositz/core (→ node:net). It loads
// the initial dashboard snapshot server-side and hands it to the InstanceList
// island, which then live-updates via SSE. Engine code stays in routes, never
// islands (the `fresh:check-imports` build guard enforces this).
export const handler = define.handlers({
  async GET(_ctx) {
    const instances = await listInstances(store);
    const views: InstanceView[] = instances.map(toInstanceView);

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
        containers: toContainerStatuses(list, label("instance")),
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
    <div class="min-h-screen bg-background text-foreground">
      <main class="max-w-screen-lg mx-auto px-6 py-10">
        {
          /* The visible app title lives in the window/tab bar; keep a screen-reader-only
            heading so the page still has an H1 and a main landmark for AT/outline nav. */
        }
        <h1 class="sr-only">Compositz</h1>
        <InstanceList views={data.views} initial={data.initial} />
      </main>
    </div>
  );
});
