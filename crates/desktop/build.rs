fn main() {
    tauri_build::build();
    embed_windows_manifest_for_tests();
}

/// Link the Common-Controls v6 application manifest into TEST binaries on
/// Windows/MSVC. tauri-build embeds it only into bins (embed-resource emits
/// `rustc-link-arg-bins`), so a manifest-less test executable resolves
/// comctl32 v5 at load and dies with STATUS_ENTRYPOINT_NOT_FOUND (the v6-only
/// exports tauri imports are missing) before any test runs — which is exactly
/// how the CI bindings-freshness gate broke on windows-latest. Scoped to test
/// targets so it can never collide with the bin's resource-embedded manifest
/// (a duplicate RT_MANIFEST is a linker error).
///
/// `windows-app-manifest.xml` is vendored verbatim from tauri-build (MIT), so
/// test executables declare the same assembly dependencies as the shipped app.
fn embed_windows_manifest_for_tests() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV");
    if target_os.as_deref() == Ok("windows") && target_env.as_deref() == Ok("msvc") {
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
