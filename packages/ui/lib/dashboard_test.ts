import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "@compositz/core";
import {
  type ContainerStatus,
  type EngineSnapshot,
  type RecipeView,
  toContainerStatuses,
  toRecipeRows,
  withOptimisticAction,
} from "./dashboard.ts";

const RECIPE_LABEL = "io.compositz.recipe";

function view(over: Partial<RecipeView> = {}): RecipeView {
  return {
    id: "hello-web",
    name: "Hello Web",
    version: "0.1.0",
    description: "demo",
    web: "http://localhost:8090/",
    imageTag: "compositz/hello-web:0.1.0",
    ...over,
  };
}

function status(over: Partial<ContainerStatus> = {}): ContainerStatus {
  return { recipe: "hello-web", state: "running", ...over };
}

function snapshot(over: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return { containers: [], installedTags: [], ...over };
}

function summary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    Id: "abc123",
    Names: ["/compositz-hello-web"],
    Image: "compositz/hello-web:0.1.0",
    State: "running",
    Status: "Up 2 minutes",
    Ports: [],
    Labels: { [RECIPE_LABEL]: "hello-web" },
    ...over,
  };
}

Deno.test("engine offline (null snapshot): recipes list, installed unknown, not running", () => {
  const rows = toRecipeRows([view()], null);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].installed, null);
  assertEquals(rows[0].running, false);
  assertEquals(rows[0].name, "Hello Web");
});

Deno.test("a running managed container for the recipe marks the row running", () => {
  const rows = toRecipeRows([view()], snapshot({ containers: [status({ state: "running" })] }));
  assertEquals(rows[0].running, true);
});

Deno.test("a stopped container does not mark the row running", () => {
  const rows = toRecipeRows([view()], snapshot({ containers: [status({ state: "exited" })] }));
  assertEquals(rows[0].running, false);
});

Deno.test("a running container for a different recipe does not bleed across rows", () => {
  const rows = toRecipeRows(
    [view({ id: "hello-web" })],
    snapshot({ containers: [status({ recipe: "something-else" })] }),
  );
  assertEquals(rows[0].running, false);
});

Deno.test("installed reflects whether the recipe's image tag exists locally", () => {
  const present = snapshot({ installedTags: ["compositz/hello-web:0.1.0"] });
  assertEquals(toRecipeRows([view()], present)[0].installed, true);

  const absent = snapshot({ installedTags: ["compositz/other:1.0.0"] });
  assertEquals(toRecipeRows([view()], absent)[0].installed, false);
});

Deno.test("no recipes yields no rows", () => {
  assertEquals(toRecipeRows([], snapshot()), []);
});

Deno.test("withOptimisticAction(up) yields a running container for the recipe", () => {
  const out = withOptimisticAction([], "hello-web", "up");
  assertEquals(out, [{ recipe: "hello-web", state: "running" }]);
  // reflected as running by toRecipeRows
  assertEquals(toRecipeRows([view()], { containers: out, installedTags: [] })[0].running, true);
});

Deno.test("withOptimisticAction(down) drops the recipe's containers", () => {
  const before: ContainerStatus[] = [{ recipe: "hello-web", state: "running" }];
  assertEquals(withOptimisticAction(before, "hello-web", "down"), []);
});

Deno.test("withOptimisticAction does not touch other recipes' containers", () => {
  const before: ContainerStatus[] = [{ recipe: "other", state: "running" }];
  assertEquals(withOptimisticAction(before, "hello-web", "up"), [
    { recipe: "other", state: "running" },
    { recipe: "hello-web", state: "running" },
  ]);
  assertEquals(withOptimisticAction(before, "hello-web", "down"), [
    { recipe: "other", state: "running" },
  ]);
});

Deno.test("withOptimisticAction(up) replaces a stale entry for the same recipe", () => {
  const before: ContainerStatus[] = [{ recipe: "hello-web", state: "exited" }];
  assertEquals(withOptimisticAction(before, "hello-web", "up"), [
    { recipe: "hello-web", state: "running" },
  ]);
});

Deno.test("toContainerStatuses maps the recipe label and state, null when unlabeled", () => {
  const out = toContainerStatuses([
    summary({ State: "running", Labels: { [RECIPE_LABEL]: "hello-web" } }),
    summary({ State: "exited", Labels: {} }),
  ], RECIPE_LABEL);
  assertEquals(out, [
    { recipe: "hello-web", state: "running" },
    { recipe: null, state: "exited" },
  ]);
});
