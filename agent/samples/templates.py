"""The DETERMINISTIC (non-AI) copy sources, reproduced verbatim from the server.

These are the templates the TS engine falls back to / uses directly. Reproduced
here (not imported — they live in TypeScript) so the sample artifact can show the
founder the exact deterministic copy alongside the AI copy. Kept byte-identical to
the source; if the source changes these must be updated (noted in README).

Sources:
  - OUTREACH_HYBRID_TEMPLATE / FOLLOWUP_HYBRID_TEMPLATE
        server/src/templates/index.ts → hybridNodes → node-outreach / node-followup
        (the mustache {{creatorName}}/{{brandName}} bodyTemplate + subjectTemplate)
  - MAX_ROUNDS_CLOSE_TEMPLATE
        server/src/engine/executors/negotiation.ts → sendCloseEmail()
        (the fixed courteous close email for a max-rounds auto-reject)
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# Outreach (hybrid) — the deterministic FALLBACK for the AI outreach email.
# The executor tries the AI draft first (initialOutreach.ts) and falls back to
# THIS template via email.draft(). Shown alongside the AI version so the founder
# can compare.
# ---------------------------------------------------------------------------

OUTREACH_HYBRID_SUBJECT = "Paid partnership + affiliate opportunity"

OUTREACH_HYBRID_BODY = (
    "Hi {creatorName},\n\n"
    "We'd love to work with you on a hybrid deal — a base fee for the content "
    "plus an affiliate commission on sales. It's the best of both worlds.\n\n"
    "Open to a quick chat?\n\n"
    "Best,\n"
    "{brandName} Team"
)


# ---------------------------------------------------------------------------
# Follow-up (hybrid) — deterministic (there is a _FOLLOWUP_PROMPT AI path, but
# the shipped hybrid node uses this bodyTemplate; the doc frames it as the
# deterministic follow-up). Sent when the creator did not reply.
# ---------------------------------------------------------------------------

FOLLOWUP_HYBRID_BODY = (
    "Hi {creatorName},\n\n"
    "Wanted to follow up on our hybrid partnership proposal. We have budget "
    "flexibility for the right fit.\n\n"
    "Best,\n"
    "{brandName} Team"
)


# ---------------------------------------------------------------------------
# Max-rounds close email — the deterministic close sent when negotiation fails
# to converge within maxRounds (negotiation.ts sendCloseEmail). No rate/round/
# bound tokens (nothing for the output guard to leak). {{senderName}}/{{brandName}}
# are filled the same way the TS side fills them.
# ---------------------------------------------------------------------------

MAX_ROUNDS_CLOSE_BODY = "\n".join(
    [
        "Hi {creatorName},",
        "",
        "Thank you so much for taking the time to talk through a partnership with "
        "{brandName} — we genuinely enjoyed the conversation.",
        "",
        "We weren't quite able to land on terms that worked for both of us on this "
        "particular campaign, so we'll close this one out for now. That's entirely "
        "okay — these things come down to fit and timing, and we'd love to stay in "
        "touch for future campaigns where the numbers line up better. If something "
        "changes on your end, our door is always open too.",
        "",
        "Wishing you all the best, and hopefully we'll work together down the line.",
        "",
        "Warmly,",
        "{senderName}",
    ]
)


def render(template: str, *, creator_name: str, brand_name: str, sender_name: str) -> str:
    """Fill the {{creatorName}}/{{brandName}}/{{senderName}} tokens the same way
    the TS mustache renderer does. (We use str.format placeholders in the Python
    copies above, so a simple keyword fill is exact.)"""
    return template.format(
        creatorName=creator_name,
        brandName=brand_name,
        senderName=sender_name,
    )
