import {
  MockEmailProvider,
  MockAgentProvider,
  type IEmailProvider,
  type IAgentProvider,
  type MockAgentOptions,
} from "./providers.js";
import { NylasEmailProvider } from "../providers/nylas/nylasEmailProvider.js";
import { LangGraphClassificationProvider } from "../adapters/classification/LangGraphClassificationProvider.js";
import { MockClassificationProvider } from "../adapters/classification/MockClassificationProvider.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import type { ClassifyResult } from "./types.js";

// ---------------------------------------------------------------------------
// Email provider factory
// ---------------------------------------------------------------------------
//   EMAIL_PROVIDER=mock   (default) → MockEmailProvider
//   EMAIL_PROVIDER=nylas            → NylasEmailProvider (reads NYLAS_* env)

export function emailProvider(): IEmailProvider {
  const choice = (process.env["EMAIL_PROVIDER"] ?? "mock").toLowerCase();

  if (choice === "nylas") {
    return new NylasEmailProvider();
  }

  if (choice !== "mock") {
    console.warn(
      `[providerFactory] unknown EMAIL_PROVIDER="${choice}" — falling back to mock`,
    );
  }
  return new MockEmailProvider();
}

// ---------------------------------------------------------------------------
// Classification provider factory
// ---------------------------------------------------------------------------
//   AGENT_PROVIDER=mock       (default) → MockClassificationProvider (keyword-based)
//   AGENT_PROVIDER=langgraph            → LangGraphClassificationProvider (HTTP)
//     Falls back to mock automatically if the agent service is unreachable.

export function classificationProvider(): ClassificationProvider {
  const choice = (process.env["AGENT_PROVIDER"] ?? "mock").toLowerCase();

  if (choice === "langgraph") {
    return new LangGraphClassificationProvider();
  }

  if (choice !== "mock") {
    console.warn(
      `[providerFactory] unknown AGENT_PROVIDER="${choice}" — falling back to mock`,
    );
  }
  return new MockClassificationProvider();
}

// ---------------------------------------------------------------------------
// Agent provider adapter
// ---------------------------------------------------------------------------
// Wraps a ClassificationProvider so the engine's IAgentProvider interface is
// satisfied. The negotiate() method stays mocked until Phase 8.

class AgentProviderAdapter implements IAgentProvider {
  constructor(
    private readonly classifier: ClassificationProvider,
    private readonly mockOpts: MockAgentOptions,
  ) {}

  async classify(body: string): Promise<ClassifyResult> {
    const result = await this.classifier.classify({ message: body });
    return { intent: result.intent as ClassifyResult["intent"], confidence: result.confidence };
  }

  async negotiate(round: number, config: Record<string, unknown>) {
    return new MockAgentProvider(this.mockOpts).negotiate(round, config);
  }
}

/**
 * Agent (AI) provider.
 * Classification is driven by AGENT_PROVIDER env flag (mock | langgraph).
 * Negotiation stays mocked until Phase 8.
 * The `opts` parameter still accepts mockIntent for harness scenarios that
 * need to force a specific classification result.
 */
export function agentProvider(opts: MockAgentOptions = {}): IAgentProvider {
  // If a mockIntent is explicitly set (harness / manual queue injection),
  // bypass the classification provider entirely and return the fixed intent.
  if (opts.replyIntent !== undefined) {
    return new MockAgentProvider(opts);
  }
  return new AgentProviderAdapter(classificationProvider(), opts);
}
