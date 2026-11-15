import { z } from 'zod';
import type { Customer, Repository, Transaction } from '../data/repository.js';
import type { PolicyIndex } from '../policy/policyDocs.js';
import { evaluateEligibility } from '../policy/rules.js';
import type { Category } from '../types.js';
import type { ToolSpec } from '../llm/types.js';

/**
 * Tool context is built by the orchestrator from the VALIDATED request, never from LLM output.
 * The authenticated customer is fixed here, so tools cannot be pointed at another account.
 */
export interface ToolContext {
  repo: Repository;
  policy: PolicyIndex;
  customer: Customer | null;
  /** Current request id: earlier decisions from other requests count as prior refunds. */
  requestId: string;
  category: Category;
  requestedAmount: number | undefined;
  now: Date;
  autoApproveLimit: number;
}

interface ToolDefinition<A extends z.ZodType> {
  spec: ToolSpec;
  args: A;
  run(args: z.infer<A>, ctx: ToolContext): unknown;
}

const txnIdArg = z.string().regex(/^txn_[A-Za-z0-9]{1,32}$/);

/** Only fields the agent needs; internal ids of other systems are not exposed. */
export function publicTransaction(t: Transaction) {
  return {
    id: t.id,
    amount: t.amount,
    currency: t.currency,
    merchant: t.merchant,
    description: t.description,
    createdAt: t.createdAt,
    status: t.status,
    productType: t.productType,
    shipment: t.shipment,
  };
}

export type PublicTransaction = ReturnType<typeof publicTransaction>;

const NO_ACCOUNT ={ found: false, reason: 'no_account_for_requesting_email' } as const;

function defineTool<A extends z.ZodType>(def: ToolDefinition<A>): ToolDefinition<A> {
  return def;
}

export const TOOLS = [
  defineTool({
    spec: {
      name: 'get_customer_history',
      description:
        'Get the requesting customer profile and refund history (account age, refunds in the last 90 days, chargebacks, risk flag). Takes no arguments; always scoped to the requesting customer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    args: z.object({}).strict(),
    run: (_args, ctx) => {
      const c = ctx.customer;
      if (!c) return NO_ACCOUNT;
      const accountAgeDays = Math.floor((ctx.now.getTime() - Date.parse(c.accountCreatedAt)) / 86_400_000);
      return {
        found: true,
        customerId: c.id,
        firstName: c.name.split(' ')[0],
        accountAgeDays,
        refundsLast90Days: c.refundsLast90Days,
        chargebacksLast12Months: c.chargebacksLast12Months,
        riskFlag: c.riskFlag,
        tier: c.tier,
      };
    },
  }),
  defineTool({
    spec: {
      name: 'lookup_transaction',
      description:
        'Look up one transaction by id. Only returns transactions that belong to the requesting customer; otherwise found=false.',
      parameters: {
        type: 'object',
        properties: { transactionId: { type: 'string', description: 'Transaction id, e.g. txn_1001' } },
        required: ['transactionId'],
        additionalProperties: false,
      },
    },
    args: z.object({ transactionId: txnIdArg }).strict(),
    run: ({ transactionId }, ctx) => {
      if (!ctx.customer) return NO_ACCOUNT;
      const t = ctx.repo.getTransactionForCustomer(ctx.customer.id, transactionId);
      // Same response for "does not exist" and "belongs to someone else": no enumeration.
      return t ? { found: true, transaction: publicTransaction(t) } : { found: false, reason: 'not_found_for_customer' };
    },
  }),
  defineTool({
    spec: {
      name: 'list_customer_transactions',
      description:
        'List the most recent transactions of the requesting customer. Use when the customer did not provide a transaction id.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 10)' } },
        additionalProperties: false,
      },
    },
    args: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
    run: ({ limit }, ctx) => {
      if (!ctx.customer) return NO_ACCOUNT;
      return {
        found: true,
        transactions: ctx.repo.listTransactionsForCustomer(ctx.customer.id, limit ?? 10).map(publicTransaction),
      };
    },
  }),
  defineTool({
    spec: {
      name: 'search_refund_policy',
      description: 'Search the internal refund policy. Returns the most relevant sections with their ids (RP-n).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords, e.g. "damaged item refund window"' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    args: z.object({ query: z.string().min(2).max(200) }).strict(),
    run: ({ query }, ctx) => ({ sections: ctx.policy.search(query, 3) }),
  }),
  defineTool({
    spec: {
      name: 'check_refund_eligibility',
      description:
        'Run the deterministic refund policy engine for one of the customer\'s transactions. Returns outcome (auto_approve | review | reject), max refund amount, reason codes and the rule checks. The request category is fixed by intake.',
      parameters: {
        type: 'object',
        properties: { transactionId: { type: 'string', description: 'Transaction id, e.g. txn_1001' } },
        required: ['transactionId'],
        additionalProperties: false,
      },
    },
    args: z.object({ transactionId: txnIdArg }).strict(),
    run: ({ transactionId }, ctx) => {
      if (!ctx.customer) return NO_ACCOUNT;
      const t = ctx.repo.getTransactionForCustomer(ctx.customer.id, transactionId);
      if (!t) return { found: false, reason: 'not_found_for_customer' };
      return {
        found: true,
        transactionId: t.id,
        transaction: publicTransaction(t),
        category: ctx.category,
        ...evaluateEligibility({
          transaction: t,
          customer: ctx.customer,
          category: ctx.category,
          requestedAmount: ctx.requestedAmount,
          now: ctx.now,
          autoApproveLimit: ctx.autoApproveLimit,
          duplicates: ctx.repo.findPossibleDuplicates(t),
          priorDecisions: ctx.repo.priorDecisionsFor(t.id, ctx.requestId),
        }),
      };
    },
  }),
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);
export type ToolName = (typeof TOOLS)[number]['spec']['name'];

export interface ToolExecution {
  name: string;
  ok: boolean;
  result: unknown;
  error?: string;
}

/**
 * Validates and executes one tool call. Errors are returned to the model as data
 * (so it can recover) instead of crashing the workflow.
 */
export function executeTool(name: string, rawArgs: string, ctx: ToolContext): ToolExecution {
  const tool = TOOLS.find((t) => t.spec.name === name);
  if (!tool) return { name, ok: false, result: null, error: `Unknown tool "${name}"` };

  let parsed: unknown;
  try {
    parsed = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return { name, ok: false, result: null, error: 'Arguments are not valid JSON' };
  }
  const args = tool.args.safeParse(parsed);
  if (!args.success) {
    return { name, ok: false, result: null, error: `Invalid arguments: ${z.prettifyError(args.error)}` };
  }
  try {
    // The cast is safe: args were validated against this tool's own schema.
    const result = (tool.run as (a: unknown, c: ToolContext) => unknown)(args.data, ctx);
    return { name, ok: true, result };
  } catch (err) {
    return { name, ok: false, result: null, error: `Tool failed: ${(err as Error).message}` };
  }
}
