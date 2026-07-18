/**
 * P9 — the log-to-file sink is opt-in via LOG_FILE / LOG_DIR. This locks the
 * path-resolution logic (the pure part): which env var wins, that a bare dir
 * gets a default filename, and that neither-set is a no-op (null).
 *
 * Run: npx tsx --test src/observability/logSink.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { resolveLogFilePath } from "./logSink.js";

test("P9: neither LOG_FILE nor LOG_DIR set → sink off (null)", () => {
  assert.equal(resolveLogFilePath({}), null);
});

test("P9: LOG_FILE resolves to an absolute path", () => {
  const p = resolveLogFilePath({ LOG_FILE: "logs/live.log" });
  assert.equal(p, resolve("logs/live.log"));
});

test("P9: LOG_DIR gets a default server.log filename", () => {
  const p = resolveLogFilePath({ LOG_DIR: "/var/log/pluvus" });
  assert.equal(p, resolve("/var/log/pluvus", "server.log"));
});

test("P9: LOG_FILE wins over LOG_DIR when both set", () => {
  const p = resolveLogFilePath({ LOG_FILE: "a.log", LOG_DIR: "/tmp" });
  assert.equal(p, resolve("a.log"));
});

test("P9: blank/whitespace env values are treated as unset", () => {
  assert.equal(resolveLogFilePath({ LOG_FILE: "   ", LOG_DIR: "" }), null);
});
