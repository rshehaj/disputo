import type { AgentResult, ReasonCode } from '../types.js';

const REASON_TEXT: Record<ReasonCode, string> = {
  WITHIN_POLICY: 'request is within policy (window, amount, customer history)',
  OUTSIDE_REFUND_WINDOW: 'purchase is outside the refund window',
  ALREADY_REFUNDED: 'transaction was already refunded',
  CHARGEBACK_IN_PROGRESS: 'a chargeback is open; must go through dispute process',
  TRANSACTION_NOT_SETTLED: 'transaction is not settled yet',
  AMOUNT_EXCEEDS_TRANSACTION: 'requested amount exceeds the original transaction',
  ABOVE_AUTO_APPROVE_LIMIT: 'amount is above the auto-approval limit',
  HIGH_REFUND_FREQUENCY: 'customer has 3+ refunds in the last 90 days',
  ACCOUNT_RISK_FLAG: 'account has a risk flag or recent chargeback',
  CARRIER_REPORTS_DELIVERED: 'carrier reports the parcel as delivered',
  SHIPMENT_STILL_IN_TRANSIT: 'parcel is still in transit within the delivery estimate',
  DUPLICATE_CHARGE_VERIFIED: 'duplicate charge verified (same merchant and amount within 24h)',
  DUPLICATE_CHARGE_NOT_FOUND: 'no matching duplicate charge found',
  UNAUTHORIZED_CHARGE_REVIEW: 'unrecognised charge, routed to fraud review',
  UNCLEAR_CATEGORY: 'request category is unclear',
  PROMPT_INJECTION_SUSPECTED: 'message contains prompt-injection / manipulation attempts',
  AGENT_REQUESTED_REVIEW: 'agent asked for human review',
  TRANSACTION_NOT_FOUND: 'no matching transaction on this customer account',
  AMBIGUOUS_TRANSACTION: 'could not determine which transaction is meant',
  CUSTOMER_NOT_FOUND: 'no account for this e-mail address',
  OUT_OF_SCOPE: 'request is not about refunds/billing',
  INVALID_INPUT: 'input failed validation',
  AGENT_ERROR: 'agent failed; failing safe to human review',
};

const NEXT_STEP: Record<AgentResult['decision'], string> = {
  AUTO_APPROVE: 'Refund can be issued automatically; customer reply is ready to send.',
  ESCALATE: 'Queued for human review; holding reply sent to customer.',
  REJECT: 'No refund; explanation reply is ready to send.',
  NEED_MORE_INFO: 'Waiting for the customer to provide the missing details.',
  REFUSED: 'Out of scope; polite redirect reply drafted.',
  INVALID_INPUT: 'Fix the input and resubmit.',
};

/** Deterministic, human-readable summary built from the structured result (not from the LLM). */
export function buildSummary(r: Omit<AgentResult, 'summary'>): string {
  const amount = r.refundAmount !== null ? ` ${r.refundAmount.toFixed(2)} ${r.currency}` : '';
  const txn = r.transactionId ? ` on ${r.transactionId}` : '';
  const cat = r.category ? ` (${r.category})` : '';
  const lines = [
    `Request ${r.requestId}: ${r.decision}${amount}${txn}${cat}`,
    `Why: ${r.reasonCodes.map((c) => REASON_TEXT[c]).join('; ') || 'n/a'}${r.policyRefs.length ? ` [${r.policyRefs.join(', ')}]` : ''}`,
  ];
  if (r.humanReview.required) lines.push(`Human review: required, queue=${r.humanReview.queue}`);
  const g = r.guardrails;
  const guard: string[] = [];
  if (g.injectionFlagged) guard.push(`injection flagged (${g.injectionSignals.join(', ')})`);
  for (const o of g.overrides) guard.push(`${o.field} ${JSON.stringify(o.from)} -> ${JSON.stringify(o.to)} by ${o.rule}`);
  if (g.replySource === 'template') guard.push('reply fell back to safe template');
  lines.push(`Guardrails: ${guard.length ? guard.join('; ') : 'none triggered'}`);
  if (r.validationErrors.length) lines.push(`Validation errors: ${r.validationErrors.join('; ')}`);
  lines.push(`Next: ${NEXT_STEP[r.decision]}`);
  lines.push(`Trace: ${r.trace.llmCalls} LLM calls, ${r.trace.toolCalls} tool calls, ${r.trace.durationMs} ms (${r.meta.llm})`);
  return lines.join('\n');
}
