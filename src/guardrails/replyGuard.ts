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

const INTERNAL_LEAKS: Array<[string, RegExp]> = [
  ['policy_rule_id', /\bRP-\d+\b/],
  ['reason_code', /\b[A-Z]{3,}(?:_[A-Z]+){1,}\b/],
  ['risk_signal', /\b(risk (?:score|flag)|refund frequency|fraud score|blacklist)\b/i],
  ['ai_internals', /\b(system prompt|LLM|language model|policy engine|guardrail|prompt injection)\b/i],
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\bhttps?:\/\/\S+/i;

/** Deterministic checks on the customer-facing reply before it can be sent. */
export function checkReply(reply: ReplyDraft, ctx: ReplyGuardContext): ReplyGuardResult {
  const violations: string[] = [];
  const text = `${reply.subject}\n${reply.body}`;

  if (ctx.decision !== 'AUTO_APPROVE' && PROMISES_REFUND.test(text)) {
    violations.push('promises_refund_not_approved');
  }
  if (ctx.decision === 'AUTO_APPROVE' && ctx.refundAmount !== null) {
    const amount = ctx.refundAmount.toFixed(2);
    if (!text.includes(amount)) violations.push('missing_refund_amount');
  }
  for (const [id, re] of INTERNAL_LEAKS) if (re.test(text)) violations.push(`leaks_${id}`);

  const emails = text.match(EMAIL) ?? [];
  if (emails.some((e) => e.toLowerCase() !== ctx.customerEmail.toLowerCase())) {
    violations.push('foreign_email_address');
  }
  if (URL.test(text)) violations.push('contains_url');

  return { ok: violations.length === 0, violations };
}
