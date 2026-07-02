// Typed Docker Engine API client. One fresh connection per request (Connection: close);
// streaming endpoints (pull, logs) return async generators that close the connection
// when fully consumed.

import { connect, type DockerEndpoint, type DuplexConn, resolveEndpoint } from "../transport.ts";
import { jsonLines, readResponse, readText, writeRequest } from "../http.ts";
import { CompositzError, EngineHttpError } from "../errors.ts";
import { demuxLog } from "./logs.ts";
import type {
  BuildOptions,
  BuildProgress,
  ContainerCreateResponse,
  ContainerCreateSpec,
  ContainerSummary,
  ContainerWaitResponse,
  DockerEvent,
  EventsOptions,
  LogFrame,
  LogsOptions,
  PullProgress,
  VersionResponse,
  VolumeListResponse,
  VolumeSummary,
} from "./types.ts";

const encoder = new TextEncoder();

/** Default pinned API version. Server (1.54) negotiates down; min supported is 1.40. */
const DEFAULT_API_VERSION = "1.43";

export interface EngineClientOptions {
  endpoint?: DockerEndpoint;
  apiVersion?: string;
}

export class EngineClient {
  readonly endpoint: DockerEndpoint;
  #apiVersion: string;

  constructor(opts: EngineClientOptions = {}) {
    this.endpoint = opts.endpoint ?? resolveEndpoint();
    this.#apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
  }

  // --- lifecycle -----------------------------------------------------------

  /** GET /_ping — returns "OK" when the engine is reachable. */
  async ping(): Promise<string> {
    const conn = await this.#open();
    try {
      await writeRequest(conn, { method: "GET", path: "/_ping" });
      const res = await readResponse(conn);
      const text = await readText(res);
      if (res.status !== 200) throw new EngineHttpError(res.status, res.statusText, text);
      return text.trim();
    } finally {
      conn.close();
    }
  }

  version(): Promise<VersionResponse> {
    return this.#call<VersionResponse>("GET", "/version") as Promise<VersionResponse>;
  }

