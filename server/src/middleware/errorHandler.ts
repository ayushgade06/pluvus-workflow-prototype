import type { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Global Express error handler (BUG-API1)
// ---------------------------------------------------------------------------
// The audit found the server had NO global error handler, so any unhandled error
// (e.g. malformed JSON caught by body-parser) fell through to Express's default
// HTML error page — leaking the full stack trace AND absolute filesystem paths
// (D:\...\node_modules\body-parser\...). The FastAPI agent returns clean
// structured JSON; this closes the same gap on the Express side.
//
// Mounted LAST in createApp() (an error-handling middleware MUST have the 4-arg
// signature and be registered after all routes). It:
//   - maps a body-parser JSON SyntaxError to a clean 400 {"error":"invalid JSON body"}
//   - honours an explicit err.status / err.statusCode when present
//   - otherwise returns 500 {"error":"internal server error"}
//   - NEVER leaks stack/paths unless NODE_ENV === "development" (then a `stack`
//     field is added purely as a local-debug convenience).

/** True only for a body-parser JSON parse failure (its SyntaxError carries a
 *  numeric `status` 400 and a `body` property). Kept narrow so a genuine
 *  application SyntaxError isn't misreported as a bad request. */
function isBodyParserJsonError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    typeof (err as { status?: unknown }).status === "number" &&
    "body" in (err as object)
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If a response was already started, defer to Express's default handler
  // (it will close the connection) — we can't safely re-send.
  if (res.headersSent) {
    next(err);
    return;
  }

  const isDev = (process.env["NODE_ENV"] ?? "").toLowerCase() === "development";

  let status = 500;
  let message = "internal server error";

  if (isBodyParserJsonError(err)) {
    status = 400;
    message = "invalid JSON body";
  } else if (
    err &&
    typeof err === "object" &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    status = (err as { status: number }).status;
    // Only surface an explicit client-error message; never echo a 5xx message
    // (it may carry internals). 4xx messages from our own routes are safe.
    if (status >= 400 && status < 500) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === "string" && m.trim()) message = m;
    }
  }

  // Log the full error server-side (stack included) — the leak we're closing is
  // to the CLIENT, not to our own logs.
  console.error("[error-handler]", err);

  const body: { error: string; stack?: string } = { error: message };
  if (isDev && err instanceof Error && err.stack) {
    body.stack = err.stack;
  }
  res.status(status).json(body);
}
