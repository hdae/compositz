import { assertEquals } from "@std/assert";
import type { DuplexConn } from "./transport.ts";
import { ByteReader, collect, jsonLines, readResponse } from "./http.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A fake connection that replays canned bytes, one `read()` per supplied chunk. */
function fakeConn(chunks: Uint8Array[]): DuplexConn {
  let i = 0;
  return {
    write: () => Promise.resolve(),
    read: () => Promise.resolve(i < chunks.length ? chunks[i++] : null),
    close: () => {},
  };
}

/** Split a buffer into N-byte pieces to stress buffering across boundaries. */
function pieces(bytes: Uint8Array, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += n) out.push(bytes.subarray(i, i + n));
  return out;
}

async function* fromBytes(bytes: Uint8Array, n: number): AsyncGenerator<Uint8Array> {
  for (const p of pieces(bytes, n)) yield p;
}

Deno.test("ByteReader.readLine handles CRLF split across chunks", async () => {
  const reader = ByteReader.fromConn(fakeConn(pieces(enc.encode("alpha\r\nbeta\r\n"), 1)));
  assertEquals(await reader.readLine(), "alpha");
  assertEquals(await reader.readLine(), "beta");
  assertEquals(await reader.readLine(), null);
});

Deno.test("ByteReader.readExactly assembles across chunk boundaries", async () => {
  const reader = ByteReader.fromConn(fakeConn(pieces(enc.encode("0123456789"), 3)));
  assertEquals(dec.decode(await reader.readExactly(4)), "0123");
  assertEquals(dec.decode(await reader.readExactly(6)), "456789");
  assertEquals((await reader.readExactly(1)).byteLength, 0); // EOF
});

Deno.test("readResponse decodes a chunked body (byte-at-a-time)", async () => {
  const raw = "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/plain\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n" +
    "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
  const res = await readResponse(fakeConn(pieces(enc.encode(raw), 1)));
  assertEquals(res.status, 200);
  assertEquals(res.statusText, "OK");
  assertEquals(dec.decode(await collect(res.body)), "hello world");
});

Deno.test("readResponse decodes a Content-Length body", async () => {
  const raw = "HTTP/1.1 201 Created\r\nContent-Length: 11\r\n\r\nhello world";
  const res = await readResponse(fakeConn(pieces(enc.encode(raw), 4)));
  assertEquals(res.status, 201);
  assertEquals(dec.decode(await collect(res.body)), "hello world");
});

Deno.test("readResponse handles a close-delimited body (no length, no chunked)", async () => {
  const raw = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\nrawbytes";
  const res = await readResponse(fakeConn(pieces(enc.encode(raw), 5)));
  assertEquals(dec.decode(await collect(res.body)), "rawbytes");
});

Deno.test("jsonLines parses newline-delimited objects split across chunks", async () => {
  const body =
    '{"status":"Pulling"}\n{"status":"Download complete"}\n{"id":"abc","progress":"50%"}\n';
  const out: unknown[] = [];
  for await (const obj of jsonLines(fromBytes(enc.encode(body), 7))) out.push(obj);
  assertEquals(out.length, 3);
  assertEquals((out[2] as { id: string }).id, "abc");
});
