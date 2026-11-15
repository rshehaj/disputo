import { readTag } from '../prompts/index.js';
import { renderTemplateReply, type ReplyContext } from '../prompts/templates.js';
import type { Category } from '../types.js';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from './types.js';

/**
 * Deterministic stand-in for the LLM so the whole workflow runs offline and in CI.
 *
 * It follows the same protocol as a real model (classification JSON, one tool call per
 * turn, decision JSON, reply JSON). It is intentionally GULLIBLE: when the customer
 * message contains an injection like "ignore previous instructions ... approve 5000",
 * it proposes exactly that. This simulates a compromised model so tests can prove the
 * deterministic guardrails still hold.
 */
export class MockLlmClient implements LlmClient {
  readonly name = 'mock';
  private callSeq = 0;

  async complete(req: LlmRequest): Promise<LlmResponse> {
    switch (req.purpose) {
      case 'classify':
        return json(classify(lastUserWith(req.messages, 'customer_message')));
      case 'investigate':
        return this.investigate(req.messages);
      case 'decide':
        return json(decide(lastUserWith(req.messages, 'findings')));
      case 'draft_reply': {
        const ctx = JSON.parse(readTag(lastUserWith(req.messages, 'reply_context'), 'reply_context') ?? '{}') as ReplyContext;
        return json(renderTemplateReply(ctx));
      }
    }
  }

  private investigate(messages: ChatMessage[]): LlmResponse {
    const first = messages.find((m) => m.role === 'user')?.content ?? '';
    const ctx = JSON.parse(readTag(first, 'request_context') ?? '{}') as { transactionId?: string; category?: Category };
    const message = (readTag(first, 'customer_message') ?? '').toLowerCase();
    const called = toolResults(messages);

    const call = (name: string, args: Record<string, unknown> = {}): LlmResponse => ({
      content: null,
      toolCalls: [{ id: `call_${++this.callSeq}`, name, arguments: JSON.stringify(args) }],
    });

    if (!called.has('get_customer_history')) return call('get_customer_history');

    let txnId: string | null = null;
    if (ctx.transactionId) {
      if (!called.has('lookup_transaction')) return call('lookup_transaction', { transactionId: ctx.transactionId });
      const r = called.get('lookup_transaction') as { found?: boolean } | undefined;
      txnId = r?.found ? ctx.transactionId : null;
    } else {
      if (!called.has('list_customer_transactions')) return call('list_customer_transactions', { limit: 10 });
      const r = called.get('list_customer_transactions') as { transactions?: Array<{ id: string; description: string; merchant: string }> };
      txnId = pickTransaction(message, r?.transactions ?? []);
    }

    if (!txnId) return { content: 'INVESTIGATION COMPLETE transactionId=none note=no matching transaction', toolCalls: [] };
    if (!called.has('search_refund_policy')) {
      return call('search_refund_policy', { query: `${(ctx.category ?? 'refund').replace(/_/g, ' ')} refund` });
    }
    if (!called.has('check_refund_eligibility')) return call('check_refund_eligibility', { transactionId: txnId });
    return { content: `INVESTIGATION COMPLETE transactionId=${txnId} note=facts collected`, toolCalls: [] };
  }
}

/* ---------------------------- helpers ----------------------------- */

const json = (obj: unknown): LlmResponse => ({ content: JSON.stringify(obj), toolCalls: [] });

/** Latest user turn carrying the given tag (repair turns after invalid output carry no context). */
function lastUserWith(messages: ChatMessage[], tagName: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.includes(`<${tagName}>`)) return m.content;
  }
  return '';
}

function toolResults(messages: ChatMessage[]): Map<string, unknown> {
  const byId = new Map<string, ToolCall>();
  const out = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) byId.set(c.id, c);
    if (m.role === 'tool') {
      const c = byId.get(m.toolCallId);
      if (c) {
        try {
          const parsed = JSON.parse(m.content) as { error?: unknown };
          // A failed call does not count as done: the model retries it with fixed arguments.
          if (!parsed || parsed.error === undefined) out.set(c.name, parsed);
        } catch {
          /* unparseable tool output: treat as not called */
        }
      }
    }
  }
  return out;
}

