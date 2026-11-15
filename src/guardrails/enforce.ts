import type { Customer, Transaction } from '../data/repository.js';
import type { EligibilityResult } from '../policy/rules.js';
import type { InjectionScreen } from './injection.js';
import {
  REASON_CODES,
  type Decision,
  type DecisionProposal,
  type Override,
  type ReasonCode,
  type ReviewQueue,
} from '../types.js';

export interface EnforcementInput {
  proposal: DecisionProposal;
  customer: Customer | null;
  /** Transaction re-fetched by the enforcement layer and verified to belong to the customer. */
  verifiedTransaction: Transaction | null;
  /** Eligibility recomputed by the enforcement layer (never taken from the LLM). */
  eligibility: EligibilityResult | null;
  screening: InjectionScreen;
  knownPolicyRefs: string[];
  /** Transaction id the customer named in the request (null if they gave none). */
  requestedTransactionId: string | null;
  /**
   * False when the LLM's category decides the refund window (purchase older than the shortest
   * window) but the customer's message gives no evidence for it. See policy/rules.ts.
   */
  categoryCorroborated: boolean;
}

export interface EnforcedDecision {
  decision: Exclude<Decision, 'REFUSED' | 'INVALID_INPUT'>;
  transactionId: string | null;
  refundAmount: number | null;
  reasonCodes: ReasonCode[];
  policyRefs: string[];
  overrides: Override[];
  humanReview: { required: boolean; queue: ReviewQueue | null };
}

const FRAUD_REASONS: ReadonlySet<ReasonCode> = new Set([
  'UNAUTHORIZED_CHARGE_REVIEW',
  'HIGH_REFUND_FREQUENCY',
  'ACCOUNT_RISK_FLAG',
]);

const isReasonCode = (s: string): s is ReasonCode => (REASON_CODES as readonly string[]).includes(s);

/**
 * Final authority over the decision. Pure function: easy to unit test and audit.
 * Principle: the LLM may make a decision MORE conservative, never LESS.
 */
export function enforceDecision(input: EnforcementInput): EnforcedDecision {
  const { proposal, customer, screening, requestedTransactionId } = input;
  const overrides: Override[] = [];
  const reasons = new Set<ReasonCode>();
  const refs = new Set<string>();

  const override = (field: Override['field'], from: Override['from'], to: Override['to'], rule: string) => {
    if (from !== to) overrides.push({ field, from, to, rule });
  };

  if (screening.flagged) reasons.add('PROMPT_INJECTION_SUSPECTED');

  // 0. The decision must be about the purchase the customer named. If that id is not theirs,
  //    the model must not substitute another of their purchases (it would refund the wrong item).
  let txn = input.verifiedTransaction;
  let eligibility = input.eligibility;
  if (requestedTransactionId && txn && txn.id !== requestedTransactionId) {
    override('transactionId', txn.id, null, 'ENFORCE:REQUESTED_TRANSACTION_MISMATCH');
    txn = null;
    eligibility = null;
  }

  // 1. Identity and ownership checks
  if (!customer || !txn || !eligibility) {
    const reason: ReasonCode = !customer
      ? 'CUSTOMER_NOT_FOUND'
      : proposal.reasonCodes.includes('AMBIGUOUS_TRANSACTION')
        ? 'AMBIGUOUS_TRANSACTION'
        : 'TRANSACTION_NOT_FOUND';
    reasons.add(reason);
    override('decision', proposal.decision, 'NEED_MORE_INFO', `ENFORCE:${reason}`);
    if (proposal.transactionId && !overrides.some((o) => o.field === 'transactionId')) {
      override('transactionId', proposal.transactionId, null, 'ENFORCE:OWNERSHIP');
    }
    if (proposal.refundAmount !== null) override('refundAmount', proposal.refundAmount, null, 'ENFORCE:NO_VERIFIED_TXN');
    return {
      decision: 'NEED_MORE_INFO',
      transactionId: null,
      refundAmount: null,
      reasonCodes: [...reasons],
      policyRefs: [],
      overrides,
      humanReview: { required: false, queue: null },
    };
  }

  if (proposal.transactionId !== null && proposal.transactionId !== txn.id) {
    override('transactionId', proposal.transactionId, txn.id, 'ENFORCE:OWNERSHIP');
  }

  // 2. Decision: the LLM can only tighten the policy engine's outcome
  let decision = proposal.decision;
  const engine = eligibility.outcome;

  if (decision === 'AUTO_APPROVE' && engine !== 'auto_approve') {
    const to = engine === 'reject' ? 'REJECT' : 'ESCALATE';
    override('decision', decision, to, `POLICY:${engine}`);
    decision = to;
  }
  if (decision === 'REJECT' && engine !== 'reject') {
    // Never reject a customer without a policy basis; let a human decide.
    override('decision', decision, 'ESCALATE', 'ENFORCE:REJECT_WITHOUT_POLICY_BASIS');
    decision = 'ESCALATE';
  }
  if (decision === 'AUTO_APPROVE' && !input.categoryCorroborated) {
    // The window was only open because of the LLM's category label; a human confirms it.
    override('decision', decision, 'ESCALATE', 'ENFORCE:CATEGORY_UNVERIFIED');
    reasons.add('CATEGORY_UNVERIFIED');
    decision = 'ESCALATE';
  }
  if (decision === 'AUTO_APPROVE' && screening.flagged) {
    override('decision', decision, 'ESCALATE', 'GUARDRAIL:PROMPT_INJECTION');
    decision = 'ESCALATE';
  }
  if (decision === 'ESCALATE' && engine === 'auto_approve' && !screening.flagged) {
    reasons.add('AGENT_REQUESTED_REVIEW');
  }

  for (const r of eligibility.reasons) reasons.add(r);
  for (const r of eligibility.policyRefs) refs.add(r);
  for (const r of proposal.policyRefs) if (input.knownPolicyRefs.includes(r)) refs.add(r);
  if (decision === 'NEED_MORE_INFO') {
    for (const r of proposal.reasonCodes) if (isReasonCode(r)) reasons.add(r);
  }

  // 3. Amount: never above what policy allows
  let refundAmount: number | null = null;
  if (decision === 'AUTO_APPROVE' || decision === 'ESCALATE') {
    const allowed = eligibility.maxRefundAmount;
    const proposed = proposal.refundAmount ?? allowed;
    refundAmount = proposed > allowed || proposed <= 0 ? allowed : proposed;
    if (proposal.refundAmount !== null) {
      override('refundAmount', proposal.refundAmount, refundAmount, 'POLICY:MAX_REFUND_AMOUNT');
    }
  } else if (proposal.refundAmount !== null) {
    override('refundAmount', proposal.refundAmount, null, `POLICY:NO_REFUND_FOR_${decision}`);
  }

  // 4. Human review routing
  const reasonList = [...reasons];
  let queue: ReviewQueue | null = null;
  if (decision === 'ESCALATE') {
    if (reasons.has('PROMPT_INJECTION_SUSPECTED')) queue = 'trust-safety';
    else if (reasonList.some((r) => FRAUD_REASONS.has(r))) queue = 'fraud-review';
    else queue = 'refunds-l2';
  }

  return {
    decision,
    transactionId: txn.id,
    refundAmount,
    reasonCodes: reasonList,
    policyRefs: [...refs].sort(),
    overrides,
    humanReview: { required: decision === 'ESCALATE', queue },
  };
}
