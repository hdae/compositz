import { type DockerEndpoint, EngineClient } from "@compositz/core";
import { bold, dim, green, red } from "@std/fmt/colors";

/** Health check: resolve the endpoint, ping the engine, print versions. */
export async function doctor(_args: string[]): Promise<number> {
  const client = new EngineClient();
  console.log(bold("compositz doctor"));
  console.log(dim(`  endpoint: ${describeEndpoint(client.endpoint)}`));

  try {
    const pong = await client.ping();
    console.log(`  ping:     ${green(pong)}`);
    const v = await client.version();
    console.log(
      `  engine:   Docker ${v.Version}  (API ${v.ApiVersion}, min ${v.MinAPIVersion ?? "?"})`,
    );
    console.log(`  platform: ${v.Os}/${v.Arch}`);
    console.log(green("OK — engine reachable."));
    return 0;
  } catch (e) {
    console.log(red(`FAILED — ${e instanceof Error ? e.message : String(e)}`));
    console.log(dim("  Is Docker running? On Windows, Docker Desktop must be started."));
    return 1;
  }
}

function describeEndpoint(ep: DockerEndpoint): string {
  switch (ep.kind) {
    case "unix":
      return `unix://${ep.path}`;
    case "npipe":
      return `npipe://${ep.path}`;
    case "tcp":
      return `tcp://${ep.host}:${ep.port}`;
  }
}
