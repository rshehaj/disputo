import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RefundRequestSchema } from '../../src/types.js';

const valid = { requestId: 'req_1', customerEmail: 'a@example.com', message: 'My item arrived broken.' };

describe('RefundRequestSchema', () => {
  it('accepts a minimal valid request and applies defaults', () => {
    expect(RefundRequestSchema.parse(valid)).toMatchObject({ currency: 'EUR', channel: 'web_form' });
  });

  it.each([
    [{ ...valid, customerEmail: 'nope' }, 'customerEmail'],
    [{ ...valid, message: 'hi' }, 'message'],
    [{ ...valid, transactionId: '1001' }, 'transactionId'],
    [{ ...valid, requestedAmount: -5 }, 'requestedAmount'],
    [{ ...valid, requestId: '../../etc/passwd' }, 'requestId'],
    [{ ...valid, currency: 'USD' }, 'currency'],
  ])('rejects invalid field %#', (input, field) => {
    const r = RefundRequestSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(field);
  });
});

describe('loadConfig', () => {
  it('defaults to mock mode without an API key', () => {
    expect(loadConfig({}).llmMode).toBe('mock');
  });
  it('refuses openai mode without a key', () => {
    expect(() => loadConfig({ LLM_MODE: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });
  it('reads an operator-pinned clock from AGENT_CLOCK', () => {
    expect(loadConfig({ AGENT_CLOCK: '2026-11-10T10:00:00Z' }).clockOverride).toBe('2026-11-10T10:00:00.000Z');
    expect(loadConfig({}).clockOverride).toBeNull();
    expect(() => loadConfig({ AGENT_CLOCK: 'yesterday' })).toThrow(/AGENT_CLOCK/);
  });
});
