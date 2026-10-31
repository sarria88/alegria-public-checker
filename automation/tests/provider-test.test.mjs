import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerTest, publicDiagnostics } from '../provider-test.mjs';

function fakeProvider(options = {}) {
  let clock = Date.parse('2026-10-31T00:00:00Z'), incident, heartbeat, lastBeat, lost = false, lostHeartbeat = false;
  const requests = [], beatUrl = 'https://incidents.betterstack.com/api/v1/heartbeat/fixture-test-url';
  const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  const fetcher = async (url, request) => {
    url = String(url); requests.push({ url, method: request.method });
    const path = new URL(url).pathname, body = request.body ? JSON.parse(request.body) : null;
    if (url.startsWith(beatUrl)) {
      if (url.endsWith('/fail')) heartbeat.attributes.status = 'down';
      else { heartbeat.attributes.status = 'up'; lastBeat = clock; }
      return response({});
    }
    if (path === '/api/v3/incidents' && request.method === 'GET') return response({ data: incident ? [incident] : [] });
    if (path === '/api/v3/incidents' && request.method === 'POST') {
      incident = { id: '42', attributes: { ...body, resolved_at: null } };
      if (options.lostCreateAcknowledgement && !lost) { lost = true; throw new Error('fixture confidential API response'); }
      return response({ data: incident }, 201);
    }
    if (path === '/api/v3/incidents/42' && request.method === 'GET') return response({ data: incident });
    if (path === '/api/v3/incidents/42/resolve') {
      if (incident.attributes.resolved_at) return response({}, 409);
      incident.attributes.resolved_at = new Date(clock).toISOString(); return response({ data: incident });
    }
    if (path === '/api/v2/heartbeats' && request.method === 'GET') return response({ data: [...(options.previousAttempt ? [{ id: '98', attributes: { name: '[TEST] Alegria external checker 123456-1 heartbeat', paused: true } }] : []), ...(heartbeat ? [heartbeat] : [])] });
    if (path === '/api/v2/heartbeats' && request.method === 'POST') {
      heartbeat = { id: '99', attributes: { ...body, url: beatUrl, status: 'pending', paused: false } };
      if (options.lostHeartbeatAcknowledgement && !lostHeartbeat) { lostHeartbeat = true; throw Error('fixture heartbeat acknowledgement lost'); }
      return response({ data: heartbeat }, 201);
    }
    if (path === '/api/v2/heartbeats/99' && request.method === 'PATCH') { heartbeat.attributes.paused = body.paused; return response({ data: heartbeat }); }
    if (path === '/api/v2/heartbeats/99' && request.method === 'GET') {
      if (heartbeat.attributes.status === 'up' && clock - lastBeat >= 30000 && !options.ignoreSilence) heartbeat.attributes.status = 'down';
      return response({ data: heartbeat });
    }
    throw Error('unexpected test request');
  };
  return { fetcher, now: () => clock, sleep: async ms => { clock += ms; }, requests, beatUrl, incident: () => incident, heartbeat: () => heartbeat };
}
const env = { BETTER_STACK_API_TOKEN: 'fixture-api-token', BETTER_STACK_REQUESTER_EMAIL: 'fixture@example.invalid', GITHUB_RUN_ID: '123456' };

test('hosted harness synthetic FFSS and accelerated silence clean up only labeled test resources', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provider-test-fixture-')), provider = fakeProvider();
  try {
    const result = await providerTest({ env, work, ...provider });
    assert.equal(result.outcome, 'PASS'); assert.equal(result.checks.acceleratedThirtySecondSilence, 'PASS');
    assert.equal(provider.heartbeat().attributes.paused, true); assert.ok(provider.incident().attributes.resolved_at);
    assert.match(provider.incident().attributes.name, /^\[TEST\]/);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('fixture-api-token'), false); assert.equal(serialized.includes('fixture-test-url'), false);
    assert.ok(provider.requests.every(item => new URL(item.url).origin === 'https://incidents.betterstack.com'));
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('a created URL equal to production completion secret is rejected before any heartbeat request', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provider-test-fixture-')), provider = fakeProvider();
  try {
    const result = await providerTest({ env: { ...env, PRODUCTION_COMPLETION_HEARTBEAT_URL: provider.beatUrl }, work, ...provider });
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.checks.execution, 'FAIL');
    assert.equal(provider.requests.some(item => item.url.startsWith(provider.beatUrl)), false);
    assert.equal(provider.heartbeat().attributes.paused, true);
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('lost creation acknowledgement is reconciled by exact run TEST metadata and closed', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provider-test-fixture-')), provider = fakeProvider({ lostCreateAcknowledgement: true });
  try {
    const result = await providerTest({ env, work, ...provider });
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.checks.testIncidentCleanup, 'PASS');
    assert.ok(provider.incident().attributes.resolved_at);
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('explicit fail simulation does not turn unobserved real silence into PASS', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provider-test-fixture-')), provider = fakeProvider({ ignoreSilence: true });
  try {
    const result = await providerTest({ env, work, ...provider });
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.checks.acceleratedThirtySecondSilence, 'INCOMPLETE');
    assert.equal(result.checks.explicitFailureSimulation, 'PASS'); assert.equal(provider.heartbeat().attributes.paused, true);
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('rerun attempt identity reconciles lost heartbeat acknowledgement without selecting prior paused test', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provider-test-fixture-')), provider = fakeProvider({ previousAttempt: true, lostHeartbeatAcknowledgement: true });
  try {
    const result = await providerTest({ env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, work, ...provider });
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.checks.disposableHeartbeatPaused, 'PASS');
    assert.equal(provider.heartbeat().attributes.paused, true);
    assert.match(provider.heartbeat().attributes.name, /123456-2 heartbeat$/);
    assert.equal(provider.requests.some(item => item.url.endsWith('/heartbeats/98')), false);
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('public diagnostics allow only fixed check/stage names and numeric HTTP status', () => {
  const text = publicDiagnostics({ outcome: 'INCOMPLETE', failedStage: 'product-alert-delivery', lastHttpStatus: 403, checks: { firstFailureDoesNotAlert: 'PASS', 'fixture-private-url': 'FAIL', execution: 'FAIL' }, rawResponse: 'fixture-api-token' });
  assert.match(text, /firstFailureDoesNotAlert: PASS/); assert.match(text, /Failed stage: product-alert-delivery/); assert.match(text, /Provider HTTP status: 403/);
  assert.equal(text.includes('fixture-private'), false); assert.equal(text.includes('fixture-api-token'), false);
});
