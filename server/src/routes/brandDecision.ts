import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import { findBrandDecisionByToken, findInstanceById } from "../db/index.js";
import {
  WorkflowRuntime,
  WrongBrandDecisionStateError,
} from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import {
  renderBrandDecisionConfirmPage,
  renderBrandDecisionResultPage,
  renderBrandDecisionAlreadyDonePage,
  renderBrandDecisionInvalidPage,
  renderBrandDecisionExpiredPage,
  renderBrandDecisionNeedsAmountPage,
} from "./brandDecisionPage.js";

// ---------------------------------------------------------------------------
// Brand-decision magic links (MANUAL_ESCALATION_RESOLUTION.md §2.5 + MED-S4)
// ---------------------------------------------------------------------------
// GET  /brand-decision/:token/approve   → confirm page (no mutation)
// GET  /brand-decision/:token/reject    → confirm page (no mutation)
// GET  /brand-decision/:token/counter?amount=<n> → confirm page (no mutation)
// GET  /brand-decision/:token/handoff   → confirm page (no mutation)
// POST /brand-decision/:token/:action   → resolves the decision
//
// The peer of the free-text email reply: the confirmed click resolves the
// BrandDecision deterministically (zero parsing risk). The route synthesizes a
// canonical reply and hands it to runtime.resolveBrandDecisionLink, which routes
// it through the SAME executeBrandDecision pipeline as an email reply — one
// resolution map, two channels.
//
// MED-S4 (prefetch safety): email clients and security gateways speculatively
// fetch GET links, sometimes ALL of them — which under the old GET-that-mutates
// design could silently auto-resolve a money decision (and with several links
// prefetched, resolve it to whichever fetch won the race). The GET now renders a
// confirm interstitial and only the explicit button press (a POST, which
// gateways do not issue) resolves. The instance state pre-check + the
// WrongBrandDecisionState idempotency path + the OCC in stepInstance additionally
// make a double-submit a no-op that renders the "already decided" page.
//
// MED-S4 (expiry): `expiresAt` was only enforced by the 72h sweep; between the
// timeout and the sweep tick — or if the sweep was down — a stale link kept
// working. Both verbs now check it on every hit.

const router = Router();

// The confirm form posts application/x-www-form-urlencoded (an empty body, but
// express still needs a parser mounted for POST to flow through cleanly).
router.use(urlencoded({ extended: false }));

const ACTIONS = ["approve", "reject", "counter", "handoff"] as const;
type LinkAction = (typeof ACTIONS)[number];

function brandNameOf(
  decision: Awaited<ReturnType<typeof findBrandDecisionByToken>>,
): string {
  return decision?.instance.workflowVersion.workflow.campaign?.brand ?? "Your brand";
}

// Parse ?amount= into a positive finite number, or undefined.
function parseAmount(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Shared validation for both verbs. Renders the terminal page itself and
// returns null when the request cannot proceed; otherwise returns everything
// the caller needs.
async function validateLink(
  req: Request,
  res: Response,
): Promise<{
  action: LinkAction;
  decision: NonNullable<Awaited<ReturnType<typeof findBrandDecisionByToken>>>;
  creatorName: string;
  brandName: string;
  amount: number | undefined;
} | null> {
  const actionParam = (req.params["action"] ?? "").toLowerCase();
  if (!(ACTIONS as readonly string[]).includes(actionParam)) {
    res.status(404).type("html").send(renderBrandDecisionInvalidPage());
    return null;
  }
  const action = actionParam as LinkAction;

  const decision = await findBrandDecisionByToken(req.params["token"]!);
  if (!decision) {
    res.status(404).type("html").send(renderBrandDecisionInvalidPage());
    return null;
  }

  const creatorName = decision.instance.creator.name;
  const brandName = brandNameOf(decision);

  // Already resolved (or the run moved on) — idempotent notice, not an error.
  if (decision.instance.currentState !== "AWAITING_BRAND_DECISION") {
    res
      .type("html")
      .send(renderBrandDecisionAlreadyDonePage({ creatorName, brandName }));
    return null;
  }

  // MED-S4: enforce the silence timeout on click, not only in the sweep. A
  // still-unresolved decision past expiresAt can no longer be actioned by link —
  // the run is (being) swept to MANUAL_REVIEW and the dashboard owns it.
  if (decision.expiresAt.getTime() <= Date.now()) {
    res.status(410).type("html").send(renderBrandDecisionExpiredPage({ creatorName, brandName }));
    return null;
  }

  // A counter with no usable amount can't resolve — tell the brand how to
  // supply one rather than recording a numberless counter. Checked on both
  // verbs so the confirm page is never rendered for an unresolvable counter.
  const amount = parseAmount(req.body?.["amount"] ?? req.query["amount"]);
  if (action === "counter" && amount === undefined) {
    res
      .status(400)
      .type("html")
      .send(renderBrandDecisionNeedsAmountPage({ creatorName, brandName }));
    return null;
  }

  return { action, decision, creatorName, brandName, amount };
}

// GET /brand-decision/:token/:action — MED-S4: render the confirm interstitial.
// Deliberately mutation-free so a prefetching gateway can't resolve anything.
router.get("/:token/:action", async (req: Request, res: Response) => {
  try {
    const v = await validateLink(req, res);
    if (!v) return;
    res.type("html").send(
      renderBrandDecisionConfirmPage(v.action, {
        creatorName: v.creatorName,
        brandName: v.brandName,
        ...(v.amount !== undefined ? { amount: v.amount } : {}),
      }),
    );
  } catch (err) {
    console.error("[brand-decision] link error:", err);
    res.status(500).type("html").send(renderBrandDecisionInvalidPage());
  }
});

// POST /brand-decision/:token/:action — the confirmed click: resolve for real.
router.post("/:token/:action", async (req: Request, res: Response) => {
  try {
    const v = await validateLink(req, res);
    if (!v) return;
    const { action, decision, creatorName, brandName, amount } = v;

    const runtime = new WorkflowRuntime(emailProvider(), agentProvider());
    try {
      await runtime.resolveBrandDecisionLink(decision.instanceId, action, amount, {
        worker: "brand-decision-route",
      });
    } catch (err) {
      if (err instanceof WrongBrandDecisionStateError) {
        // A concurrent reply/click already resolved it — idempotent success.
        res
          .type("html")
          .send(renderBrandDecisionAlreadyDonePage({ creatorName, brandName }));
        return;
      }
      throw err;
    }

    // Forward-compat auto-chain (mirrors the inbound worker): no brand-decision
    // outcome advances to NEGOTIATING in this pass, so this is a no-op guard for
    // now — but keeps the route ready for the final-offer sub-state.
    try {
      const after = await findInstanceById(decision.instanceId);
      if (after?.currentState === "NEGOTIATING") {
        await enqueueNodeExecution({
          instanceId: decision.instanceId,
          expectedState: "NEGOTIATING",
          triggerRef: `auto-negotiate-${decision.instanceId}-brand-link-${action}`,
        });
      }
    } catch (err) {
      console.error("[brand-decision] follow-on enqueue error (non-fatal):", err);
    }

    res
      .type("html")
      .send(
        renderBrandDecisionResultPage(action, {
          creatorName,
          brandName,
          ...(amount !== undefined ? { amount } : {}),
        }),
      );
  } catch (err) {
    console.error("[brand-decision] link error:", err);
    res.status(500).type("html").send(renderBrandDecisionInvalidPage());
  }
});

export default router;
