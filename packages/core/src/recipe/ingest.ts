// Ingest a recipe bundle into the instance store (ADR-017): extract → Zod-validate
// → mint an instanceId → create `<instancesDir>/<instanceId>/app/`. Sources are a
// tar/tar.gz archive byte stream (UI upload / CLI file) or a local directory.
// Building the image stays the separate Install step.
//
// The archive is extracted STREAMING (written to disk entry-by-entry), so an
// arbitrarily large bundle never buffers in RAM — there is no size cap (the manager
// is trusted and recipes come from the user; resource-exhaustion "bombs" are out of
// scope per the threat model).
//
// SECURITY (extract safely, regardless of size): archive entry paths are UNTRUSTED.
// Extraction rejects absolute paths, `..` traversal, and symlink/hardlink/device
// entries — a bundle must not write outside the staging directory or plant a link.

import { isAbsolute, join, normalize, resolve, SEPARATOR } from "@std/path";
import { UntarStream } from "@std/tar";
import { CompositzError } from "../errors.ts";
import { BRAND } from "../brand.ts";
import { loadRecipe } from "./loader.ts";
import { APP_SUBDIR, type Instance, loadInstance, META_FILE, writeMeta } from "./instance.ts";

/**
 * The instance id charset — `<appId>-<rand>`. Lowercase alphanumeric + hyphen.
 * Callers that accept an id from outside (a UI route) MUST validate against this,
 * since it flows into filesystem paths and Docker names.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Mint an opaque, legible instance id `<appId>-<rand>`. The random suffix is a
 * collision-avoidance tag, NOT a security token — modulo bias on 36 symbols is
 * irrelevant for a 36^8 opaque key.
 */
