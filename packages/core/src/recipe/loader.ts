// Load a recipe from a directory: parse + validate its manifest and read the
// build context (Dockerfile + assets) into memory. Recipes are small.

import { BRAND } from "../brand.ts";
import { CompositzError } from "../errors.ts";
import type { BuildFile } from "../build.ts";
import { type Manifest, parseManifest } from "./manifest.ts";

export interface Recipe {
  id: string;
  /** Recipe directory, normalized to forward slashes. */
  dir: string;
  manifest: Manifest;
  /** Build-context files with POSIX-relative paths (excludes the manifest). */
  context: BuildFile[];
}

export async function loadRecipe(dir: string): Promise<Recipe> {
  const root = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  const manifestPath = `${root}/${BRAND.manifestFile}`;

  let text: string;
  try {
    text = await Deno.readTextFile(manifestPath);
  } catch {
    throw new CompositzError(`recipe manifest not found: ${manifestPath}`);
  }
  const manifest = parseManifest(text);

  const context: BuildFile[] = [];
  for await (const file of walk(root)) {
    if (file.rel === BRAND.manifestFile) continue; // the manifest is not build context
    if (file.rel.split("/").some((seg) => seg.startsWith("."))) continue; // skip dotfiles/dirs
    context.push({ path: file.rel, data: await Deno.readFile(file.abs) });
  }

  // `image`-based recipes have no build context to validate.
  const dockerfile = manifest.build?.dockerfile;
  if (dockerfile && !context.some((f) => f.path === dockerfile)) {
    throw new CompositzError(
      `recipe "${manifest.id}": Dockerfile "${dockerfile}" not found in ${root}`,
    );
  }
  return { id: manifest.id, dir: root, manifest, context };
}

/** Load every valid recipe under a directory (skips invalid ones). Sorted by name. */
export async function listRecipes(dir: string): Promise<Recipe[]> {
  const out: Recipe[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue;
      try {
        out.push(await loadRecipe(`${dir}/${entry.name}`));
      } catch {
        // skip directories without a valid manifest
      }
    }
  } catch {
    // recipes dir missing
  }
  out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return out;
}

async function* walk(
  base: string,
  dir: string = base,
): AsyncGenerator<{ abs: string; rel: string }> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(base, abs);
    } else if (entry.isFile) {
      yield { abs, rel: abs.slice(base.length + 1) };
    }
  }
}
