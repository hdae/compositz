// Demultiplex Docker's stdout/stderr stream format. When a container has no TTY,
// `GET /containers/{id}/logs` (and attach) frames output as repeated:
//
//   byte 0      : stream type (0=stdin, 1=stdout, 2=stderr)
//   bytes 1..3  : zero padding
//   bytes 4..7  : payload length, uint32 big-endian
//   bytes 8..   : payload
//
// With a TTY the bytes are raw (no framing) — callers that enable TTY must not use
// this demuxer. We control container creation, so Phase 0 always runs Tty:false.

import { ByteReader } from "../http.ts";
import type { LogFrame } from "./types.ts";

export async function* demuxLog(src: AsyncIterable<Uint8Array>): AsyncGenerator<LogFrame> {
  const reader = ByteReader.fromIterable(src);
  while (true) {
    const header = await reader.readExactly(8);
    if (header.byteLength === 0) return; // clean EOF
    if (header.byteLength < 8) return; // truncated tail
    const type = header[0];
    const size = new DataView(header.buffer, header.byteOffset, 8).getUint32(4);
    if (size === 0) continue;
    const payload = await reader.readExactly(size);
    if (payload.byteLength === 0) return;
    yield { stream: type === 2 ? "stderr" : "stdout", data: payload };
    if (payload.byteLength < size) return; // truncated payload
  }
}
