import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDefaultDeps, runAgent, type AgentDeps } from './agent/runAgent.js';

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Minimal HTTP API: POST /v1/refund-requests, GET /healthz. */
export function createApp(deps: AgentDeps): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true, llm: deps.llm.name });
      if (req.method !== 'POST' || req.url !== '/v1/refund-requests') return send(404, { error: 'not_found' });
      if (!req.headers['content-type']?.includes('application/json')) return send(415, { error: 'expected application/json' });

      let input: unknown;
      try {
        input = JSON.parse(await readBody(req));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        return send(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' });
      }
      const result = await runAgent(input, deps);
      return send(result.status === 'invalid_input' ? 422 : 200, result);
    } catch (err) {
      deps.logger.error({ err }, 'request failed');
      return send(500, { error: 'internal_error' });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const deps = createDefaultDeps();
  const port = Number(process.env.PORT ?? 3000);
  createApp(deps).listen(port, () => deps.logger.info({ port, llm: deps.llm.name }, 'disputo listening'));
}
