import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import type { PayoutMethod } from "../db/schema.js";
import { findPaymentInfoByToken, findInstanceById } from "../db/index.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import {
  renderPaymentFormPage,
  renderPaymentThankYouPage,
  renderPaymentAlreadySubmittedPage,
  renderPaymentInvalidPage,
  PAYOUT_METHODS,
} from "./paymentPage.js";

// ---------------------------------------------------------------------------
// Hosted payout-information page (Payment Info node)
// ---------------------------------------------------------------------------
// GET  /payment/:token  — renders the payout form (or a notice if already done)
// POST /payment/:token  — stores the payout info and hands control back to the
//                         workflow engine (runtime.handlePaymentSubmission),
//                         which advances PAYMENT_PENDING → PAYMENT_RECEIVED and
//                         resumes into the next connected node.
//
// The token is the only credential (prototype scope): it resolves to exactly one
// ExecutionInstance. There is no auth, no payment integration, no verification.

const router = Router();

// Form posts are application/x-www-form-urlencoded. The global express.json()
// (index.ts) doesn't parse that, so parse it here for this router only.
router.use(urlencoded({ extended: false }));

const VALID_METHODS = new Set(PAYOUT_METHODS.map((m) => m.value));

// EASY-W3: the payout is truly FINALIZED only when the PaymentInfo row is
// PAYMENT_RECEIVED **and** the instance has advanced past PAYMENT_PENDING.
//
// The bug this fixes: handlePaymentSubmission flips PaymentInfo.status →
// PAYMENT_RECEIVED BEFORE the OCC step (executePaymentSubmission requires the row
// to already read PAYMENT_RECEIVED). If that step then threw non-stale, the row
// was PAYMENT_RECEIVED but the instance stayed stuck in PAYMENT_PENDING with no
// recovery — and because the form showed "already submitted" on row status alone,
// the creator could never re-submit to unstick it. The payout was bricked.
//
// Keying the "already submitted" notice on BOTH conditions means that a
// row-received-but-instance-still-pending state re-renders the FORM (not the
// notice), so a re-submit re-runs the idempotent step and advances the instance —
// self-recovery. (PAYMENT_PENDING is a waiting state the HARD-R1 reconciliation
// sweep deliberately does NOT re-enqueue, so the re-submit is the recovery path.)
export function isPayoutFinalized(
  payment: NonNullable<Awaited<ReturnType<typeof findPaymentInfoByToken>>>,
): boolean {
  return (
    payment.status === "PAYMENT_RECEIVED" &&
    payment.instance.currentState !== "PAYMENT_PENDING"
  );
}

// MED-S5: a payout token is a bearer capability, so an UNSUBMITTED link past its
// expiresAt no longer works (a leaked/forwarded link can't collect payout info
// forever). Scoped to still-pending rows on purpose: once the creator has
// submitted (status PAYMENT_RECEIVED), expiry never blocks the idempotent
// "already submitted" notice — nor the EASY-W3 stuck-instance re-submit
// recovery, which must stay available. Rows minted before the column existed
// have expiresAt null → no expiry (grandfathered).
export function isPaymentTokenExpired(
  payment: NonNullable<Awaited<ReturnType<typeof findPaymentInfoByToken>>>,
  now: Date = new Date(),
): boolean {
  return (
    payment.status === "PAYMENT_PENDING" &&
    payment.expiresAt !== null &&
    payment.expiresAt.getTime() <= now.getTime()
  );
}

// Resolve the brand name for the page from the payment row's joined relations,
// falling back gracefully when a campaign isn't linked.
function brandNameOf(
  payment: Awaited<ReturnType<typeof findPaymentInfoByToken>>,
): string {
  return payment?.instance.workflowVersion.workflow.campaign?.brand ?? "Your brand";
}