  /** POST /images/create — pull an image, streaming progress events. */
  async pull(ref: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    const { name, tag } = splitImageRef(ref);
    const q = new URLSearchParams({ fromImage: name });
    if (tag) q.set("tag", tag);
    const conn = await this.#open();
    try {
      await writeRequest(conn, { method: "POST", path: this.#path(`/images/create?${q}`) });
      const res = await readResponse(conn);
      if (res.status >= 300) {
        throw new EngineHttpError(res.status, res.statusText, await readText(res));
      }
      for await (const obj of jsonLines(res.body)) {
        const p = obj as PullProgress;
        if (p.error) throw new CompositzError(`pull failed: ${p.error}`);
        onProgress?.(p);
      }
    } finally {
      conn.close();
    }
  }

  async create(spec: ContainerCreateSpec, name?: string): Promise<ContainerCreateResponse> {
    const path = name
      ? `/containers/create?name=${encodeURIComponent(name)}`
      : "/containers/create";
    return (await this.#call<ContainerCreateResponse>("POST", path, { body: spec }))!;
  }

  /** POST /containers/{id}/start (204 ok; 304 = already started). */
  async start(id: string): Promise<void> {
    await this.#call("POST", `/containers/${id}/start`, { ok: [304] });
  }

  /** POST /containers/{id}/stop (204 ok; 304 = already stopped). */
  async stop(id: string, timeoutSec?: number): Promise<void> {
    const q = timeoutSec != null ? `?t=${timeoutSec}` : "";
    await this.#call("POST", `/containers/${id}/stop${q}`, { ok: [304] });
  }

  /** POST /containers/{id}/wait — blocks until the container exits. */
  async wait(id: string): Promise<ContainerWaitResponse> {
    return (await this.#call<ContainerWaitResponse>("POST", `/containers/${id}/wait`))!;
  }

  async remove(id: string, opts: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    const q = new URLSearchParams();
    if (opts.force) q.set("force", "1");
    if (opts.volumes) q.set("v", "1");
    const qs = q.toString();
    await this.#call("DELETE", `/containers/${id}${qs ? `?${qs}` : ""}`);
  }

  inspect(id: string): Promise<unknown> {
    return this.#call("GET", `/containers/${id}/json`);
  }

  /** GET /images/{ref}/json — true if the image exists locally. */
  async imageExists(ref: string): Promise<boolean> {
    const conn = await this.#open();
    try {
      await writeRequest(conn, { method: "GET", path: this.#path(`/images/${ref}/json`) });
      const res = await readResponse(conn);
      await readText(res); // drain
      return res.status === 200;
    } finally {
      conn.close();
    }
  }

  /**
   * DELETE /images/{ref} — remove an image by tag/id. A 404 (already gone) is tolerated;
   * a 409 (still referenced by a container) surfaces as an EngineHttpError so the caller
   * decides. The path mirrors `imageExists` (ref passed unencoded, slashes are significant).
   */
  async removeImage(ref: string, opts: { force?: boolean } = {}): Promise<void> {
    const q = opts.force ? "?force=1" : "";
    await this.#call("DELETE", `/images/${ref}${q}`, { ok: [404] });
  }

  /**
   * GET /containers/{id}/archive — stream a path inside a container's filesystem as a
   * tar archive. Works on a CREATED container (it need not be running), which is what
   * makes volume export possible without executing anything. The returned stream OWNS
   * the connection: consume it fully or `cancel()` it, or the socket leaks.
   */
  async archive(id: string, path: string): Promise<ReadableStream<Uint8Array>> {
    const q = new URLSearchParams({ path });
    const conn = await this.#open();
    let handedOff = false;
    try {
      await writeRequest(conn, {
        method: "GET",
        path: this.#path(`/containers/${id}/archive?${q}`),
      });
      const res = await readResponse(conn);
      if (res.status >= 300) {
        throw new EngineHttpError(res.status, res.statusText, await readText(res));
      }
      const body = res.body;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await body.next();
            if (done) {
              controller.close();
              conn.close();
            } else {
              controller.enqueue(value);
            }
          } catch (e) {
            conn.close();
            controller.error(e);
          }
        },
        cancel() {
          conn.close();
        },
      });
      handedOff = true;
      return stream;
    } finally {
      if (!handedOff) conn.close();
    }
  }

  /** GET /volumes — list volumes, optionally filtered (e.g. by exact name or label). */
  async listVolumes(
    opts: { filters?: Record<string, string[]> } = {},
  ): Promise<VolumeSummary[]> {
    const q = new URLSearchParams();
    if (opts.filters) q.set("filters", JSON.stringify(opts.filters));
    const qs = q.toString();
    const res = await this.#call<VolumeListResponse>("GET", `/volumes${qs ? `?${qs}` : ""}`);
    return res?.Volumes ?? [];
  }

  /**
   * DELETE /volumes/{name} — remove a named volume AND ITS DATA (irreversible).
   * A 404 (already gone) is tolerated; a 409 (still mounted by a container)
   * surfaces as an EngineHttpError so the caller decides (call `down` first).
   */
  async removeVolume(name: string, opts: { force?: boolean } = {}): Promise<void> {
    const q = opts.force ? "?force=1" : "";
    await this.#call("DELETE", `/volumes/${encodeURIComponent(name)}${q}`, { ok: [404] });
  }

  /** GET /containers/json — list containers, optionally filtered (e.g. by label). */
  async ps(opts: { all?: boolean; filters?: Record<string, string[]> } = {}): Promise<
    ContainerSummary[]
  > {
    const q = new URLSearchParams();
    q.set("all", opts.all ? "1" : "0");
    if (opts.filters) q.set("filters", JSON.stringify(opts.filters));
    return (await this.#call<ContainerSummary[]>("GET", `/containers/json?${q}`)) ?? [];
  }

  /** GET /containers/{id}/logs — demultiplexed stdout/stderr frames. */
  async *logs(id: string, opts: LogsOptions = {}): AsyncGenerator<LogFrame> {
    const q = new URLSearchParams();
    q.set("stdout", opts.stdout === false ? "0" : "1");
    q.set("stderr", opts.stderr === false ? "0" : "1");
    if (opts.follow) q.set("follow", "1");
    if (opts.timestamps) q.set("timestamps", "1");
    if (opts.tail != null) q.set("tail", String(opts.tail));
    if (opts.since != null) q.set("since", String(opts.since));
    const conn = await this.#open();
    const onAbort = () => conn.close();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // If the signal aborted DURING #open(), the listener above never fires (abort is
    // one-shot and already dispatched), so close here or the follow socket leaks.
    if (opts.signal?.aborted) {
      conn.close();
      return;
    }
    try {
      await writeRequest(conn, { method: "GET", path: this.#path(`/containers/${id}/logs?${q}`) });
      const res = await readResponse(conn);
      if (res.status >= 300) {
        throw new EngineHttpError(res.status, res.statusText, await readText(res));
      }
      if (opts.tty) {
        // TTY containers stream raw bytes with no 8-byte framing.
        for await (const chunk of res.body) yield { stream: "stdout", data: chunk };
      } else {
        yield* demuxLog(res.body);
      }
    } catch (e) {
      // Aborting closes the conn, which surfaces here as a read error — expected.
      if (opts.signal?.aborted) return;
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      conn.close();
    }
  }

  /**
   * POST /build — build an image from a tar context, streaming progress.
   * Uses the classic builder (the plain Engine API endpoint); progress objects
   * carry `stream` lines and a terminal `aux.ID` with the built image id.
   */
  async *build(context: Uint8Array, opts: BuildOptions = {}): AsyncGenerator<BuildProgress> {
    const q = new URLSearchParams();
    for (const t of [opts.tag, ...(opts.tags ?? [])].filter((t): t is string => !!t)) {
      q.append("t", t);
    }
    q.set("dockerfile", opts.dockerfile ?? "Dockerfile");
    if (opts.buildArgs) q.set("buildargs", JSON.stringify(opts.buildArgs));
    if (opts.platform) q.set("platform", opts.platform);
    if (opts.noCache) q.set("nocache", "1");
    if (opts.pull) q.set("pull", "1");

    const conn = await this.#open();
    try {
      await writeRequest(conn, {
        method: "POST",
        path: this.#path(`/build?${q}`),
        headers: { "Content-Type": "application/x-tar" },
        body: context,
      });
      const res = await readResponse(conn);
      if (res.status >= 300) {
        throw new EngineHttpError(res.status, res.statusText, await readText(res));
      }
      for await (const obj of jsonLines(res.body)) {
        const p = obj as BuildProgress;
        if (p.error) throw new CompositzError(`build failed: ${p.error ?? p.errorDetail?.message}`);
        yield p;
      }
    } finally {
      conn.close();
    }
  }

  /**
   * GET /events — follow the engine event stream (container/image/... lifecycle),
   * yielding one {@link DockerEvent} per line. Long-lived: it parks on the socket
   * waiting for the next event, so pass `opts.signal` and abort it to close the
   * stream promptly (e.g. when the consumer disconnects).
   */
  async *events(opts: EventsOptions = {}): AsyncGenerator<DockerEvent> {
    const q = new URLSearchParams();
    if (opts.filters) q.set("filters", JSON.stringify(opts.filters));
    if (opts.since != null) q.set("since", String(opts.since));
    const conn = await this.#open();
    const onAbort = () => conn.close();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted during #open()? The one-shot listener won't fire — close here so the
    // long-lived events socket can't leak.
    if (opts.signal?.aborted) {
      conn.close();
      return;
    }
    try {
      await writeRequest(conn, { method: "GET", path: this.#path(`/events?${q}`) });
      const res = await readResponse(conn);
      if (res.status >= 300) {
        throw new EngineHttpError(res.status, res.statusText, await readText(res));
      }
      for await (const obj of jsonLines(res.body)) {
        yield obj as DockerEvent;
      }
    } catch (e) {
      // Aborting closes the conn, which surfaces here as a read error — expected.
      if (opts.signal?.aborted) return;
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      conn.close();
    }
  }

  // --- internals -----------------------------------------------------------

  #open(): Promise<DuplexConn> {
    return connect(this.endpoint);
  }

  #path(p: string, versioned = true): string {
    return versioned ? `/v${this.#apiVersion}${p}` : p;
  }

  /** Non-streaming call. Throws EngineHttpError unless status < 300 or in `ok`. */
  async #call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; ok?: number[] } = {},
  ): Promise<T | undefined> {
    const conn = await this.#open();
    try {
      const body = opts.body === undefined ? undefined : encoder.encode(JSON.stringify(opts.body));
      const headers = body ? { "Content-Type": "application/json" } : undefined;
      await writeRequest(conn, { method, path: this.#path(path), headers, body });
      const res = await readResponse(conn);
      const text = await readText(res);
      if (!(res.status < 300 || (opts.ok ?? []).includes(res.status))) {
        throw new EngineHttpError(res.status, res.statusText, text);
      }
      return text.length ? (JSON.parse(text) as T) : undefined;
    } finally {
      conn.close();
    }
  }
}

/** Split "repo[:tag]" / "host:port/repo[:tag]" / "repo@sha256:..." into name + tag. */
export function splitImageRef(ref: string): { name: string; tag: string } {
  if (ref.includes("@")) return { name: ref, tag: "" }; // digest-pinned
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: "latest" };
}
