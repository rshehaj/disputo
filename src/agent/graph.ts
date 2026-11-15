import { END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repository } from '../data/repository.js';
import { enforceDecision } from '../guardrails/enforce.js';
import { screenForInjection } from '../guardrails/injection.js';
import { checkReply } from '../guardrails/replyGuard.js';
import { callLlm, callStructured } from '../llm/reliability.js';
import type { ChatMessage, LlmClient, ToolCall } from '../llm/types.js';
import type { Tracer } from '../observability/tracer.js';
import type { PolicyIndex } from '../policy/policyDocs.js';
import { evaluateEligibility } from '../policy/rules.js';
import {
  CLASSIFY_SYSTEM,
  DECIDE_SYSTEM,
  DRAFT_REPLY_SYSTEM,
  INVESTIGATE_SYSTEM,
  PROMPT_VERSION,
  tag,
} from '../prompts/index.js';
import { renderTemplateReply, type ReplyContext } from '../prompts/templates.js';
import { executeTool, TOOL_SPECS, type ToolContext } from '../tools/index.js';
import {
  AGENT_VERSION,
  AgentResultSchema,
  ClassificationSchema,
  DecisionProposalSchema,
  ReplyDraftSchema,
  RefundRequestSchema,
  type AgentResult,
  type ReplyDraft,
} from '../types.js';
import { AgentState, emptyFindings, type AgentStateType, type AgentStateUpdate, type Findings } from './state.js';
import { buildSummary } from './summary.js';

export interface GraphDeps {
  llm: LlmClient;
  repo: Repository;
  policy: PolicyIndex;
  config: AppConfig;
  tracer: Tracer;
}

type NodeFn = (s: AgentStateType) => Promise<AgentStateUpdate>;

/**
 * Workflow (LangGraph state machine):
 *
 *  validate_input ─invalid─────────────────────────────────────────────┐
 *        │                                                             │
 *  screen_input → classify ─out of scope→ refuse ──────┐               │
 *                    │                                 │               │
 *               investigate (tool loop) → decide → enforce_policy → draft_reply → finalize
 *                    └──── any node error ──→ fail_safe ─┘
 */
