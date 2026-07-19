/**
 * P1 — the server must FAIL LOUD (refuse to boot) in production if a required
 * secret (e.g. ATTRIBUTION_WEBHOOK_SECRET) is unset, rather than silently run an
 * open money/data posture. In dev/test the same secret stays optional so local
 * harnesses keep working. This locks that predicate + the exit behavior.
 *
 * Run: npx tsx --test src/config/requiredSecrets.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isProductionEnv,
  openPostureAllowed,
  missingProductionSecrets,
  assertRequiredSecrets,
} from "./requiredSecrets.js";

const REQ = [{ name: "ATTRIBUTION_WEBHOOK_SECRET", reason: "test" }];

test("P1: isProductionEnv is true only for production (case-insensitive)", () => {
  assert.equal(isProductionEnv("production"), true);
  assert.equal(isProductionEnv("PRODUCTION"), true);
  assert.equal(isProductionEnv("development"), false);
  assert.equal(isProductionEnv("test"), false);
  assert.equal(isProductionEnv(undefined), false);
});

test("BUG-SEC3: openPostureAllowed only in dev/test or with explicit opt-in", () => {
  assert.equal(openPostureAllowed({ NODE_ENV: "development" }), true);
  assert.equal(openPostureAllowed({ NODE_ENV: "test" }), true);
  // Fail CLOSED for everything else — the footgun cases.
  assert.equal(openPostureAllowed({ NODE_ENV: "production" }), false);
  assert.equal(openPostureAllowed({ NODE_ENV: "staging" }), false);
  assert.equal(openPostureAllowed({ NODE_ENV: "preview" }), false);
  assert.equal(openPostureAllowed({}), false, "unset NODE_ENV must NOT run open");
  // Explicit escape hatch.
  assert.equal(openPostureAllowed({ ALLOW_OPEN_SECRETS: "true" }), true);
  assert.equal(openPostureAllowed({ NODE_ENV: "staging", ALLOW_OPEN_SECRETS: "true" }), true);
});

test("BUG-SEC3: dev/test (or opt-in) never report missing secrets (stay open)", () => {
  assert.deepEqual(missingProductionSecrets({ NODE_ENV: "development" }, REQ), []);
  assert.deepEqual(missingProductionSecrets({ NODE_ENV: "test" }, REQ), []);
  assert.deepEqual(
    missingProductionSecrets({ NODE_ENV: "staging", ALLOW_OPEN_SECRETS: "true" }, REQ),
    [],
  );
});

test("BUG-SEC3: staging/unset NODE_ENV with the secret unset now reports it missing (fail closed)", () => {
  assert.equal(missingProductionSecrets({ NODE_ENV: "staging" }, REQ).length, 1);
  assert.equal(missingProductionSecrets({}, REQ).length, 1, "unset NODE_ENV must fail closed");
});

test("P1: production with the secret unset reports it missing", () => {
  const missing = missingProductionSecrets({ NODE_ENV: "production" }, REQ);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.name, "ATTRIBUTION_WEBHOOK_SECRET");
});

test("P1: production treats blank/whitespace as unset", () => {
  assert.equal(
    missingProductionSecrets({ NODE_ENV: "production", ATTRIBUTION_WEBHOOK_SECRET: "" }, REQ).length,
    1,
  );
  assert.equal(
    missingProductionSecrets({ NODE_ENV: "production", ATTRIBUTION_WEBHOOK_SECRET: "   " }, REQ)
      .length,
    1,
  );
});

test("P1: production with the secret set reports nothing missing", () => {
  assert.deepEqual(
    missingProductionSecrets({ NODE_ENV: "production", ATTRIBUTION_WEBHOOK_SECRET: "s3cret" }, REQ),
    [],
  );
});

test("P1: assertRequiredSecrets exits(1) in production when a required secret is unset", () => {
  let exitCode: number | null = null;
  const fakeExit = ((code: number) => {
    exitCode = code;
    // In the real process this never returns; in the test we just record it.
    return undefined as never;
  }) as (code: number) => never;

  assertRequiredSecrets({ NODE_ENV: "production" }, fakeExit);
  assert.equal(exitCode, 1);
});

test("P1: assertRequiredSecrets does NOT exit in development", () => {
  let exited = false;
  const fakeExit = ((_code: number) => {
    exited = true;
    return undefined as never;
  }) as (code: number) => never;

  assertRequiredSecrets({ NODE_ENV: "development" }, fakeExit);
  assert.equal(exited, false);
});

test("P1: assertRequiredSecrets does NOT exit in production when ALL required secrets are present", () => {
  let exited = false;
  const fakeExit = ((_code: number) => {
    exited = true;
    return undefined as never;
  }) as (code: number) => never;

  // The default production-required list now includes both the attribution
  // webhook secret (P1) and the operator key (P2) — set both.
  assertRequiredSecrets(
    {
      NODE_ENV: "production",
      ATTRIBUTION_WEBHOOK_SECRET: "s3cret",
      OPERATOR_API_KEY: "op3rator",
    },
    fakeExit,
  );
  assert.equal(exited, false);
});
