import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

export type LlmMode = 'openai' | 'mock';

export interface AppConfig {
  llmMode: LlmMode;
  openaiApiKey: string | undefined;
  openaiModel: string;
  openaiBaseUrl: string | undefined;
  /** null = do not send a temperature parameter */
  openaiTemperature: number | null;
  llmTimeoutMs: number;
  autoApproveLimit: number;
  maxToolIterations: number;
  logLevel: string;
  logPretty: boolean;
  traceDir: string | null;
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric env var ${name}=${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const modeRaw = env.LLM_MODE?.trim().toLowerCase();
  let llmMode: LlmMode;
  if (modeRaw === 'openai' || modeRaw === 'mock') llmMode = modeRaw;
  else if (!modeRaw) llmMode = apiKey ? 'openai' : 'mock';
  else throw new Error(`Invalid LLM_MODE=${modeRaw} (expected "openai" or "mock")`);

  if (llmMode === 'openai' && !apiKey) {
    throw new Error('LLM_MODE=openai requires OPENAI_API_KEY');
  }

  const tempRaw = env.OPENAI_TEMPERATURE?.trim();
  const openaiTemperature =
    tempRaw?.toLowerCase() === 'none' ? null : num(tempRaw, 0, 'OPENAI_TEMPERATURE');

  return {
    llmMode,
    openaiApiKey: apiKey,
    openaiModel: env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    openaiTemperature,
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 30_000, 'LLM_TIMEOUT_MS'),
    autoApproveLimit: num(env.AUTO_APPROVE_LIMIT_EUR, 200, 'AUTO_APPROVE_LIMIT_EUR'),
    maxToolIterations: num(env.MAX_TOOL_ITERATIONS, 8, 'MAX_TOOL_ITERATIONS'),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    logPretty: env.LOG_PRETTY === '1' || env.LOG_PRETTY === 'true',
    traceDir: env.TRACE_DIR === undefined ? 'traces' : env.TRACE_DIR.trim() || null,
  };
}
