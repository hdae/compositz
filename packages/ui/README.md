# @compositz/ui

The Compositz management UI — a [Fresh 2](https://fresh.deno.dev/) (Vite) app and a member of the
Compositz Deno workspace.

It talks to `@compositz/core` **in-process from server-side route handlers** (no separate API hop):
a handler imports the engine client / recipe loader directly, and Fresh ships only islands to the
browser. The `fresh:check-imports` build guard fails if anything reaching `node:net` (the Docker
transport) ever leaks into a client bundle — so engine code must stay in routes, never islands. See
[`routes/index.tsx`](routes/index.tsx) and the pure view-model in
[`lib/dashboard.ts`](lib/dashboard.ts).

## Develop

Run from the repo root (tasks set the correct cwd):

```sh
deno task ui          # dev server (Vite HMR)
deno task ui:build    # production build -> packages/ui/_fresh/
```

`COMPOSITZ_RECIPES_DIR` overrides where recipes are read from (default: `../../recipes`, i.e. the
repo-root `recipes/`).

> Requires Deno >= 2.9 (use the project-local `bin/deno`). The engine reads degrade gracefully — the
> dashboard still renders with an "engine offline" badge when Docker is unreachable.
