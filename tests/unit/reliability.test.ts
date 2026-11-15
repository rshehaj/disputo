import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callLlm, callStructured, extractJson, StructuredOutputError } from '../../src/llm/reliability.js';
import { TransientLlmError, type LlmClient, type LlmResponse } from '../../src/llm/types.js';
import { silentLogger } from '../../src/observability/logger.js';
import { Tracer } from '../../src/observability/tracer.js';

const scripted = (outputs: Array<LlmResponse | Error>): LlmClient & { n: number } => ({
  name: 'scripted',
  n: 0,
  async complete() {
    const o = outputs[Math.min(this.n++, outputs.length - 1)]!;
    if (o instanceof Error) throw o;
    return o;
  },
});
const text = (content: string): LlmResponse => ({ content, toolCalls: [] });
const schema = z.object({ ok: z.boolean() });
const req = { purpose: 'decide' as const, messages: [{ role: 'user' as const, content: 'JSON please' }] };

describe('extractJson', () => {
  it('handles fenced and surrounded JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope it helps')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('callStructured', () => {
  it('repairs invalid output by feeding the validation error back', async () => {
    const llm = scripted([text('not json'), text('{"ok":"yes"}'), text('{"ok":true}')]);
    const tracer = new Tracer('t', silentLogger());
    await expect(callStructured(llm, req, schema, tracer)).resolves.toEqual({ ok: true });
    expect(llm.n).toBe(3);
    expect(tracer.events.filter((e) => e.name.startsWith('schema_validation_failed'))).toHaveLength(2);
  });

  it('gives up after maxAttempts with a typed error', async () => {
    const llm = scripted([text('{"nope":1}')]);
    await expect(callStructured(llm, req, schema, new Tracer('t', silentLogger()), { maxAttempts: 2 })).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
  });
});

describe('callLlm', () => {
  it('retries transient errors with backoff', async () => {
    const llm = scripted([new TransientLlmError('429'), new TransientLlmError('503'), text('{"ok":true}')]);
    const r = await callLlm(llm, req, new Tracer('t', silentLogger()), { transientRetries: 2, baseDelayMs: 1 });
    expect(r.content).toBe('{"ok":true}');
    expect(llm.n).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    const llm = scripted([new Error('401 invalid api key'), text('{}')]);
    await expect(callLlm(llm, req, new Tracer('t', silentLogger()), { baseDelayMs: 1 })).rejects.toThrow('401');
    expect(llm.n).toBe(1);
  });
});
