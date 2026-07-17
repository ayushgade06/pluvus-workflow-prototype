// P2 — the operator-route gate predicate. Pure (no HTTP): given the configured
// OPERATOR_API_KEY and the request's X-Operator-Key header, decide open/missing/
// invalid/ok. Also exercises the Express middleware form with a fake req/res to
// confirm the 401 vs pass-through wiring and, critically, that an unset key is
// open (dev) so local work isn't blocked — the prod boot guard (P1) is what
// forces the key in production.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { checkOperatorKey, requireOperatorKey } from "./requireOperatorKey.js";

const KEY = "s3cret-operator-key";

test("P2: unset / blank key is OPEN (dev convenience)", () => {
  assert.equal(checkOperatorKey(undefined, "anything"), "open");
  assert.equal(checkOperatorKey("", "anything"), "open");
  assert.equal(checkOperatorKey("   ", "anything"), "open");
});

test("P2: set key + matching header is ok", () => {
  assert.equal(checkOperatorKey(KEY, KEY), "ok");
});

test("P2: set key + missing/empty/non-string header is missing", () => {
  assert.equal(checkOperatorKey(KEY, undefined), "missing");
  assert.equal(checkOperatorKey(KEY, ""), "missing");
  assert.equal(checkOperatorKey(KEY, ["a", "b"]), "missing"); // array header
  assert.equal(checkOperatorKey(KEY, 12345), "missing");
});

test("P2: set key + wrong header is invalid", () => {
  assert.equal(checkOperatorKey(KEY, "wrong"), "invalid");
  assert.equal(checkOperatorKey(KEY, KEY + "x"), "invalid"); // length differs
  assert.equal(checkOperatorKey(KEY, KEY.toUpperCase()), "invalid"); // case-sensitive
});

// --- Express middleware wiring (fake req/res) ------------------------------

function fakeReqRes(headerVal: unknown) {
  const req = { headers: { "x-operator-key": headerVal } } as unknown as Request;
  const state: { status: number | null; body: unknown; nexted: boolean } = {
    status: null,
    body: null,
    nexted: false,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  const next = () => {
    state.nexted = true;
  };
  return { req, res, next, state };
}

function withEnv(key: string | undefined, fn: () => void) {
  const prev = process.env["OPERATOR_API_KEY"];
  if (key === undefined) delete process.env["OPERATOR_API_KEY"];
  else process.env["OPERATOR_API_KEY"] = key;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["OPERATOR_API_KEY"];
    else process.env["OPERATOR_API_KEY"] = prev;
  }
}

test("P2 middleware: unset key → passes through (next called, no 401)", () => {
  withEnv(undefined, () => {
    const { req, res, next, state } = fakeReqRes("whatever");
    requireOperatorKey(req, res, next);
    assert.equal(state.nexted, true);
    assert.equal(state.status, null);
  });
});

test("P2 middleware: set key + no header → 401 missing, next NOT called", () => {
  withEnv(KEY, () => {
    const { req, res, next, state } = fakeReqRes(undefined);
    requireOperatorKey(req, res, next);
    assert.equal(state.nexted, false);
    assert.equal(state.status, 401);
    assert.deepEqual(state.body, { error: "Missing X-Operator-Key header" });
  });
});

test("P2 middleware: set key + wrong header → 401 invalid, next NOT called", () => {
  withEnv(KEY, () => {
    const { req, res, next, state } = fakeReqRes("nope");
    requireOperatorKey(req, res, next);
    assert.equal(state.nexted, false);
    assert.equal(state.status, 401);
    assert.deepEqual(state.body, { error: "Invalid operator key" });
  });
});

test("P2 middleware: set key + correct header → passes through", () => {
  withEnv(KEY, () => {
    const { req, res, next, state } = fakeReqRes(KEY);
    requireOperatorKey(req, res, next);
    assert.equal(state.nexted, true);
    assert.equal(state.status, null);
  });
});
