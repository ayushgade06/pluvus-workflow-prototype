// ---------------------------------------------------------------------------
// Log-to-file sink (P9 / single-operator go-live)
// ---------------------------------------------------------------------------
// The server logs to stdout ONLY. When it runs behind a tunnel / as a detached
// process, that stream is gone — "we literally couldn't read the live log this
// session" (go-live plan P9). This module adds an OPTIONAL file sink: when
// LOG_FILE (or LOG_DIR) is set, every console.log / .error / .warn / .info line
// is ALSO appended to a file, so an operator can `tail -f` the live log and a
// post-mortem has something to read.
//
// Why patch console instead of adding a logger dependency: the codebase already
// logs everything through console.* with stable tags ([transition], [trace],
// [metrics], [escalation], worker [node-execution] failures, …). Mirroring at
// the console layer captures ALL of it — including third-party libs — with zero
// call-site churn, and keeps the "no pino/winston" footprint decision (see
// observability/logger.ts). stdout still gets every line unchanged; the file is
// purely additive.
//
// Off by default: with neither env var set, initLogSink() is a no-op and
// behavior is exactly as before.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type ConsoleMethod = "log" | "info" | "warn" | "error";

let installed = false;

/** Resolve the target log file path from env, or null when the sink is off. */
export function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env["LOG_FILE"]?.trim();
  if (file) return resolve(file);
  const dir = env["LOG_DIR"]?.trim();
  if (dir) return resolve(dir, "server.log");
  return null;
}

/** Format one console call into a single timestamped line for the file. */
function formatLine(level: ConsoleMethod, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `${ts} [${level}] ${body}\n`;
}

/**
 * Install the file sink if LOG_FILE / LOG_DIR is set. Idempotent — safe to call
 * once at startup from every process role. Returns the file path when enabled,
 * else null. A failed write NEVER throws (logging must not crash the app); it
 * degrades to stdout-only after warning once.
 */
export function initLogSink(env: NodeJS.ProcessEnv = process.env): string | null {
  if (installed) return resolveLogFilePath(env);
  const filePath = resolveLogFilePath(env);
  if (!filePath) return null;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Directory may already exist or be uncreatable; the append below will tell.
  }

  let warned = false;
  const methods: ConsoleMethod[] = ["log", "info", "warn", "error"];
  for (const level of methods) {
    // Capture the ORIGINAL so stdout/stderr still receive every line.
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        appendFileSync(filePath, formatLine(level, args));
      } catch (err) {
        if (!warned) {
          warned = true;
          original(
            `[logSink] failed to write ${filePath}; continuing stdout-only: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    };
  }

  installed = true;
  console.log(`[logSink] mirroring console output to ${filePath}`);
  return filePath;
}