export function randomInstanceId(appId: string, size = 8): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${appId}-${suffix}`;
}

/** A recipe bundle to ingest: a packed-archive byte stream, or a directory on disk. */
export type BundleSource =
  | { kind: "archive"; stream: ReadableStream<Uint8Array> }
  | { kind: "dir"; dir: string };

/**
 * Ingest a bundle and create a new instance. Staging happens INSIDE `instancesDir`
 * (same filesystem) so the final move is an atomic rename. The new instance id is
 * random, so this never overwrites an existing instance.
 */
export async function ingestBundle(
  source: BundleSource,
  instancesDir: string,
  opts: { source?: string; createdAt?: string } = {},
): Promise<Instance> {
  await Deno.mkdir(instancesDir, { recursive: true });
  const staging = await Deno.makeTempDir({ dir: instancesDir, prefix: ".ingest-" });
  try {
    if (source.kind === "archive") {
      await extractArchiveTo(source.stream, staging);
    } else {
      await copyTreeTo(source.dir, staging);
    }

    const bundleRoot = await locateBundleRoot(staging);
    const { manifest } = await loadRecipe(bundleRoot); // Zod-validate; throws on any problem
    const instanceId = randomInstanceId(manifest.id);

    const finalDir = join(instancesDir, instanceId);
    if (await pathExists(finalDir)) {
      throw new CompositzError(`instance "${instanceId}" already exists`);
    }
    // Assemble the COMPLETE instance (app/ + meta.json) in a dot-prefixed publish
    // dir, then publish with ONE atomic rename — so a concurrent listInstances
    // never sees a half-built (meta-less ghost) instance, and a pre-publish failure
    // leaves no orphan.
    const pub = await Deno.makeTempDir({ dir: instancesDir, prefix: ".pub-" });
    try {
      await Deno.rename(bundleRoot, join(pub, APP_SUBDIR));
      await writeMeta(join(pub, META_FILE), {
        source: opts.source ?? describeSource(source),
        createdAt: opts.createdAt ?? new Date().toISOString(),
      });
      await Deno.rename(pub, finalDir); // atomic publish
    } catch (e) {
      await Deno.remove(pub, { recursive: true }).catch(() => {});
      throw e;
    }
    // finalDir is now a complete, valid instance; a transient re-read failure here
    // must NOT delete it (that would be irreversible data loss).
    return await loadInstance(finalDir);
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

/**
 * Duplicate an instance into a new one: copies ONLY the `app/` bundle (a fresh
 * deployment), never the persistent data (volumes / data-root start empty).
 */
export async function duplicateInstance(
  instancesDir: string,
  srcInstanceId: string,
): Promise<Instance> {
  const srcApp = join(instancesDir, srcInstanceId, APP_SUBDIR);
  const { id } = (await loadRecipe(srcApp)).manifest; // validates the source is a real instance
  const instanceId = randomInstanceId(id);
  const finalDir = join(instancesDir, instanceId);
  if (await pathExists(finalDir)) {
    throw new CompositzError(`instance "${instanceId}" already exists`);
  }
  // Stage the copy, then publish with one atomic rename — so a concurrent
  // listInstances never sees a half-copied bundle, and a failed copy leaves no
  // orphan (same-fs staging dir, like ingestBundle).
  const staging = await Deno.makeTempDir({ dir: instancesDir, prefix: ".dup-" });
  try {
    await copyTreeTo(srcApp, join(staging, APP_SUBDIR));
    await writeMeta(join(staging, META_FILE), {
      source: `duplicate:${srcInstanceId}`,
      createdAt: new Date().toISOString(),
    });
    await Deno.rename(staging, finalDir);
    return await loadInstance(finalDir);
  } catch (e) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw e;
  }
}

// --- extraction ------------------------------------------------------------

const LINK_TYPEFLAGS = new Set(["1", "2"]); // hardlink, symlink — never followed
const DEVICE_TYPEFLAGS = new Set(["3", "4", "6"]); // char, block, fifo — refused

/**
 * Securely expand a tar / tar.gz BYTE STREAM into `destDir`, writing each entry to
 * disk as it streams (so an arbitrarily large bundle never buffers in RAM). Gzip is
 * auto-detected by magic bytes. Entry paths are sanitized (no absolute/`..`/escape)
 * and symlink/hardlink/device entries are refused.
 */
export async function extractArchiveTo(
  source: ReadableStream<Uint8Array>,
  destDir: string,
): Promise<void> {
  const tar = await decompressIfGzipped(source);
  for await (const entry of tar.pipeThrough(new UntarStream())) {
    const typeflag = entry.header.typeflag;
    if (LINK_TYPEFLAGS.has(typeflag) || DEVICE_TYPEFLAGS.has(typeflag)) {
      await entry.readable?.cancel();
      throw new CompositzError(
        `refusing archive entry "${entry.path}": symlinks, hardlinks and devices are not allowed`,
      );
    }
    // Skip the archive root / empty-name entries (normalize("") === ".") — they
    // resolve to destDir itself, which is not a file to write.
    const rel = normalize(entry.path.replaceAll("\\", "/"));
    if (rel === "." || rel === "") {
      await entry.readable?.cancel();
      continue;
    }
    const target = safeJoin(destDir, entry.path);
    if (typeflag === "5" || entry.path.endsWith("/")) {
      await entry.readable?.cancel();
      await Deno.mkdir(target, { recursive: true });
      continue;
    }
    await Deno.mkdir(dirOf(target), { recursive: true });
    const file = await Deno.open(target, { write: true, create: true, truncate: true });
    if (entry.readable) await entry.readable.pipeTo(file.writable);
    else file.close();
  }
}

/** Peek the first 2 bytes; gunzip the stream when it is gzip-magic, else pass through. */
async function decompressIfGzipped(
  source: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = source.getReader();
  let head = new Uint8Array(0);
  while (head.byteLength < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(head.byteLength + value.byteLength);
    merged.set(head);
    merged.set(value, head.byteLength);
    head = merged;
  }
  // Re-emit the peeked head, then the remainder of the original stream.
  const restored = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
  const gzipped = head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  // (De)CompressionStream is web-typed with BufferSource, which TS won't accept as a
  // Uint8Array transform (WritableStream invariance) — an unavoidable cast.
  return gzipped
    ? restored.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
    : restored;
}

/**
 * Resolve an untrusted archive path under `destDir`, refusing anything that would
 * escape it (absolute, a `..` segment, or a resolved path outside the root).
 */
function safeJoin(destDir: string, entryPath: string): string {
  const norm = normalize(entryPath.replaceAll("\\", "/"));
  if (isAbsolute(norm) || norm.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new CompositzError(`refusing archive entry "${entryPath}": path escapes the bundle`);
  }
  const base = resolve(destDir);
  const target = resolve(base, norm);
  if (target !== base && !target.startsWith(base + SEPARATOR)) {
    throw new CompositzError(`refusing archive entry "${entryPath}": path escapes the bundle`);
  }
  return target;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf(SEPARATOR);
  return i <= 0 ? path : path.slice(0, i);
}

/** Recursively copy a directory tree, skipping symlinks (never follow out of tree). */
async function copyTreeTo(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    if (entry.isSymlink) continue;
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory) await copyTreeTo(s, d);
    else if (entry.isFile) await Deno.copyFile(s, d);
  }
}

/**
 * Find the bundle root in a staging dir: the directory holding `compositz.yaml`,
 * at the root or in a single top-level wrapper dir (e.g. `tar czf` of a directory,
 * or a GitHub codeload tarball). Zero or multiple matches are ambiguous → reject.
 */
async function locateBundleRoot(staging: string): Promise<string> {
  const manifest = BRAND.manifestFile;
  if (await pathExists(join(staging, manifest))) return staging;

  const candidates: string[] = [];
  for await (const entry of Deno.readDir(staging)) {
    if (entry.isDirectory && await pathExists(join(staging, entry.name, manifest))) {
      candidates.push(join(staging, entry.name));
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new CompositzError(
      `no ${manifest} found in the bundle (expected at the root or in a single top-level directory)`,
    );
  }
  throw new CompositzError(`ambiguous bundle: ${manifest} found in multiple top-level directories`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function describeSource(source: BundleSource): string {
  return source.kind === "archive" ? "upload" : `dir:${source.dir}`;
}
