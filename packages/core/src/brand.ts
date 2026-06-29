// Single source of truth for the project's externally-visible names.
//
// "compositz" is a WORKING TITLE. The project name, the per-recipe manifest
// filename, the Docker label namespace, and the image namespace may all change.
// Keep every such string here so a rename is a one-file edit — never hard-code
// these elsewhere.

export const BRAND = {
  /** Project name. Used for container names and managed-volume prefixes. */
  name: "compositz",
  /** Manifest filename expected in each recipe bundle. */
  manifestFile: "compositz.yaml",
  /** Docker label namespace, e.g. "io.compositz.instance". */
  labelPrefix: "io.compositz",
  /** Image repository namespace, e.g. "compositz/<instanceId>". */
  imageNamespace: "compositz",
} as const;

/** A namespaced Docker label key, e.g. label("instance") => "io.compositz.instance". */
export function label(suffix: string): string {
  return `${BRAND.labelPrefix}.${suffix}`;
}

// Every runtime resource keys off the instance id (ADR-017): one flat namespace,
// no recipe×instance nesting. A `build` recipe's image is per-instance.

/** Per-instance image tag, e.g. imageTag("comfyui-a1b2c3", "0.1.0") => "compositz/comfyui-a1b2c3:0.1.0". */
export function imageTag(instanceId: string, version = "latest"): string {
  return `${BRAND.imageNamespace}/${instanceId}:${version}`;
}

/** Container name for an instance, e.g. "compositz-comfyui-a1b2c3". */
export function containerName(instanceId: string): string {
  return `${BRAND.name}-${instanceId}`;
}

/** Managed named-volume for an instance mount, e.g. "compositz_comfyui-a1b2c3_models". */
export function volumeName(instanceId: string, name: string): string {
  return `${BRAND.name}_${instanceId}_${name}`;
}

/**
 * Managed cache volume, not scoped to one recipe (shared/global), e.g.
 * cacheVolumeName("uv") => "compositz_uv", cacheVolumeName("cache_torch") =>
 * "compositz_cache_torch".
 */
export function cacheVolumeName(suffix: string): string {
  return `${BRAND.name}_${suffix}`;
}

/** Env var name Compositz injects into containers, e.g. envVar("INSTANCE") => "COMPOSITZ_INSTANCE". */
export function envVar(suffix: string): string {
  return `${BRAND.name.toUpperCase()}_${suffix}`;
}

/**
 * In-container mount root for Compositz-managed caches/venvs, e.g. "/compositz".
 * Recipe authors read the per-cache paths via injected env vars (see `cache[]`),
 * never this prefix directly.
 */
export const MANAGED_MOUNT_ROOT = `/${BRAND.name}`;
