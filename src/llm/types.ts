/** Provider-neutral LLM types. The agent depends on this interface, not on the OpenAI SDK. */

export type LlmPurpose = 'classify' | 'investigate' | 'decide' | 'draft_reply';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  purpose: LlmPurpose;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask the provider for a JSON object response. */
  json?: boolean;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Thrown for errors worth retrying (timeouts, 429, 5xx). */
export class TransientLlmError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientLlmError';
  }
}
