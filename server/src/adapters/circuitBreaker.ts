// ---------------------------------------------------------------------------
// Circuit breaker (FIX-9)
// ---------------------------------------------------------------------------
// A minimal, dependency-free circuit breaker for the agent-service calls.
//
// Why: the audit's Reliability Review found that a failing/slow agent service is
// "hammered on every job" with "no open-circuit, no shed-load", and that an
// outage strands instances at REPLY_RECEIVED. The breaker turns repeated
// failures into a fast, cheap rejection so the orchestration layer can degrade
// gracefully (classify → UNKNOWN → MANUAL_REVIEW; negotiate → ESCALATE →
// MANUAL_REVIEW) instead of retrying a dead backend to exhaustion.
//
// States:
//   closed    — calls pass through. Consecutive failures are counted; on the
//               Nth the breaker opens.
//   open      — calls fail fast (throw OpenCircuitError) without touching the
//               network, until `cooldownMs` has elapsed since it opened.
//   half-open — after the cooldown, the next single call is allowed through as a
//               probe. Success closes the breaker; failure re-opens it.
//
// The time source is injectable so it can be unit-tested without sleeping.

export class OpenCircuitError extends Error {
  constructor(name: string) {
    super(`circuit "${name}" is open — agent service is failing, shedding load`);
    this.name = "OpenCircuitError";
  }
}

type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker from closed → open. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a half-open probe (ms). */
  cooldownMs?: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(name: string, opts: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** Current state, transitioning open → half-open when the cooldown elapses. */
  currentState(): BreakerState {
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /**
   * Run `fn` under the breaker. Throws OpenCircuitError immediately if the
   * circuit is open (and the cooldown has not elapsed). Records success/failure
   * to drive the state transitions.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();
    if (state === "open") {
      throw new OpenCircuitError(this.name);
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    // A failure while probing (half-open) re-opens immediately; otherwise open
    // once the consecutive-failure threshold is reached.
    if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  /** Test/ops helper: force the breaker back to a clean closed state. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}
