import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "@compositz/core";
import {
  type ContainerStatus,
  type EngineSnapshot,
  type InstanceView,
  toContainerStatuses,
  toInstanceRows,
  withOptimisticAction,
} from "./dashboard.ts";

const INSTANCE_LABEL = "io.compositz.instance";
const IID = "hello-web-a1b2c3";

function view(over: Partial<InstanceView> = {}): InstanceView {
  return {
    instanceId: IID,
    appId: "hello-web",
    name: "Hello Web",
    version: "0.1.0",
    description: "demo",
    web: "http://localhost:8090/",
    imageTag: "compositz/hello-web-a1b2c3:0.1.0",
    ...over,
  };
}

function status(over: Partial<ContainerStatus> = {}): ContainerStatus {
  return { instance: IID, state: "running", ...over };
}

function snapshot(over: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return { containers: [], installedTags: [], ...over };
}

function summary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    Id: "abc123",
    Names: [`/compositz-${IID}`],
    Image: "compositz/hello-web-a1b2c3:0.1.0",
    State: "running",
    Status: "Up 2 minutes",
    Ports: [],
    Labels: { [INSTANCE_LABEL]: IID },
    ...over,
  };
}

Deno.test("engine offline (null snapshot): instances list, installed unknown, not running", () => {
  const rows = toInstanceRows([view()], null);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].installed, null);
  assertEquals(rows[0].running, false);
  assertEquals(rows[0].name, "Hello Web");
});

Deno.test("a running managed container for the instance marks the row running", () => {
  const rows = toInstanceRows([view()], snapshot({ containers: [status({ state: "running" })] }));
  assertEquals(rows[0].running, true);
});

Deno.test("a stopped container does not mark the row running", () => {
  const rows = toInstanceRows([view()], snapshot({ containers: [status({ state: "exited" })] }));
  assertEquals(rows[0].running, false);
});

Deno.test("a running container for a different instance does not bleed across rows", () => {
  const rows = toInstanceRows(
    [view()],
    snapshot({ containers: [status({ instance: "something-else-x9y8z7" })] }),
  );
  assertEquals(rows[0].running, false);
});

Deno.test("installed reflects whether the instance's image tag exists locally", () => {
  const present = snapshot({ installedTags: ["compositz/hello-web-a1b2c3:0.1.0"] });
  assertEquals(toInstanceRows([view()], present)[0].installed, true);

  const absent = snapshot({ installedTags: ["compositz/other:1.0.0"] });
  assertEquals(toInstanceRows([view()], absent)[0].installed, false);
});

Deno.test("no instances yields no rows", () => {
  assertEquals(toInstanceRows([], snapshot()), []);
});

Deno.test("withOptimisticAction(up) yields a running container for the instance", () => {
  const out = withOptimisticAction([], IID, "up");
  assertEquals(out, [{ instance: IID, state: "running" }]);
  // reflected as running by toInstanceRows
  assertEquals(toInstanceRows([view()], { containers: out, installedTags: [] })[0].running, true);
});

Deno.test("withOptimisticAction(down) drops the instance's containers", () => {
  const before: ContainerStatus[] = [{ instance: IID, state: "running" }];
  assertEquals(withOptimisticAction(before, IID, "down"), []);
});

Deno.test("withOptimisticAction does not touch other instances' containers", () => {
  const before: ContainerStatus[] = [{ instance: "other-z9", state: "running" }];
  assertEquals(withOptimisticAction(before, IID, "up"), [
    { instance: "other-z9", state: "running" },
    { instance: IID, state: "running" },
  ]);
  assertEquals(withOptimisticAction(before, IID, "down"), [
    { instance: "other-z9", state: "running" },
  ]);
});

Deno.test("withOptimisticAction(up) replaces a stale entry for the same instance", () => {
  const before: ContainerStatus[] = [{ instance: IID, state: "exited" }];
  assertEquals(withOptimisticAction(before, IID, "up"), [
    { instance: IID, state: "running" },
  ]);
});

Deno.test("toContainerStatuses maps the instance label and state, null when unlabeled", () => {
  const out = toContainerStatuses([
    summary({ State: "running", Labels: { [INSTANCE_LABEL]: IID } }),
    summary({ State: "exited", Labels: {} }),
  ], INSTANCE_LABEL);
  assertEquals(out, [
    { instance: IID, state: "running" },
    { instance: null, state: "exited" },
  ]);
});
