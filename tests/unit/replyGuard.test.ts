import { describe, expect, it } from 'vitest';
import { checkReply } from '../../src/guardrails/replyGuard.js';
import { renderTemplateReply } from '../../src/prompts/templates.js';
import { DECISIONS } from '../../src/types.js';

const ctx = { customerEmail: 'ana@example.com', refundAmount: null };

describe('checkReply', () => {
  it('blocks promising a refund that was not approved', () => {
    const r = checkReply({ subject: 'Update', body: 'Good news, your refund has been approved and sent.' }, { ...ctx, decision: 'ESCALATE' });
    expect(r.violations).toContain('promises_refund_not_approved');
  });

  it('requires the exact amount in approval replies', () => {
    const r = checkReply({ subject: 'Refund', body: 'We have approved your refund, thank you.' }, { ...ctx, decision: 'AUTO_APPROVE', refundAmount: 45 });
    expect(r.violations).toContain('missing_refund_amount');
  });

  it('blocks internal details, foreign e-mails and links', () => {
    const r = checkReply(
      { subject: 'Hi', body: 'Per RP-6 your risk score is high (HIGH_REFUND_FREQUENCY). Contact boss@corp.com or https://x.y' },
      { ...ctx, decision: 'ESCALATE' },
    );
    expect(r.violations).toEqual(
      expect.arrayContaining(['leaks_policy_rule_id', 'leaks_reason_code', 'leaks_risk_signal', 'foreign_email_address', 'contains_url']),
    );
  });

  it.each(DECISIONS)('the fallback template for %s always passes the guard', (decision) => {
    const refundAmount = decision === 'AUTO_APPROVE' ? 19.99 : null;
    const reply = renderTemplateReply({
      decision, customerFirstName: 'Ana', refundAmount, currency: 'EUR', transactionDescription: 'Mug set',
      reasonCodes: ['OUTSIDE_REFUND_WINDOW'], estimatedDeliveryAt: null,
    });
    expect(checkReply(reply, { ...ctx, decision, refundAmount })).toEqual({ ok: true, violations: [] });
  });
});
