// Compositz desktop — a native window onto the Fresh management UI. It starts the
// UI server (packages/ui) and points a CEF webview at it; recipe install/up/down
// all happen inside that UI (which calls @compositz/core in-process — ADR-013).
//
// Run it (dev):  deno desktop --hmr --backend cef -A --unstable-net packages/desktop/main.ts
//   (`deno task desktop` BUILDS the app to dist/; add --hmr to run it in place.)
//   COMPOSITZ_UI_URL=<url>   navigate to an already-running UI instead of spawning one
//   COMPOSITZ_UI_PORT=<n>    port for the spawned UI dev server (default 8765)
//   COMPOSITZ_SMOKE=1        navigate, verify the page <title>, then exit
//   COMPOSITZ_LOG=<file>     capture a step trace (GUI stdout is invisible)

import { fromFileUrl } from "@std/path";

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

const UI_PORT = Number(safeEnv("COMPOSITZ_UI_PORT") ?? "8765");
const UI_URL = safeEnv("COMPOSITZ_UI_URL");
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

interface UiServer {
  url: string;
  stop: () => void;
}

/**
 * Make the management UI reachable. With COMPOSITZ_UI_URL set we just point at an
 * already-running server; otherwise we spawn the Fresh dev server (same Deno binary)
 * on a fixed port. Packaging the built UI into the standalone app is future work
 * (Phase 4) — this drives the dev/`--hmr` experience.
 */
function startUi(): UiServer {
  if (UI_URL) return { url: UI_URL, stop: () => {} };
  const root = fromFileUrl(new URL("../../", import.meta.url)); // packages/desktop/ → repo root
  const child = new Deno.Command(Deno.execPath(), {
    args: ["task", "--cwd", "packages/ui", "dev", "--port", String(UI_PORT), "--strictPort"],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return {
    url: `http://localhost:${UI_PORT}/`,
    stop: () => {
      try {
        child.kill();
      } catch { /* already exited */ }
    },
  };
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
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

  const ui = startUi();
  await logStep(`management UI at ${ui.url}${UI_URL ? " (external)" : " (spawned)"}`);
  try {
    await waitForHttp(ui.url);
  } catch (e) {
    await logStep(`ERROR: UI did not come up: ${e instanceof Error ? e.message : String(e)}`);
    ui.stop();
    Deno.exit(1);
  }
  await logStep(`UI ready at ${ui.url}`);

  await logStep("create BrowserWindow");
  const win = new BrowserWindow({ title: "Compositz", width: 1200, height: 800 });
  await logStep(`navigate ${ui.url}`);
  win.navigate(ui.url);

  if (safeEnv("COMPOSITZ_SMOKE") === "1") {
    const title = await readPageTitle(win);
    await logStep(`SMOKE: WebView loaded page title = ${JSON.stringify(title)}`);
    ui.stop();
    try {
      win.close();
    } catch { /* backend may already be tearing down */ }
    Deno.exit(title.length > 0 ? 0 : 2);
  }

  win.addEventListener("close", async () => {
    await logStep("window closed; stopping UI");
    ui.stop();
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
