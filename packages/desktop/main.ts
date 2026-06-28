// Compositz desktop — Phase 2: launch a recipe and embed its web UI in a native
// window. Builds the image if needed, brings the container up via @compositz/core,
// navigates the CEF webview to the recipe's web UI, and tears the container down
// when the window closes.
//
// Run it:   deno task desktop   then   dist\compositz-cef\compositz-cef.bat
//   COMPOSITZ_RECIPE_DIR=<path>   choose the recipe (default: recipes/hello-web)
//   COMPOSITZ_SMOKE=1            navigate, verify the page <title>, then tear down
//   COMPOSITZ_LOG=<file>        capture a step trace (GUI stdout is invisible)

import {
  down,
  EngineClient,
  installRecipe,
  loadRecipe,
  recipeImageTag,
  up,
  webUrl,
} from "@compositz/core";

// --- Minimal Deno Desktop typings (cast, so `deno check` passes without the desktop lib) ---
interface BrowserWindow {
  navigate(url: string): void;
  executeJs(code: string): Promise<unknown>;
  reload(): void;
  close(): void;
  addEventListener(type: string, cb: (ev?: unknown) => void): void;
}
interface BrowserWindowOptions {
  title?: string;
  width?: number;
  height?: number;
}
type BrowserWindowCtor = new (opts?: BrowserWindowOptions) => BrowserWindow;

const BrowserWindow = (Deno as unknown as { BrowserWindow?: BrowserWindowCtor }).BrowserWindow;

const RECIPE_DIR = safeEnv("COMPOSITZ_RECIPE_DIR") ?? "recipes/hello-web";
const LOG_PATH = safeEnv("COMPOSITZ_LOG");

async function logStep(msg: string): Promise<void> {
  try {
    console.log(msg);
  } catch { /* GUI subsystem: no console */ }
  if (LOG_PATH) {
    try {
      await Deno.writeTextFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, {
        append: true,
      });
    } catch { /* ignore */ }
  }
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main(): Promise<void> {
  await logStep(`main() start; BrowserWindow=${typeof BrowserWindow}`);
  if (!BrowserWindow) {
    await logStep("ERROR: Deno.BrowserWindow unavailable — run via `deno desktop`.");
    Deno.exit(1);
  }

  const client = new EngineClient();
  const recipe = await loadRecipe(RECIPE_DIR);
  await logStep(`recipe ${recipe.manifest.name} (${recipe.id})`);

  if (!(await client.imageExists(recipeImageTag(recipe.manifest)))) {
    await logStep("building image…");
    for await (const _ of installRecipe(client, recipe)) { /* drain build stream */ }
  }

  const { id, usedGpu, hostPorts } = await up(client, recipe);
  await logStep(`container ${id.slice(0, 12)} up (gpu=${usedGpu ? "on" : "off"})`);

  const url = webUrl(recipe.manifest, { hostPorts });
  if (!url) {
    await logStep("ERROR: recipe has no web UI (no `web:` block).");
    await down(client, recipe.id);
    Deno.exit(1);
  }
  await waitForHttp(url);
  await logStep(`serving at ${url}`);

  const cleanup = () => down(client, recipe.id).catch(() => {});

  await logStep("create BrowserWindow");
  const win = new BrowserWindow({
    title: `Compositz — ${recipe.manifest.name}`,
    width: 1000,
    height: 720,
  });
  await logStep(`navigate ${url}`);
  win.navigate(url);

  if (safeEnv("COMPOSITZ_SMOKE") === "1") {
    const title = await readPageTitle(win);
    await logStep(`SMOKE: WebView loaded page title = ${JSON.stringify(title)}`);
    await cleanup(); // tear down before close(): the CEF backend may abort the process on close()
    try {
      win.close();
    } catch { /* backend may already be tearing down */ }
    Deno.exit(title.length > 0 ? 0 : 2);
  }

  win.addEventListener("close", async () => {
    await logStep("window closed; tearing down");
    await cleanup();
    Deno.exit(0);
  });
}

/** Poll the page until loaded, then return document.title. Logs each probe. */
async function readPageTitle(win: BrowserWindow): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const rawReady = await win.executeJs("document.readyState");
      const rawTitle = await win.executeJs("document.title");
      await logStep(`  probe ready=${JSON.stringify(rawReady)} title=${JSON.stringify(rawTitle)}`);
      const ready = unwrap(rawReady);
      const title = unwrap(rawTitle);
      if ((ready === "complete" || ready === "interactive") && title.length > 0) return title;
    } catch (e) {
      await logStep(`  probe executeJs error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

/** Deno Desktop executeJs wraps the result as {ok, value}; pull out the value. */
function unwrap(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).result;
    if (typeof inner === "string") return inner;
  }
  return String(v ?? "");
}

function safeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

try {
  await main();
} catch (e) {
  await logStep(`FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
  Deno.exit(1);
}
