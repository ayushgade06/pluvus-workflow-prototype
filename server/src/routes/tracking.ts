import { Router } from "express";
import type { Request, Response } from "express";
import { findPartnershipByReferralCode, recordClick } from "../db/index.js";

// ---------------------------------------------------------------------------
// Short-link redirect: GET /t/:referralCode → 302 to campaign targetUrl
// ---------------------------------------------------------------------------
// I-8: the redirect must never fail because the click insert did.
// Unknown or PAUSED code → minimal 404 HTML page.

const router = Router();

router.get("/:referralCode", async (req: Request, res: Response) => {
  const { referralCode } = req.params as { referralCode: string };

  const partnership = await findPartnershipByReferralCode(referralCode);

  if (!partnership || partnership.status === "PAUSED") {
    res.status(404).send(notFoundPage("Link not found or no longer active."));
    return;
  }

  // Campaign must have a targetUrl — a link-less campaign with a short link is a
  // config bug. 404 loudly so it is noticed.
  if (!partnership.trackingLink) {
    console.error(
      `[tracking] referralCode=${referralCode} partnershipId=${partnership.id}: ` +
        `no trackingLink — campaign has no targetUrl or it failed to build`,
    );
    res.status(404).send(notFoundPage("This link is not properly configured."));
    return;
  }

  // Best-effort click recording — never block the redirect (I-8).
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim() ?? req.socket.remoteAddress ?? null;
    await recordClick({
      partnershipId: partnership.id,
      referralCode,
      ip,
      userAgent: req.headers["user-agent"] ?? null,
      referer: req.headers["referer"] ?? null,
    });
  } catch (err) {
    console.error(`[tracking] click insert failed for referralCode=${referralCode}:`, err);
  }

  res.redirect(302, partnership.trackingLink);
});

function notFoundPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link Not Found</title>
  <style>
    :root { --bg: #0d1117; --panel: #161b22; --border: #2d333b; --text: #e6edf3; --muted: #9198a1; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; padding: 40px 16px; }
    .card { width: 100%; max-width: 420px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 12px; padding: 32px 28px; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 10px; }
    p { color: var(--muted); font-size: 14px; margin: 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Link Not Found</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export default router;
