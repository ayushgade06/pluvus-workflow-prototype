import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import type { PayoutMethod } from "@prisma/client";
import { findPaymentInfoByToken } from "../db/index.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
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

// Resolve the brand name for the page from the payment row's joined relations,
// falling back gracefully when a campaign isn't linked.
function brandNameOf(
  payment: Awaited<ReturnType<typeof findPaymentInfoByToken>>,
): string {
  return payment?.instance.workflowVersion.workflow.campaign?.brand ?? "Your brand";
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
    if (payment.status === "PAYMENT_RECEIVED") {
      res
        .type("html")
        .send(renderPaymentAlreadySubmittedPage({ creatorName, brandName }));
      return;
    }

    res.type("html").send(renderPaymentFormPage({ token, creatorName, brandName }));
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

    // Idempotent: a re-POST of an already-submitted link is a no-op success.
    if (payment.status === "PAYMENT_RECEIVED") {
      res
        .type("html")
        .send(renderPaymentAlreadySubmittedPage({ creatorName, brandName }));
      return;
    }

    // ── Validate the submission ────────────────────────────────────────────
    const body = req.body as Record<string, unknown>;
    const method = typeof body["method"] === "string" ? body["method"].trim() : "";
    const accountIdentifier =
      typeof body["accountIdentifier"] === "string" ? body["accountIdentifier"].trim() : "";
    const country =
      typeof body["country"] === "string" && body["country"].trim() ? body["country"].trim() : null;
    const notes =
      typeof body["notes"] === "string" && body["notes"].trim() ? body["notes"].trim() : null;

    const values = { method, accountIdentifier, country: country ?? "", notes: notes ?? "" };
    const rejectWith = (error: string) =>
      res
        .status(400)
        .type("html")
        .send(renderPaymentFormPage({ token, creatorName, brandName, error, values }));

    if (!VALID_METHODS.has(method)) {
      rejectWith("Please choose a payout method.");
      return;
    }
    if (!accountIdentifier) {
      rejectWith("Please enter your account identifier or email.");
      return;
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

    res.type("html").send(renderPaymentThankYouPage({ creatorName, brandName }));
  } catch (err) {
    console.error("[payment] post error:", err);
    res.status(500).type("html").send(renderPaymentInvalidPage());
  }
});

export default router;
