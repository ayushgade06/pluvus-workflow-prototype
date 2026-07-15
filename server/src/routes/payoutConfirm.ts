import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import {
  appendEvent,
  findCreatorById,
  findInstanceById,
  findPayoutById,
  loadPayoutContextByPartnership,
  markPayoutConfirmed,
  markPayoutDisputed,
  type PayoutContext,
} from "../db/index.js";
import type { JsonObject, Payout } from "../db/schema.js";
import { emailProvider } from "../engine/providerFactory.js";
import { sendOnce } from "../engine/executors/idempotentSend.js";
import { resolveBrandRecipient } from "../notifications/escalation.js";
import { renderPayoutDisputedEmail } from "../engine/executors/payoutDisputedEmail.js";
import {
  isPayoutTokenExpired,
  payoutTokenMatches,
} from "../engine/executors/payoutToken.js";
import {
  renderPayoutAlreadyActionedPage,
  renderPayoutConfirmedPage,
  renderPayoutDisputedPage,
  renderPayoutExpiredPage,
  renderPayoutInterstitialPage,
  renderPayoutInvalidPage,
} from "./payoutConfirmPage.js";

// ---------------------------------------------------------------------------
// Creator-facing payout confirm/dispute — public, magic-link-gated (Phase 3).
// Mounted at /payout.
//
//   GET  /payout/confirm/:payoutId?token=…   renders the confirm interstitial
//   GET  /payout/dispute/:payoutId?token=…   renders the dispute interstitial
//   POST /payout/confirm/:payoutId           SENT → SETTLED (creator confirmed)
//   POST /payout/dispute/:payoutId           SENT → DISPUTED + emails the brand
//
// I-5: GET NEVER MUTATES — it only renders an interstitial whose button POSTs.
// Mail-scanner prefetch fires GETs, so a GET that settled a payout would settle
// it the instant the email landed. The parent's GET-mutation is the anti-pattern
// deliberately NOT ported here.
// ---------------------------------------------------------------------------

const router = Router();

// The POST carries the token in a hidden urlencoded form field.
router.use(urlencoded({ extended: false }));

type Action = "confirm" | "dispute";

/** First x-forwarded-for hop (or req.ip), for the confirm/dispute audit trail. */
function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.ip ?? null;
}

function clientUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua.length > 0 ? ua : null;
}

/**
 * Shared guard resolution used by BOTH the GET (render) and POST (mutate) paths,
 * so they agree exactly on what "valid / expired / already-actioned" means. This
 * function performs NO writes — the caller decides whether to render or mutate.
 */
async function resolveGuard(
  payoutId: string,
  presentedToken: string | undefined,
): Promise<
  | { kind: "invalid" }
  | { kind: "expired"; ctx: PayoutContext | null }
  | { kind: "already"; payout: Payout; ctx: PayoutContext | null }
  | { kind: "ok"; payout: Payout; ctx: PayoutContext }
> {
  const payout = await findPayoutById(payoutId);
  if (!payout) return { kind: "invalid" };

  // Token must match the stored hash (timing-safe). Absent/mismatch → invalid,
  // with no detail (404 semantics).
  if (!payoutTokenMatches(presentedToken, payout.confirmTokenHash)) {
    return { kind: "invalid" };
  }

  const ctx = await loadPayoutContextByPartnership(payout.partnershipId);

  // Expired token → friendly "contact brand" page (only meaningful while SENT).
  if (payout.status === "SENT" && isPayoutTokenExpired(payout.confirmTokenExpiresAt)) {
    return { kind: "expired", ctx };
  }

  // Not SENT → already confirmed/disputed/settled. A mail-prefetch of the OTHER
  // link after acting must be a safe no-op notice.
  if (payout.status !== "SENT") {
    return { kind: "already", payout, ctx };
  }

  if (!ctx) return { kind: "invalid" };
  return { kind: "ok", payout, ctx };
}

