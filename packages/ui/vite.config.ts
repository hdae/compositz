import { defineConfig, type Plugin } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

// The Deno resolver does not surface `lucide-preact`'s `sideEffects: false` to Rollup,
// so importing any icon drags its ~1700-icon barrel into the client bundle (+460 kB).
// Its `exports` map also blocks per-icon deep imports, so we annotate just that
// package's modules as side-effect-free here — unused icon re-exports then tree-shake,
// while every other module keeps Rollup's default behavior (unlike a global override).
//
// Durability: this works only while lucide-preact stays a barrel of pure
// `createLucideIcon` calls. If a future version adds module-level side effects, or once
// it ships per-icon subpath `exports`, switch `lib/icons.ts` to deep imports
// (`import { default as Upload } from "lucide-preact/icons/upload"`) and drop this.
const lucidePreactSideEffectsFree: Plugin = {
  name: "lucide-preact-side-effects-free",
  transform(code, id) {
    // Match the package directory boundary so an adjacent name can't trip it. `map: null`
    // is safe because the code is returned unchanged (metadata-only transform) — a real
    // edit here MUST return a proper sourcemap instead.
    if (id.includes("/lucide-preact/")) return { code, map: null, moduleSideEffects: false };
  },
};

export default defineConfig({
  plugins: [fresh(), tailwindcss(), lucidePreactSideEffectsFree],
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
