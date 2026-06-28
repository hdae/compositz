// Where Compositz keeps host-side state, and how host paths are derived.
//
// Three tiers (see docs/recipe-ingestion.md):
//   - app-data:  recipe store, per-install overrides, settings.
//   - data-root: per-app host-VISIBLE data (bind mounts); user-configurable.
//   - volumes:   Docker-managed named volumes (everything else; named via brand.ts).
//
// Path DERIVATION is pure (`bindHostPath` takes the data-root as input). The
// per-OS DEFAULT locations are the only impure part — they read the environment,
// injectable via `Platform` so they stay unit-testable.

import { join } from "@std/path";
import { BRAND } from "./brand.ts";

/** The host environment the default-location resolvers read. Injectable for tests. */
export type Platform = {
  os: string;
  env: (key: string) => string | undefined;
};

const HOST: Platform = {
  os: Deno.build.os,
  env: (key) => Deno.env.get(key),
};

/**
 * Host directory for a bind mount: `<data-root>/<id>/<name>`. Host-browsable, so
 * the layout is derived from the recipe id + mount name (never an author-written
 * absolute path). NOTE: the path is on the Docker daemon's host — correct for a
 * local daemon; a remote `DOCKER_HOST` would resolve it on that host.
 */
export function bindHostPath(dataRoot: string, recipeId: string, mountName: string): string {
  return join(dataRoot, recipeId, mountName);
}

/**
 * App-data directory (recipe store / overrides / settings):
 * `%APPDATA%\compositz` on Windows, else `$XDG_DATA_HOME/compositz` or
 * `$HOME/.local/share/compositz`.
 */
export function appDataDir(p: Platform = HOST): string {
  if (p.os === "windows") {
    const appData = p.env("APPDATA");
    if (appData) return join(appData, BRAND.name);
    return join(home(p), "AppData", "Roaming", BRAND.name);
  }
  const xdg = p.env("XDG_DATA_HOME");
  if (xdg) return join(xdg, BRAND.name);
  return join(home(p), ".local", "share", BRAND.name);
}

/**
 * Default host data-root for bind mounts: `%USERPROFILE%\Compositz` on Windows,
 * else `$HOME/Compositz`. User-overridable per install.
 */
export function defaultDataRoot(p: Platform = HOST): string {
  // The directory is user-facing (they browse outputs here), so capitalize it.
  const dirName = BRAND.name.charAt(0).toUpperCase() + BRAND.name.slice(1);
  return join(home(p), dirName);
}

function home(p: Platform): string {
  const h = p.os === "windows" ? p.env("USERPROFILE") : p.env("HOME");
  if (!h) {
    throw new Error(
      `cannot resolve home directory (${p.os === "windows" ? "USERPROFILE" : "HOME"} unset)`,
    );
  }
  return h;
}
