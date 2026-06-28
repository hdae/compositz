import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "@compositz/core";
import { type EngineSnapshot, type RecipeView, toRecipeRows } from "./dashboard.ts";

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

function container(over: Partial<ContainerSummary> = {}): ContainerSummary {
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

function snapshot(over: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return { containers: [], installedTags: new Set(), ...over };
}

Deno.test("engine offline (null snapshot): recipes list, installed unknown, not running", () => {
  const rows = toRecipeRows([view()], null, RECIPE_LABEL);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].installed, null);
  assertEquals(rows[0].running, false);
  assertEquals(rows[0].name, "Hello Web");
});

Deno.test("a running managed container for the recipe marks the row running", () => {
  const snap = snapshot({ containers: [container({ State: "running" })] });
  const rows = toRecipeRows([view()], snap, RECIPE_LABEL);
  assertEquals(rows[0].running, true);
});

Deno.test("a stopped container does not mark the row running", () => {
  const snap = snapshot({ containers: [container({ State: "exited" })] });
  const rows = toRecipeRows([view()], snap, RECIPE_LABEL);
  assertEquals(rows[0].running, false);
});

Deno.test("a running container for a different recipe does not bleed across rows", () => {
  const snap = snapshot({
    containers: [container({ Labels: { [RECIPE_LABEL]: "something-else" } })],
  });
  const rows = toRecipeRows([view({ id: "hello-web" })], snap, RECIPE_LABEL);
  assertEquals(rows[0].running, false);
});

Deno.test("installed reflects whether the recipe's image tag exists locally", () => {
  const present = snapshot({ installedTags: new Set(["compositz/hello-web:0.1.0"]) });
  assertEquals(toRecipeRows([view()], present, RECIPE_LABEL)[0].installed, true);

  const absent = snapshot({ installedTags: new Set(["compositz/other:1.0.0"]) });
  assertEquals(toRecipeRows([view()], absent, RECIPE_LABEL)[0].installed, false);
});

Deno.test("no recipes yields no rows", () => {
  assertEquals(toRecipeRows([], snapshot(), RECIPE_LABEL), []);
});
