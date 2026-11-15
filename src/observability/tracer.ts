import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import { redact } from './redact.js';

export type SpanKind = 'node' | 'llm' | 'tool' | 'guardrail' | 'decision';

export interface TraceEvent {
  seq: number;
  kind: SpanKind;
  name: string;
  at: string;
  durationMs: number;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

/**
 * Minimal tracer: records every node, LLM call, tool call and guardrail decision
 * as an ordered event list (exportable to OpenTelemetry/LangSmith later) and
 * mirrors each event to the structured logger. All payloads are PII-redacted.
 */
export class Tracer {
  readonly traceId = randomUUID();
  readonly events: TraceEvent[] = [];
  private readonly startedAt = Date.now();
  private seq = 0;

  constructor(
    readonly requestId: string,
    private readonly logger: Logger,
  ) {}

  async span<T>(
    kind: SpanKind,
    name: string,
    input: unknown,
    fn: () => Promise<T> | T,
    summarize: (out: T) => unknown = (o) => o,
  ): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn();
      this.push({ kind, name, durationMs: Date.now() - start, status: 'ok', input, output: summarize(out) });
      return out;
    } catch (err) {
      this.push({ kind, name, durationMs: Date.now() - start, status: 'error', input, error: (err as Error).message });
      throw err;
    }
  }

  record(kind: SpanKind, name: string, data: { input?: unknown; output?: unknown; error?: string; status?: 'ok' | 'error' }): void {
    this.push({ kind, name, durationMs: 0, status: data.status ?? (data.error ? 'error' : 'ok'), ...data });
  }

  private push(e: Omit<TraceEvent, 'seq' | 'at'>): void {
    const event: TraceEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      ...e,
      ...(e.input !== undefined ? { input: redact(e.input) } : {}),
      ...(e.output !== undefined ? { output: redact(e.output) } : {}),
    };
    this.events.push(event);
    const level = event.status === 'error' ? 'warn' : event.kind === 'node' ? 'debug' : 'info';
    this.logger[level](
      { traceId: this.traceId, requestId: this.requestId, kind: event.kind, step: event.name, durationMs: event.durationMs, ...(event.kind !== 'node' ? { input: event.input, output: event.output } : {}), error: event.error },
      `${event.kind}:${event.name}`,
    );
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  count(kind: SpanKind): number {
    return this.events.filter((e) => e.kind === kind).length;
  }

  toJSON() {
    return { traceId: this.traceId, requestId: this.requestId, durationMs: this.durationMs, events: this.events };
  }

  writeTo(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const safeId = this.requestId.replace(/[^A-Za-z0-9_-]/g, '_');
    const file = join(dir, `${safeId}.${this.traceId.slice(0, 8)}.json`);
    writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
    return file;
  }
}
