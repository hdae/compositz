import { define } from "../../utils.ts";

// SERVER-ONLY: opens a URL in the OS DEFAULT browser — the in-app webview / a browser tab
// can't reach the system default from client JS, so the manager process does it via the
// platform opener. Locked down: only http(s) **localhost** service URLs, and the URL is
// passed as a direct ARG (no shell) — so neither command injection nor an arbitrary opener
// (file://, app protocols, remote hosts) is possible.

const OPENERS: Record<string, { cmd: string; args: (url: string) => string[] }> = {
  linux: { cmd: "xdg-open", args: (url) => [url] },
  darwin: { cmd: "open", args: (url) => [url] },
  windows: { cmd: "rundll32", args: (url) => ["url.dll,FileProtocolHandler", url] },
};

/** Only a local web-service URL may be opened (the dashboard's own services are localhost). */
function isLocalServiceUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export const handler = define.handlers({
  async POST(ctx) {
    const body = await ctx.req.json().catch(() => null) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    if (!isLocalServiceUrl(url)) {
      return Response.json({ ok: false, error: "only local http(s) service URLs can be opened" }, {
        status: 400,
      });
    }
    const opener = OPENERS[Deno.build.os];
    if (!opener) {
      return Response.json({ ok: false, error: `unsupported platform: ${Deno.build.os}` }, {
        status: 500,
      });
    }
    try {
      const out = await new Deno.Command(opener.cmd, {
        args: opener.args(url),
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!out.success) {
        const err = new TextDecoder().decode(out.stderr).trim();
        return Response.json({ ok: false, error: err || `${opener.cmd} exited ${out.code}` }, {
          status: 500,
        });
      }
      return Response.json({ ok: true });
    } catch (e) {
      // e.g. the opener binary is missing on this host.
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, {
        status: 500,
      });
    }
  },
});
