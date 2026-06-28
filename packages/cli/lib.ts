import { loadRecipe, type Recipe } from "@compositz/core";

/** Resolve a recipe arg: an explicit directory path, or an id under ./recipes/<id>. */
export async function resolveRecipe(arg: string): Promise<Recipe> {
  const candidates = looksLikePath(arg) ? [arg] : [`recipes/${arg}`, arg];
  for (const dir of candidates) {
    try {
      if ((await Deno.stat(dir)).isDirectory) return await loadRecipe(dir);
    } catch {
      // try next candidate
    }
  }
  throw new Error(`recipe not found: "${arg}" (looked in: ${candidates.join(", ")})`);
}

function looksLikePath(s: string): boolean {
  return s.includes("/") || s.includes("\\") || s === "." || s.startsWith("..");
}
