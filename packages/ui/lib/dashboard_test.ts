import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "@compositz/core";
import {
  type ContainerStatus,
  type EngineSnapshot,
  instanceServices,
  type InstanceView,
  type PublishedPort,
  toContainerStatuses,
  toInstanceRows,
  type WebPort,
  withOptimisticAction,
} from "./dashboard.ts";

const INSTANCE_LABEL = "io.compositz.instance";
const IID = "hello-web-a1b2c3";

const WEB_PORT: WebPort = { name: "web", container: 8080, protocol: "tcp", path: "/" };

function view(over: Partial<InstanceView> = {}): InstanceView {
  return {
    instanceId: IID,
    appId: "hello-web",
    name: "Hello Web",
    version: "0.1.0",
    description: "demo",
    webPorts: [WEB_PORT],
    imageTag: "compositz/hello-web-a1b2c3:0.1.0",
    ...over,
  };
}

function status(over: Partial<ContainerStatus> = {}): ContainerStatus {
  return { instance: IID, state: "running", ports: [], ...over };
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
  assertEquals(rows[0].services, []);
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

Deno.test("instanceServices resolves a web port to the live published host port + path", () => {
  const webPorts: WebPort[] = [{ name: "ui", container: 8080, protocol: "tcp", path: "/app" }];
  const ports: PublishedPort[] = [{ container: 8080, public: 49153, protocol: "tcp" }];
  assertEquals(instanceServices(webPorts, ports), [
    {
      name: "ui",
      path: "/app",
      description: undefined,
      port: 49153,
      url: "http://localhost:49153/app",
    },
  ]);
});

Deno.test("instanceServices lists a web port with NO live binding as starting (url undefined)", () => {
  assertEquals(instanceServices([WEB_PORT], []), [
    { name: "web", path: "/", description: undefined, port: undefined, url: undefined },
  ]);
  // protocol mismatch is not a binding → still listed, still starting
  assertEquals(
    instanceServices([WEB_PORT], [{ container: 8080, public: 5000, protocol: "udp" }]),
    [{ name: "web", path: "/", description: undefined, port: undefined, url: undefined }],
  );
});

Deno.test("instanceServices lists every declared web port (multi-web app)", () => {
  const webPorts: WebPort[] = [
    { name: "ui", container: 8080, protocol: "tcp", path: "/" },
    { name: "admin", container: 9090, protocol: "tcp", path: "/admin" },
  ];
  const ports: PublishedPort[] = [
    { container: 8080, public: 18080, protocol: "tcp" },
    // admin (9090) not published yet → listed as starting
  ];
  assertEquals(instanceServices(webPorts, ports).map((s) => s.url), [
    "http://localhost:18080/",
    undefined,
  ]);
});

Deno.test("toInstanceRows resolves services from the running container's LIVE ports (auto-bumped)", () => {
  // Declared container 8080; the running container published it on a bumped 18080.
  const running = status({ ports: [{ container: 8080, public: 18080, protocol: "tcp" }] });
  const rows = toInstanceRows([view()], snapshot({ containers: [running] }));
  assertEquals(rows[0].services, [
    { name: "web", path: "/", description: undefined, port: 18080, url: "http://localhost:18080/" },
  ]);
});

Deno.test("toInstanceRows lists services-from-definition before the port is published (starting)", () => {
  // Running, but the SSE snapshot hasn't carried the published port yet (e.g. optimistic up).
  const startingUp = status({ ports: [] });
  const rows = toInstanceRows([view()], snapshot({ containers: [startingUp] }));
  assertEquals(rows[0].services, [
    { name: "web", path: "/", description: undefined, port: undefined, url: undefined },
  ]);
});

Deno.test("toInstanceRows: a stopped instance has no services", () => {
  const stopped = status({ state: "exited", ports: [] });
  assertEquals(toInstanceRows([view()], snapshot({ containers: [stopped] }))[0].services, []);
});

Deno.test("withOptimisticAction(up) yields a running container for the instance", () => {
  const out = withOptimisticAction([], IID, "up");
  assertEquals(out, [{ instance: IID, state: "running", ports: [] }]);
  // reflected as running by toInstanceRows
  assertEquals(toInstanceRows([view()], { containers: out, installedTags: [] })[0].running, true);
});

Deno.test("withOptimisticAction(down) drops the instance's containers", () => {
  const before: ContainerStatus[] = [{ instance: IID, state: "running", ports: [] }];
  assertEquals(withOptimisticAction(before, IID, "down"), []);
});

Deno.test("withOptimisticAction does not touch other instances' containers", () => {
  const before: ContainerStatus[] = [{ instance: "other-z9", state: "running", ports: [] }];
  assertEquals(withOptimisticAction(before, IID, "up"), [
    { instance: "other-z9", state: "running", ports: [] },
    { instance: IID, state: "running", ports: [] },
  ]);
  assertEquals(withOptimisticAction(before, IID, "down"), [
    { instance: "other-z9", state: "running", ports: [] },
  ]);
});

Deno.test("withOptimisticAction(up) replaces a stale entry for the same instance", () => {
  const before: ContainerStatus[] = [{ instance: IID, state: "exited", ports: [] }];
  assertEquals(withOptimisticAction(before, IID, "up"), [
    { instance: IID, state: "running", ports: [] },
  ]);
});

Deno.test("toContainerStatuses maps label, state, and host-published ports (drops unpublished)", () => {
  const out = toContainerStatuses([
    summary({
      State: "running",
      Labels: { [INSTANCE_LABEL]: IID },
      Ports: [
        { PrivatePort: 8080, PublicPort: 18080, Type: "tcp" },
        { PrivatePort: 9090, Type: "tcp" }, // unpublished → dropped
      ],
    }),
    summary({ State: "exited", Labels: {}, Ports: [] }),
  ], INSTANCE_LABEL);
  assertEquals(out, [
    {
      instance: IID,
      state: "running",
      ports: [{ container: 8080, public: 18080, protocol: "tcp" }],
    },
    { instance: null, state: "exited", ports: [] },
  ]);
});
