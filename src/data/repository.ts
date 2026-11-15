import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const CustomerSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  accountCreatedAt: z.iso.datetime(),
  refundsLast90Days: z.number().int().nonnegative(),
  chargebacksLast12Months: z.number().int().nonnegative(),
  riskFlag: z.boolean(),
  tier: z.enum(['standard', 'gold']),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  amount: z.number().positive(),
  currency: z.literal('EUR'),
  merchant: z.string(),
  description: z.string(),
  createdAt: z.iso.datetime(),
  status: z.enum(['settled', 'pending', 'refunded', 'chargeback_open']),
  productType: z.enum(['physical', 'digital', 'subscription']),
  shipment: z.object({
    status: z.enum(['none', 'not_shipped', 'in_transit', 'delivered']),
    deliveredAt: z.iso.datetime().optional(),
    estimatedDeliveryAt: z.iso.datetime().optional(),
  }),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export interface StoredDecision {
  requestId: string;
  decision: string;
  transactionId: string | null;
  refundAmount: number | null;
  decidedAt: string;
}

/**
 * Small data-access layer. In production this would wrap the payments DB / PSP APIs.
 * Every read that the agent can trigger is scoped to a customer id so a tool call
 * can never read another customer's data (no IDOR via the LLM).
 */
export class Repository {
  private readonly customers: Customer[];
  private readonly transactions: Transaction[];
  private readonly decisions: StoredDecision[] = [];

  constructor(
    data: { customers: Customer[]; transactions: Transaction[] },
    private readonly decisionLogPath: string | null = null,
  ) {
    this.customers = z.array(CustomerSchema).parse(data.customers);
    this.transactions = z.array(TransactionSchema).parse(data.transactions);
  }

  static fromFixtures(dir = 'data', decisionLogPath: string | null = null): Repository {
    const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return new Repository(
      {
        customers: read('customers.json') as Customer[],
        transactions: read('transactions.json') as Transaction[],
      },
      decisionLogPath,
    );
  }

  findCustomerByEmail(email: string): Customer | null {
    const needle = email.trim().toLowerCase();
    return this.customers.find((c) => c.email.toLowerCase() === needle) ?? null;
  }

  /** Returns the transaction only if it belongs to the given customer. */
  getTransactionForCustomer(customerId: string, transactionId: string): Transaction | null {
    return (
      this.transactions.find((t) => t.id === transactionId && t.customerId === customerId) ?? null
    );
  }

  listTransactionsForCustomer(customerId: string, limit = 10): Transaction[] {
    return this.transactions
      .filter((t) => t.customerId === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** Other charges from the same customer + merchant + amount within 24h. */
  findPossibleDuplicates(txn: Transaction): Transaction[] {
    const t0 = Date.parse(txn.createdAt);
    return this.transactions.filter(
      (t) =>
        t.id !== txn.id &&
        t.customerId === txn.customerId &&
        t.merchant === txn.merchant &&
        t.amount === txn.amount &&
        t.status !== 'refunded' &&
        Math.abs(Date.parse(t.createdAt) - t0) <= 24 * 3600 * 1000,
    );
  }

  recordDecision(decision: StoredDecision): void {
    this.decisions.push(decision);
    if (this.decisionLogPath) {
      mkdirSync(dirname(this.decisionLogPath), { recursive: true });
      appendFileSync(this.decisionLogPath, JSON.stringify(decision) + '\n');
    }
  }

  listDecisions(): readonly StoredDecision[] {
    return this.decisions;
  }
}
