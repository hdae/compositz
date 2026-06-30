// The instance: the self-contained, deployed unit (ADR-017). It owns everything
// keyed by its `instanceId` — the embedded bundle (`app/`), provenance (`meta.json`),
// and (RI-4) the per-install override. A recipe has NO separate store; it is just
// the bundle copied inside an instance.
//
//   <instancesDir>/<instanceId>/
//     app/            ← the recipe bundle (manifest + Dockerfile + context)
//     meta.json       ← { source, createdAt }  (instanceId == the directory name)
//     config.yaml     ← per-instance override (RI-4)

import { CompositzError } from "../errors.ts";
import type { BuildFile } from "../build.ts";
import { type Manifest } from "./manifest.ts";
import { loadRecipe } from "./loader.ts";
import { type Override, parseOverride, serializeOverride } from "./config.ts";

/** Subdirectory holding the recipe bundle inside an instance directory. */
export const APP_SUBDIR = "app";
/** Provenance file inside an instance directory. */
export const META_FILE = "meta.json";
/** Per-instance launch override (RI-4) inside an instance directory. */
export const CONFIG_FILE = "config.yaml";
/** Snapshot of the override the instance was last LAUNCHED with (written at `up`) — lets the
 * UI tell when the saved config has diverged from what's running (a restart is needed). */
export const LAUNCHED_FILE = ".launched.yaml";

/** Non-derivable provenance for an instance (the manifest holds appId + version). */
export interface InstanceMeta {
  /** Where the bundle came from, e.g. "upload", "dir:…", "github:owner/repo@ref", "duplicate:<id>". */
  source?: string;
  /** ISO-8601 creation time. */
  createdAt?: string;
}

/** A deployed instance: its id, the app it runs, the embedded bundle, and provenance. */
export interface Instance {
  /** The single runtime key — container/image/volume/data all derive from it. */
  instanceId: string;
  /** The app (manifest id) this instance runs — a non-unique slug, for grouping/labels. */
  appId: string;
  /** Instance directory: `<instancesDir>/<instanceId>`. Forward-slash normalized. */
  dir: string;
  manifest: Manifest;
  /** Build-context files (excludes the manifest), from the embedded bundle. */
  context: BuildFile[];
  meta: InstanceMeta;
}

/** Load one instance from its directory (reads the embedded bundle + provenance). */
export async function loadInstance(instanceDir: string): Promise<Instance> {
  const dir = instanceDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const instanceId = dir.slice(dir.lastIndexOf("/") + 1);
  if (!instanceId) throw new CompositzError(`invalid instance directory: ${instanceDir}`);
  const bundle = await loadRecipe(`${dir}/${APP_SUBDIR}`);
  const meta = await readMeta(`${dir}/${META_FILE}`);
  return {
    instanceId,
    appId: bundle.manifest.id,
    dir,
    manifest: bundle.manifest,
    context: bundle.context,
    meta,
  };
}

/** Load every valid instance under the store (skips invalid ones). Sorted by name. */
export async function listInstances(instancesDir: string): Promise<Instance[]> {
  const out: Instance[] = [];
  try {
    for await (const entry of Deno.readDir(instancesDir)) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue; // skip staging dirs
      try {
        out.push(await loadInstance(`${instancesDir}/${entry.name}`));
      } catch {
        // skip directories without a valid embedded bundle
      }
    }
  } catch {
    // store dir missing yet — no instances
  }
  out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return out;
}

/** Remove an instance's directory (its definition + override). Docker resources/data are untouched. */
export async function removeInstanceDir(instancesDir: string, instanceId: string): Promise<void> {
  await Deno.remove(`${instancesDir}/${instanceId}`, { recursive: true }).catch(() => {});
}

function normDir(instanceDir: string): string {
  return instanceDir.replaceAll("\\", "/").replace(/\/+$/, "");
}

/** Read + parse an override file under an instance dir; `undefined` if it doesn't exist. */
async function readOverrideFile(instanceDir: string, file: string): Promise<Override | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(`${normDir(instanceDir)}/${file}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
  return parseOverride(text); // a present-but-invalid file throws (fail loud)
}

/**
 * Load the per-instance launch override (`config.yaml`). An absent file ⇒ the empty
 * override (the common case). A present-but-invalid file throws (fail loud — never
 * silently launch with a misread override).
 */
export async function loadInstanceConfig(instanceDir: string): Promise<Override> {
  return (await readOverrideFile(instanceDir, CONFIG_FILE)) ?? {};
}

/** Persist the per-instance launch override (`config.yaml`). */
export async function saveInstanceConfig(instanceDir: string, override: Override): Promise<void> {
  await Deno.writeTextFile(`${normDir(instanceDir)}/${CONFIG_FILE}`, serializeOverride(override));
}

/**
 * Load the override the instance was last LAUNCHED with (`.launched.yaml`). `undefined`
 * if it was never launched. Compared against the live `config.yaml` to tell whether a
 * restart is needed to apply edited settings.
 */
export function loadLaunchedConfig(instanceDir: string): Promise<Override | undefined> {
  return readOverrideFile(instanceDir, LAUNCHED_FILE);
}

/** Record the override an instance is launched with (written by `up`). */
export async function saveLaunchedConfig(instanceDir: string, override: Override): Promise<void> {
  await Deno.writeTextFile(`${normDir(instanceDir)}/${LAUNCHED_FILE}`, serializeOverride(override));
}

async function readMeta(path: string): Promise<InstanceMeta> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as InstanceMeta;
  } catch {
    return {};
  }
}

export async function writeMeta(path: string, meta: InstanceMeta): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(meta, null, 2) + "\n");
}