type Guard = Awaited<ReturnType<typeof resolveGuard>>;

/**
 * Render the response for any non-"ok" guard outcome (invalid → 404, expired →
 * 410, already-actioned → idempotent notice). Returns true if it handled the
 * response. Shared by the GET render path and BOTH POST mutate paths so all
 * three agree exactly on what invalid/expired/already looks like.
 */
function respondForNonOkGuard(res: Response, guard: Guard): boolean {
  switch (guard.kind) {
    case "invalid":
      res.status(404).type("html").send(renderPayoutInvalidPage());
      return true;
    case "expired":
      res
        .status(410)
        .type("html")
        .send(renderPayoutExpiredPage({ brandName: guard.ctx?.brandName ?? null }));
      return true;
    case "already":
      res.type("html").send(
        renderPayoutAlreadyActionedPage({
          brandName: guard.ctx?.brandName ?? "Your brand",
          status: guard.payout.status,
        }),
      );
      return true;
    default:
      return false; // "ok" — caller renders/mutates
  }
}

// ── GET interstitial (renders only, never mutates) ──────────────────────────
function registerGet(action: Action): void {
  router.get(`/${action}/:payoutId`, async (req: Request, res: Response) => {
    try {
      const payoutId = req.params["payoutId"]!;
      const token = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
      const guard = await resolveGuard(payoutId, token);
      if (respondForNonOkGuard(res, guard)) return;
      if (guard.kind !== "ok") return; // narrows guard for the compiler (unreachable)

      // guard.kind === "ok": render the interstitial (NO write — I-5).
      res.type("html").send(
        renderPayoutInterstitialPage({
          payoutId,
          token: token!,
          creatorName: guard.ctx.creatorName,
          brandName: guard.ctx.brandName ?? "Your brand",
          amountCents: guard.payout.amountCents,
          currency: guard.payout.currency,
          reference: guard.payout.reference,
          action,
        }),
      );
    } catch (err) {
      console.error(`[payoutConfirm] GET ${action} error:`, err);
      res.status(500).type("html").send(renderPayoutInvalidPage());
    }
  });
}

registerGet("confirm");
registerGet("dispute");

// ── POST confirm — SENT → SETTLED ───────────────────────────────────────────
router.post("/confirm/:payoutId", async (req: Request, res: Response) => {
  try {
    const payoutId = req.params["payoutId"]!;
    const token = tokenFromBody(req);
    const guard = await resolveGuard(payoutId, token);
    if (respondForNonOkGuard(res, guard)) return;
    if (guard.kind !== "ok") return; // narrows guard for the compiler (unreachable)

    // guard.kind === "ok": mutate. markPayoutConfirmed's WHERE requires SENT, so
    // a concurrent confirm/dispute makes this a no-op → treat as already-actioned.
    const updated = await markPayoutConfirmed(payoutId, {
      confirmIp: clientIp(req),
      confirmUserAgent: clientUserAgent(req),
    });
    if (!updated) {
      const latest = await findPayoutById(payoutId);
      res.type("html").send(
        renderPayoutAlreadyActionedPage({
          brandName: guard.ctx.brandName ?? "Your brand",
          status: latest?.status ?? "SETTLED",
        }),
      );
      return;
    }

    // confirm short-circuits to SETTLED (parent semantics), so append BOTH
    // PAYOUT_CONFIRMED and PAYOUT_SETTLED (I-7), best-effort (I-8).
    await appendLedgerEvent(guard.ctx.instanceId, "PAYOUT_CONFIRMED", {
      payoutId,
      amountCents: updated.amountCents,
    });
    await appendLedgerEvent(guard.ctx.instanceId, "PAYOUT_SETTLED", {
      payoutId,
      resolvedBy: "creator-confirm",
    });

    res.type("html").send(
      renderPayoutConfirmedPage({
        creatorName: guard.ctx.creatorName,
        brandName: guard.ctx.brandName ?? "Your brand",
        amountCents: updated.amountCents,
        currency: updated.currency,
      }),
    );
  } catch (err) {
    console.error("[payoutConfirm] POST confirm error:", err);
    res.status(500).type("html").send(renderPayoutInvalidPage());
  }
});

