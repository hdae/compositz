import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [fresh(), tailwindcss()],
  // Alias React → preact/compat so React-based primitives (Base UI) run on Preact.
  // Order matters: the more specific `react/jsx-runtime` must precede `react`.
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react-dom\/client$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react$/, replacement: "preact/compat" },
    ],
  },
});
