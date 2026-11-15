/**
 * Runs every case in evals/dataset.json through the agent and writes one JSON file per
 * case to evals/runs/ (result + the tool calls taken from the trace), for the DeepEval
 * suite in evals/ to score. Usage: npm run eval:export [-- --openai]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultDeps, runAgent } from '../src/agent/runAgent.js';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/data/repository.js';
import { silentLogger } from '../src/observability/logger.js';
import type { TraceEvent } from '../src/observability/tracer.js';

type LlmMode = 'mock' | 'openai';

interface EvalCase {
  id: string;
  /** Inline request, or a path to one (e.g. samples/inputs/...). */
  input?: Record<string, unknown>;
  inputPath?: string;
  /** Expected business outcome (same shape as samples/expected), inline or by path. */
  expected?: Record<string, unknown>;
  expectedPath?: string;
  /** Tool names the agent should call (order not enforced). */
  expectedTools: string[];
  adversarial?: boolean;
  /** Case-insensitive substrings that must not appear in the customer reply (leaks, echoed injections). */
  replyMustNotContain?: string[];
  /** LLM modes this case is meaningful for (default: all). */
  modes?: LlmMode[];
  notes?: string;
}

const DATASET = 'evals/dataset.json';
const OUT_DIR = 'evals/runs';
const TRACE_DIR = join(OUT_DIR, 'traces');

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const mode: LlmMode = process.argv.includes('--openai') ? 'openai' : 'mock';
const config = { ...loadConfig({ ...process.env, LLM_MODE: mode }), traceDir: TRACE_DIR };
// Fixture repo without a decision log, so eval runs never touch data/runtime.
const deps = createDefaultDeps({ config, logger: silentLogger(), repo: Repository.fromFixtures('data') });

const { cases } = readJson<{ cases: EvalCase[] }>(DATASET);
// Empty the output dir rather than deleting it: in Docker it is a volume mount point.
mkdirSync(OUT_DIR, { recursive: true });
for (const entry of readdirSync(OUT_DIR)) rmSync(join(OUT_DIR, entry), { recursive: true, force: true });
mkdirSync(TRACE_DIR, { recursive: true });

let written = 0;
for (const c of cases) {
  if (c.modes && !c.modes.includes(mode)) {
    console.log(`SKIP  ${c.id.padEnd(36)} (only for ${c.modes.join(', ')})`);
    continue;
  }
  const input = c.input ?? (c.inputPath ? readJson<Record<string, unknown>>(c.inputPath) : undefined);
  if (!input) throw new Error(`Case ${c.id} has neither input nor inputPath`);
  const expected = c.expected ?? (c.expectedPath ? readJson<Record<string, unknown>>(c.expectedPath) : null);

  // Trusted harness: replay each case at its recorded time. The agent itself ignores receivedAt.
  // Fresh repo per case: cases are independent scenarios and some share a transaction.
  const at = Date.parse(String(input.receivedAt));
  const caseDeps = { ...deps, repo: Repository.fromFixtures('data') };
  const result = await runAgent(input, Number.isNaN(at) ? caseDeps : { ...caseDeps, now: () => new Date(at) });
  const events =
    result.trace.file && existsSync(result.trace.file) ? readJson<{ events: TraceEvent[] }>(result.trace.file).events : [];
  const toolsCalled = events
    .filter((e) => e.kind === 'tool')
    .map((e) => ({ name: e.name, input: e.input ?? {}, output: e.output ?? null, status: e.status }));

  const run = {
    id: c.id,
    mode,
    llm: deps.llm.name,
    adversarial: c.adversarial ?? false,
    notes: c.notes ?? null,
    input,
    expected,
    expectedTools: c.expectedTools,
    replyMustNotContain: c.replyMustNotContain ?? [],
    toolsCalled,
    result,
  };
  writeFileSync(join(OUT_DIR, `${c.id}.json`), JSON.stringify(run, null, 2) + '\n');
  written++;
  console.log(
    `OK    ${c.id.padEnd(36)} ${result.decision.padEnd(15)} tools=[${toolsCalled.map((t) => t.name).join(', ')}]`,
  );
}

writeFileSync(join(OUT_DIR, '_meta.json'), JSON.stringify({ mode, llm: deps.llm.name, cases: written, exportedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`\nExported ${written} run(s) to ${OUT_DIR} (llm=${deps.llm.name})`);
