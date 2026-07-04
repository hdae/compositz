{
  # Dev shell that lets the `compositz-desktop` (Tauri) crate compile IN THIS
  # Linux container. Tauri's `wry`/`webkit2gtk` and its plugins link native GUI
  # libraries (webkit2gtk-4.1, gtk3, glib, dbus, libsoup) whose pkg-config `.dev`
  # outputs must be discoverable at build time. A flat `devbox add` / nix profile
  # does NOT run the stdenv pkg-config setup hook, so those `-sys` build scripts
  # fail there; `mkShell` DOES run it, wiring every buildInput's pkgconfig dir
  # onto PKG_CONFIG_PATH — which is the whole reason this file exists.
  #
  # The real target (Windows) uses WebView2 and needs none of this; the flake is
  # only for local `cargo clippy/test` and regenerating the tauri-specta TS
  # bindings (`cargo test -p compositz-desktop export_bindings`).
  description = "compositz desktop (Tauri) build shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      # This shell is only ever entered on the x86_64 Linux dev host; the app
      # itself is built on Windows in CI, so there is no need for multi-system
      # plumbing (flake-utils) here.
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ (import rust-overlay) ];
      };
      # Pin the toolchain to the version the workspace is developed against
      # (edition 2024 / resolver 3). The `default` profile already carries
      # rustfmt + clippy; add rust-src for editor tooling.
      rust = pkgs.rust-bin.stable."1.96.1".default.override {
        extensions = [ "rust-src" ];
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [
          rust
          pkg-config
          gobject-introspection
        ];
        buildInputs = with pkgs; [
          glib
          gtk3
          cairo
          pango
          gdk-pixbuf
          atk
          harfbuzz
          librsvg
          libsoup_3
          webkitgtk_4_1
          dbus
          openssl
        ];
      };
    };
}
