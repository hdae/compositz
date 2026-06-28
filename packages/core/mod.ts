// @compositz/core — public surface.

export { CompositzError, EngineHttpError } from "./src/errors.ts";

export {
  BRAND,
  cacheVolumeName,
  containerName,
  envVar,
  imageTag,
  label,
  MANAGED_MOUNT_ROOT,
  volumeName,
} from "./src/brand.ts";

export { appDataDir, bindHostPath, defaultDataRoot, type Platform } from "./src/storage.ts";

export {
  type BuildSpec,
  type CacheSpec,
  type EnvSpec,
  type GpuMode,
  type Manifest,
  MANIFEST_VERSION,
  manifestJsonSchema,
  ManifestSchema,
  type MountMapping,
  parseManifest,
  type PortMapping,
} from "./src/recipe/manifest.ts";
export { listRecipes, loadRecipe, type Recipe } from "./src/recipe/loader.ts";
export {
  DEFAULT_INSTANCE,
  type LaunchConfig,
  recipeContainerName,
  recipeImageTag,
  resolveHostPorts,
  toCreateSpec,
  type ToSpecOptions,
  type WebEndpoint,
  webEndpoints,
  webUrl,
} from "./src/recipe/run.ts";
export { down, installRecipe, up, type UpResult } from "./src/recipe/operations.ts";

export {
  connect,
  type DockerEndpoint,
  type DuplexConn,
  parseDockerHost,
  resolveEndpoint,
} from "./src/transport.ts";

export { EngineClient, type EngineClientOptions, splitImageRef } from "./src/engine/client.ts";
export { demuxLog } from "./src/engine/logs.ts";
export { type BuildFile, tarContext } from "./src/build.ts";
export {
  type BuildOptions,
  type BuildProgress,
  type ContainerCreateResponse,
  type ContainerCreateSpec,
  type ContainerSummary,
  type ContainerWaitResponse,
  type DeviceRequest,
  type DockerEvent,
  type EventsOptions,
  GPU_ALL_CDI,
  GPU_ALL_NVIDIA,
  type HostConfig,
  type LogFrame,
  type LogsOptions,
  type Mount,
  type PullProgress,
  type VersionResponse,
} from "./src/engine/types.ts";
