import { EngineClient, label } from "@compositz/core";
import { cyan, dim, green } from "@std/fmt/colors";

/** List Compositz-managed containers. */
export async function ps(_args: string[]): Promise<number> {
  const client = new EngineClient();
  const list = await client.ps({ all: true, filters: { label: [`${label("managed")}=true`] } });
  if (list.length === 0) {
    console.log(dim("no compositz-managed containers"));
    return 0;
  }
  console.log(dim("NAME".padEnd(24) + "STATE".padEnd(10) + "RECIPE".padEnd(16) + "PORTS"));
  for (const c of list) {
    const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
    // Docker reports IPv4 + IPv6 bindings separately; collapse to unique mappings.
    const ports = [
      ...new Set(
        c.Ports.filter((p) => p.PublicPort).map((p) =>
          `${p.PublicPort}->${p.PrivatePort}/${p.Type}`
        ),
      ),
    ].join(", ");
    const recipe = c.Labels[label("recipe")] ?? "?";
    console.log(`${green(name.padEnd(24))}${c.State.padEnd(10)}${recipe.padEnd(16)}${cyan(ports)}`);
  }
  return 0;
}
