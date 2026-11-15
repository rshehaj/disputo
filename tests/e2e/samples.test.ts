import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/runAgent.js';
import { AgentResultSchema } from '../../src/types.js';
import { makeDeps } from '../helpers/deps.js';
import { compareExpected, type Expected } from '../helpers/expected.js';

const files = readdirSync('samples/inputs').filter((f) => f.endsWith('.json')).sort();

describe('end-to-end: every sample request through the full agent graph (mock LLM)', () => {
  it.each(files)('%s', async (file) => {
    const input = JSON.parse(readFileSync(`samples/inputs/${file}`, 'utf8'));
    const expected = JSON.parse(readFileSync(`samples/expected/${file}`, 'utf8')) as Expected;

    const result = await runAgent(input, makeDeps());

    expect(() => AgentResultSchema.parse(result)).not.toThrow();
    expect(compareExpected(result, expected)).toEqual([]);
    expect(result.summary).toContain(result.decision);
  });

  it('produces a full trace: tool calls, LLM calls and the final decision', async () => {
    const deps = makeDeps();
    const input = JSON.parse(readFileSync('samples/inputs/01-damaged-item-auto-approve.json', 'utf8'));
    const result = await runAgent(input, deps);
    expect(result.trace.toolCalls).toBe(4);
    expect(result.trace.llmCalls).toBeGreaterThanOrEqual(4);
    expect(deps.repo.listDecisions()).toEqual([
      expect.objectContaining({ requestId: 'req_01', decision: 'AUTO_APPROVE', refundAmount: 45 }),
    ]);
  });

  it('is deterministic: the same input gives the same decision', async () => {
    const input = JSON.parse(readFileSync('samples/inputs/05-prompt-injection-escalate.json', 'utf8'));
    const [a, b] = await Promise.all([runAgent(input, makeDeps()), runAgent(input, makeDeps())]);
    const pick = (r: typeof a) => [r.decision, r.refundAmount, r.reasonCodes, r.guardrails.overrides, r.customerReply];
    expect(pick(a)).toEqual(pick(b));
  });
});