// ── POST dispute — SENT → DISPUTED + email the brand ────────────────────────
router.post("/dispute/:payoutId", async (req: Request, res: Response) => {
  try {
    const payoutId = req.params["payoutId"]!;
    const token = tokenFromBody(req);
    const guard = await resolveGuard(payoutId, token);
    if (respondForNonOkGuard(res, guard)) return;
    if (guard.kind !== "ok") return; // narrows guard for the compiler (unreachable)

    const updated = await markPayoutDisputed(payoutId, {
      confirmIp: clientIp(req),
      confirmUserAgent: clientUserAgent(req),
    });
    if (!updated) {
      const latest = await findPayoutById(payoutId);
      res.type("html").send(
        renderPayoutAlreadyActionedPage({
          brandName: guard.ctx.brandName ?? "Your brand",
          status: latest?.status ?? "DISPUTED",
        }),
      );
      return;
    }

    await appendLedgerEvent(guard.ctx.instanceId, "PAYOUT_DISPUTED", {
      payoutId,
      amountCents: updated.amountCents,
    });

    // Email the brand (idempotent, I-6). Non-fatal — the dispute is recorded
    // regardless of whether the notice lands.
    await emailBrandOfDispute(guard.ctx, updated);

    res.type("html").send(
      renderPayoutDisputedPage({
        creatorName: guard.ctx.creatorName,
        brandName: guard.ctx.brandName ?? "Your brand",
      }),
    );
  } catch (err) {
    console.error("[payoutConfirm] POST dispute error:", err);
    res.status(500).type("html").send(renderPayoutInvalidPage());
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenFromBody(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const t = body?.["token"];
  return typeof t === "string" ? t : undefined;
}

async function appendLedgerEvent(
  instanceId: string,
  type: "PAYOUT_CONFIRMED" | "PAYOUT_DISPUTED" | "PAYOUT_SETTLED",
  payload: JsonObject,
): Promise<void> {
  try {
    await appendEvent({ instanceId, type, payload });
  } catch (err) {
    console.error(`[payoutConfirm] ${type} event append failed (non-fatal)`, err);
  }
}

/**
 * Email the brand that the creator disputed the payout. Recipient precedence is
 * the Phase-11 chain: campaign.notifyEmail → BRAND_NOTIFY_EMAIL → operator
 * (resolveBrandRecipient). Idempotent via sendOnce (payout:disputed:{id}).
 */
async function emailBrandOfDispute(ctx: PayoutContext, payout: Payout): Promise<void> {
  try {
    const recipient = resolveBrandRecipient(ctx.campaignNotifyEmail);
    if (!recipient) return;

    const inst = await findInstanceById(ctx.instanceId);
    if (!inst) return;
    const creator = await findCreatorById(inst.creatorId);
    if (!creator) return;

    const draft = renderPayoutDisputedEmail({
      creatorName: ctx.creatorName,
      brandName: ctx.brandName ?? "Your brand",
      amountCents: payout.amountCents,
      currency: payout.currency,
      reference: payout.reference,
      payoutId: payout.id,
    });

    // Address the brand via an explicit recipient (the creator is the thread
    // owner); keyed so a mail-prefetch double-POST can't double-notify.
    await sendOnce(
      emailProvider(),
      ctx.instanceId,
      creator,
      draft,
      `payout:disputed:${payout.id}`,
      undefined,
      { email: recipient, name: ctx.brandName ?? "Brand" },
    );
  } catch (err) {
    console.error("[payoutConfirm] dispute brand-email failed (non-fatal)", err);
  }
}

export default router;
