import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/runAgent.js';
import { Repository } from '../../src/data/repository.js';
import { jsonResponse, makeDeps, sample, ScriptedLlm } from '../helpers/deps.js';

/**
 * Attacks that do not go through the LLM at all: request fields, replays, and a mislabelled
 * category. Each test runs the full graph and checks that no money moves that policy forbids.
 */

describe('the caller cannot set the policy clock', () => {
  it('ignores a backdated receivedAt (outside-window purchase stays rejected)', async () => {
    const backdated = { ...sample('03-outside-window-reject'), requestId: 'req_backdate', receivedAt: '2026-08-25T10:00:00Z' };
    const r = await runAgent(backdated, makeDeps());
    expect(r.decision).toBe('REJECT');
    expect(r.reasonCodes).toContain('OUTSIDE_REFUND_WINDOW');
  });

  it('ignores a future receivedAt (parcel still in transit stays a wait)', async () => {
    const future = { ...sample('11-not-received-in-transit-reject'), requestId: 'req_future', receivedAt: '2026-12-31T10:00:00Z' };
    const r = await runAgent(future, makeDeps());
    expect(r.decision).toBe('REJECT');
    expect(r.reasonCodes).toContain('SHIPMENT_STILL_IN_TRANSIT');
  });
});

describe('one transaction cannot be refunded twice', () => {
  it('rejects a second claim with a new requestId after an auto-approval', async () => {
    const deps = makeDeps();
    const first = await runAgent(sample('01-damaged-item-auto-approve'), deps);
    expect(first.decision).toBe('AUTO_APPROVE');

    const again = await runAgent({ ...sample('01-damaged-item-auto-approve'), requestId: 'req_01_again' }, deps);
    expect(again).toMatchObject({ decision: 'REJECT', refundAmount: null });
    expect(again.reasonCodes).toContain('REFUND_ALREADY_APPROVED');
    expect(again.customerReply?.body).toContain('already been approved');
  });

  it('treats a retry of the same requestId as the same claim (idempotent, not a second refund)', async () => {
    const deps = makeDeps();
    const first = await runAgent(sample('01-damaged-item-auto-approve'), deps);
    const retry = await runAgent(sample('01-damaged-item-auto-approve'), deps);
    expect(retry).toMatchObject({ requestId: first.requestId, decision: 'AUTO_APPROVE', refundAmount: first.refundAmount });
  });

  it('keeps a clean resubmission in review while the injected first attempt is with trust & safety', async () => {
    const deps = makeDeps();
    const injected = await runAgent(sample('05-prompt-injection-escalate'), deps);
    expect(injected.humanReview.queue).toBe('trust-safety');

    const clean = await runAgent(
      { ...sample('05-prompt-injection-escalate'), requestId: 'req_05_clean', message: 'My water bottle arrived dented and damaged.' },
      deps,
    );
    expect(clean.decision).toBe('ESCALATE');
    expect(clean.reasonCodes).toContain('REQUEST_ALREADY_IN_REVIEW');
  });

  it('remembers approvals across a restart (decision log is reloaded)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disputo-'));
    dirs.push(dir);
    const log = join(dir, 'decisions.jsonl');
    const first = await runAgent(sample('01-damaged-item-auto-approve'), { ...makeDeps(), repo: Repository.fromFixtures('data', log) });
    expect(first.decision).toBe('AUTO_APPROVE');

    const restarted = { ...makeDeps(), repo: Repository.fromFixtures('data', log) };
    const again = await runAgent({ ...sample('01-damaged-item-auto-approve'), requestId: 'req_after_restart' }, restarted);
    expect(again.reasonCodes).toContain('REFUND_ALREADY_APPROVED');
  });
});

describe('the LLM category cannot open a longer refund window on its own', () => {
  // txn_1001 was bought on 2026-11-01; on 2026-11-20 it is 19 days old: outside the 14-day
  // change-of-mind window, inside the 30-day damaged-item window.
  const later = new Date('2026-11-20T10:00:00Z');
  const asDamaged = () =>
    new ScriptedLlm({
      classify: () => jsonResponse({ inScope: true, category: 'damaged_item', confidence: 0.95, summary: 'Damaged item.' }),
    });

  it('escalates when a change-of-mind message is labelled as damage', async () => {
    const input = { ...sample('01-damaged-item-auto-approve'), requestId: 'req_mislabel', message: 'I just do not like the mugs anymore, please take them back.' };
    const r = await runAgent(input, makeDeps(asDamaged(), later));
    expect(r).toMatchObject({ decision: 'ESCALATE', humanReview: { required: true, queue: 'refunds-l2' } });
    expect(r.reasonCodes).toContain('CATEGORY_UNVERIFIED');
    expect(r.guardrails.overrides).toContainEqual(expect.objectContaining({ rule: 'ENFORCE:CATEGORY_UNVERIFIED' }));
  });

  it('still auto-approves when the message supports the category', async () => {
    const r = await runAgent(sample('01-damaged-item-auto-approve'), makeDeps(asDamaged(), later));
    expect(r.decision).toBe('AUTO_APPROVE');
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
