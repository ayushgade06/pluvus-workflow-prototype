import { Router } from "express";
import type { Request, Response } from "express";
import { findBrandDecisionByToken, findInstanceById } from "../db/index.js";
import {
  WorkflowRuntime,
  WrongBrandDecisionStateError,
} from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import {
  renderBrandDecisionResultPage,
  renderBrandDecisionAlreadyDonePage,
  renderBrandDecisionInvalidPage,
  renderBrandDecisionNeedsAmountPage,
} from "./brandDecisionPage.js";

// ---------------------------------------------------------------------------
// Brand-decision one-click magic links (MANUAL_ESCALATION_RESOLUTION.md §2.5)
// ---------------------------------------------------------------------------
// GET /brand-decision/:token/approve
// GET /brand-decision/:token/reject
// GET /brand-decision/:token/counter?amount=<n>
// GET /brand-decision/:token/handoff
//
// The peer of the free-text email reply: a click resolves the BrandDecision
// deterministically (zero parsing risk). The route synthesizes a canonical reply
// and hands it to runtime.resolveBrandDecisionLink, which routes it through the
// SAME executeBrandDecision pipeline as an email reply — one resolution map, two
// channels.
//
// GET-that-mutates note: email clients/prefetchers may issue speculative GETs.
// That's safe here — the instance state pre-check + the WrongBrandDecisionState
// idempotency path + the OCC in stepInstance make a repeated fire a no-op that
// renders the "already decided" page rather than double-resolving.

const router = Router();

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

// GET /brand-decision/:token/:action
router.get("/:token/:action", async (req: Request, res: Response) => {
  const token = req.params["token"]!;
  const actionParam = (req.params["action"] ?? "").toLowerCase();

  try {
    if (!(ACTIONS as readonly string[]).includes(actionParam)) {
      res.status(404).type("html").send(renderBrandDecisionInvalidPage());
      return;
    }
    const action = actionParam as LinkAction;

    const decision = await findBrandDecisionByToken(token);
    if (!decision) {
      res.status(404).type("html").send(renderBrandDecisionInvalidPage());
      return;
    }

    const creatorName = decision.instance.creator.name;
    const brandName = brandNameOf(decision);

    // Already resolved (or the run moved on) — idempotent notice, not an error.
    if (decision.instance.currentState !== "AWAITING_BRAND_DECISION") {
      res
        .type("html")
        .send(renderBrandDecisionAlreadyDonePage({ creatorName, brandName }));
      return;
    }

    const amount = parseAmount(req.query["amount"]);

    // A counter with no usable amount can't resolve — tell the brand how to
    // supply one rather than recording a numberless counter.
    if (action === "counter" && amount === undefined) {
      res
        .status(400)
        .type("html")
        .send(renderBrandDecisionNeedsAmountPage({ creatorName, brandName }));
      return;
    }

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