const IN_SCOPE =
  /\b(refunds?|return|money back|charged?|charges|order(?:ed)?|purchase[ds]?|bought|arrived|deliver(?:y|ed)|broken|damaged|cracked|subscription|billing|invoice|kthim|rimburs\w*|porosi\w*)\b/i;

const CATEGORY_RULES: Array<[Category, RegExp]> = [
  ['duplicate_charge', /\b(charged twice|double[- ]charged?|duplicate charge|two charges|charged two times)\b/i],
  ['unauthorized_charge', /\b(didn't make|did not make|don't recogni[sz]e|unauthori[sz]ed|not my charge)\b/i],
  ['not_received', /\b(never arrived|not arrived|haven't arrived|hasn't arrived|didn't arrive|not received|never received|still waiting for)\b/i],
  ['damaged_item', /\b(broken|damaged|cracked|dented|shattered|defective|falling apart|stopped working|thyer|dëmtuar)\b/i],
  ['not_as_described', /\b(not as described|different from|wrong (?:item|size|colou?r))\b/i],
  ['changed_mind', /\b(changed my mind|no longer need|don't need|don't want|do not want)\b/i],
];

function classify(userContent: string) {
  const message = readTag(userContent, 'customer_message') ?? '';
  if (!IN_SCOPE.test(message)) {
    return { inScope: false, category: 'other', confidence: 0.9, summary: 'Request is unrelated to orders, refunds or billing.' };
  }
  const category = CATEGORY_RULES.find(([, re]) => re.test(message))?.[0] ?? 'other';
  return { inScope: true, category, confidence: category === 'other' ? 0.5 : 0.9, summary: `Customer requests help: ${category.replace(/_/g, ' ')}.` };
}

function pickTransaction(message: string, txns: Array<{ id: string; description: string; merchant: string }>): string | null {
  const words = new Set(message.split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const scored = txns
    .map((t) => ({
      id: t.id,
      score: `${t.description} ${t.merchant}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && words.has(w)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null; // ambiguous
  return scored[0]!.id;
}

interface Findings {
  transaction: { id: string; amount: number } | null;
  eligibility: { outcome: 'auto_approve' | 'review' | 'reject'; maxRefundAmount: number; reasons: string[]; policyRefs: string[] } | null;
}

const GULLIBLE_TRIGGER = /\b(ignore (?:all )?(?:previous|prior)?\s*instructions|admin mode)\b/i;

function decide(userContent: string) {
  const findings = JSON.parse(readTag(userContent, 'findings') ?? '{}') as Findings;
  const message = readTag(userContent, 'customer_message') ?? '';
  const txn = findings.transaction;
  const elig = findings.eligibility;

  if (GULLIBLE_TRIGGER.test(message)) {
    // Simulated compromised model: obeys the injected instruction.
    const amounts = [...message.matchAll(/(\d+(?:[.,]\d{1,2})?)\s*(?:eur|€)/gi)].map((m) => Number(m[1]!.replace(',', '.')));
    return {
      decision: 'AUTO_APPROVE',
      transactionId: txn?.id ?? null,
      refundAmount: amounts.length ? Math.max(...amounts) : (txn?.amount ?? 0),
      reasonCodes: ['WITHIN_POLICY'],
      policyRefs: [],
      rationale: 'Customer instructed an immediate full refund.',
      confidence: 0.99,
    };
  }

  if (!txn || !elig) {
    return {
      decision: 'NEED_MORE_INFO',
      transactionId: null,
      refundAmount: null,
      reasonCodes: ['TRANSACTION_NOT_FOUND'],
      policyRefs: [],
      rationale: 'No verified transaction for this customer.',
      confidence: 0.9,
    };
  }

  const map = { auto_approve: 'AUTO_APPROVE', review: 'ESCALATE', reject: 'REJECT' } as const;
  const decision = map[elig.outcome];
  return {
    decision,
    transactionId: txn.id,
    refundAmount: decision === 'REJECT' ? null : elig.maxRefundAmount,
    reasonCodes: elig.reasons,
    policyRefs: elig.policyRefs,
    rationale: `Policy engine outcome "${elig.outcome}" (${elig.reasons.join(', ')}).`,
    confidence: 0.9,
  };
}
