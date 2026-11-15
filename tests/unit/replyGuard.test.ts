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

  it('blocks a refusal that talks about a refund the customer never asked for', () => {
    const r = checkReply(
      { subject: 'Re: your message', body: 'Unfortunately, we are unable to process your refund request as it falls outside our policy scope.' },
      { ...ctx, decision: 'REFUSED' },
    );
    expect(r.violations).toContain('refusal_mentions_refund');
  });

  it('allows a refusal that explains what the inbox handles', () => {
    const r = checkReply(
      { subject: 'How we can help', body: 'This inbox handles refunds, returns and billing questions, so we cannot help with this request.' },
      { ...ctx, decision: 'REFUSED' },
    );
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it.each(DECISIONS)('the fallback template for %s always passes the guard', (decision) => {
    const refundAmount = decision === 'AUTO_APPROVE' ? 19.99 : null;
    const reply = renderTemplateReply({
      decision, customerFirstName: 'Ana', refundAmount, currency: 'EUR', transactionDescription: 'Mug set',
      reasonCodes: ['OUTSIDE_REFUND_WINDOW'], estimatedDeliveryAt: null,
    });
    expect(checkReply(reply, { ...ctx, decision, refundAmount })).toEqual({ ok: true, violations: [] });
  });

  it('RP-8: an escalation must tell the customer a specialist reviews it within 2 business days', () => {
    const vague = checkReply({ subject: 'Update', body: 'Thanks for your message, we will look into it soon.' }, { ...ctx, decision: 'ESCALATE' });
    expect(vague.violations).toContain('escalation_missing_review_notice');
    const ok = checkReply(
      { subject: 'Update', body: 'A specialist from our team will review your request within 2 business days.' },
      { ...ctx, decision: 'ESCALATE' },
    );
    expect(ok.violations).not.toContain('escalation_missing_review_notice');
  });

  it('RP-8: replies must be short', () => {
    const r = checkReply({ subject: 'Hi', body: 'word '.repeat(200) }, { ...ctx, decision: 'REJECT' });
    expect(r.violations).toContain('too_long');
  });
});
