// Shapes that cross the Tauri IPC boundary. These MUST match the Rust side
// byte-for-byte (crates/desktop, serde rename_all = "camelCase"). Phase 0 keeps
// the error channel a plain string; a structured error enum lands in Phase 3.
//
// Managed containers are identified by the presence of the Docker label key
// "io.compositz.instance" (packages/core/src/brand.ts); the backend applies that
// filter, so the frontend treats every summary it receives as managed.

/** One row of the container list, as returned by `list_containers`. */
export type ContainerSummary = {
  /** Full Docker container id. */
  id: string;
  /** Primary container name with the leading "/" already stripped. */
  name: string;
  /** Docker state string, e.g. "running", "exited", "created". */
  state: string;
  /** Image reference the container was created from. */
  image: string;
  /** Human-readable port strings, e.g. "8188->8188/tcp". */
  ports: string[];
};
