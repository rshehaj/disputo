import { readFileSync } from 'node:fs';
import type { AgentDeps } from '../../src/agent/runAgent.js';
import { loadConfig } from '../../src/config.js';
import { Repository } from '../../src/data/repository.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import type { LlmClient, LlmPurpose, LlmRequest, LlmResponse } from '../../src/llm/types.js';
import { silentLogger } from '../../src/observability/logger.js';
import { PolicyIndex } from '../../src/policy/policyDocs.js';

/** The clock the fixtures are written for (data/*.json, samples/inputs). */
export const FIXTURE_NOW = new Date('2026-11-10T10:00:00Z');

export function makeDeps(llm: LlmClient = new MockLlmClient(), now: Date = FIXTURE_NOW): AgentDeps {
  return {
    now: () => now,
    llm,
    config: { ...loadConfig({ LLM_MODE: 'mock' }), traceDir: null },
    repo: Repository.fromFixtures('data'),
    policy: PolicyIndex.fromFile(),
    logger: silentLogger(),
  };
}

export const sample = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`samples/inputs/${name}.json`, 'utf8')) as Record<string, unknown>;

/** `base` is the normal mock, so a handler can misbehave once and then behave normally. */
type Handler = (req: LlmRequest, callIndex: number, base: LlmClient) => LlmResponse | Promise<LlmResponse>;

/** Mock LLM whose behaviour can be overridden per purpose (to simulate bad/hostile model output). */
export class ScriptedLlm implements LlmClient {
  readonly name = 'scripted';
  readonly calls: Record<LlmPurpose, number> = { classify: 0, investigate: 0, decide: 0, draft_reply: 0 };
  private readonly base = new MockLlmClient();

  constructor(private readonly handlers: Partial<Record<LlmPurpose, Handler>>) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const n = this.calls[req.purpose]++;
    const h = this.handlers[req.purpose];
    return h ? h(req, n, this.base) : this.base.complete(req);
  }
}

export const jsonResponse = (obj: unknown): LlmResponse => ({ content: JSON.stringify(obj), toolCalls: [] });
