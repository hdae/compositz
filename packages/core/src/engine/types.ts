// A pragmatic subset of the Docker Engine API types — only what Compositz uses.
// Field names match the wire format (PascalCase) so specs serialize directly.

export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

export interface DeviceRequest {
  Driver?: string;
  Count?: number;
  DeviceIDs?: string[];
  Capabilities?: string[][];
  Options?: Record<string, string>;
}

export interface RestartPolicy {
  Name: "" | "no" | "always" | "unless-stopped" | "on-failure";
  MaximumRetryCount?: number;
}

/**
 * A `HostConfig.Mounts` entry. Preferred over the legacy `Binds` strings: it is
 * unambiguous on Windows (a `C:\…` source has a colon that breaks `Binds`
 * splitting) and expresses bind vs named-volume uniformly.
 */
export interface Mount {
  Type: "bind" | "volume";
  /** Host path (bind) or named volume (volume). */
  Source: string;
  /** In-container path. */
  Target: string;
  ReadOnly?: boolean;
  /**
   * Bind-only options. Unlike the legacy `Binds` strings, a `Mounts` bind does NOT
   * auto-create a missing host source — the daemon rejects it (400). `CreateMountpoint`
   * (API 1.44+) restores daemon-side creation, which is required since the source is
   * on the daemon host (a remote `DOCKER_HOST` is unreachable from here).
   */
  BindOptions?: { CreateMountpoint?: boolean };
}

export interface HostConfig {
  Binds?: string[];
  PortBindings?: Record<string, PortBinding[]>;
  Mounts?: Mount[];
  DeviceRequests?: DeviceRequest[];
  RestartPolicy?: RestartPolicy;
  AutoRemove?: boolean;
  NetworkMode?: string;
}

export interface ContainerCreateSpec {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  Env?: string[];
  ExposedPorts?: Record<string, Record<string, never>>;
  Tty?: boolean;
  Labels?: Record<string, string>;
  WorkingDir?: string;
  HostConfig?: HostConfig;
}

export interface ContainerCreateResponse {
  Id: string;
  Warnings: string[];
}

export interface ContainerWaitResponse {
  StatusCode: number;
  Error?: { Message: string } | null;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
  Labels: Record<string, string>;
}

/** One volume from `GET /volumes`. */
export interface VolumeSummary {
  Name: string;
  Driver: string;
  /** Daemon-host path of the volume's data — informational only from a remote client. */
  Mountpoint: string;
  Labels: Record<string, string> | null;
  Scope: string;
  CreatedAt?: string;
}

export interface VolumeListResponse {
  Volumes: VolumeSummary[] | null;
  Warnings: string[] | null;
}

export interface VersionResponse {
  Version: string;
  ApiVersion: string;
  MinAPIVersion?: string;
  Os: string;
  Arch: string;
  KernelVersion?: string;
  GitCommit?: string;
  BuildTime?: string;
}

export interface PullProgress {
  status?: string;
  id?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
}

export interface LogsOptions {
  follow?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  tail?: number | "all";
  timestamps?: boolean;
  since?: number;
  /**
   * Whether the container was created with a TTY. With a TTY the engine streams
   * raw bytes (no 8-byte multiplexing), so the demuxer must be bypassed. This is
   * the container's own create-time `Tty` — NOT inferable from the response
   * Content-Type (GET /logs may not set one).
   */
  tty?: boolean;
  /**
   * Abort signal for a `follow` stream. The generator parks on the socket waiting
   * for the next line, so abort it (e.g. on consumer disconnect) to close the
   * connection promptly instead of leaking it until the container stops.
   */
  signal?: AbortSignal;
}

export interface LogFrame {
  stream: "stdout" | "stderr";
  data: Uint8Array;
}

export interface BuildOptions {
  /** Image tag(s) to apply, e.g. "compositz/comfyui:latest". */
  tag?: string;
  tags?: string[];
  /** Dockerfile path within the context (default "Dockerfile"). */
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  platform?: string;
  noCache?: boolean;
  pull?: boolean;
}

/** One progress object from the classic `POST /build` stream. */
export interface BuildProgress {
  /** Human-readable build output line (classic builder). */
  stream?: string;
  /** Terminal metadata, e.g. the built image id: aux.ID. */
  aux?: { ID?: string };
  error?: string;
  errorDetail?: { message?: string };
  status?: string;
  id?: string;
}

/** One event object from the `GET /events` stream (Docker Engine event). */
export interface DockerEvent {
  /** Object kind, e.g. "container", "image", "volume", "network". */
  Type?: string;
  /** Lifecycle action, e.g. "create", "start", "die", "destroy". */
  Action?: string;
  /** The object the event is about; Attributes carries labels (incl. ours). */
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  /** Legacy fields (older API): status == Action, id == Actor.ID. */
  status?: string;
  id?: string;
  from?: string;
  time?: number;
  timeNano?: number;
}

export interface EventsOptions {
  /** Engine-side filters, e.g. { type: ["container"], label: ["io.compositz.managed=true"] }. */
  filters?: Record<string, string[]>;
  /** Unix seconds; replay events since this time before following live ones. */
  since?: number;
  /** Abort to close the stream promptly (the read otherwise parks on the socket). */
  signal?: AbortSignal;
}

/**
 * GPU passthrough equivalent to `--gpus all`. The docker CLI emits an EMPTY driver
 * (`""`) and lets the daemon pick the device driver; "nvidia" also works but the
 * empty form is the canonical, most portable shape.
 */
export const GPU_ALL_NVIDIA: DeviceRequest = {
  Driver: "",
  Count: -1,
  Capabilities: [["gpu"]],
};

/** GPU passthrough via CDI (Linux, Docker 28.3+): `--device nvidia.com/gpu=all`. */
export const GPU_ALL_CDI: DeviceRequest = {
  Driver: "cdi",
  DeviceIDs: ["nvidia.com/gpu=all"],
};
