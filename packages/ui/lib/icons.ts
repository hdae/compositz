// Single place the app pulls Lucide icons from. The bundler is told (via
// `treeshake.moduleSideEffects` in vite.config.ts) that `lucide-preact` is
// side-effect-free, so only the icons re-exported here land in the client bundle —
// the package's own `sideEffects: false` is not surfaced to Rollup by the Deno
// resolver, and its `exports` map blocks per-icon deep imports.
export {
  ChevronDown,
  Download,
  ExternalLink,
  Globe,
  Hammer,
  LoaderCircle,
  Play,
  ScrollText,
  Square,
  Trash2,
  Upload,
} from "lucide-preact";
