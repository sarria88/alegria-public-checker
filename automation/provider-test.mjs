import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, appendFile } from 'node:fs/promises';
import { atomicJson, readJson, productTransition, deliverPending } from '../checker/state.mjs';
import { createBetterStackAdapter } from '../checker/adapters/better-stack.mjs';

const origin = 'https://incidents.betterstack.com';
const fail = () => new Error('provider-test/operation-failed');
export async function providerTest({ env = process.env, fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, work = 'runtime/provider-test' } = {}) {
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  if (!env.BETTER_STACK_API_TOKEN || !env.BETTER_STACK_REQUESTER_EMAIL || !/^\d{1,24}$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d{1,6}$/.test(attempt)) throw fail();
  const runIdentity = env.GITHUB_RUN_ID + '-' + attempt;
  const label = '[TEST] Alegria external checker ' + runIdentity;
  const result = { version: 1, test: true, startedAtUtc: new Date(now()).toISOString(), checks: {}, notes: ['Synthetic FFSS exercises adapter delivery without probing or disrupting production.', 'Thirty-second silence proves only the test threshold, not production >12-minute silence or one-minute evaluation cadence.'] };
  let testIncidentId, heartbeatId, heartbeatUrl, stage = 'initialization';
  const testEnv = { ...env, BETTER_STACK_STATE_PATH: resolve(work, 'provider-state.json'), BETTER_STACK_INSTANCE: 'provider-test-' + runIdentity };
  // This harness never loads production state or calls the production completion hook.
  await mkdir(work, { recursive: true, mode: 0o700 });
  if (await readJson(testEnv.BETTER_STACK_STATE_PATH)) throw fail();
  await atomicJson(testEnv.BETTER_STACK_STATE_PATH, { schemaVersion: '1.0', incidentId: null, lastEventId: null });
  let state;
  const persist = value => atomicJson(resolve(work, 'monitor-state.json'), value);
  async function request(path, method = 'GET', body) {
    try {
      const response = await fetcher(origin + path, { method, headers: { Authorization: 'Bearer ' + env.BETTER_STACK_API_TOKEN, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok && !(response.status === 409 && path.endsWith('/resolve'))) { result.lastHttpStatus = response.status; throw fail(); }
      return response.status === 409 ? null : await response.json();
    } catch { throw fail(); }
  }
  async function beat(suffix = '') {
    if (!heartbeatId || !heartbeatUrl || !['', '/fail'].includes(suffix)) throw fail();
    try {
      const response = await fetcher(heartbeatUrl + suffix, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { result.lastHttpStatus = response.status; throw fail(); }
    } catch { throw fail(); }
  }
  async function waitForHeartbeat(expected, seconds) {
    const deadline = now() + seconds * 1000;
    do {
      const current = await request('/api/v2/heartbeats/' + heartbeatId);
      if (current?.data?.attributes?.status === expected) return true;
      await sleep(5000);
    } while (now() < deadline);
    return false;
  }
  const liveFetch = async (url, options) => {
    if (options.method === 'POST' && String(url) === origin + '/api/v3/incidents') {
      const body = JSON.parse(options.body);
      options = { ...options, body: JSON.stringify({ ...body, name: label, summary: label + ' — safe synthetic two-failure alert', description: 'Controlled provider integration test; production is not being failed. Test instance ' + testEnv.BETTER_STACK_INSTANCE }) };
    }
    const response = await fetcher(url, options);
    if (!response.ok && response.status !== 409) result.lastHttpStatus = response.status;
    return response;
  };
  const adapter = createBetterStackAdapter({ env: testEnv, fetcher: liveFetch });
  try {
    stage = 'product-first-failure';
    state = productTransition(state, { outcome: 'FAIL', runId: 'synthetic-first', finishedAtUtc: new Date(now()).toISOString() }); await persist(state);
    if (state.pendingEvents.length !== 0) throw fail();
    result.checks.firstFailureDoesNotAlert = 'PASS';
    state = productTransition(state, { outcome: 'INCOMPLETE', runId: 'synthetic-second', finishedAtUtc: new Date(now()).toISOString() }); await persist(state);
    stage = 'injected-channel-failure';
    const failedAdapter = createBetterStackAdapter({ env: testEnv, fetcher: async () => { throw new Error('synthetic-private-channel-value'); } });
    let channelFailed = false;
    try { await deliverPending(state, failedAdapter, persist); } catch (error) { channelFailed = error.errorClass === 'monitor/notification-delivery'; }
    if (!channelFailed || state.pendingEvents.length !== 1) throw fail();
    result.checks.injectedChannelFailureSanitizedAndPending = 'PASS';
    stage = 'product-alert-delivery';
    await deliverPending(state, adapter, persist);
    testIncidentId = (await readJson(testEnv.BETTER_STACK_STATE_PATH))?.incidentId;
    if (!/^\d+$/.test(testIncidentId ?? '')) throw fail();
    const opened = await request('/api/v3/incidents/' + testIncidentId);
    if (opened?.data?.attributes?.resolved_at || opened?.data?.attributes?.name !== label) throw fail();
    result.checks.secondFailureCreatesLabeledTestIncident = 'PASS';
    stage = 'product-first-pass';
    state = productTransition(state, { outcome: 'PASS', runId: 'synthetic-third', finishedAtUtc: new Date(now()).toISOString() }); await persist(state);
    if (!state.incidentOpen || state.pendingEvents.length) throw fail();
    const stillOpen = await request('/api/v3/incidents/' + testIncidentId);
    if (stillOpen?.data?.attributes?.resolved_at) throw fail();
    result.checks.firstPassDoesNotRecover = 'PASS';
    stage = 'product-recovery-delivery';
    state = productTransition(state, { outcome: 'PASS', runId: 'synthetic-fourth', finishedAtUtc: new Date(now()).toISOString() }); await persist(state); await deliverPending(state, adapter, persist);
    const recovered = await request('/api/v3/incidents/' + testIncidentId);
    if (!recovered?.data?.attributes?.resolved_at) throw fail();
    result.checks.secondPassResolvesTestIncident = 'PASS';

    stage = 'test-heartbeat-create';
    const inventory = await request('/api/v2/heartbeats?per_page=50');
    if (!Array.isArray(inventory?.data) || inventory.data.length >= 10 || inventory.links?.next) throw fail();
    const created = await request('/api/v2/heartbeats', 'POST', { name: label + ' heartbeat', period: 30, grace: 0, email: true, call: false, sms: false, push: false, critical_alert: false });
    heartbeatId = created?.data?.id;
    if (!/^\d+$/.test(heartbeatId ?? '')) throw fail();
    const url = new URL(created?.data?.attributes?.url);
    if (url.origin !== origin || !/^\/api\/v1\/heartbeat\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password || url.href === env.PRODUCTION_COMPLETION_HEARTBEAT_URL || url.href === env.BETTER_STACK_COMPLETION_HEARTBEAT_URL) throw fail();
    heartbeatUrl = url.href;
    stage = 'test-heartbeat-start';
    await beat();
    result.checks.disposableHeartbeatStarted = 'PASS';
    stage = 'test-heartbeat-silence';
    const silenceBegan = now();
    const missed = await waitForHeartbeat('down', 100);
    result.checks.acceleratedThirtySecondSilence = missed && now() - silenceBegan >= 30000 ? 'PASS' : 'INCOMPLETE';
    stage = 'test-heartbeat-recovery';
    await beat();
    result.checks.disposableHeartbeatRecovery = await waitForHeartbeat('up', 30) ? 'PASS' : 'FAIL';
    stage = 'test-heartbeat-explicit-failure';
    await beat('/fail');
    result.checks.explicitFailureSimulation = await waitForHeartbeat('down', 30) ? 'PASS' : 'FAIL';
    stage = 'test-heartbeat-explicit-recovery';
    await beat();
    result.checks.explicitSimulationRecovery = await waitForHeartbeat('up', 30) ? 'PASS' : 'FAIL';
  } catch { result.checks.execution = 'FAIL'; result.failedStage = stage; }
  finally {
    // Lost acknowledgements are reconciled only by this run's exact TEST name
    // and unique metadata. No production incident or heartbeat is selected.
    if (!heartbeatId) {
      try {
        const inventory = await request('/api/v2/heartbeats?per_page=50');
        const matches = inventory?.data?.filter(item => item.attributes?.name === label + ' heartbeat') ?? [];
        if (matches.length === 1 && /^\d+$/.test(matches[0].id)) heartbeatId = matches[0].id;
      } catch { result.checks.testResourceReconciliation = 'FAIL'; }
    }
    if (!testIncidentId) {
      try {
        const query = new URLSearchParams({ 'metadata[checker_instance][][value]': testEnv.BETTER_STACK_INSTANCE });
        const inventory = await request('/api/v3/incidents?' + query);
        const matches = inventory?.data?.filter(item => item.attributes?.name === label) ?? [];
        if (matches.length === 1 && /^\d+$/.test(matches[0].id)) testIncidentId = matches[0].id;
      } catch { result.checks.testResourceReconciliation = 'FAIL'; }
    }
    if (heartbeatId) {
      try {
        await request('/api/v2/heartbeats/' + heartbeatId, 'PATCH', { paused: true });
        const paused = await request('/api/v2/heartbeats/' + heartbeatId);
        result.checks.disposableHeartbeatPaused = paused?.data?.attributes?.paused === true || !!paused?.data?.attributes?.paused_at ? 'PASS' : 'FAIL';
      } catch { result.checks.disposableHeartbeatPaused = 'FAIL'; }
    }
    if (testIncidentId) {
      try { await request('/api/v3/incidents/' + testIncidentId + '/resolve', 'POST', { resolved_by: 'Controlled TEST cleanup' }); result.checks.testIncidentCleanup = 'PASS'; }
      catch { result.checks.testIncidentCleanup = 'FAIL'; }
    }
  }
  result.finishedAtUtc = new Date(now()).toISOString();
  result.outcome = Object.values(result.checks).every(value => value === 'PASS') ? 'PASS' : 'INCOMPLETE';
  if (result.outcome !== 'PASS' && !result.failedStage) result.failedStage = Object.entries(result.checks).find(([, value]) => value !== 'PASS')?.[0] ?? 'cleanup';
  result.emailReceipt = 'Must be independently verified in the recipient mailbox; API state is not delivery proof.';
  await atomicJson(resolve(work, 'receipt', 'aggregate.json'), result);
  return result;
}
export function publicDiagnostics(result) {
  const allowedChecks = new Set(['firstFailureDoesNotAlert', 'injectedChannelFailureSanitizedAndPending', 'secondFailureCreatesLabeledTestIncident', 'firstPassDoesNotRecover', 'secondPassResolvesTestIncident', 'disposableHeartbeatStarted', 'acceleratedThirtySecondSilence', 'disposableHeartbeatRecovery', 'explicitFailureSimulation', 'explicitSimulationRecovery', 'execution', 'testResourceReconciliation', 'disposableHeartbeatPaused', 'testIncidentCleanup']);
  const allowedStages = new Set(['initialization', 'product-first-failure', 'injected-channel-failure', 'product-alert-delivery', 'product-first-pass', 'product-recovery-delivery', 'test-heartbeat-create', 'test-heartbeat-start', 'test-heartbeat-silence', 'test-heartbeat-recovery', 'test-heartbeat-explicit-failure', 'test-heartbeat-explicit-recovery', 'cleanup', ...allowedChecks]);
  const lines = ['Provider TEST outcome: ' + (result.outcome === 'PASS' ? 'PASS' : 'INCOMPLETE')];
  for (const [name, status] of Object.entries(result.checks ?? {})) if (allowedChecks.has(name) && ['PASS', 'FAIL', 'INCOMPLETE'].includes(status)) lines.push(name + ': ' + status);
  if (allowedStages.has(result.failedStage)) lines.push('Failed stage: ' + result.failedStage);
  if (Number.isInteger(result.lastHttpStatus) && result.lastHttpStatus >= 100 && result.lastHttpStatus <= 599) lines.push('Provider HTTP status: ' + result.lastHttpStatus);
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await providerTest(); const diagnostic = publicDiagnostics(result); process.stdout.write(diagnostic); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, diagnostic); process.exitCode = result.outcome === 'PASS' ? 0 : 2; }
  catch { process.stderr.write('provider-test/unavailable\n'); process.exitCode = 2; }
}
