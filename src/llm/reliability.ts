import { z } from 'zod';
import type { Tracer } from '../observability/tracer.js';
import { TransientLlmError, type LlmClient, type LlmRequest, type LlmResponse } from './types.js';

export interface RetryOptions {
  /** Retries for transient provider errors (timeouts, 429, 5xx). */
  transientRetries?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One traced LLM call with exponential backoff on transient errors. */
export async function callLlm(
  llm: LlmClient,
  req: LlmRequest,
  tracer: Tracer,
  opts: RetryOptions = {},
): Promise<LlmResponse> {
  const retries = opts.transientRetries ?? 2;
  const base = opts.baseDelayMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await tracer.span(
        'llm',
        `${req.purpose}${attempt > 0 ? `#retry${attempt}` : ''}`,
        { model: llm.name, messages: req.messages.length, tools: req.tools?.map((t) => t.name) ?? [] },
        () => llm.complete(req),
        (r) => ({ content: r.content, toolCalls: r.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })), usage: r.usage }),
      );
    } catch (err) {
      if (!(err instanceof TransientLlmError) || attempt >= retries) throw err;
      await sleep(base * 2 ** attempt);
    }
  }
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

export class StructuredOutputError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Calls the model for a JSON object and validates it with Zod.
 * On invalid output, feeds the validation error back to the model and retries ("repair loop").
 */
export async function callStructured<S extends z.ZodType>(
  llm: LlmClient,
  req: Omit<LlmRequest, 'json' | 'tools'>,
  schema: S,
  tracer: Tracer,
  opts: RetryOptions & { maxAttempts?: number } = {},
): Promise<z.infer<S>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const messages = [...req.messages];
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await callLlm(llm, { ...req, messages, json: true }, tracer, opts);
    const raw = res.content ?? '';
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(raw));
      if (parsed.success) return parsed.data;
      problem = z.prettifyError(parsed.error);
    } catch (err) {
      problem = (err as Error).message;
    }
    lastError = problem;
    tracer.record('guardrail', `schema_validation_failed:${req.purpose}`, { output: { attempt, problem }, status: 'error' });
    messages.push(
      { role: 'assistant', content: raw.slice(0, 2000) },
      {
        role: 'user',
        content: `Your previous output was invalid:\n${problem}\nReturn ONLY one JSON object that matches the required schema. No prose, no markdown.`,
      },
    );
  }
  throw new StructuredOutputError(`Invalid ${req.purpose} output after ${maxAttempts} attempts: ${lastError}`, maxAttempts);
}
