"""Run two real creator replies through the live agent pipeline.

classify + negotiate -> Opus (money path), draft -> DeepSeek, all via OpenRouter.
Hits the already-running service on :8001. Writes raw JSON out for the write-up.
"""
import json
import sys
import urllib.request

import os
BASE = os.environ.get("AGENT_URL", "http://localhost:8001")


def post(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


# --- Two real creator replies -------------------------------------------------

JANICE = (
    "Hi Matt,\n"
    "Thank you so much for following up and for considering me for the Payback "
    "Ambassador Program.\n"
    "I'm still interested in the game, but I currently have several existing "
    "content commitments and wouldn't be able to confidently guarantee a post "
    "within 14 days of receiving the deck. I don't want to accept the product "
    "unless I know I can give the collaboration the attention and timely delivery "
    "it deserves.\n"
    "For now, I'll have to pass, but I'd be happy to reconnect in the future when "
    "my content schedule is more open.\n"
    "Thank you again for understanding.\n"
    "Best,\nJanice"
)

SAMANTHA = (
    "Hi Dyme,\n\n"
    "Thank you for reaching out and sending this information.\n\n"
    "I do have some questions:\n\n"
    "1. Do people have the money to use your booking platform?\n\n"
    "2. Is the 5% commission guarantee or is there a tiered commission structure?\n\n"
    "3. What are the qualifications you're looking for to be an approved partner?\n\n"
    "4. What is the estimated gift voucher amount?\n\n"
    "5. Is this a one time gift voucher or will there be more opportunities to "
    "earn additional ones?\n\n"
    "Best, Samanth"
)

# --- Campaign constraints (hybrid: fixed fee band + commission perk) ----------

CONSTRAINTS = {
    "termFloor": {"rate": 200.0},
    "termCeiling": {"rate": 500.0},
    "senderName": "Dyme",
    "brandDescription": "Dyme, a booking platform for service providers",
    "deliverables": "one dedicated post plus one story",
    "timeline": "go live within 14 days of receiving the brief",
    "commissionRate": 5.0,
    "rewardDescription": "a gift voucher for the platform",
    "recommendedOfferPosition": 0.5,
}


def run(name: str, reply: str, sender: str, brand: str, deal: str) -> dict:
    print(f"\n===== {name} =====", file=sys.stderr)

    classify = post("/classify", {"message": reply})
    print("classify:", json.dumps(classify), file=sys.stderr)

    negotiate = post(
        "/negotiate",
        {
            "creatorReply": reply,
            "currentOffer": {"rate": 350.0},
            "round": 1,
            "maxRounds": 3,
            "negotiationHistory": [],
            "conversationHistory": [
                {"role": "us", "round": 1, "action": "PRESENT_OFFER", "rate": 350.0,
                 "message": "initial outreach"},
                {"role": "creator", "message": reply},
            ],
            # classify→negotiate hint: thread the classifier's intent as a soft
            # signal (the executor threads Message.replyIntent the same way).
            **({"intent": classify.get("intent")} if classify.get("intent") else {}),
            "campaignConstraints": {**CONSTRAINTS, "senderName": sender,
                                    "brandDescription": brand},
        },
    )
    print("negotiate action:", negotiate.get("action"), file=sys.stderr)

    # Draft from the negotiate decision. DeepSeek writes the copy.
    action = negotiate.get("action")
    purpose = {
        "ACCEPT": "acceptance",
        "COUNTER": "counter_offer",
        "PRESENT_OFFER": "counter_offer",
        "REJECT": "follow_up",
        "ESCALATE": "follow_up",
    }.get(action, "counter_offer")

    draft = post(
        "/draft",
        {
            "purpose": purpose,
            "creatorName": name,
            "senderName": sender,
            "round": 1,
            "proposedTerms": negotiate.get("proposedTerms") or {"rate": 350.0},
            "brandDescription": brand,
            "dealDescription": deal,
            "deliverables": CONSTRAINTS["deliverables"],
            "timeline": CONSTRAINTS["timeline"],
            "rewardDescription": CONSTRAINTS["rewardDescription"],
            # The offer prompt reads commission from campaignContext["commissionRate"]
            # (see _commission_rate). The real executor threads it here — the first
            # run omitted it, so the draft prompt took the no-commission branch and
            # DeepSeek correctly rendered "no commission structure". Thread it now.
            "campaignContext": {"commissionRate": CONSTRAINTS["commissionRate"]},
            "creatorReply": reply,
            "creatorQuestions": negotiate.get("creatorQuestions", []),
            "pushedFixedTerms": negotiate.get("pushedFixedTerms", []),
            # Option A (negotiate→draft answer sync): thread the negotiator's OWN
            # vetted answers (its responseDraft) so DeepSeek rephrases them instead
            # of re-deriving (and hallucinating) answers from raw facts. Only when
            # present — the agent nulls responseDraft when the guards altered the
            # decision, so the executor threads nothing there.
            **({"negotiatorAnswers": negotiate.get("responseDraft")}
               if negotiate.get("responseDraft") else {}),
        },
    )
    print("draft subject:", draft.get("subject"), file=sys.stderr)

    return {"classify": classify, "negotiate": negotiate, "draft": draft}


out = {
    "janice": run(
        "Janice", JANICE, "Matt", "Payback, a tabletop game",
        "an ambassador program: a free game deck in exchange for a post",
    ),
    "samantha": run(
        "Samanth", SAMANTHA, "Dyme", "Dyme, a booking platform for service providers",
        "a hybrid partnership: a fixed fee for your content plus 5% commission on sales you drive, and a gift voucher",
    ),
}

print(json.dumps(out, indent=2))
