import type { Customer, Transaction } from '../data/repository.js';
import type { Category, ReasonCode } from '../types.js';

/**
 * Deterministic refund policy engine. This is the source of truth for money movement:
 * the LLM can propose, but only outcomes allowed here can be executed.
 * Each rule maps to a section of policies/refund-policy.md.
 */

export type EligibilityOutcome = 'auto_approve' | 'review' | 'reject';

export interface RuleCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface EligibilityResult {
  outcome: EligibilityOutcome;
  maxRefundAmount: number;
  reasons: ReasonCode[];
  policyRefs: string[];
  checks: RuleCheck[];
  daysSincePurchase: number;
}

export interface EligibilityInput {
  transaction: Transaction;
  customer: Customer;
  category: Category;
  requestedAmount?: number | undefined;
  now: Date;
  autoApproveLimit: number;
  duplicates: Transaction[];
  /** Earlier decisions on this transaction from OTHER requests (same requestId = a retry, not a new claim). */
  priorDecisions?: ReadonlyArray<{ decision: string }>;
}

export const REFUND_WINDOW_DAYS: Record<Category, number> = {
  damaged_item: 30,
  not_as_described: 30,
  not_received: 45,
  changed_mind: 14,
  duplicate_charge: 60,
  unauthorized_charge: 60,
  other: 30,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { transaction: txn, customer, category, now, autoApproveLimit } = input;
  const rejects: ReasonCode[] = [];
  const reviews: ReasonCode[] = [];
  const positives: ReasonCode[] = [];
  const refs = new Set<string>();
  const checks: RuleCheck[] = [];

  const check = (rule: string, passed: boolean, detail: string): boolean => {
    checks.push({ rule, passed, detail });
    return passed;
  };

  const daysSincePurchase = Math.floor((now.getTime() - Date.parse(txn.createdAt)) / 86_400_000);
  const maxRefundAmount = round2(Math.min(input.requestedAmount ?? txn.amount, txn.amount));

  // RP-3: status
  if (txn.status === 'refunded') {
    check('RP-3', false, 'Transaction was already refunded');
    rejects.push('ALREADY_REFUNDED');
    refs.add('RP-3');
  } else if (txn.status === 'chargeback_open') {
    check('RP-3', false, 'A chargeback is open for this transaction');
    rejects.push('CHARGEBACK_IN_PROGRESS');
    refs.add('RP-3');
  } else if (txn.status === 'pending') {
    check('RP-3', false, 'Transaction is not settled yet');
    reviews.push('TRANSACTION_NOT_SETTLED');
    refs.add('RP-3');
  } else {
    check('RP-3', true, 'Transaction settled and not refunded');
  }

  // RP-3: a refund already approved by this agent counts as refunded, even before the payout
  // system updates the transaction status. An open escalation must be finished by that human first.
  const prior = input.priorDecisions ?? [];
  if (prior.some((d) => d.decision === 'AUTO_APPROVE')) {
    check('RP-3', false, 'A refund for this transaction was already approved by an earlier request');
    rejects.push('REFUND_ALREADY_APPROVED');
    refs.add('RP-3');
  } else if (prior.some((d) => d.decision === 'ESCALATE')) {
    check('RP-3', false, 'An earlier request for this transaction is waiting for human review');
    reviews.push('REQUEST_ALREADY_IN_REVIEW');
    refs.add('RP-3');
  }

  // RP-1: window
  const window = REFUND_WINDOW_DAYS[category];
  if (!check('RP-1', daysSincePurchase <= window, `${daysSincePurchase} days since purchase, window ${window} days`)) {
    rejects.push('OUTSIDE_REFUND_WINDOW');
    refs.add('RP-1');
  }

  // Category-specific rules
  if (category === 'not_received') {
    refs.add('RP-7');
    const s = txn.shipment;
    if (s.status === 'delivered') {
      check('RP-7', false, 'Carrier reports the parcel as delivered');
      reviews.push('CARRIER_REPORTS_DELIVERED');
    } else if (
      s.status === 'in_transit' &&
      s.estimatedDeliveryAt &&
      now.getTime() <= Date.parse(s.estimatedDeliveryAt)
    ) {
      check('RP-7', false, `Parcel in transit, estimated delivery ${s.estimatedDeliveryAt}`);
      rejects.push('SHIPMENT_STILL_IN_TRANSIT');
    } else {
      check('RP-7', true, `Shipment status ${s.status}, past estimated delivery`);
    }
  }

  if (category === 'duplicate_charge') {
    refs.add('RP-4');
    if (check('RP-4', input.duplicates.length > 0, `${input.duplicates.length} matching charge(s) within 24h`)) {
      positives.push('DUPLICATE_CHARGE_VERIFIED');
    } else {
      reviews.push('DUPLICATE_CHARGE_NOT_FOUND');
    }
  }

  if (category === 'unauthorized_charge') {
    check('RP-5', false, 'Unauthorized charges always go to fraud review');
    reviews.push('UNAUTHORIZED_CHARGE_REVIEW');
    refs.add('RP-5');
  }

  if (category === 'other') {
    check('CATEGORY', false, 'Request category is unclear');
    reviews.push('UNCLEAR_CATEGORY');
  }

  // RP-2: amounts
  if (input.requestedAmount !== undefined && input.requestedAmount > txn.amount) {
    check('RP-2', false, `Requested ${input.requestedAmount} exceeds transaction amount ${txn.amount}`);
    reviews.push('AMOUNT_EXCEEDS_TRANSACTION');
    refs.add('RP-2');
  }
  if (!check('RP-2', maxRefundAmount <= autoApproveLimit, `Refund ${maxRefundAmount} vs auto-approve limit ${autoApproveLimit}`)) {
    reviews.push('ABOVE_AUTO_APPROVE_LIMIT');
    refs.add('RP-2');
  }

  // RP-6: customer risk
  if (!check('RP-6', customer.refundsLast90Days < 3, `${customer.refundsLast90Days} refunds in last 90 days`)) {
    reviews.push('HIGH_REFUND_FREQUENCY');
    refs.add('RP-6');
  }
  if (!check('RP-6', !customer.riskFlag && customer.chargebacksLast12Months === 0, 'Account risk flag / chargebacks')) {
    reviews.push('ACCOUNT_RISK_FLAG');
    refs.add('RP-6');
  }

  let outcome: EligibilityOutcome;
  let reasons: ReasonCode[];
  if (rejects.length > 0) {
    outcome = 'reject';
    reasons = rejects;
  } else if (reviews.length > 0) {
    outcome = 'review';
    reasons = reviews;
  } else {
    outcome = 'auto_approve';
    reasons = positives.length > 0 ? positives : ['WITHIN_POLICY'];
    refs.add('RP-1').add('RP-2');
  }

  return {
    outcome,
    maxRefundAmount,
    reasons: [...new Set(reasons)],
    policyRefs: [...refs].sort(),
    checks,
    daysSincePurchase,
  };
}