export function buildAgentGraph(deps: GraphDeps) {
  const { llm, repo, policy, config, tracer } = deps;

  /** Wraps a node: traced span + exceptions become state.failure (fail closed, never crash). */
  const node =
    (name: string, fn: NodeFn): NodeFn =>
    async (s) => {
      try {
        return await tracer.span('node', name, undefined, () => fn(s), () => undefined);
      } catch (err) {
        tracer.record('guardrail', 'node_failed', { input: { node: name }, error: (err as Error).message });
        return { failure: { node: name, message: (err as Error).message } };
      }
    };

  const toolContext = (s: AgentStateType): ToolContext => ({
    repo,
    policy,
    customer: s.customer,
    category: s.classification?.category ?? 'other',
    requestedAmount: s.request?.requestedAmount,
    now: new Date(s.now),
    autoApproveLimit: config.autoApproveLimit,
  });

  /* ----------------------------- nodes ------------------------------ */

  const validateInput = node('validate_input', async (s) => {
    const parsed = RefundRequestSchema.safeParse(s.rawInput);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
      tracer.record('guardrail', 'input_validation', { output: { valid: false, errors }, status: 'error' });
      return {
        validationErrors: errors,
        outcome: {
          status: 'invalid_input',
          decision: 'INVALID_INPUT',
          transactionId: null,
          refundAmount: null,
          reasonCodes: ['INVALID_INPUT'],
          policyRefs: [],
          overrides: [],
          humanReview: { required: false, queue: null },
        },
      };
    }
    const request = parsed.data;
    tracer.record('guardrail', 'input_validation', { output: { valid: true } });
    return {
      request,
      now: request.receivedAt ?? s.now,
      // Identity comes from the authenticated channel (the e-mail), never from message text.
      customer: repo.findCustomerByEmail(request.customerEmail),
    };
  });

  const screenInput = node('screen_input', async (s) => {
    const screening = screenForInjection(s.request!.message);
    tracer.record('guardrail', 'injection_screen', {
      output: { flagged: screening.flagged, score: screening.score, signals: screening.signals },
    });
    return { screening };
  });

  const classify = node('classify', async (s) => {
    const classification = await callStructured(
      llm,
      {
        purpose: 'classify',
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: tag('customer_message', s.screening!.sanitized) },
        ],
      },
      ClassificationSchema,
      tracer,
    );
    return { classification };
  });

  const refuse = node('refuse', async () => {
    tracer.record('guardrail', 'out_of_scope_refusal', { output: { decision: 'REFUSED' } });
    return {
      outcome: {
        status: 'refused',
        decision: 'REFUSED',
        transactionId: null,
        refundAmount: null,
        reasonCodes: ['OUT_OF_SCOPE'],
        policyRefs: [],
        overrides: [],
        humanReview: { required: false, queue: null },
      },
    };
  });

  const investigate = node('investigate', async (s) => {
    const req = s.request!;
    const ctx = toolContext(s);
    const findings: Findings = emptyFindings();
    const messages: ChatMessage[] = [
      { role: 'system', content: INVESTIGATE_SYSTEM },
      {
        role: 'user',
        content: [
          tag(
            'request_context',
            JSON.stringify({
              transactionId: req.transactionId ?? null,
              requestedAmount: req.requestedAmount ?? null,
              category: s.classification!.category,
              channel: req.channel,
              receivedAt: s.now,
            }),
          ),
          tag('customer_message', s.screening!.sanitized),
        ].join('\n'),
      },
    ];
    const seenCalls = new Set<string>();

    // Step 1 of the plan is always the same call, so the orchestrator makes it instead of
    // trusting the model to (gpt-4o-mini often skipped it). It is added to the conversation
    // as a normal tool call + result, so the model sees it and the trace records it.
    const historyCall: ToolCall = { id: 'orchestrator_customer_history', name: 'get_customer_history', arguments: '{}' };
    const history = await tracer.span('tool', historyCall.name, {}, () =>
      executeTool(historyCall.name, historyCall.arguments, ctx),
    );
    seenCalls.add(callKey(historyCall.name, historyCall.arguments));
    findings.toolCalls++;
    if (history.ok) collectFinding(findings, historyCall.name, history.result);
    messages.push(
      { role: 'assistant', content: null, toolCalls: [historyCall] },
      { role: 'tool', toolCallId: historyCall.id, content: JSON.stringify(history.ok ? history.result : { error: history.error }) },
    );

    for (let i = 0; i < config.maxToolIterations; i++) {
      const res = await callLlm(llm, { purpose: 'investigate', messages, tools: TOOL_SPECS }, tracer);
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      if (res.toolCalls.length === 0) {
        findings.investigationNote = (res.content ?? '').slice(0, 300);
        return { findings };
      }
      for (const call of res.toolCalls) {
        const key = callKey(call.name, call.arguments);
        let content: string;
        if (seenCalls.has(key)) {
          tracer.record('guardrail', 'duplicate_tool_call_blocked', { input: { name: call.name } });
          content = JSON.stringify({ error: 'Duplicate call skipped: you already have this result.' });
        } else {
          seenCalls.add(key);
          findings.toolCalls++;
          const exec = await tracer.span('tool', call.name, safeJson(call.arguments), () =>
            executeTool(call.name, call.arguments, ctx),
          );
          content = JSON.stringify(exec.ok ? exec.result : { error: exec.error });
          if (exec.ok) collectFinding(findings, call.name, exec.result);
        }
        messages.push({ role: 'tool', toolCallId: call.id, content });
      }
    }
    findings.hitIterationLimit = true;
    tracer.record('guardrail', 'max_tool_iterations_reached', { output: { limit: config.maxToolIterations } });
    return { findings };
  });

  const decide = node('decide', async (s) => {
    const f = s.findings;
    const proposal = await callStructured(
      llm,
      {
        purpose: 'decide',
        messages: [
          { role: 'system', content: DECIDE_SYSTEM },
          {
            role: 'user',
            content: [
              tag(
                'findings',
                JSON.stringify({
                  classification: s.classification,
                  customer: f.customerHistory,
                  transaction: f.transaction,
                  eligibility: f.eligibility && {
                    transactionId: f.eligibility.transactionId,
                    outcome: f.eligibility.outcome,
                    maxRefundAmount: f.eligibility.maxRefundAmount,
                    reasons: f.eligibility.reasons,
                    policyRefs: f.eligibility.policyRefs,
                  },
                  policySections: f.policySections.map((p) => ({ id: p.id, title: p.title })),
                  investigationNote: f.investigationNote,
                  requestedAmount: s.request!.requestedAmount ?? null,
                }),
              ),
              tag('customer_message', s.screening!.sanitized),
            ].join('\n'),
          },
        ],
      },
      DecisionProposalSchema,
      tracer,
    );
    return { proposal };
  });

  const enforcePolicy = node('enforce_policy', async (s) => {
    const proposal = s.proposal!;
    const customer = s.customer;
    // Re-derive everything from the source of truth instead of trusting tool output relayed by the LLM.
    // The id the customer named wins: the model may not substitute another of their purchases.
    const candidateId = s.request!.transactionId ?? proposal.transactionId ?? s.findings.transaction?.id ?? null;
    const verified = customer && candidateId ? repo.getTransactionForCustomer(customer.id, candidateId) : null;
    const eligibility =
      verified && customer
        ? evaluateEligibility({
            transaction: verified,
            customer,
            category: s.classification!.category,
            requestedAmount: s.request!.requestedAmount,
            now: new Date(s.now),
            autoApproveLimit: config.autoApproveLimit,
            duplicates: repo.findPossibleDuplicates(verified),
          })
        : null;

    const enforced = enforceDecision({
      proposal,
      customer,
      verifiedTransaction: verified,
      eligibility,
      screening: s.screening!,
      knownPolicyRefs: policy.ids,
      requestedTransactionId: s.request!.transactionId ?? null,
    });
    tracer.record('guardrail', 'policy_enforcement', {
      input: { proposed: proposal.decision, proposedAmount: proposal.refundAmount, engine: eligibility?.outcome ?? null },
      output: { decision: enforced.decision, refundAmount: enforced.refundAmount, overrides: enforced.overrides },
    });
    // If enforcement dropped the transaction, the reply must not describe it either.
    return { verifiedTransaction: enforced.transactionId ? verified : null, outcome: { status: 'completed', ...enforced } };
  });

  const failSafe = node('fail_safe', async (s) => {
    tracer.record('guardrail', 'fail_safe', { output: { failedNode: s.failure?.node, reason: s.failure?.message } });
    return {
      outcome: {
        status: 'failed_safe',
        decision: 'ESCALATE',
        transactionId: null,
        refundAmount: null,
        reasonCodes: ['AGENT_ERROR', ...(s.screening?.flagged ? (['PROMPT_INJECTION_SUSPECTED'] as const) : [])],
        policyRefs: [],
        overrides: [],
        humanReview: { required: true, queue: s.screening?.flagged ? 'trust-safety' : 'refunds-l2' },
      },
    };
  });

  const draftReply = node('draft_reply', async (s) => {
    const o = s.outcome!;
    const ctx: ReplyContext = {
      decision: o.decision,
      customerFirstName: s.customer?.name.split(' ')[0] ?? null,
      refundAmount: o.refundAmount,
      currency: 'EUR',
      transactionDescription: s.verifiedTransaction?.description ?? null,
      reasonCodes: o.reasonCodes,
      estimatedDeliveryAt: s.verifiedTransaction?.shipment.estimatedDeliveryAt ?? null,
    };
    const guardCtx = { decision: o.decision, refundAmount: o.refundAmount, customerEmail: s.request!.customerEmail };
    const fallback = (why: string) => {
      tracer.record('guardrail', 'reply_fallback_template', { output: { why } });
      return { reply: { draft: renderTemplateReply(ctx), source: 'template' as const } };
    };

    // After a failure we do not call the LLM again: deterministic template only.
    if (o.status === 'failed_safe') return fallback('agent failed earlier');

    const messages: ChatMessage[] = [
      { role: 'system', content: DRAFT_REPLY_SYSTEM },
      {
        role: 'user',
        content: [tag('reply_context', JSON.stringify(ctx)), tag('customer_message', s.screening!.sanitized)].join('\n'),
      },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      let draft: ReplyDraft;
      try {
        draft = await callStructured(llm, { purpose: 'draft_reply', messages }, ReplyDraftSchema, tracer, { maxAttempts: 2 });
      } catch (err) {
        return fallback(`LLM draft failed: ${(err as Error).message}`);
      }
      const check = checkReply(draft, guardCtx);
      tracer.record('guardrail', 'reply_check', { output: { attempt, ...check }, status: check.ok ? 'ok' : 'error' });
      if (check.ok) return { reply: { draft, source: 'llm' as const } };
      messages.push(
        { role: 'assistant', content: JSON.stringify(draft) },
        { role: 'user', content: `The reply violates communication rules: ${check.violations.join(', ')}. Rewrite it. JSON only.` },
      );
    }
    return fallback('LLM draft failed reply checks twice');
  });

  const finalize = node('finalize', async (s) => {
    const o = s.outcome!;
    const base: Omit<AgentResult, 'summary'> = {
      requestId: s.request?.requestId ?? safeRequestId(s.rawInput),
      status: o.status,
      decision: o.decision,
      category: s.classification?.inScope ? s.classification.category : null,
      transactionId: o.transactionId,
      refundAmount: o.refundAmount,
      currency: 'EUR',
      reasonCodes: o.reasonCodes,
      policyRefs: o.policyRefs,
      humanReview: o.humanReview,
      guardrails: {
        injectionFlagged: s.screening?.flagged ?? false,
        injectionSignals: s.screening?.signals ?? [],
        overrides: o.overrides,
        replySource: s.reply?.source ?? null,
      },
      agentRationale: s.proposal?.rationale ?? null,
      customerReply: s.reply?.draft ?? null,
      validationErrors: s.validationErrors,
      trace: {
        traceId: tracer.traceId,
        llmCalls: tracer.count('llm'),
        toolCalls: tracer.count('tool'),
        durationMs: tracer.durationMs,
        file: null,
      },
      meta: { agentVersion: AGENT_VERSION, promptVersion: PROMPT_VERSION, llm: llm.name, decidedAt: new Date().toISOString() },
    };
    const result = AgentResultSchema.parse({ ...base, summary: buildSummary(base) });
    tracer.record('decision', 'final_decision', {
      output: { decision: result.decision, refundAmount: result.refundAmount, transactionId: result.transactionId, reasonCodes: result.reasonCodes, humanReview: result.humanReview },
    });
    return { result };
  });

  /* ----------------------------- edges ------------------------------ */

  const okOr = (next: string) => (s: AgentStateType) => (s.failure ? 'fail_safe' : next);

  return new StateGraph(AgentState)
    .addNode('validate_input', validateInput)
    .addNode('screen_input', screenInput)
    .addNode('classify', classify)
    .addNode('refuse', refuse)
    .addNode('investigate', investigate)
    .addNode('decide', decide)
    .addNode('enforce_policy', enforcePolicy)
    .addNode('fail_safe', failSafe)
    .addNode('draft_reply', draftReply)
    .addNode('finalize', finalize)
    .addEdge(START, 'validate_input')
    .addConditionalEdges('validate_input', (s) => (s.failure ? 'fail_safe' : s.outcome ? 'finalize' : 'screen_input'), [
      'fail_safe',
      'finalize',
      'screen_input',
    ])
    .addConditionalEdges('screen_input', okOr('classify'), ['fail_safe', 'classify'])
    .addConditionalEdges(
      'classify',
      (s) => (s.failure ? 'fail_safe' : s.classification?.inScope ? 'investigate' : 'refuse'),
      ['fail_safe', 'investigate', 'refuse'],
    )
    .addConditionalEdges('investigate', okOr('decide'), ['fail_safe', 'decide'])
    .addConditionalEdges('decide', okOr('enforce_policy'), ['fail_safe', 'enforce_policy'])
    .addConditionalEdges('enforce_policy', okOr('draft_reply'), ['fail_safe', 'draft_reply'])
    .addEdge('refuse', 'draft_reply')
    .addEdge('fail_safe', 'draft_reply')
    .addEdge('draft_reply', 'finalize')
    .addEdge('finalize', END)
    .compile();
}

/* ----------------------------- helpers ------------------------------ */

function collectFinding(f: Findings, tool: string, result: unknown): void {
  const r = result as Record<string, unknown>;
  switch (tool) {
    case 'get_customer_history':
      f.customerHistory = r;
      break;
    case 'lookup_transaction':
      if (r.found) f.transaction = r.transaction as Findings['transaction'];
      break;
    case 'search_refund_policy':
      f.policySections = (r.sections as Findings['policySections']) ?? [];
      break;
    case 'check_refund_eligibility':
      if (r.found) {
        const { transaction, ...eligibility } = r;
        f.eligibility = eligibility as unknown as Findings['eligibility'];
        f.transaction ??= transaction as Findings['transaction'];
      }
      break;
    case 'list_customer_transactions':
      break;
  }
}

/** Dedup key that ignores whitespace in the arguments (`{ }` and `{}` are the same call). */
function callKey(name: string, args: string): string {
  return `${name}:${JSON.stringify(safeJson(args))}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeRequestId(raw: unknown): string {
  const id = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).safeParse(raw);
  return id.success ? id.data.requestId : 'unknown';
}
