import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/data/repository.js';
import { PolicyIndex } from '../../src/policy/policyDocs.js';
import { executeTool, type ToolContext } from '../../src/tools/index.js';

const repo = Repository.fromFixtures('data');
const policy = PolicyIndex.fromFile();
const ctxFor = (email: string): ToolContext => ({
  repo,
  policy,
  customer: repo.findCustomerByEmail(email),
  requestId: 'req_tools',
  category: 'damaged_item',
  requestedAmount: undefined,
  now: new Date('2026-11-10T10:00:00Z'),
  autoApproveLimit: 200,
});
const ana = ctxFor('ana.krasniqi@example.com');

describe('tools', () => {
  it('lookup_transaction returns the customer own transaction', () => {
    const r = executeTool('lookup_transaction', '{"transactionId":"txn_1001"}', ana);
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ found: true, transaction: { id: 'txn_1001', amount: 45 } });
  });

  it('lookup_transaction cannot read another customer transaction (same answer as non-existent)', () => {
    const other = executeTool('lookup_transaction', '{"transactionId":"txn_1008"}', ana);
    const missing = executeTool('lookup_transaction', '{"transactionId":"txn_9999"}', ana);
    expect(other.result).toEqual({ found: false, reason: 'not_found_for_customer' });
    expect(other.result).toEqual(missing.result);
  });

  it('rejects malformed or extra arguments instead of crashing', () => {
    expect(executeTool('lookup_transaction', '{"transactionId":"1; DROP TABLE"}', ana)).toMatchObject({ ok: false });
    expect(executeTool('get_customer_history', '{"customerId":"cus_002"}', ana)).toMatchObject({ ok: false });
    expect(executeTool('lookup_transaction', 'not json', ana).error).toMatch(/not valid JSON/);
    expect(executeTool('delete_everything', '{}', ana).error).toMatch(/Unknown tool/);
  });

  it('get_customer_history is scoped to the requesting customer', () => {
    expect(executeTool('get_customer_history', '{}', ana).result).toMatchObject({ customerId: 'cus_001', refundsLast90Days: 0 });
    expect(executeTool('get_customer_history', '{}', ctxFor('nobody@example.com')).result).toMatchObject({ found: false });
  });

  it('search_refund_policy finds the relevant section', () => {
    const r = executeTool('search_refund_policy', '{"query":"duplicate charge"}', ana).result as { sections: Array<{ id: string }> };
    expect(r.sections[0]?.id).toBe('RP-4');
  });

  it('check_refund_eligibility runs the policy engine', () => {
    const r = executeTool('check_refund_eligibility', '{"transactionId":"txn_1002"}', ana).result;
    expect(r).toMatchObject({ found: true, outcome: 'review', reasons: ['ABOVE_AUTO_APPROVE_LIMIT'] });
  });
});
