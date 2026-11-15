/**
 * Runs every request in samples/inputs through the agent (mock LLM by default),
 * writes full results to samples/outputs, and compares them with samples/expected.
 * Exit code 1 if any expectation fails. Usage: npm run samples [-- --openai]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultDeps, runAgent } from '../src/agent/runAgent.js';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/data/repository.js';
import { silentLogger } from '../src/observability/logger.js';
import { compareExpected, type Expected } from '../tests/helpers/expected.js';

const useOpenAi = process.argv.includes('--openai');
const config = { ...loadConfig({ ...process.env, LLM_MODE: useOpenAi ? 'openai' : 'mock' }), traceDir: null };
const deps = createDefaultDeps({ config, logger: silentLogger(), repo: Repository.fromFixtures('data') });

mkdirSync('samples/outputs', { recursive: true });
let failures = 0;
const rows: string[] = [];

for (const file of readdirSync('samples/inputs').filter((f) => f.endsWith('.json')).sort()) {
  const input = JSON.parse(readFileSync(join('samples/inputs', file), 'utf8'));
  const expected = JSON.parse(readFileSync(join('samples/expected', file), 'utf8')) as Expected;
  // The harness (not the caller) replays each sample at the time it was recorded.
  // Each sample is its own scenario: a fresh repo, so an approval in one sample cannot turn the
  // next sample on the same transaction into REFUND_ALREADY_APPROVED.
  const at = Date.parse(input.receivedAt);
  const caseDeps = { ...deps, repo: Repository.fromFixtures('data') };
  const result = await runAgent(input, Number.isNaN(at) ? caseDeps : { ...caseDeps, now: () => new Date(at) });

  // Strip volatile fields so committed outputs are stable across runs.
  const stable = { ...result, trace: { ...result.trace, traceId: '<varies>', durationMs: 0, file: null }, meta: { ...result.meta, decidedAt: '<varies>' } };
  stable.summary = stable.summary.replace(/, \d+ ms \(/, ', <n> ms (');
  if (!useOpenAi) writeFileSync(join('samples/outputs', file), `${JSON.stringify(stable, null, 2)}\n`);

  const problems = compareExpected(result, expected);
  if (problems.length) failures++;
  rows.push(
    `${problems.length ? 'FAIL' : 'PASS'}  ${file.padEnd(42)} ${result.decision.padEnd(15)} ${String(result.refundAmount ?? '-').padEnd(7)} ${problems.join('; ')}`,
  );
}

console.log(rows.join('\n'));
console.log(`\n${rows.length - failures}/${rows.length} samples match expectations (llm=${deps.llm.name})`);
process.exit(failures ? 1 : 0);
