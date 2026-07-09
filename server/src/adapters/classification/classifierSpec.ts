import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Shared classification-gate spec loader (MED-A2)
// ---------------------------------------------------------------------------
// Loads shared/classifier-spec.json — the SINGLE SOURCE OF TRUTH for the
// deterministic classification gates — and compiles it into RegExps + the gate
// order. The Python production classifier (agent/app/injection.py) uses the same
// spec's patterns/order, and both sides run the spec's `fixture` as a parity
// test, so the TS mock can no longer drift silently from Python (the audit's
// MED-A2 finding: the mock was a hand-maintained mirror → guaranteed drift).
//
// Read at RUNTIME (not a compile-time JSON import) because the spec lives OUTSIDE
// server/src (rootDir), so a static import would violate the TS rootDir/outDir
// layout. Resolving relative to this module's URL works in both tsx (dev) and the
// compiled dist build.

export interface ClassifierSpec {
  version: string;
  order: string[];
  gates: Record<string, GateSpec>;
  fixture: FixtureCase[];
}

interface GateSpec {
  flags: string;
  patterns: string[];
  amount?: string;
}

export interface FixtureCase {
  text: string;
  /** The gate expected to fire: "opt_out" | "injection" | "rate" | "question" | "none". */
  gate: string;
}

/** Absolute path to shared/classifier-spec.json (repo root /shared). */
function specPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dev (tsx):   <repo>/server/src/adapters/classification → up 4 to <repo>
  // build (dist):<repo>/server/dist/adapters/classification → up 4 to <repo>
  return path.resolve(here, "..", "..", "..", "..", "shared", "classifier-spec.json");
}

let _cached: ClassifierSpec | null = null;

/** Load + cache the raw spec JSON. */
export function loadClassifierSpec(): ClassifierSpec {
  if (_cached) return _cached;
  const raw = readFileSync(specPath(), "utf8");
  _cached = JSON.parse(raw) as ClassifierSpec;
  return _cached;
}

/** Expand the `__AMOUNT__` placeholder + compile a gate's patterns into RegExps. */
export function compileGate(gate: GateSpec): RegExp[] {
  return gate.patterns.map((p) => {
    const src = gate.amount ? p.replace(/__AMOUNT__/g, gate.amount) : p;
    return new RegExp(src, gate.flags);
  });
}

/**
 * The compiled gate set, mirroring the Python gate order + patterns. `rejection`
 * suppresses the rate/question gates (a price/question inside a refusal is not
 * engagement) — identical to agent/app/injection.py's _REJECTION_RE handling.
 */
export interface CompiledGates {
  order: string[];
  optOut: RegExp[];
  injection: RegExp[];
  rejection: RegExp[];
  rate: RegExp[];
  question: RegExp[];
}

let _compiled: CompiledGates | null = null;

export function compiledGates(): CompiledGates {
  if (_compiled) return _compiled;
  const spec = loadClassifierSpec();
  _compiled = {
    order: spec.order,
    optOut: compileGate(spec.gates["opt_out"]!),
    injection: compileGate(spec.gates["injection"]!),
    rejection: compileGate(spec.gates["rejection"]!),
    rate: compileGate(spec.gates["rate"]!),
    question: compileGate(spec.gates["question"]!),
  };
  return _compiled;
}

/**
 * Deterministic opt-out gate over the shared spec patterns (MED-W1).
 *
 * Used by the reply handlers that DON'T go through the first-reply classifier
 * (mid-negotiation short-circuit, reward/payment replies, creator noise while
 * AWAITING_BRAND_DECISION) so "unsubscribe" / "stop emailing me" is honored on
 * EVERY inbound, not only on round 0. Compliance-critical (CAN-SPAM): this is
 * code, not a model call, so nothing can suppress it. Same normalization subset
 * as the Python sanitizer so both sides see the same text.
 */
export function looksLikeOptOut(text: string): boolean {
  const clean = (text ?? "").normalize("NFKC").slice(0, 4000);
  return compiledGates().optOut.some((re) => re.test(clean));
}
