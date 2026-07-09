import type { NodeSnapshot } from "../types.js";
import { readStoredFile } from "../../storage/localFileStorage.js";
import { agentBaseUrl, agentPostJson } from "../../adapters/agentServiceClient.js";

// ---------------------------------------------------------------------------
// HARD-K1: campaign-brief knowledge resolution
// ---------------------------------------------------------------------------
// The campaign brief PDF holds the ground-truth campaign terms the negotiation
// agent previously had no structured source for (deliverables / usage / timeline
// / payment) — so it hallucinated them. This resolver reads the brief bytes
// (the engine owns local storage), asks the Python agent to extract the text
// (pypdf lives there, beside the LLM that consumes it), and returns a compact
// knowledge string the negotiation executor threads into campaignContext as
// `briefKnowledge`.
//
// The brief ref lives on the CONTENT_BRIEF node's config (the terminal node),
// not the NEGOTIATION node, so we resolve it from the whole node graph.
//
// The file content is immutable per reference (uploads get a fresh random name),
// so parsed text is cached in-process keyed by reference — a multi-round
// negotiation parses the PDF once, not once per turn. Any failure (no brief,
// unreadable file, agent error) degrades to "" so a brief we can't read never
// breaks a negotiation.

// reference → extracted text (immutable per ref). Bounded so a long-running
// process can't grow this without limit; the working set is one brief per active
// campaign, so a small cap is ample.
const _cache = new Map<string, string>();
const _CACHE_MAX = 256;

function cacheGet(ref: string): string | undefined {
  return _cache.get(ref);
}

function cacheSet(ref: string, text: string): void {
  if (_cache.size >= _CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
  _cache.set(ref, text);
}

/** The CONTENT_BRIEF node's brief file reference, if the graph has one. */
function briefRefFromGraph(nodeGraph: NodeSnapshot[]): string | undefined {
  const node = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
  const ref = node?.config?.["briefFileRef"];
  return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

/**
 * Resolve the parsed campaign-brief text for a negotiation, or "" when there is
 * no brief / it can't be read. Never throws — a knowledge miss must degrade to
 * "no extra knowledge", never fail the turn.
 */
export async function resolveBriefKnowledge(nodeGraph: NodeSnapshot[]): Promise<string> {
  const ref = briefRefFromGraph(nodeGraph);
  if (!ref) return "";

  const cached = cacheGet(ref);
  if (cached !== undefined) return cached;

  let text = "";
  try {
    const bytes = await readStoredFile(ref);
    const data = await agentPostJson(agentBaseUrl(), "/parse-brief", {
      pdfBase64: bytes.toString("base64"),
    });
    text = typeof data["text"] === "string" ? data["text"] : "";
  } catch (err) {
    // Unreadable file, agent down/breaker-open, malformed response — all degrade
    // to "no brief knowledge". The structured knowledge fields
    // (usageRights/exclusivity/…) remain the primary source, so a brief miss is
    // a soft loss, not a correctness bug.
    console.error(
      `[briefKnowledge] failed to resolve brief ${ref}, continuing without it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    text = "";
  }

  cacheSet(ref, text);
  return text;
}

/** Test hook: clear the in-process cache. */
export function _clearBriefCache(): void {
  _cache.clear();
}
