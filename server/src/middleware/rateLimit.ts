import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Rate limiting (BUG-SEC1)
// ---------------------------------------------------------------------------
// The audit found NO rate limiting on any public Express route (30 rapid
// /health all 200) → token brute-force with no lockout + a cheap DoS surface.
// This module builds two buckets:
//
//   - a GLOBAL default limiter mounted on every request (generous — it only
//     catches abusive floods), and
//   - a TIGHTER public limiter for the creator-magic-link / webhook / redirect /
//     attribution routes (/webhooks, /payment, /t, /attribution, /payout), which
//     are the unauthenticated, token-guessable surface.
//
// Both return a clean 429 JSON body (never the express-rate-limit default text).
// Every limit is env-tunable with sane defaults; set the *_MAX to 0 to DISABLE a
// bucket (useful for load tests / local dev), matching the AGENT_RATE_LIMIT=0
// convention on the agent side.

/** Parse a non-negative integer env var, falling back to `fallback` when unset,
 *  empty, or not a valid finite non-negative number. */
export function envInt(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Shared 429 JSON responder — no stack, no internals, just a clean message. */
function tooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({ error: "too many requests, please slow down" });
}

/**
 * Config resolved from the environment. Exported (and pure) so it can be unit
 * tested without constructing Express middleware.
 *
 *   RATE_LIMIT_WINDOW_MS     global bucket window (default 60_000 = 1 min)
 *   RATE_LIMIT_MAX           global bucket max requests / window (default 300)
 *   PUBLIC_RATE_LIMIT_WINDOW_MS  public bucket window (default 60_000)
 *   PUBLIC_RATE_LIMIT_MAX    public bucket max requests / window (default 60)
 *
 * A *_MAX of 0 disables that bucket.
 */
export interface RateLimitConfig {
  globalWindowMs: number;
  globalMax: number;
  publicWindowMs: number;
  publicMax: number;
}

export function resolveRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return {
    globalWindowMs: envInt(env["RATE_LIMIT_WINDOW_MS"], 60_000),
    globalMax: envInt(env["RATE_LIMIT_MAX"], 300),
    publicWindowMs: envInt(env["PUBLIC_RATE_LIMIT_WINDOW_MS"], 60_000),
    publicMax: envInt(env["PUBLIC_RATE_LIMIT_MAX"], 60),
  };
}

// A no-op passthrough used when a bucket is disabled (*_MAX = 0), so callers can
// always mount the returned handler unconditionally.
const passthrough: RateLimitRequestHandler = ((
  _req: Request,
  _res: Response,
  next: NextFunction,
) => next()) as unknown as RateLimitRequestHandler;

function buildLimiter(windowMs: number, max: number): RateLimitRequestHandler {
  if (max <= 0) return passthrough;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // RateLimit-* headers
    legacyHeaders: false, // no X-RateLimit-* headers
    handler: tooManyRequests,
  });
}

/** The generous global bucket, mounted on every request. */
export function globalRateLimiter(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitRequestHandler {
  const cfg = resolveRateLimitConfig(env);
  return buildLimiter(cfg.globalWindowMs, cfg.globalMax);
}

/** The tighter bucket for the unauthenticated public/magic-link/webhook routes. */
export function publicRateLimiter(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitRequestHandler {
  const cfg = resolveRateLimitConfig(env);
  return buildLimiter(cfg.publicWindowMs, cfg.publicMax);
}
