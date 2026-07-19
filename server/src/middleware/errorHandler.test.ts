/**
 * Unit tests for the global error handler (BUG-API1).
 * Drives errorHandler with a minimal fake req/res — no HTTP server needed.
 * Run via the tsx --test glob (npm test -w server).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "./errorHandler.js";

// A tiny res double that records status()/json() and headersSent.
function makeRes(headersSent = false) {
  const rec: { status?: number; body?: unknown; headersSent: boolean } = {
    headersSent,
  };
  const res = {
    headersSent,
    status(code: number) {
      rec.status = code;
      return this;
    },
    json(body: unknown) {
      rec.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, rec };
}

const req = {} as Request;
const noopNext: NextFunction = () => {};

test("body-parser JSON SyntaxError → clean 400", () => {
  // Shape body-parser produces: a SyntaxError with numeric status + body prop.
  const err = new SyntaxError("Unexpected token } in JSON") as SyntaxError & {
    status: number;
    body: string;
  };
  err.status = 400;
  err.body = "{bad";
  const { res, rec } = makeRes();
  errorHandler(err, req, res, noopNext);
  assert.equal(rec.status, 400);
  assert.deepEqual(rec.body, { error: "invalid JSON body" });
});

test("unknown error → 500 with generic message, no stack leaked (non-dev)", () => {
  const prev = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "test";
  try {
    const err = new Error("secret internal detail at D:\\app\\node_modules\\x");
    const { res, rec } = makeRes();
    errorHandler(err, req, res, noopNext);
    assert.equal(rec.status, 500);
    assert.deepEqual(rec.body, { error: "internal server error" });
    // Crucially, no `stack` field and no internal message.
    assert.equal((rec.body as { stack?: string }).stack, undefined);
  } finally {
    process.env["NODE_ENV"] = prev;
  }
});

test("explicit 4xx status + message is surfaced", () => {
  const err = { status: 413, message: "payload too large" };
  const { res, rec } = makeRes();
  errorHandler(err as unknown as Error, req, res, noopNext);
  assert.equal(rec.status, 413);
  assert.deepEqual(rec.body, { error: "payload too large" });
});

test("explicit 5xx status does NOT echo its message (may carry internals)", () => {
  const err = { status: 503, message: "db password rejected at 10.0.0.1" };
  const { res, rec } = makeRes();
  errorHandler(err as unknown as Error, req, res, noopNext);
  assert.equal(rec.status, 503);
  assert.deepEqual(rec.body, { error: "internal server error" });
});

test("development mode adds a stack field for local debugging", () => {
  const prev = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "development";
  try {
    const err = new Error("boom");
    const { res, rec } = makeRes();
    errorHandler(err, req, res, noopNext);
    assert.equal(rec.status, 500);
    assert.ok(typeof (rec.body as { stack?: string }).stack === "string");
  } finally {
    process.env["NODE_ENV"] = prev;
  }
});

test("headersSent → delegates to next, does not re-send", () => {
  const err = new Error("late");
  const { res, rec } = makeRes(true);
  let nexted = false;
  errorHandler(err, req, res, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
  assert.equal(rec.status, undefined);
});
