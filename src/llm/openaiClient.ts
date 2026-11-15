import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { TransientLlmError, type ChatMessage, type LlmClient, type LlmRequest, type LlmResponse } from './types.js';

export interface OpenAiClientOptions {
  apiKey: string;
  model: string;
  temperature: number | null;
  timeoutMs: number;
  /** Optional: OpenAI-compatible endpoint (Azure/OpenRouter/local proxy, or a fake server in tests). */
  baseURL?: string;
}

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function toOpenAi(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: the switch is exhaustive over ChatMessage['role'] (checked by tsc)
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

export class OpenAiLlmClient implements LlmClient {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiClientOptions) {
    this.name = `openai:${opts.model}`;
    // Retries are handled by our own wrapper (with tracing), so disable SDK retries.
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const tools: ChatCompletionTool[] | undefined = req.tools?.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    try {
      const res = await this.client.chat.completions.create({
        model: this.opts.model,
        messages: toOpenAi(req.messages),
        ...(this.opts.temperature !== null ? { temperature: this.opts.temperature } : {}),
        ...(tools?.length ? { tools, tool_choice: 'auto' as const, parallel_tool_calls: false } : {}),
        ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
      });
      const msg = res.choices[0]?.message;
      if (!msg) throw new TransientLlmError('OpenAI returned no choices');
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? []).flatMap((c) =>
          c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
        ),
        ...(res.usage
          ? { usage: { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens } }
          : {}),
      };
    } catch (err) {
      if (err instanceof TransientLlmError) throw err;
      if (err instanceof OpenAI.APIConnectionError) throw new TransientLlmError(err.message, err);
      if (err instanceof OpenAI.APIError && err.status !== undefined && TRANSIENT_STATUS.has(err.status)) {
        throw new TransientLlmError(`OpenAI ${err.status}: ${err.message}`, err);
      }
      throw err;
    }
  }
}