/**
 * The category comes from the LLM, and it picks the refund window (RP-1). For categories that
 * no data can confirm, the customer's own words must back the label before a purchase older
 * than the shortest window can be auto-approved. Duplicate, not-received and unauthorized
 * claims are checked against transaction / carrier data instead, so they are not listed here.
 */
const CATEGORY_EVIDENCE: Partial<Record<Category, RegExp>> = {
  damaged_item:
    /\b(damag\w*|broke|broken|crack\w*|shatter\w*|dent\w*|torn|ripped|smashed|defect\w*|faulty|scratch\w*|leak\w*|snapped|falling apart|coming off|stopped working|not working|(?:does|did)n'?t work|won'?t (?:work|turn on|charge)|dead on arrival|thyer\w*|dëmtuar|kaputt|beschädigt|cassé\w*|roto|rotto)\b/i,
  not_as_described:
    /\b(not as (?:described|advertised|pictured|shown)|different (?:from|than|to)|wrong (?:item|size|colou?r|model|product|version)|doesn'?t match|does not match|not what i (?:ordered|expected)|counterfeit|fake|misleading)\b/i,
};

/** Shortest refund window: inside it the category cannot change eligibility, so no evidence is needed. */
export const MIN_REFUND_WINDOW_DAYS = Math.min(...Object.values(REFUND_WINDOW_DAYS));

export function categoryNeedsEvidence(category: Category, daysSincePurchase: number): boolean {
  return category in CATEGORY_EVIDENCE && daysSincePurchase > MIN_REFUND_WINDOW_DAYS;
}

export function messageSupportsCategory(category: Category, message: string): boolean {
  const re = CATEGORY_EVIDENCE[category];
  return re ? re.test(message.normalize('NFKC')) : true;
}
