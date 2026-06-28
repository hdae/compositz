// Transport layer: obtain a raw duplex byte stream to the Docker Engine, abstracting
// over the platform-specific endpoint.
//
//   Linux/macOS : Deno.connect({ transport: "unix", path })          (native)
//   Windows     : node:net Socket -> named pipe \\.\pipe\docker_engine (node compat)
//   any         : Deno.connect({ hostname, port })                   (tcp:// fallback)
//
// Everything above the transport speaks plain HTTP/1.1 over a `DuplexConn`, so the
// rest of core never needs to know which platform/runtime it is on. This is the seam
// where a future swap to WSL Containers / Podman stays cheap (a new endpoint kind).
//
// NOTE (verified on the dev machine, 2026-06-28): the node:net named-pipe connect
// requires Deno's full permission set (`--allow-all`). Our threat model accepts this:
// the *manager* process is trusted; isolation is enforced at the container boundary.

import net from "node:net";
import { CompositzError } from "./errors.ts";

/** A bidirectional byte stream to the engine. Pull-based read; null = EOF. */
export interface DuplexConn {
  write(data: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array | null>;
  close(): void;
}

export type DockerEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "npipe"; path: string }
  | { kind: "tcp"; host: string; port: number };

/**
 * Resolve the engine endpoint from `DOCKER_HOST`, falling back to the platform default.
 *   Windows -> \\.\pipe\docker_engine   (Docker Desktop)
 *   other   -> /var/run/docker.sock
 */
export function resolveEndpoint(): DockerEndpoint {
  const host = envGet("DOCKER_HOST");
  if (host && host.length > 0) return parseDockerHost(host);
  if (Deno.build.os === "windows") {
    return { kind: "npipe", path: "\\\\.\\pipe\\docker_engine" };
  }
  return { kind: "unix", path: "/var/run/docker.sock" };
}

export function parseDockerHost(h: string): DockerEndpoint {
  if (h.startsWith("unix://")) return { kind: "unix", path: h.slice("unix://".length) };
  if (h.startsWith("npipe://")) {
    // e.g. "npipe:////./pipe/docker_engine" -> "\\.\pipe\docker_engine"
    const p = h.slice("npipe://".length).replace(/\//g, "\\");
    return { kind: "npipe", path: p };
  }
  if (h.startsWith("tcp://") || h.startsWith("http://")) {
    const u = new URL(h);
    return { kind: "tcp", host: u.hostname, port: Number(u.port) || 2375 };
  }
  throw new CompositzError(`Unsupported DOCKER_HOST: ${h}`);
}

export function connect(endpoint: DockerEndpoint): Promise<DuplexConn> {
  switch (endpoint.kind) {
    case "unix":
      return connectDenoConn({ transport: "unix", path: endpoint.path });
    case "tcp":
      return connectDenoConn({ hostname: endpoint.host, port: endpoint.port });
    case "npipe":
      return connectNpipe(endpoint.path);
  }
}

// ---------------------------------------------------------------------------
// Deno.Conn adapter (unix socket on Linux/macOS, TCP everywhere)
// ---------------------------------------------------------------------------

async function connectDenoConn(opts: Deno.ConnectOptions | Deno.UnixConnectOptions) {
  // deno-lint-ignore no-explicit-any -- one overload covers unix + tcp options
  const conn = await Deno.connect(opts as any);
  return new DenoConnAdapter(conn);
}

class DenoConnAdapter implements DuplexConn {
  #conn: Deno.Conn;
  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }
  async write(data: Uint8Array): Promise<void> {
    let off = 0;
    while (off < data.length) {
      const n = await this.#conn.write(data.subarray(off));
      if (n <= 0) throw new CompositzError("short write to docker socket");
      off += n;
    }
  }
  async read(): Promise<Uint8Array | null> {
    const buf = new Uint8Array(64 * 1024);
    const n = await this.#conn.read(buf);
    return n === null ? null : buf.subarray(0, n);
  }
  close(): void {
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// node:net adapter (Windows named pipe). Bridges the event-based Node stream
// to a pull-based reader, with simple backpressure.
// ---------------------------------------------------------------------------

function connectNpipe(path: string): Promise<DuplexConn> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const onError = (err: Error) => {
      socket.removeListener("connect", onConnect);
      reject(new CompositzError(`failed to connect to named pipe ${path}: ${err.message}`));
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(new NodeSocketAdapter(socket));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

const HIGH_WATER = 32;
const LOW_WATER = 8;

class NodeSocketAdapter implements DuplexConn {
  #socket: net.Socket;
  #queue: Uint8Array[] = [];
  #waiters: Array<{
    resolve: (v: Uint8Array | null) => void;
    reject: (e: unknown) => void;
  }> = [];
  #ended = false;
  #error: unknown = null;
  #paused = false;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (d: Uint8Array) => this.#onData(new Uint8Array(d)));
    socket.on("end", () => this.#finish());
    socket.on("close", () => this.#finish());
    socket.on("error", (e: Error) => {
      this.#error = new CompositzError(`named pipe error: ${e.message}`);
      this.#finish();
    });
  }

  #onData(chunk: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(chunk);
      return;
    }
    this.#queue.push(chunk);
    if (!this.#paused && this.#queue.length >= HIGH_WATER) {
      this.#paused = true;
      this.#socket.pause();
    }
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const w of this.#waiters) {
      if (this.#error) w.reject(this.#error);
      else w.resolve(null);
    }
    this.#waiters = [];
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  read(): Promise<Uint8Array | null> {
    if (this.#queue.length > 0) {
      const chunk = this.#queue.shift()!;
      if (this.#paused && this.#queue.length <= LOW_WATER) {
        this.#paused = false;
        this.#socket.resume();
      }
      return Promise.resolve(chunk);
    }
    if (this.#error) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  close(): void {
    try {
      this.#socket.destroy();
    } catch {
      // already destroyed
    }
  }
}

// ---------------------------------------------------------------------------

function envGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined; // no --allow-env; treat as unset
  }
}
