import test from 'node:test';
import assert from 'node:assert/strict';
import { createBetterStackAdapter, validatePairedState } from '../adapters/better-stack.mjs';
import { productTransition, deliverPending } from '../state.mjs';

const env = { BETTER_STACK_API_TOKEN: 'fixture-secret', BETTER_STACK_REQUESTER_EMAIL: 'fixture@example.invalid', BETTER_STACK_INSTANCE: 'fixture', BETTER_STACK_STATE_PATH: 'unused', BETTER_STACK_COMPLETION_HEARTBEAT_URL: 'https://incidents.betterstack.com/api/v1/heartbeat/fixture' };
const event = { id: '12345678-1234-1234-1234-123456789abc', type: 'product-alert' };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function fixture(fetcher, initial) {
  let state = initial ?? { schemaVersion: '1.0', incidentId: null, lastEventId: null };
  return { adapter: createBetterStackAdapter({ env, fetcher, load: async (_, fallback) => structuredClone(state ?? fallback), save: async (_, next) => { state = structuredClone(next); } }), state: () => state };
}
test('alert creates one incident and replay does not repeat the notification', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push([url, options]); return response(options.method === 'GET' ? { data: [] } : { data: { id: '42' } }); });
  await f.adapter.notify(event); await f.adapter.notify(event);
  assert.equal(calls.length, 2); assert.equal(f.state().incidentId, '42');
  const posted = JSON.parse(calls[1][1].body); assert.equal(posted.email, true); assert.equal(posted.call, false);
  assert.equal(posted.metadata.checker_event, event.id);
});
test('lost acknowledgement reconciles stable provider metadata before retrying POST', async () => {
  let posts = 0;
  const f = fixture(async (_, options) => { if (options.method === 'POST') posts++; return response({ data: [{ id: '43' }] }); });
  await f.adapter.notify(event); assert.equal(posts, 0); assert.equal(f.state().incidentId, '43');
});
test('recovery resolves only known incident; already-resolved conflict is idempotent', async () => {
  const f = fixture(async (url, options) => { assert.match(url, /incidents\/42\/resolve$/); assert.equal(options.method, 'POST'); return response(null, 409); }, { schemaVersion: '1.0', incidentId: '42', lastEventId: event.id });
  await f.adapter.notify({ ...event, id: '22345678-1234-1234-1234-123456789abc', type: 'product-recovery' });
  assert.equal(f.state().incidentId, null);
});
test('failed channel stays unacknowledged and sanitizes secret-bearing provider errors', async () => {
  const f = fixture(async () => { throw new Error('fixture-secret private-url body'); });
  await assert.rejects(f.adapter.notify(event), { message: 'better-stack/delivery-failed' }); assert.equal(f.state().lastEventId, null);
});
test('completed FAIL sends completion heartbeat; starts and other hosts are rejected', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(null); });
  const completion = { schemaVersion: '1.0', completed: true, completedAtUtc: new Date().toISOString(), outcome: 'FAIL' };
  await f.adapter.heartbeat(completion); assert.equal(calls, 1);
  await assert.rejects(f.adapter.heartbeat({ ...completion, completed: false })); assert.equal(calls, 1);
  const bad = createBetterStackAdapter({ env: { ...env, BETTER_STACK_COMPLETION_HEARTBEAT_URL: 'https://example.invalid/api/v1/heartbeat/fixture' }, fetcher: async () => { throw Error('must not fetch'); } });
  await assert.rejects(bad.heartbeat(completion), { message: 'better-stack/delivery-failed' });
});
test('portable state preserves FFSS policy across adapter delivery and suppresses unchanged incidents', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push(url); return response(options.method === 'GET' ? { data: [] } : { data: { id: '44' } }); });
  let state;
  for (const outcome of ['FAIL', 'INCOMPLETE', 'FAIL', 'PASS', 'PASS']) {
    state = productTransition(state, { outcome, runId: 'fixture-run', finishedAtUtc: new Date().toISOString() });
    await deliverPending(state, f.adapter, async () => {});
  }
  assert.equal(calls.filter(url => /incidents$/.test(url)).length, 1);
  assert.equal(calls.filter(url => /\/resolve$/.test(url)).length, 1);
  assert.equal(state.incidentOpen, false);
});
test('missing paired state fails closed before provider requests; recovery requires its provider ID', async () => {
  let calls = 0;
  const adapter = createBetterStackAdapter({ env, load: async () => null, fetcher: async () => { calls++; } });
  await assert.rejects(adapter.notify(event), { message: 'better-stack/delivery-failed' });
  assert.equal(calls, 0);
  const monitor = { schemaVersion: '1.0', incidentOpen: true, pendingEvents: [] };
  const provider = { schemaVersion: '1.0', incidentId: null, lastEventId: null };
  assert.throws(() => validatePairedState(monitor, null), /paired-state-invalid/);
  assert.throws(() => validatePairedState(monitor, provider), /paired-state-invalid/);
  assert.doesNotThrow(() => validatePairedState({ ...monitor, pendingEvents: [event] }, provider));
  const recovery = { ...event, type: 'product-recovery' };
  assert.throws(() => validatePairedState({ ...monitor, incidentOpen: false, pendingEvents: [recovery] }, provider), /paired-state-invalid/);
  assert.doesNotThrow(() => validatePairedState({ ...monitor, incidentOpen: false, pendingEvents: [recovery] }, { ...provider, lastEventId: event.id }));
});
