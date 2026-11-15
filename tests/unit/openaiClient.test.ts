import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiLlmClient } from '../../src/llm/openaiClient.js';
import { TransientLlmError } from '../../src/llm/types.js';
import { TOOL_SPECS } from '../../src/tools/index.js';

/** Fake OpenAI-compatible server: verifies the adapter's wire format without a real API key. */
let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> = {};
let nextStatus = 200;
let nextReply: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    lastBody = JSON.parse(raw);
    res.writeHead(nextStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nextStatus === 200 ? nextReply : { error: { message: 'slow down', type: 'rate_limit' } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const completion = (message: Record<string, unknown>) => ({
  id: 'x', object: 'chat.completion', created: 0, model: 'gpt-test',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, ...message } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const client = () => new OpenAiLlmClient({ apiKey: 'test', model: 'gpt-test', temperature: 0, timeoutMs: 5000, baseURL });

describe('OpenAiLlmClient', () => {
  it('sends tools and tool messages in OpenAI format and parses tool calls', async () => {
    nextStatus = 200;
    nextReply = completion({
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_transaction', arguments: '{"transactionId":"txn_1"}' } }],
    });
    const r = await client().complete({
      purpose: 'investigate',
      tools: TOOL_SPECS,
      messages: [
        { role: 'system', content: 's' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'get_customer_history', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_0', content: '{"found":true}' },
      ],
    });
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'lookup_transaction', arguments: '{"transactionId":"txn_1"}' }]);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(lastBody).toMatchObject({ model: 'gpt-test', temperature: 0, tool_choice: 'auto', parallel_tool_calls: false });
    expect((lastBody.tools as unknown[]).length).toBe(TOOL_SPECS.length);
    expect(lastBody.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_customer_history', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: '{"found":true}' },
    ]);
  });

  it('requests JSON mode for structured steps', async () => {
    nextReply = completion({ content: '{"ok":true}' });
    const r = await client().complete({ purpose: 'decide', json: true, messages: [{ role: 'user', content: 'JSON' }] });
    expect(r.content).toBe('{"ok":true}');
    expect(lastBody.response_format).toEqual({ type: 'json_object' });
    expect(lastBody.tools).toBeUndefined();
  });

  it('maps 429 to a retryable TransientLlmError', async () => {
    nextStatus = 429;
    await expect(client().complete({ purpose: 'classify', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
      TransientLlmError,
    );
    nextStatus = 200;
  });
});
