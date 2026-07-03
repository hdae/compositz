import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri exposes these when driving Vite (mobile dev / remote HMR). Absent in
// plain `vp dev` and in CI, so every read is guarded.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  fmt: {},
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Tauri expects a fixed dev port and never garbles the console it wraps.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tauri source lives outside frontend/; no reason to watch it.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Only VITE_ and TAURI_ENV_* vars are exposed to the client bundle.
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // Match the webview each target platform ships; Windows/WebView2 tracks
    // Chrome, macOS tracks Safari. Falls back to a modern baseline for `vp dev`.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // Debug builds keep readable output; release strips it.
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  test: {
    // jsdom lacks WebCrypto, which @tauri-apps/api's mockIPC transport needs.
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
