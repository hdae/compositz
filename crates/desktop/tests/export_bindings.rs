//! Regenerate the frontend's typed IPC bindings from the SAME commands the app
//! registers — the canonical tauri-specta workflow, run as a test so it is
//! reproducible in the Nix build shell where this crate compiles (the headless
//! dev container cannot link webkit outside that shell) and so CI can assert
//! the committed bindings are fresh.
//!
//! An INTEGRATION test on purpose, not a lib unit test: on Windows, a test
//! executable does not receive tauri-build's embedded application manifest
//! (embed-resource emits `rustc-link-arg-bins` — bins only), so a lib unit-test
//! exe resolves comctl32 v5 at load and dies with STATUS_ENTRYPOINT_NOT_FOUND
//! before any test runs. The build script embeds the manifest for TEST targets
//! via `rustc-link-arg-tests`, which is guaranteed to cover integration tests.

#[test]
fn export_bindings() {
    let path = "../../frontend/src/ipc/bindings.ts";
    compositz_desktop_lib::specta_builder()
        .export(specta_typescript::Typescript::default(), path)
        .expect("export typescript bindings");

    // tauri-specta rc.21 emits, for a Channel-carrying command surface, a
    // `TAURI_CHANNEL` placeholder type that collides with the imported
    // `Channel as TAURI_CHANNEL` (TS2440), plus event scaffolding we never
    // reference (we push over Channels, not tauri events). Drop the colliding
    // placeholder so `TAURI_CHANNEL` unambiguously means the imported Channel
    // for consumers, and prepend `// @ts-nocheck` so `noUnusedLocals` does not
    // trip on the leftover generated scaffolding. The frontend also excludes
    // this file from fmt/lint (see vite.config.ts) — its shape is the
    // generator's, not ours.
    let generated = std::fs::read_to_string(path).expect("read generated bindings");
    let body: String = generated
        .lines()
        .filter(|line| line.trim() != "export type TAURI_CHANNEL<TSend> = null")
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(path, format!("// @ts-nocheck\n{body}\n")).expect("write cleaned bindings");
}
