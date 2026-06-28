// Single source of truth for the project's externally-visible names.
//
// "compositz" is a WORKING TITLE. The project name, the per-recipe manifest
// filename, the Docker label namespace, and the image namespace may all change.
// Keep every such string here so a rename is a one-file edit — never hard-code
// these elsewhere.

export const BRAND = {
  /** Project name. Used for container names and managed-volume prefixes. */
  name: "compositz",
  /** Manifest filename expected in each recipe directory. */
  manifestFile: "compositz.yaml",
  /** Docker label namespace, e.g. "io.compositz.recipe". */
  labelPrefix: "io.compositz",
  /** Image repository namespace, e.g. "compositz/<recipe>". */
  imageNamespace: "compositz",
} as const;

/** A namespaced Docker label key, e.g. label("recipe") => "io.compositz.recipe". */
export function label(suffix: string): string {
  return `${BRAND.labelPrefix}.${suffix}`;
}

/** Image tag for a recipe, e.g. imageTag("comfyui", "0.1.0") => "compositz/comfyui:0.1.0". */
export function imageTag(recipeId: string, version = "latest"): string {
  return `${BRAND.imageNamespace}/${recipeId}:${version}`;
}

/** Container name for a recipe instance, e.g. "compositz-comfyui". */
export function containerName(recipeId: string): string {
  return `${BRAND.name}-${recipeId}`;
}

/** Managed named-volume for a recipe, e.g. "compositz_comfyui_models". */
export function volumeName(recipeId: string, name: string): string {
  return `${BRAND.name}_${recipeId}_${name}`;
}
