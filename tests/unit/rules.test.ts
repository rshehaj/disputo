import { describe, expect, it } from 'vitest';
import type { Customer, Transaction } from '../../src/data/repository.js';
import { evaluateEligibility, type EligibilityInput } from '../../src/policy/rules.js';

const customer: Customer = {
  id: 'cus_x',
  email: 'x@example.com',
  name: 'X Y',
  accountCreatedAt: '2024-01-01T00:00:00Z',
  refundsLast90Days: 0,
  chargebacksLast12Months: 0,
  riskFlag: false,
  tier: 'standard',
};
const txn: Transaction = {
  id: 'txn_1',
  customerId: 'cus_x',
  amount: 50,
  currency: 'EUR',
  merchant: 'Shop',
  description: 'Lamp',
  createdAt: '2026-11-01T00:00:00Z',
  status: 'settled',
  productType: 'physical',
  shipment: { status: 'delivered' },
};
const base = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  transaction: txn,
  customer,
  category: 'damaged_item',
  now: new Date('2026-11-10T00:00:00Z'),
  autoApproveLimit: 200,
  duplicates: [],
  ...over,
});

describe('evaluateEligibility', () => {
  it('auto-approves a small, recent, clean request', () => {
    const r = evaluateEligibility(base());
    expect(r.outcome).toBe('auto_approve');
    expect(r.maxRefundAmount).toBe(50);
    expect(r.reasons).toEqual(['WITHIN_POLICY']);
  });

  it('rejects outside the category window (boundary: day 30 ok, day 31 not)', () => {
    expect(evaluateEligibility(base({ now: new Date('2026-12-01T00:00:00Z') })).outcome).toBe('auto_approve');
    const r = evaluateEligibility(base({ now: new Date('2026-12-02T00:00:00Z') }));
    expect(r.outcome).toBe('reject');
    expect(r.reasons).toContain('OUTSIDE_REFUND_WINDOW');
  });

  it('uses a shorter window for change of mind', () => {
    const r = evaluateEligibility(base({ category: 'changed_mind', now: new Date('2026-11-20T00:00:00Z') }));
    expect(r.outcome).toBe('reject');
  });

  it('rejects already refunded transactions even if everything else is fine', () => {
    const r = evaluateEligibility(base({ transaction: { ...txn, status: 'refunded' } }));
    expect(r).toMatchObject({ outcome: 'reject', reasons: ['ALREADY_REFUNDED'] });
  });

  it('escalates above the auto-approve limit', () => {
    const r = evaluateEligibility(base({ transaction: { ...txn, amount: 200.01 } }));
    expect(r.outcome).toBe('review');
    expect(r.reasons).toContain('ABOVE_AUTO_APPROVE_LIMIT');
  });

  it('caps the refund at the transaction amount and flags over-asks', () => {
    const r = evaluateEligibility(base({ requestedAmount: 500 }));
    expect(r.maxRefundAmount).toBe(50);
    expect(r.outcome).toBe('review');
    expect(r.reasons).toContain('AMOUNT_EXCEEDS_TRANSACTION');
  });

  it('allows partial refunds below the transaction amount', () => {
    expect(evaluateEligibility(base({ requestedAmount: 20 })).maxRefundAmount).toBe(20);
  });

  it('routes risky customers to review', () => {
    expect(evaluateEligibility(base({ customer: { ...customer, refundsLast90Days: 3 } })).reasons).toContain('HIGH_REFUND_FREQUENCY');
    expect(evaluateEligibility(base({ customer: { ...customer, riskFlag: true } })).reasons).toContain('ACCOUNT_RISK_FLAG');
  });

  it('verifies duplicate charges', () => {
    expect(evaluateEligibility(base({ category: 'duplicate_charge', duplicates: [txn] })).reasons).toEqual(['DUPLICATE_CHARGE_VERIFIED']);
    expect(evaluateEligibility(base({ category: 'duplicate_charge' })).outcome).toBe('review');
  });

  it('asks to wait when the parcel is still in transit', () => {
    const inTransit = { ...txn, shipment: { status: 'in_transit' as const, estimatedDeliveryAt: '2026-11-15T00:00:00Z' } };
    expect(evaluateEligibility(base({ category: 'not_received', transaction: inTransit })).reasons).toContain('SHIPMENT_STILL_IN_TRANSIT');
    expect(evaluateEligibility(base({ category: 'not_received' })).reasons).toContain('CARRIER_REPORTS_DELIVERED');
  });

  it('always sends unauthorized charges to review', () => {
    expect(evaluateEligibility(base({ category: 'unauthorized_charge' })).outcome).toBe('review');
  });
});
