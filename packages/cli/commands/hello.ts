import { EngineClient } from "@compositz/core";
import { bold, cyan, dim, green, red } from "@std/fmt/colors";

const IMAGE = "alpine:3.20";
const NAME = "compositz-hello";

/** Full Phase 0 round-trip: pull -> create -> start -> stream logs -> wait -> remove. */
export async function hello(_args: string[]): Promise<number> {
  const client = new EngineClient();
  const td = new TextDecoder();

  console.log(bold("compositz hello") + dim(" — container round-trip"));

  // Remove any leftover container from a previous run.
  await client.remove(NAME, { force: true }).catch(() => {});

  console.log(`→ pull ${IMAGE}`);
  let lastStatus = "";
  await client.pull(IMAGE, (p) => {
    if (p.status && p.status !== lastStatus) {
      lastStatus = p.status;
      console.log(dim(`  ${p.status}`));
    }
  });

  console.log(`→ create ${NAME}`);
  const { Id } = await client.create({
    Image: IMAGE,
    Cmd: ["sh", "-c", 'for i in 1 2 3; do echo "hello $i from $(hostname)"; sleep 1; done'],
    Tty: false,
    Labels: { "io.compositz.demo": "hello" },
  }, NAME);
  console.log(dim(`  id ${Id.slice(0, 12)}`));

  console.log("→ start + stream logs");
  await client.start(Id);
  for await (const frame of client.logs(Id, { follow: true, tty: false })) {
    const tag = frame.stream === "stderr" ? red("err") : cyan("out");
    const text = td.decode(frame.data).replace(/\n+$/, "");
    for (const line of text.split("\n")) console.log(`  [${tag}] ${line}`);
  }

  const { StatusCode } = await client.wait(Id);
  console.log(`→ exited ${StatusCode === 0 ? green("0") : red(String(StatusCode))}`);

  console.log("→ remove");
  await client.remove(Id, { force: true });

  if (StatusCode === 0) {
    console.log(green("OK — pull → create → start → logs → wait → remove all succeeded."));
    return 0;
  }
  console.log(red(`FAILED — container exited ${StatusCode}`));
  return 1;
}
