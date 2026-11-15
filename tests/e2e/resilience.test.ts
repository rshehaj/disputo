import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/runAgent.js';
import { TransientLlmError } from '../../src/llm/types.js';
import { jsonResponse, makeDeps, sample, ScriptedLlm } from '../helpers/deps.js';

/**
 * Integration tests that simulate a misbehaving model. The point: whatever the LLM does,
 * the workflow ends with a valid, policy-compliant result and never moves money unsafely.
 */
describe('agent resilience against bad or hostile model output', () => {
  it('recovers from invalid JSON in the decision step (repair loop)', async () => {
    const llm = new ScriptedLlm({
      decide: (req, n, base) =>
        n === 0 ? { content: 'I think we should approve it!', toolCalls: [] } : base.complete(req),
    });
    const r = await runAgent(sample('01-damaged-item-auto-approve'), makeDeps(llm));
    expect(r.decision).toBe('AUTO_APPROVE');
    expect(llm.calls.decide).toBe(2);
  });

  it('fails safe to human review when the LLM is down', async () => {
    const down = () => {
      throw new TransientLlmError('503 Service Unavailable');
    };
    const llm = new ScriptedLlm({ classify: down, investigate: down, decide: down, draft_reply: down });
    const r = await runAgent(sample('01-damaged-item-auto-approve'), makeDeps(llm));
    expect(r).toMatchObject({ status: 'failed_safe', decision: 'ESCALATE', refundAmount: null });
    expect(r.reasonCodes).toContain('AGENT_ERROR');
    expect(r.humanReview).toEqual({ required: true, queue: 'refunds-l2' });
    expect(r.guardrails.replySource).toBe('template');
    expect(llm.calls.classify).toBe(3); // 1 call + 2 transient retries
  });

  it('blocks a model that tries to refund another customer transaction', async () => {
    const llm = new ScriptedLlm({
      decide: () =>
        jsonResponse({
          decision: 'AUTO_APPROVE', transactionId: 'txn_1002', refundAmount: 849,
          reasonCodes: ['WITHIN_POLICY'], policyRefs: [], rationale: 'x', confidence: 1,
        }),
    });
    // Request comes from Dritan; txn_1002 belongs to Ana.
    const r = await runAgent(sample('07-duplicate-charge-auto-approve'), makeDeps(llm));
    expect(r.decision).toBe('NEED_MORE_INFO');
    expect(r.refundAmount).toBeNull();
    expect(r.guardrails.overrides.map((o) => o.field)).toEqual(['decision', 'transactionId', 'refundAmount']);
  });

  it('cannot be talked into approving above the auto-approve limit', async () => {
    const llm = new ScriptedLlm({
      decide: () =>
        jsonResponse({
          decision: 'AUTO_APPROVE', transactionId: 'txn_1002', refundAmount: 849,
          reasonCodes: [], policyRefs: [], rationale: 'gold customer', confidence: 1,
        }),
    });
    const r = await runAgent(sample('02-high-value-escalate'), makeDeps(llm));
    expect(r.decision).toBe('ESCALATE');
    expect(r.guardrails.overrides[0]).toMatchObject({ field: 'decision', from: 'AUTO_APPROVE', to: 'ESCALATE' });
  });

  it('replaces a reply that promises an unapproved refund with the safe template', async () => {
    const llm = new ScriptedLlm({
      draft_reply: () => jsonResponse({ subject: 'Done', body: 'Great news Ana, your refund has been approved and sent today!' }),
    });
    const r = await runAgent(sample('02-high-value-escalate'), makeDeps(llm));
    expect(r.decision).toBe('ESCALATE');
    expect(r.guardrails.replySource).toBe('template');
    expect(r.customerReply?.body).toContain('specialist');
    expect(r.customerReply?.body).not.toMatch(/approved/i);
  });

  it('stops a runaway tool loop at the iteration limit and still decides safely', async () => {
    let i = 0;
    const llm = new ScriptedLlm({
      investigate: () => ({
        content: null,
        toolCalls: [{ id: `c${i}`, name: 'search_refund_policy', arguments: JSON.stringify({ query: `refund ${i++}` }) }],
      }),
    });
    const deps = makeDeps(llm);
    const r = await runAgent(sample('01-damaged-item-auto-approve'), deps);
    expect(llm.calls.investigate).toBe(deps.config.maxToolIterations);
    // Mock decide had no eligibility -> NEED_MORE_INFO; enforcement re-verifies the request txn but keeps the conservative choice.
    expect(['NEED_MORE_INFO', 'ESCALATE']).toContain(r.decision);
    expect(r.refundAmount === null || r.refundAmount <= 45).toBe(true);
  });

  it('feeds tool errors back to the model instead of crashing', async () => {
    const llm = new ScriptedLlm({
      investigate: (req, n, base) =>
        n === 0
          ? { content: null, toolCalls: [{ id: 'bad', name: 'lookup_transaction', arguments: '{"transactionId": 42}' }] }
          : base.complete(req), // normal mock: sees the error result and retries with valid args
    });
    const r = await runAgent(sample('01-damaged-item-auto-approve'), makeDeps(llm));
    expect(r.status).toBe('completed');
    expect(r.decision).toBe('AUTO_APPROVE');
    expect(llm.calls.investigate).toBe(6); // bad call + 4 good calls + completion
  });
});
