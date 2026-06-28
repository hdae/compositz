// Compositz CLI — Linux-first control surface (and the debugging tool for the desktop app).
//
//   deno task doctor   # ping the engine, print versions
//   deno task hello    # full container round-trip
//
// Requires `--unstable-net` and (on Windows) `--allow-all` for the named-pipe transport.

import { red } from "@std/fmt/colors";
import { doctor } from "./commands/doctor.ts";
import { hello } from "./commands/hello.ts";
import { install } from "./commands/install.ts";
import { upCmd } from "./commands/up.ts";
import { downCmd } from "./commands/down.ts";
import { ps } from "./commands/ps.ts";

type Command = (args: string[]) => Promise<number>;

const COMMANDS: Record<string, { run: Command; help: string }> = {
  doctor: { run: doctor, help: "Check that the Docker engine is reachable" },
  install: { run: install, help: "Build a recipe's image" },
  up: { run: upCmd, help: "Build (if needed) and start a recipe" },
  down: { run: downCmd, help: "Stop and remove a recipe's container" },
  ps: { run: ps, help: "List Compositz-managed containers" },
  hello: { run: hello, help: "Run a full container round-trip against the engine" },
};

function printHelp(): void {
  console.log("compositz — run local-AI apps as isolated Docker containers\n");
  console.log("Usage: compositz <command>\n");
  console.log("Commands:");
  for (const [name, { help }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${help}`);
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = Deno.args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return cmd ? 0 : 1;
  }
  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(red(`unknown command: ${cmd}\n`));
    printHelp();
    return 1;
  }
  try {
    return await entry.run(rest);
  } catch (e) {
    console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
