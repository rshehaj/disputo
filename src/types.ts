import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export const RefundRequestSchema = z.object({
  requestId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'requestId may only contain letters, digits, "_" and "-"'),
  customerEmail: z.email().max(254),
  transactionId: z
    .string()
    .regex(/^txn_[A-Za-z0-9]{1,32}$/, 'transactionId must look like "txn_123"')
    .optional(),
  requestedAmount: z.number().positive().max(100_000).optional(),
  currency: z.enum(['EUR']).default('EUR'),
  message: z.string().trim().min(10, 'message is too short to act on').max(4000),
  channel: z.enum(['email', 'chat', 'web_form']).default('web_form'),
  receivedAt: z.iso.datetime().optional(),
});
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

/* ------------------------------------------------------------------ */
/* Domain enums                                                        */
/* ------------------------------------------------------------------ */

export const CATEGORIES = [
  'damaged_item',
  'not_received',
  'not_as_described',
  'duplicate_charge',
  'unauthorized_charge',
  'changed_mind',
  'other',
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const DECISIONS = [
  'AUTO_APPROVE',
  'ESCALATE',
  'REJECT',
  'NEED_MORE_INFO',
  'REFUSED',
  'INVALID_INPUT',
] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const REASON_CODES = [
  'WITHIN_POLICY',
  'OUTSIDE_REFUND_WINDOW',
  'ALREADY_REFUNDED',
  'CHARGEBACK_IN_PROGRESS',
  'TRANSACTION_NOT_SETTLED',
  'AMOUNT_EXCEEDS_TRANSACTION',
  'ABOVE_AUTO_APPROVE_LIMIT',
  'HIGH_REFUND_FREQUENCY',
  'ACCOUNT_RISK_FLAG',
  'CARRIER_REPORTS_DELIVERED',
  'SHIPMENT_STILL_IN_TRANSIT',
  'DUPLICATE_CHARGE_VERIFIED',
  'DUPLICATE_CHARGE_NOT_FOUND',
  'UNAUTHORIZED_CHARGE_REVIEW',
  'UNCLEAR_CATEGORY',
  'PROMPT_INJECTION_SUSPECTED',
  'AGENT_REQUESTED_REVIEW',
  'TRANSACTION_NOT_FOUND',
  'AMBIGUOUS_TRANSACTION',
  'CUSTOMER_NOT_FOUND',
  'OUT_OF_SCOPE',
  'INVALID_INPUT',
  'AGENT_ERROR',
  'REFUND_ALREADY_APPROVED',
  'REQUEST_ALREADY_IN_REVIEW',
  'CATEGORY_UNVERIFIED',
] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const REVIEW_QUEUES = ['refunds-l2', 'fraud-review', 'trust-safety'] as const;
export type ReviewQueue = (typeof REVIEW_QUEUES)[number];

/* ------------------------------------------------------------------ */
/* LLM structured outputs (validated, never trusted blindly)          */
/* ------------------------------------------------------------------ */

export const ClassificationSchema = z.object({
  inScope: z.boolean(),
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(300),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const DecisionProposalSchema = z.object({
  decision: z.enum(['AUTO_APPROVE', 'ESCALATE', 'REJECT', 'NEED_MORE_INFO']),
  transactionId: z.string().nullable(),
  refundAmount: z.number().nonnegative().nullable(),
  reasonCodes: z.array(z.string()).max(10),
  policyRefs: z.array(z.string()).max(10),
  rationale: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
});
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>;

export const ReplyDraftSchema = z.object({
  subject: z.string().min(3).max(120),
  body: z.string().min(20).max(2000),
});
export type ReplyDraft = z.infer<typeof ReplyDraftSchema>;

/* ------------------------------------------------------------------ */
/* Final agent result                                                  */
/* ------------------------------------------------------------------ */

export const OverrideSchema = z.object({
  field: z.enum(['decision', 'refundAmount', 'transactionId']),
  from: z.union([z.string(), z.number(), z.null()]),
  to: z.union([z.string(), z.number(), z.null()]),
  rule: z.string(),
});
export type Override = z.infer<typeof OverrideSchema>;

export const AgentResultSchema = z.object({
  requestId: z.string(),
  status: z.enum(['completed', 'invalid_input', 'refused', 'failed_safe']),
  decision: DecisionSchema,
  category: CategorySchema.nullable(),
  transactionId: z.string().nullable(),
  refundAmount: z.number().nullable(),
  currency: z.literal('EUR'),
  reasonCodes: z.array(ReasonCodeSchema),
  policyRefs: z.array(z.string()),
  humanReview: z.object({
    required: z.boolean(),
    queue: z.enum(REVIEW_QUEUES).nullable(),
  }),
  guardrails: z.object({
    injectionFlagged: z.boolean(),
    injectionSignals: z.array(z.string()),
    overrides: z.array(OverrideSchema),
    replySource: z.enum(['llm', 'template']).nullable(),
  }),
  agentRationale: z.string().nullable(),
  customerReply: ReplyDraftSchema.nullable(),
  validationErrors: z.array(z.string()),
  summary: z.string(),
  trace: z.object({
    traceId: z.string(),
    llmCalls: z.number().int(),
    toolCalls: z.number().int(),
    durationMs: z.number(),
    file: z.string().nullable(),
  }),
  meta: z.object({
    agentVersion: z.string(),
    promptVersion: z.string(),
    llm: z.string(),
    decidedAt: z.string(),
  }),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const AGENT_VERSION = '0.1.0';
