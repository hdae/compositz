// Load a recipe BUNDLE from a directory: parse + validate its manifest and read
// the build context (Dockerfile + assets) into memory. Recipes are small. A bundle
// is what an instance is created from (it lives at `<instance>/app/`); the deployed
// unit is an Instance (see instance.ts). Used by ingestion to validate, and by
// instance loading to read the embedded bundle.

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
