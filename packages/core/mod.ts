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

export {
  appDataDir,
  bindHostPath,
  defaultDataRoot,
  instancesDir,
  type Platform,
} from "./src/storage.ts";

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
  RECIPE_ID_PATTERN,
} from "./src/recipe/manifest.ts";
export { loadRecipe, type Recipe } from "./src/recipe/loader.ts";
export {
  APP_SUBDIR,
  CONFIG_FILE,
  type Instance,
  type InstanceMeta,
  LAUNCHED_FILE,
  listInstances,
  loadInstance,
  loadInstanceConfig,
  loadLaunchedConfig,
  removeInstanceDir,
  saveInstanceConfig,
  saveLaunchedConfig,
} from "./src/recipe/instance.ts";
export {
  type Override,
  OverrideSchema,
  parseOverride,
  sameOverride,
  serializeOverride,
} from "./src/recipe/config.ts";
export {
  type BundleSource,
  duplicateInstance,
  extractArchiveTo,
  ingestBundle,
  INSTANCE_ID_PATTERN,
  randomInstanceId,
} from "./src/recipe/ingest.ts";
export {
  githubSource,
  type GithubSpec,
  githubTarballUrl,
  ingestGithub,
  parseGithubSpec,
} from "./src/recipe/github.ts";
export {
  effectiveHostPort,
  instanceContainerName,
  instanceImageTag,
  type LaunchConfig,
  mergeLaunch,
  resolveHostPorts,
  toCreateSpec,
  type ToSpecOptions,
  type WebEndpoint,
  webEndpoints,
  webUrl,
} from "./src/recipe/run.ts";
export {
  deconflictHostPorts,
  definedHostPorts,
  down,
  installInstance,
  type PortBump,
  removeInstanceImage,
  up,
  type UpResult,
} from "./src/recipe/operations.ts";

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
  type VolumeSummary,
} from "./src/engine/types.ts";
