// A minimal, correct HTTP/1.1 client over a raw `DuplexConn`. Just enough for the
// Docker Engine API: request writing, response head parsing, and body framing
// (Content-Length, Transfer-Encoding: chunked, or close-delimited).
//
// We send `Connection: close` and use a fresh connection per request. That keeps
// framing trivial (read to EOF) and sidesteps keep-alive state — including for
// streaming endpoints (follow logs, build/pull progress), where the connection
// simply stays open until the engine closes it.

import type { DuplexConn } from "./transport.ts";
import { EngineHttpError } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = encoder.encode("\r\n");

export interface HttpRequest {
  method: string;
  /** Path including any query string, e.g. "/v1.43/containers/json?all=1". */
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  /** Body bytes with transfer framing already decoded, streamed lazily. */
  body: AsyncGenerator<Uint8Array>;
}

export async function writeRequest(conn: DuplexConn, req: HttpRequest): Promise<void> {
  const headers: Record<string, string> = {
    "Host": "docker",
    "User-Agent": "compositz",
    "Accept": "*/*",
    "Connection": "close",
    ...req.headers,
  };
  if (req.body) headers["Content-Length"] = String(req.body.byteLength);

  let head = `${req.method} ${req.path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += "\r\n";

  await conn.write(encoder.encode(head));
  if (req.body && req.body.byteLength > 0) await conn.write(req.body);
}

/** Read and parse the response head, then expose the framing-decoded body stream. */
export async function readResponse(conn: DuplexConn): Promise<HttpResponse> {
  const reader = ByteReader.fromConn(conn);

  const statusLine = await reader.readLine();
  if (statusLine === null) {
    throw new EngineHttpError(0, "no response", "connection closed before any response");
  }
  const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
  if (!m) throw new EngineHttpError(0, "bad status line", statusLine);
  const status = Number(m[1]);
  const statusText = m[2] ?? "";

  const headers = new Headers();
  while (true) {
    const line = await reader.readLine();
    if (line === null || line === "") break;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const body = decodeBody(reader, headers);
  return { status, statusText, headers, body };
}

function decodeBody(reader: ByteReader, headers: Headers): AsyncGenerator<Uint8Array> {
  const te = headers.get("transfer-encoding")?.toLowerCase() ?? "";
  if (te.includes("chunked")) return chunkedDecode(reader);
  const len = headers.get("content-length");
  if (len !== null) return readBounded(reader, Number(len));
  return reader.drain(); // close-delimited
}

async function* readBounded(reader: ByteReader, total: number): AsyncGenerator<Uint8Array> {
  let remaining = total;
  while (remaining > 0) {
    const chunk = await reader.readSome(remaining);
    if (chunk === null) return; // EOF early
    remaining -= chunk.byteLength;
    yield chunk;
  }
}

async function* chunkedDecode(reader: ByteReader): AsyncGenerator<Uint8Array> {
  while (true) {
    const sizeLine = await reader.readLine();
    if (sizeLine === null) return;
    const size = parseInt(sizeLine.split(";", 1)[0].trim(), 16);
    if (!Number.isFinite(size)) throw new EngineHttpError(0, "bad chunk size", sizeLine);
    if (size === 0) {
      // consume trailers up to the terminating blank line
      while (true) {
        const t = await reader.readLine();
        if (t === null || t === "") break;
      }
      return;
    }
    let need = size;
    while (need > 0) {
      const chunk = await reader.readSome(need);
      if (chunk === null) throw new EngineHttpError(0, "truncated chunk body", "");
      need -= chunk.byteLength;
      yield chunk;
    }
    await reader.readExactly(2); // trailing CRLF
  }
}

// ---------------------------------------------------------------------------
// Body consumers
// ---------------------------------------------------------------------------

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readText(res: HttpResponse): Promise<string> {
  return decoder.decode(await collect(res.body));
}

/** Yield each newline-delimited JSON object from a streaming body (build/pull progress). */
export async function* jsonLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail);
}

/** Drain `res.body` and throw an EngineHttpError carrying the body text. */
export async function throwHttp(res: HttpResponse): Promise<never> {
  const text = await readText(res).catch(() => "");
  throw new EngineHttpError(res.status, res.statusText, text);
}

// ---------------------------------------------------------------------------
// Buffered byte reader over either a DuplexConn or an async byte iterable.
// ---------------------------------------------------------------------------

export class ByteReader {
  #next: () => Promise<Uint8Array | null>;
  // Explicit bare annotation => Uint8Array<ArrayBufferLike>, so chunks from any
  // backing buffer (TS 6.0 made Uint8Array generic over its ArrayBuffer) assign cleanly.
  #buf: Uint8Array = new Uint8Array(0);
  #eof = false;

  private constructor(next: () => Promise<Uint8Array | null>) {
    this.#next = next;
  }

  static fromConn(conn: DuplexConn): ByteReader {
    return new ByteReader(() => conn.read());
  }

  static fromIterable(src: AsyncIterable<Uint8Array>): ByteReader {
    const it = src[Symbol.asyncIterator]();
    return new ByteReader(async () => {
      const { value, done } = await it.next();
      return done ? null : value;
    });
  }

  async #fill(): Promise<boolean> {
    if (this.#eof) return false;
    const chunk = await this.#next();
    if (chunk === null || chunk.byteLength === 0) {
      if (chunk === null) this.#eof = true;
      return chunk !== null; // empty (non-null) chunk: not EOF, just nothing yet
    }
    this.#buf = this.#buf.byteLength === 0 ? chunk : concat(this.#buf, chunk);
    return true;
  }

  /** Read a line terminated by CRLF (or LF); returns it without the terminator, or null at EOF. */
  async readLine(): Promise<string | null> {
    while (true) {
      const i = indexOf(this.#buf, 0x0a); // '\n'
      if (i >= 0) {
        let end = i;
        if (end > 0 && this.#buf[end - 1] === 0x0d) end -= 1; // strip '\r'
        const line = decoder.decode(this.#buf.subarray(0, end));
        this.#buf = this.#buf.subarray(i + 1);
        return line;
      }
      if (!(await this.#fill())) {
        if (this.#buf.byteLength === 0) return null;
        const line = decoder.decode(this.#buf);
        this.#buf = new Uint8Array(0);
        return line;
      }
    }
  }

  /** Return up to `max` buffered bytes (reading more if buffer empty). null at EOF. */
  async readSome(max: number): Promise<Uint8Array | null> {
    while (this.#buf.byteLength === 0) {
      if (!(await this.#fill())) return null;
    }
    const n = Math.min(max, this.#buf.byteLength);
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  /** Read exactly `n` bytes; returns fewer only if EOF is hit first. */
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.#buf.byteLength < n) {
      if (!(await this.#fill())) break;
    }
    const take = Math.min(n, this.#buf.byteLength);
    const out = this.#buf.subarray(0, take);
    this.#buf = this.#buf.subarray(take);
    return out;
  }

  /** Yield all remaining bytes until EOF. */
  async *drain(): AsyncGenerator<Uint8Array> {
    if (this.#buf.byteLength > 0) {
      yield this.#buf;
      this.#buf = new Uint8Array(0);
    }
    while (await this.#fill()) {
      yield this.#buf;
      this.#buf = new Uint8Array(0);
    }
  }
}

// ---------------------------------------------------------------------------

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function indexOf(haystack: Uint8Array, byte: number): number {
  return haystack.indexOf(byte);
}

export { CRLF };
