/** Base error for all Compositz failures. */
export class CompositzError extends Error {
  override name = "CompositzError";
}

/** A non-2xx response from the Docker Engine API. */
export class EngineHttpError extends CompositzError {
  override name = "EngineHttpError";
  readonly status: number;
  readonly statusText: string;
  /** Raw (already framing-decoded) response body, as text. */
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    const detail = parseMessage(body) ?? body.slice(0, 500);
    super(`Docker Engine returned ${status} ${statusText}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/** Docker errors are usually `{ "message": "..." }`. */
function parseMessage(body: string): string | undefined {
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj.message === "string") return obj.message;
  } catch {
    // not JSON
  }
  return undefined;
}
