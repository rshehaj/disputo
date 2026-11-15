import { Annotation } from '@langchain/langgraph';
import type { Customer, Transaction } from '../data/repository.js';
import type { InjectionScreen } from '../guardrails/injection.js';
import type { PolicySection } from '../policy/policyDocs.js';
import type { EligibilityResult } from '../policy/rules.js';
import type { PublicTransaction } from '../tools/index.js';
import type {
  AgentResult,
  Classification,
  Decision,
  DecisionProposal,
  Override,
  ReasonCode,
  RefundRequest,
  ReplyDraft,
  ReviewQueue,
} from '../types.js';

export interface Findings {
  customerHistory: unknown | null;
  transaction: PublicTransaction | null;
  eligibility: (EligibilityResult & { transactionId: string }) | null;
  policySections: PolicySection[];
  investigationNote: string | null;
  toolCalls: number;
  hitIterationLimit: boolean;
}

export const emptyFindings = (): Findings => ({
  customerHistory: null,
  transaction: null,
  eligibility: null,
  policySections: [],
  investigationNote: null,
  toolCalls: 0,
  hitIterationLimit: false,
});

export interface Outcome {
  status: AgentResult['status'];
  decision: Decision;
  transactionId: string | null;
  refundAmount: number | null;
  reasonCodes: ReasonCode[];
  policyRefs: string[];
  overrides: Override[];
  humanReview: { required: boolean; queue: ReviewQueue | null };
}

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_prev, next) => next, default: init });

/** Shared, explicit state passed between graph nodes. */
export const AgentState = Annotation.Root({
  rawInput: last<unknown>(() => null),
  now: last<string>(() => new Date().toISOString()),
  request: last<RefundRequest | null>(() => null),
  validationErrors: last<string[]>(() => []),
  screening: last<InjectionScreen | null>(() => null),
  customer: last<Customer | null>(() => null),
  classification: last<Classification | null>(() => null),
  findings: last<Findings>(emptyFindings),
  proposal: last<DecisionProposal | null>(() => null),
  verifiedTransaction: last<Transaction | null>(() => null),
  outcome: last<Outcome | null>(() => null),
  reply: last<{ draft: ReplyDraft; source: 'llm' | 'template' } | null>(() => null),
  failure: last<{ node: string; message: string } | null>(() => null),
  result: last<AgentResult | null>(() => null),
});

export type AgentStateType = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
