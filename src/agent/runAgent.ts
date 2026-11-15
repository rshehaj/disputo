import { loadConfig, type AppConfig } from '../config.js';
import { Repository } from '../data/repository.js';
import { MockLlmClient } from '../llm/mockClient.js';
import { OpenAiLlmClient } from '../llm/openaiClient.js';
import type { LlmClient } from '../llm/types.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { Tracer } from '../observability/tracer.js';
import { PolicyIndex } from '../policy/policyDocs.js';
import type { AgentResult } from '../types.js';
import { buildAgentGraph } from './graph.js';

export interface AgentDeps {
  llm: LlmClient;
  repo: Repository;
  policy: PolicyIndex;
  config: AppConfig;
  logger: Logger;
  /** Clock used when the request has no receivedAt (injectable for tests). */
  now?: () => Date;
}

export function createLlm(config: AppConfig): LlmClient {
  if (config.llmMode === 'openai') {
    return new OpenAiLlmClient({
      apiKey: config.openaiApiKey!,
      model: config.openaiModel,
      temperature: config.openaiTemperature,
      timeoutMs: config.llmTimeoutMs,
      ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
    });
  }
  return new MockLlmClient();
}

export function createDefaultDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const config = overrides.config ?? loadConfig();
  return {
    config,
    llm: overrides.llm ?? createLlm(config),
    repo: overrides.repo ?? Repository.fromFixtures('data', 'data/runtime/decisions.jsonl'),
    policy: overrides.policy ?? PolicyIndex.fromFile(),
    logger: overrides.logger ?? createLogger(config.logLevel, config.logPretty),
    ...(overrides.now ? { now: overrides.now } : {}),
  };
}

/** Runs one refund request through the agent workflow. Never throws for bad input or LLM failures. */
export async function runAgent(rawInput: unknown, deps: AgentDeps): Promise<AgentResult> {
  const requestId =
    typeof rawInput === 'object' && rawInput !== null && typeof (rawInput as { requestId?: unknown }).requestId === 'string'
      ? String((rawInput as { requestId: string }).requestId).slice(0, 64)
      : 'unknown';
  const tracer = new Tracer(requestId, deps.logger);
  const graph = buildAgentGraph({ llm: deps.llm, repo: deps.repo, policy: deps.policy, config: deps.config, tracer });

  const state = await graph.invoke(
    { rawInput, now: (deps.now?.() ?? new Date()).toISOString() },
    { recursionLimit: 30 },
  );
  const result = state.result;
  if (!result) throw new Error('Agent finished without a result (graph wiring bug)');

  if (result.status !== 'invalid_input') {
    deps.repo.recordDecision({
      requestId: result.requestId,
      decision: result.decision,
      transactionId: result.transactionId,
      refundAmount: result.refundAmount,
      decidedAt: result.meta.decidedAt,
    });
  }
  if (deps.config.traceDir) {
    result.trace.file = tracer.writeTo(deps.config.traceDir);
  }
  return result;
}
