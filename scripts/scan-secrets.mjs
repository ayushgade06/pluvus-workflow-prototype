#!/usr/bin/env node
// ---------------------------------------------------------------------------
// P10 — secret scanner (single-operator go-live)
// ---------------------------------------------------------------------------
// Real secrets belong only in the gitignored .env / the deploy platform's
// secret store — NEVER in a tracked file. This script scans every git-TRACKED
// file for values that look like live secrets (provider key prefixes, a Postgres
// DSN with an inline password, a populated SECRET/KEY/TOKEN assignment) so a
// leak is caught before it's pushed. Run it manually, in CI, or as a pre-commit
// hook.
//
//   node scripts/scan-secrets.mjs         # scan tracked files, exit 1 on a hit
//
// It scans `git ls-files` output, so untracked files (your real .env) are never
// read — by design. .env.example / web/.env.example are tracked and ARE scanned;
// they must stay placeholder-only, which is the point.
//
// Zero dependencies (Node built-ins only) so it runs anywhere with no install.

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// Patterns that indicate a REAL secret value (not a placeholder). Each entry:
//   { id, re, note } — re must match the concrete value, not just the key name.
const SECRET_PATTERNS = [
  {
    id: "nylas_api_key",
    re: /nyk_v0_[A-Za-z0-9]{20,}/,
    note: "Nylas API key",
  },
  {
    id: "postgres_dsn_with_password",
    // postgres(ql)://user:<non-empty, non-placeholder password>@host
    re: /postgres(?:ql)?:\/\/[^:\s'"]+:(?!password\b|user\b|<)[^@\s'"]{6,}@/,
    note: "Postgres connection string with an inline password",
  },
  {
    id: "openai_or_openrouter_key",
    re: /sk-(?:or-)?[A-Za-z0-9]{20,}/,
    note: "OpenAI / OpenRouter-style secret key",
  },
  {
    id: "anthropic_key",
    re: /sk-ant-[A-Za-z0-9-]{20,}/,
    note: "Anthropic API key",
  },
  {
    id: "aws_access_key",
    re: /AKIA[0-9A-Z]{16}/,
    note: "AWS access key id",
  },
  {
    id: "populated_secret_assignment",
    // A *_KEY/_SECRET/_TOKEN/_PASSWORD assigned a real-looking OPAQUE value —
    // either an env-file line `KEY=abc123...` (no spaces, no dots) or a quoted
    // string literal `KEY = "abc123..."`. Deliberately NOT matching:
    //   - empty / placeholder values (=, ="", =<...>, =your-…, =xxx, =changeme…)
    //   - code that READS a secret from env (value starts with an identifier and
    //     a `.`/`(`, e.g. `= process.env.X`, `= envFile.X`, `= getSecret()`), or
    //     references `process` / `.env` / `import.meta` — those aren't leaks.
    // The negative lookahead after the assignment op rejects the code-expression
    // and placeholder cases before the opaque-value alternation.
    re: /(?:_KEY|_SECRET|_TOKEN|_PASSWORD)\s*[=:]\s*(?!\s*$|["'`]\s*$|<|your[-_]|xxx|changeme|placeholder|example|process\b|import\.meta|env\.|require\b|[A-Za-z_$][A-Za-z0-9_$]*\s*[.(])(?:["'`][A-Za-z0-9_\-./+]{16,}|[A-Za-z0-9_\-/+]{16,}\s*$)/,
    note: "a populated *_KEY/_SECRET/_TOKEN/_PASSWORD assignment",
  },
];

// Files/paths to skip even though tracked (lockfiles, this scanner's own pattern
// list, binaries). Lockfile hashes trip the generic assignment rule and are not
// secrets.
const SKIP = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)scripts\/scan-secrets\.mjs$/,
];

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|node)$/i;
const MAX_BYTES = 512 * 1024; // don't slurp huge files

function trackedFiles() {
  const out = execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function shouldScan(path) {
  if (SKIP.some((re) => re.test(path))) return false;
  if (BINARY_EXT.test(path)) return false;
  try {
    if (statSync(path).size > MAX_BYTES) return false;
  } catch {
    return false; // deleted / unreadable
  }
  return true;
}

function main() {
  const files = trackedFiles();
  const findings = [];

  for (const path of files) {
    if (!shouldScan(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) {
          findings.push({ path, line: i + 1, id: p.id, note: p.note, text: line.trim().slice(0, 120) });
        }
      }
    });
  }

  if (findings.length === 0) {
    console.log(`✓ scan-secrets: no secrets found in ${files.length} tracked files.`);
    process.exit(0);
  }

  console.error(`✗ scan-secrets: ${findings.length} possible secret(s) in TRACKED files:\n`);
  for (const f of findings) {
    console.error(`  ${f.path}:${f.line}  [${f.id}] ${f.note}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    "\nMove the value into the gitignored .env / the deploy secret store, replace it " +
      "with a placeholder here, and ROTATE it (it may already be in git history).",
  );
  process.exit(1);
}

main();
