import { assertEquals } from "@std/assert";
import { demuxLog } from "./logs.ts";
import type { LogFrame } from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build one 8-byte-framed log record (type 1=stdout, 2=stderr). */
function frame(type: 1 | 2, payload: string): Uint8Array {
  const data = enc.encode(payload);
  const buf = new Uint8Array(8 + data.byteLength);
  buf[0] = type;
  new DataView(buf.buffer).setUint32(4, data.byteLength, false); // big-endian length
  buf.set(data, 8);
  return buf;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

async function* inPieces(bytes: Uint8Array, n: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += n) yield bytes.subarray(i, i + n);
}

async function drain(src: AsyncIterable<Uint8Array>): Promise<LogFrame[]> {
  const out: LogFrame[] = [];
  for await (const f of demuxLog(src)) out.push(f);
  return out;
}

Deno.test("demuxLog splits stdout/stderr frames", async () => {
  const stream = concat([
    frame(1, "out line 1\n"),
    frame(2, "err line\n"),
    frame(1, "out line 2\n"),
  ]);
  const frames = await drain(inPieces(stream, 1024));
  assertEquals(frames.map((f) => f.stream), ["stdout", "stderr", "stdout"]);
  assertEquals(dec.decode(frames[1].data), "err line\n");
});

Deno.test("demuxLog reassembles frames split mid-header and mid-payload", async () => {
  // 1-byte chunks force the demuxer to buffer the 8-byte header and payload itself.
  const stream = concat([frame(1, "hello world"), frame(2, "boom")]);
  const frames = await drain(inPieces(stream, 1));
  assertEquals(frames.length, 2);
  assertEquals(dec.decode(frames[0].data), "hello world");
  assertEquals(frames[0].stream, "stdout");
  assertEquals(dec.decode(frames[1].data), "boom");
  assertEquals(frames[1].stream, "stderr");
});

Deno.test("demuxLog stops cleanly at EOF with no frames", async () => {
  const frames = await drain(inPieces(new Uint8Array(0), 4));
  assertEquals(frames.length, 0);
});

Deno.test("demuxLog tolerates a large payload across many chunks", async () => {
  const big = "x".repeat(70_000);
  const frames = await drain(inPieces(frame(1, big), 4096));
  assertEquals(frames.length, 1);
  assertEquals(frames[0].data.byteLength, 70_000);
});
