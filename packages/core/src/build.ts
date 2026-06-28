// Build-context helpers: assemble an in-memory tar archive suitable for
// `POST /build`. Recipes are small (a Dockerfile plus a few provisioning files),
// so building the whole archive in memory is fine; streaming large contexts is a
// later optimization.

import { TarStream, type TarStreamInput } from "@std/tar";

export interface BuildFile {
  /** Path within the context root, e.g. "Dockerfile" or "rootfs/run.sh". */
  path: string;
  data: Uint8Array;
}

/** Pack files into an uncompressed (ustar) tar archive Docker can consume. */
export async function tarContext(files: BuildFile[]): Promise<Uint8Array> {
  const inputs: TarStreamInput[] = files.map((f) => ({
    type: "file",
    path: f.path,
    size: f.data.byteLength,
    readable: ReadableStream.from([f.data]),
  }));
  const tar = ReadableStream.from(inputs).pipeThrough(new TarStream());
  return await new Response(tar).bytes();
}
