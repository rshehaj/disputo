import { readFileSync } from 'node:fs';
import { createDefaultDeps, runAgent } from './agent/runAgent.js';
import { loadConfig } from './config.js';

const USAGE = `Usage: npm run agent -- <request.json | -> [--mock | --openai] [--json]

  <request.json>   Path to a refund request (see samples/inputs). Use "-" to read stdin.
  --mock           Force the deterministic mock LLM (no API key needed)
  --openai         Force OpenAI (requires OPENAI_API_KEY)
  --json           Print only the JSON result (for piping)
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  if (flags.has('--help') || args.length !== 1) {
    process.stderr.write(USAGE);
    return args.length === 1 ? 0 : 1;
  }

  const env = { ...process.env };
  if (flags.has('--mock')) env.LLM_MODE = 'mock';
  if (flags.has('--openai')) env.LLM_MODE = 'openai';
  const config = loadConfig(env);

  const path = args[0]!;
  let input: unknown;
  try {
    input = JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
  } catch (err) {
    process.stderr.write(`Could not read JSON from ${path}: ${(err as Error).message}\n`);
    return 1;
  }

  const result = await runAgent(input, createDefaultDeps({ config }));

  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const line = '─'.repeat(72);
    process.stdout.write(`${line}\n${result.summary}\n${line}\n`);
    if (result.customerReply) {
      process.stdout.write(`Customer reply (${result.guardrails.replySource}):\nSubject: ${result.customerReply.subject}\n\n${result.customerReply.body}\n${line}\n`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
