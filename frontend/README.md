# compositz — desktop frontend

The React UI for the compositz Tauri desktop app: a dashboard for running local‑AI
apps as isolated Docker containers (import a recipe → build → start → open). The Rust
core + Tauri shell live in [`../crates`](../crates); this package is the webview.

## Stack

- **React 19** + **[vite-plus](https://viteplus.dev) (`vp`)** — dev server, build, lint
  (Oxlint), format (Oxfmt), test (Vitest‑compatible).
- **Tailwind CSS v4** + **[Base UI](https://base-ui.com)** components (shadcn `base-nova`
  style — see `src/components/ui/`).
- **zustand** for dashboard state; **lucide-react** icons; **Geist** font.

## Backend seam

Everything crosses one seam so nothing else touches Tauri directly:

- `src/ipc/bindings.ts` — **generated** by `tauri-specta` (the desktop crate's
  `export_bindings` test). Do not edit by hand; it is `@ts-nocheck` and excluded from
  fmt/lint.
- `src/ipc/client.ts` — the typed wrapper over `bindings`: `Result → throw` unwrapping,
  request/response commands, and `Channel` subscriptions (snapshots, install/runtime
  logs). Also the native dialog seams (`pickRecipeFile` / `pickSaveDest`).
- `src/ipc/mock.ts` — a **dev‑only** stateful fake of the backend. Loaded only under
  plain `vp dev` in a browser (no Tauri); tree‑shaken from the production build. Lets the
  whole UI run and be clicked through without the Rust backend.
- `src/store/instances.ts` — the dashboard store (server‑confirmed, **no optimistic
  updates**); `src/lib/rows.ts` — merges the base rows with the live snapshot.

## Develop

```sh
vp dev            # browser dev with the mock IPC (or drive the real app via `cargo tauri dev`)
vp check          # format + lint + typecheck  (--fix to auto-fix)
vp test run       # tests (none yet — passWithNoTests)
tsc -b && vp build
```

Add a shadcn component (Base UI, never hand‑written):

```sh
pnpm dlx shadcn@latest add <name>   # base-nova style is configured in components.json
```

Real Docker‑backed behavior (drag‑drop file paths, native dialogs, container logs) is
exercised in the packaged desktop app, not in browser dev.
