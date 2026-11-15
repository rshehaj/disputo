import type { Decision, ReplyDraft } from '../types.js';

export interface ReplyGuardContext {
  decision: Decision;
  refundAmount: number | null;
  customerEmail: string;
}

export interface ReplyGuardResult {
  ok: boolean;
  violations: string[];
}

const PROMISES_REFUND =
  /\b(refund (?:has been|was|is being|is|will be) (?:approved|issued|processed|sent)|we(?: have|'ve)? (?:issued|processed|approved) (?:a|your|the) refund|you will (?:receive|get) (?:a|your) refund|we will refund)\b/i;

/** A refusal is for messages that are not about a refund, so it must not talk about "your refund". */
const REFUND_REQUEST_MENTION = /\b(?:your|the|this) refund(?: request)?\b|\brefund request\b/i;

const INTERNAL_LEAKS: Array<[string, RegExp]> = [
  ['policy_rule_id', /\bRP-\d+\b/],
  ['reason_code', /\b[A-Z]{3,}(?:_[A-Z]+){1,}\b/],
  ['risk_signal', /\b(risk (?:score|flag)|refund frequency|fraud score|blacklist)\b/i],
  ['ai_internals', /\b(system prompt|LLM|language model|policy engine|guardrail|prompt injection)\b/i],
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\bhttps?:\/\/\S+/i;

/** RP-8: "Escalated cases: tell the customer a specialist will review the request within 2 business days." */
const ESCALATION_TIMELINE = /\b(?:2|two) business days\b/i;
const ESCALATION_REVIEWER = /\b(specialist|member of our team|our team will review|colleague will review)\b/i;

/** RP-8: "short". The prompt asks for at most 120 words; the guard allows some slack. */
export const MAX_REPLY_WORDS = 160;

/**
 * Deterministic checks on the customer-facing reply before it can be sent.
 * This is how RP-8 (customer communication) is enforced; every clause maps to a check:
 *  - "polite, short and specific"            → too_long, missing_refund_amount
 *  - "never promise an undecided outcome"    → promises_refund_not_approved, refusal_mentions_refund
 *  - "never reveal internal rules / risk"    → leaks_*
 *  - "never reveal other customers' data"    → foreign_email_address
 *  - "escalated: specialist within 2 days"   → escalation_missing_review_notice
 *  - (no links, to keep phishing-shaped replies out) → contains_url
 * Politeness itself is judged by the G-Eval tone metric in evals/, not here.
 */
export function checkReply(reply: ReplyDraft, ctx: ReplyGuardContext): ReplyGuardResult {
  const violations: string[] = [];
  const text = `${reply.subject}\n${reply.body}`;

  if (ctx.decision !== 'AUTO_APPROVE' && PROMISES_REFUND.test(text)) {
    violations.push('promises_refund_not_approved');
  }
  if (ctx.decision === 'REFUSED' && REFUND_REQUEST_MENTION.test(text)) {
    violations.push('refusal_mentions_refund');
  }
  if (ctx.decision === 'AUTO_APPROVE' && ctx.refundAmount !== null) {
    const amount = ctx.refundAmount.toFixed(2);
    if (!text.includes(amount)) violations.push('missing_refund_amount');
  }
  if (ctx.decision === 'ESCALATE' && !(ESCALATION_TIMELINE.test(text) && ESCALATION_REVIEWER.test(text))) {
    violations.push('escalation_missing_review_notice');
  }
  if (reply.body.trim().split(/\s+/).length > MAX_REPLY_WORDS) violations.push('too_long');
  for (const [id, re] of INTERNAL_LEAKS) if (re.test(text)) violations.push(`leaks_${id}`);

  const emails = text.match(EMAIL) ?? [];
  if (emails.some((e) => e.toLowerCase() !== ctx.customerEmail.toLowerCase())) {
    violations.push('foreign_email_address');
  }
  if (URL.test(text)) violations.push('contains_url');

  return { ok: violations.length === 0, violations };
}
