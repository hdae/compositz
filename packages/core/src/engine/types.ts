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

export interface HostConfig {
  Binds?: string[];
  PortBindings?: Record<string, PortBinding[]>;
  Mounts?: unknown[];
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
