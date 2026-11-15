import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server.js';
import { makeDeps, sample } from '../helpers/deps.js';

describe('HTTP API', () => {
  const server = createApp(makeDeps());
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: string, type = 'application/json') =>
    fetch(`${base}/v1/refund-requests`, { method: 'POST', headers: { 'content-type': type }, body });

  it('decides a refund request end-to-end', async () => {
    const res = await post(JSON.stringify(sample('07-duplicate-charge-auto-approve')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: 'AUTO_APPROVE', refundAmount: 19.99 });
  });

  it('returns 422 for invalid input and 400 for broken JSON', async () => {
    expect((await post(JSON.stringify(sample('10-invalid-input')))).status).toBe(422);
    expect((await post('{not json')).status).toBe(400);
    expect((await post('{}', 'text/plain')).status).toBe(415);
  });

  it('exposes a health check', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, llm: 'mock' });
  });
});