// Whether this campaign ships a physical product — read off the (stamped) config
// of the payout-collection node in the immutable version's nodeGraph. That is the
// CONTENT_BRIEF node in the merged flow, or the legacy PAYMENT_INFO node. This is
// the authoritative gate for the shipping-address section: the flag is stamped
// into every node by restampBrand, and reading it from the version (not the
// mutable campaign) keeps the hosted form pinned to what was published. Exported
// so the verification harness can assert the gate against a real payment row.
export function shipsPhysicalProductOf(
  payment: Awaited<ReturnType<typeof findPaymentInfoByToken>>,
): boolean {
  const graph = payment?.instance.workflowVersion.nodeGraph;
  if (!Array.isArray(graph)) return false;
  for (const n of graph) {
    if (!n || typeof n !== "object" || Array.isArray(n)) continue;
    const node = n as Record<string, unknown>;
    if (node["type"] !== "PAYMENT_INFO" && node["type"] !== "CONTENT_BRIEF") continue;
    const config =
      node["config"] && typeof node["config"] === "object"
        ? (node["config"] as Record<string, unknown>)
        : {};
    return config["shipsPhysicalProduct"] === true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /payment/:token — render the form
// ---------------------------------------------------------------------------

router.get("/:token", async (req: Request, res: Response) => {
  try {
    const token = req.params["token"]!;
    const payment = await findPaymentInfoByToken(token);
    if (!payment) {
      res.status(404).type("html").send(renderPaymentInvalidPage());
      return;
    }

    const creatorName = payment.instance.creator.name;
    const brandName = brandNameOf(payment);

    // Already submitted — show the idempotent notice rather than a fresh form.
    // EASY-W3: only when the payout is truly finalized (row received AND instance
    // advanced). A row-received-but-instance-stuck state falls through to re-render
    // the form so the creator can re-submit and unstick the run.
    if (isPayoutFinalized(payment)) {
      res
        .type("html")
        .send(renderPaymentAlreadySubmittedPage({ creatorName, brandName }));
      return;
    }

    // MED-S5: an unsubmitted token past its lifecycle no longer renders the form.
    if (isPaymentTokenExpired(payment)) {
      res.status(410).type("html").send(renderPaymentInvalidPage());
      return;
    }

    const showShippingAddress = shipsPhysicalProductOf(payment);
    res
      .type("html")
      .send(renderPaymentFormPage({ token, creatorName, brandName, showShippingAddress }));
  } catch (err) {
    console.error("[payment] get error:", err);
    res.status(500).type("html").send(renderPaymentInvalidPage());
  }
});

// ---------------------------------------------------------------------------
// POST /payment/:token — store payout info + resume the workflow
// ---------------------------------------------------------------------------

router.post("/:token", async (req: Request, res: Response) => {
  const token = req.params["token"]!;
  try {
    const payment = await findPaymentInfoByToken(token);
    if (!payment) {
      res.status(404).type("html").send(renderPaymentInvalidPage());
      return;
    }

    const creatorName = payment.instance.creator.name;
    const brandName = brandNameOf(payment);

    // Idempotent: a re-POST of an already-FINALIZED link is a no-op success.
    // EASY-W3: "finalized" now requires the instance to have advanced too, so a
    // re-POST after a row-received-but-instance-stuck failure is NOT short-
    // circuited here — it proceeds to re-run handlePaymentSubmission, which
    // idempotently re-persists the (already PAYMENT_RECEIVED) row and re-steps the
    // node, this time advancing the instance and unsticking the payout.
    if (isPayoutFinalized(payment)) {
      res
        .type("html")
        .send(renderPaymentAlreadySubmittedPage({ creatorName, brandName }));
      return;
    }

    // MED-S5: reject a submission on an expired, unsubmitted token — checked on
    // POST too so a form loaded before expiry can't be submitted after it.
    if (isPaymentTokenExpired(payment)) {
      res.status(410).type("html").send(renderPaymentInvalidPage());
      return;
    }

    const showShippingAddress = shipsPhysicalProductOf(payment);

    // ── Validate the submission ────────────────────────────────────────────
    const body = req.body as Record<string, unknown>;
    const str = (key: string): string =>
      typeof body[key] === "string" ? (body[key] as string).trim() : "";
    const method = str("method");
    const accountIdentifier = str("accountIdentifier");
    const country = str("country") || null;
    const notes = str("notes") || null;

    // Shipping fields are only read when the campaign ships a product. When the
    // flag is off we ignore any submitted address fields (anti-spoof).
    const ship = showShippingAddress
      ? {
          name: str("shipName"),
          line1: str("shipLine1"),
          line2: str("shipLine2"),
          city: str("shipCity"),
          region: str("shipRegion"),
          postalCode: str("shipPostalCode"),
          country: str("shipCountry"),
        }
      : null;

    const values = {
      method,
      accountIdentifier,
      country: country ?? "",
      notes: notes ?? "",
      shipName: ship?.name ?? "",
      shipLine1: ship?.line1 ?? "",
      shipLine2: ship?.line2 ?? "",
      shipCity: ship?.city ?? "",
      shipRegion: ship?.region ?? "",
      shipPostalCode: ship?.postalCode ?? "",
      shipCountry: ship?.country ?? "",
    };
    const rejectWith = (error: string) =>
      res
        .status(400)
        .type("html")
        .send(
          renderPaymentFormPage({
            token,
            creatorName,
            brandName,
            showShippingAddress,
            error,
            values,
          }),
        );

    if (!VALID_METHODS.has(method)) {
      rejectWith("Please choose a payout method.");
      return;
    }
    if (!accountIdentifier) {
      rejectWith("Please enter your account identifier or email.");
      return;
    }
    // Require the minimum shippable set when collecting an address. line2/region
    // are optional (not every locale uses them).
    if (ship) {
      if (!ship.name || !ship.line1 || !ship.city || !ship.postalCode || !ship.country) {
        rejectWith(
          "Please complete your shipping address (name, address, city, postal code, and country).",
        );
        return;
      }
    }

    // ── Hand control back to the workflow engine ───────────────────────────
    // handlePaymentSubmission persists the payout fields, then steps the node:
    // PAYMENT_PENDING → PAYMENT_RECEIVED, exposing the output connection so the
    // engine resumes into the next connected node. We do NOT execute the next
    // node ourselves.
    const runtime = new WorkflowRuntime(emailProvider(), agentProvider());
    try {
      await runtime.handlePaymentSubmission(
        payment.instanceId,
        {
          method: method as PayoutMethod,
          accountIdentifier,
          country,
          notes,
          // Persist the shipping address under PaymentInfo.extra (no schema
          // change) only when we actually collected one.
          ...(ship ? { extra: { shipping: ship } } : {}),
        },
        { source: "payment-form", worker: "payment-route" },
      );
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        // A concurrent submission already advanced the instance — treat this
        // POST as a successful (idempotent) duplicate.
        res
          .type("html")
          .send(renderPaymentAlreadySubmittedPage({ creatorName, brandName }));
        return;
      }
      // Wrong-state (e.g. not PAYMENT_PENDING) or other error — surface a friendly
      // message rather than a stack trace.
      console.error("[payment] submission error:", err);
      rejectWith("We couldn't record your submission. Please try again in a moment.");
      return;
    }

    // ── Auto-chain into Content Brief (legacy Payment Info graphs only) ───────
    // In the MERGED flow the Content Brief node owns PAYMENT_PENDING, so
    // handlePaymentSubmission steps it straight to CONTENT_BRIEF_SENT (terminal)
    // and this block no-ops (currentState is not PAYMENT_RECEIVED). In LEGACY
    // graphs the Payment Info node advances to PAYMENT_RECEIVED here (the payment
    // route), NOT via a node-execution job, so the node-execution worker's
    // auto-chain never sees it — exactly like the reward reply in the inbound
    // worker. Enqueue the Content Brief step so a completed payout flows straight
    // into the campaign-brief email (guarded for legacy graphs without a
    // CONTENT_BRIEF node, which leave PAYMENT_RECEIVED terminal). Best-effort: the
    // payout is already recorded and the creator has seen the thank-you page, so a
    // failure to enqueue must not fail the POST.
    try {
      const after = await findInstanceById(payment.instanceId);
      if (
        after?.currentState === "PAYMENT_RECEIVED" &&
        (await runtime.contentBriefApplies(payment.instanceId))
      ) {
        await enqueueNodeExecution({
          instanceId: payment.instanceId,
          expectedState: "PAYMENT_RECEIVED",
          triggerRef: `auto-content-brief-${payment.instanceId}`,
        });
        console.log(
          `[payment] auto-enqueued content-brief step for ${payment.instanceId} (PAYMENT_RECEIVED)`,
        );
      }
    } catch (err) {
      console.error("[payment] content-brief enqueue error (non-fatal):", err);
    }

    res.type("html").send(renderPaymentThankYouPage({ creatorName, brandName }));
  } catch (err) {
    console.error("[payment] post error:", err);
    res.status(500).type("html").send(renderPaymentInvalidPage());
  }
});

export default router;
