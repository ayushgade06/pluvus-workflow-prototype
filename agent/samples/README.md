# Sample-copy generator (founder review)

Generates a single markdown artifact showing the copy our pipeline produces at
**every step** of creator outreach + negotiation. Every stage — `/classify`,
`/negotiate`, `/draft` — is written out **in full** (a readable block **plus** the
complete raw JSON), and each conversation is shown **two ways**:

- 🟦 **AI** — the real agent endpoints (the LLM writes the copy and decides the number).
- 🟨 **Deterministic** — the rule-based mock/template path (fixed copy, no LLM).

So AI and non-AI copy are unmistakably separated, side by side, at every turn.

Output: `readme_docs/SAMPLE_COPY_CURRENT_STATE.md` — this is what we send the founder.

---

## What it produces

**Standalone copy (once per run):** outreach (AI + template), follow-up (template),
max-rounds close (template).

**18 conversations, grouped by outcome**, each replayed through **both** paths, per
turn capturing the complete `/classify`, `/negotiate`, and `/draft` responses:

- **Group A — Succeed (5):** straightforward accept, enthusiastic-yes→present→accept,
  below-floor bargain, quick close after concession, multi-question (all answerable) + fee.
- **Group B — Haggle + multi-Q (5):** multi-round haggle→counters→final-round close,
  present-offer path, push commission (held fixed)→ultimatum→escalate, push perk +
  deliverables, bundled multi-Q with one sensitive clause.
- **Group C — Fail / escalate (8):** over-ceiling firm, haggle-stays-over-ceiling,
  legal/contract demand, exclusivity demand, hostile tone, opt-out, prompt-injection,
  plain rejection.

Base campaign: a **hybrid** running-shoe deal (Stridr × Maya Chen), band **$300–$700**,
4 rounds, **10%** fixed commission. An ask above $700 escalates; below $300 we accept
at the creator's own cheaper number.

> Note on the deterministic path: the mock provider is intentionally *simple* — it
> only understands `$`-amounts and rounds, with **no** classifier, topic gate, or
> opt-out gate. So on several "fail" cases (legal, exclusivity, hostile, opt-out,
> rejection) the deterministic pass just **counters** where the AI pass correctly
> escalates/opts-out. That contrast is the point — it shows what the non-AI path can
> and can't do.

---

## Running it

### Dry run (no cost, no network) — see the plan

```powershell
# from agent/
.venv\Scripts\python.exe -m samples --dry-run
```

### Deterministic-only (no cost, no LLM) — the 🟨 column, for free

Fully exercises the runner + emitter and produces a real artifact with the
deterministic column populated (AI column shows "not run"):

```powershell
.venv\Scripts\python.exe -m samples --template-only
```

### Full run (AI + deterministic) — needs a running agent

**1. Start a FRESH agent with a known-good config.** An agent may already be on
`:8001` with unknown config; start a session-owned one on a new port.

Two config traps (handled by the command below):

- Root `.env` has `LLM_PROVIDER=ollama`. For real **frontier AI copy**, run with
  `LLM_PROVIDER=openrouter` (a valid `OPENROUTER_API_KEY` is already in `.env`).
- `OPENROUTER_MODEL_DRAFT=deepseek/deepseek-chat-v3` **no longer resolves** (the
  `.env` warns this). Outreach **and** every negotiation reply run on the "draft"
  role — leaving the default **breaks the most important samples**. Override it.

**PowerShell:**

```powershell
# from agent/
$env:LLM_PROVIDER = "openrouter"
$env:OPENROUTER_MODEL_DRAFT = "anthropic/claude-opus-4.8"
$env:NEGOTIATION_STRATEGY = "llm"
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8003
```

**bash:**

```bash
LLM_PROVIDER=openrouter \
OPENROUTER_MODEL_DRAFT=anthropic/claude-opus-4.8 \
NEGOTIATION_STRATEGY=llm \
uvicorn app.main:app --port 8003
```

**2. Generate the artifact** (second shell, from `agent/`, matching the LLM env so
the header records it):

```powershell
$env:LLM_PROVIDER = "openrouter"
$env:OPENROUTER_MODEL_DRAFT = "anthropic/claude-opus-4.8"
.venv\Scripts\python.exe -m samples --agent-url http://127.0.0.1:8003
```

Flags: `--agent-url URL`, `--out PATH`, `--only key1,key2` (subset),
`--template-only` (no LLM), `--dry-run`.

---

## 💵 Cost — the AI pass calls OpenRouter and spends real money

A full AI run makes roughly: 1 outreach draft + up to 26 `/negotiate` + 26
`/draft` + 18 `/classify` calls (18 conversations, 26 turns). On
`anthropic/claude-opus-4.8` — long prompts each — that can total **a few dollars**.
**Confirm before a paid run.** Validate first with `--dry-run` and `--template-only`
(both zero cost), and use `--only <key>` to run one conversation while iterating.

Point the agent at Ollama (`LLM_PROVIDER=ollama`) for a **free** local AI run
(lower copy quality, but the pipeline exercises identically).

---

## Files

| File | Purpose |
| --- | --- |
| `campaign.py` | Brand/creator personas + campaign constraints (band 300–700) + wire helpers |
| `conversations.py` | The 18 multi-turn conversation scripts, grouped by category |
| `templates.py` | The `sendCloseEmail` close template (reproduced from the server) |
| `deterministic.py` | Python port of `MockNegotiationProvider` — rule-based negotiate + template draft (the 🟨 path) |
| `client.py` | Stdlib HTTP client for the agent endpoints (the 🟦 path) |
| `runner.py` | Replays each conversation through BOTH providers, mirroring the TS executor state machine |
| `emit.py` | Renders captured results into the tagged markdown artifact (full verbatim responses) |
| `__main__.py` | CLI entry point |

**Drift note:** `templates.py` (close email) and `deterministic.py` (mock copy)
are reproduced from TypeScript. If `server/src/templates/index.ts`,
`negotiation.ts sendCloseEmail()`, or `MockNegotiationProvider.ts` change, update
these to match.
