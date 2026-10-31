import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { configuration, parseArguments } from '../config.mjs';
import { CheckError, exitCode, iso } from '../contracts.mjs';
import { createChecker } from '../checker.mjs';
import { feed, countries } from '../schemas.mjs';
import { validateEvidence, validateManifest } from '../manifest.mjs';
import { productTransition, heartbeatTransition, atomicJson, readJson, acquireLock, deliverPending } from '../state.mjs';
import { acceptedCycles, runGate } from '../gate.mjs';
import { networkError, createHttp, authorityOptions } from '../http.mjs';
import { fixture, page, releaseEvidence, API_SHA, FRONTEND_SHA } from './fixture.mjs';

const fakeBrowser = async () => ({ apiFeedObserved: true, detailVisible: true, fixtureOnly: true });
test('configuration accepts HTTPS and limits local fixture to literal loopback; no TLS bypass', () => {
  assert.equal(configuration().requestTimeoutMs, 15000); assert.equal(configuration().cycleTimeoutMs, 120000);
  for (const input of [{ apiBase: 'http://api.alegrianews.com' }, { localFixture: true, apiBase: 'http://localhost' }, { localFixture: true, apiBase: 'https://evil.invalid' }, { apiBase: 'https://user:secret@api.alegrianews.com' }, { requestTimeoutMs: 15001 }, { cycleTimeoutMs: 120001 }, { expectedApiRelease: 'short' }]) assert.throws(() => configuration(input));
  assert.equal(configuration({ localFixture: true, apiBase: 'http://127.0.0.1:1', apexUrl: 'http://127.0.0.1:2', wwwUrl: 'http://[::1]:3' }).localFixture, true);
  assert.throws(() => parseArguments(['gate', '--cycles', '1'])); assert.throws(() => parseArguments(['monitor', '--api-base']));
  assert.equal(parseArguments(['monitor', '--no-browser']).input.browser, false);
  assert.deepEqual(['PASS', 'FAIL', 'INCOMPLETE'].map(exitCode), [0, 1, 2]);
});
test('authority TLS options pin URL SNI and certificate target while preserving an invalid real HTTP Host', () => {
  const options = authorityOptions(new URL('https://api.alegrianews.com/api/categories'), { headers: { Host: 'invalid.example', 'X-Forwarded-Host': 'api.alegrianews.com' } });
  assert.equal(options.headers.host, 'invalid.example'); assert.equal(options.servername, 'api.alegrianews.com'); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity('invalid.example', { subjectaltname: 'DNS:api.alegrianews.com' }), undefined);
  assert.equal(options.checkServerIdentity('api.alegrianews.com', { subjectaltname: 'DNS:invalid.example' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  for (const [url, san] of [['https://127.0.0.1/', 'IP Address:127.0.0.1'], ['https://[::1]/', 'IP Address:0:0:0:0:0:0:0:1']]) {
    const literal = authorityOptions(new URL(url), { headers: { Host: 'invalid.example' } });
    assert.equal(literal.servername, ''); assert.equal(literal.rejectUnauthorized, true); assert.equal(literal.headers.host, 'invalid.example');
    assert.equal(literal.checkServerIdentity('invalid.example', { subjectaltname: san }), undefined);
    assert.equal(literal.checkServerIdentity('invalid.example', { subjectaltname: 'DNS:invalid.example' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  }
  assert.equal(authorityOptions(new URL('http://127.0.0.1/'), { headers: { Host: 'invalid.example' } }).servername, undefined);
});
test('schemas reject empty international, wrong envelope, duplicate IDs, anonymous vote and invalid ISO', () => {
  feed(page());
  for (const value of [{ ...page(), items: [] }, { ...page(), pageSize: 12 }, { ...page(), total: -1 }, { ...page(), items: [page().items[0], page().items[0]], total: 2 }, { ...page(), items: [{ ...page().items[0], userVote: 1 }] }]) assert.throws(() => feed(value));
  assert.throws(() => countries([{ code: 'ZZ', names: { es: 'x', en: 'x', fr: 'x' } }]));
  feed({ items: [], total: 0, page: 1, pageSize: 6 }, { allowEmpty: true, national: true });
});
test('HTTP full core safe loopback passes and produces versioned bounded JSON without session values', async () => {
  const f = await fixture();
  try {
    const report = await createChecker(configuration({ ...f.config, evidence: releaseEvidence() }), { browserRunner: fakeBrowser })('gate');
    assert.equal(report.outcome, 'PASS', JSON.stringify(report.checks.filter(x => x.status !== 'PASS')));
    assert.equal(report.checks.find(x => x.name === 'feed-national-es').evidence.content, 'EMPTY_VALID');
    assert.equal(report.schemaVersion, '1.0'); assert.equal(report.observedRelease.api[0], API_SHA);
    assert.ok(report.observedRelease.instances.length > 0); assert.ok(report.observedRelease.instances.every(x => x.apiSha === API_SHA && x.revision === 'fixture-public-r1' && x.replica === 'fixture-public-replica-one' && x.correlationId));
    assert.ok(report.checks.every(x => Number.isFinite(x.durationMs) && 'httpStatus' in x && 'correlationId' in x));
    assert.ok(!JSON.stringify(report).includes('FIXTURE_SECRET')); assert.ok(f.state.requests.some(x => x.path === '/api/articles/101'));
  } finally { await f.close(); }
});
for (const [mode, expected] of [['categories', 'content/categories-empty'], ['invalid-json', 'response/json'], ['empty', 'response/empty'], ['html', 'response/content-type'], ['redirect', 'http/unexpected-redirect'], ['duplicate-categories', 'schema/category-duplicate'], ['countries', 'schema/countries'], ['feed-empty', 'content/feed-empty'], ['duplicate-feed', 'schema/article-duplicate'], ['detail-missing', 'content/detail-unavailable'], ['cors-wrong', 'cors/allowed-origin'], ['cors-foreign', 'cors/foreign-authorized'], ['cookie', 'session/cookie-flags'], ['http', 'transport/public-http'], ['aca', 'transport/aca-authority'], ['admin', 'security/admin-exposed'], ['mutation', 'security/anonymous-mutation'], ['national-invalid', 'content/national-filter'], ['api-release', 'release/api']]) {
  test('readiness 200 cannot hide ' + mode, async () => {
    const f = await fixture({ mode });
    try {
      const report = await createChecker(configuration({ ...f.config, evidence: releaseEvidence() }), { browserRunner: fakeBrowser })('gate');
      assert.equal(report.outcome, 'FAIL');
      assert.ok(report.checks.some(x => x.errorClass === expected), JSON.stringify(report.checks.filter(x => x.status !== 'PASS')));
      if (mode !== 'api-release') assert.equal(report.checks.find(x => x.name === 'readiness').status, 'PASS');
    } finally { await f.close(); }
  });
}
test('detail disappears once: refetch feed once and try another dynamic ID', async () => {
  const f = await fixture({ mode: 'detail-race' });
  try { const report = await createChecker(configuration(f.config), { browserRunner: fakeBrowser })(); assert.equal(report.outcome, 'PASS'); assert.ok(f.state.requests.some(x => x.path === '/api/articles/102')); assert.equal(f.state.detailMisses, 1); }
  finally { await f.close(); }
});
test('timeout and DNS/TLS classifications are explicit; cycle does not overlap', async () => {
  const f = await fixture({ mode: 'timeout' });
  try {
    const run = createChecker(configuration({ ...f.config, requestTimeoutMs: 25 } ), { browserRunner: fakeBrowser });
    const first = run(); await assert.rejects(run(), /monitor\/overlap/); const report = await first;
    assert.equal(report.outcome, 'FAIL'); assert.ok(report.checks.some(x => x.errorClass === 'network/timeout'));
  } finally { await f.close(); }
  assert.equal(networkError({ cause: { code: 'ENOTFOUND' } }).errorClass, 'network/dns');
  assert.equal(networkError({ cause: { code: 'CERT_HAS_EXPIRED' } }).errorClass, 'network/tls');
  for (const [code, expected] of [['ENOTFOUND', 'network/dns'], ['CERT_HAS_EXPIRED', 'network/tls']]) {
    const request = createHttp({ requestTimeoutMs: 100 }, AbortSignal.timeout(500), async () => { throw Object.assign(new Error('not retained'), { cause: { code } }); });
    await assert.rejects(request('https://owned.invalid'), error => error.errorClass === expected);
  }
});
test('missing manifest, release or isolated same-SHA evidence is INCOMPLETE', async () => {
  const f = await fixture();
  try {
    const report = await createChecker(configuration(f.config), { browserRunner: fakeBrowser })('gate'); assert.equal(report.outcome, 'INCOMPLETE');
    const noManifest = await createChecker(configuration({ ...f.config, manifest: null }), { browserRunner: fakeBrowser })(); assert.equal(noManifest.outcome, 'INCOMPLETE');
    assert.throws(() => validateEvidence({ ...releaseEvidence(), apiSha: 'c'.repeat(40) }, API_SHA, FRONTEND_SHA));
    assert.throws(() => validateEvidence({ ...releaseEvidence(), replicas: [] }, API_SHA, FRONTEND_SHA));
    assert.throws(() => validateEvidence({ ...releaseEvidence(), imageDigest: 'header-only' }, API_SHA, FRONTEND_SHA));
    assert.throws(() => validateManifest({ ...f.config.manifest, files: { '/': 'a'.repeat(64) } }, FRONTEND_SHA));
  } finally { await f.close(); }
});
for (const mode of ['instance-missing', 'instance-malformed']) {
  test('gate requires actual bounded served identity despite complete isolated attestation: ' + mode, async () => {
    const f = await fixture({ mode });
    try {
      const report = await createChecker(configuration({ ...f.config, evidence: releaseEvidence() }), { browserRunner: fakeBrowser })('gate');
      assert.equal(report.outcome, 'INCOMPLETE'); assert.equal(report.checks.find(x => x.name === 'served-instance-identification').errorClass, 'evidence/served-instance');
      assert.equal(report.checks.find(x => x.name === 'isolated-release-evidence').status, 'PASS'); assert.equal(report.observedRelease.instances.length, 0);
    } finally { await f.close(); }
  });
}
test('product FF alert, FS no alert, FFS no recovery, FFSS one recovery; incomplete breaks recovery', () => {
  const report = outcome => ({ outcome, runId: 'fixture', finishedAtUtc: iso(0) });
  function run(sequence) { return [...sequence].reduce((state, item) => productTransition(state, report(item === 'S' ? 'PASS' : item === 'I' ? 'INCOMPLETE' : 'FAIL')), null); }
  assert.equal(run('FF').pendingEvents[0].type, 'product-alert'); assert.equal(run('FS').pendingEvents.length, 0);
  assert.equal(run('FFS').incidentOpen, true); assert.deepEqual(run('FFSS').pendingEvents.map(x => x.type), ['product-alert', 'product-recovery']);
  assert.equal(run('FFSIS').incidentOpen, true); assert.equal(run('FFFF').pendingEvents.length, 1);
});
test('watchdog requires completed heartbeat, >12min silent, two distinct completed cycles resume', () => {
  const hb = (id, ms) => ({ schemaVersion: '1.0', completed: true, runId: id, completedAtUtc: iso(ms), outcome: 'FAIL' });
  let state = heartbeatTransition(null, { ...hb('1', 0), completed: false }, 0); assert.equal(state.silent, false); assert.equal(state.heartbeatValid, false);
  state = heartbeatTransition(state, { ...hb('1', 0), completed: false }, 720001); assert.equal(state.silent, true);
  assert.equal(heartbeatTransition(null, hb('1', 0), 720000).silent, false); assert.equal(heartbeatTransition(null, hb('1', 0), 720001).silent, true);
  state = heartbeatTransition(state, hb('2', 1000), 1001); assert.equal(state.silent, true);
  state = heartbeatTransition(state, hb('2', 1000), 1002); assert.equal(state.silent, true);
  state = heartbeatTransition(state, hb('3', 2000), 2001); assert.equal(state.silent, false);
  assert.deepEqual(state.pendingEvents.map(x => x.type), ['monitor-silent', 'monitor-resumed']);
});
test('fresh watchdog persists grace anchor without a heartbeat; incomplete IDs never recover an incident', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alegria-checker-watchdog-'));
  const hb = (id, ms, completed = true) => ({ schemaVersion: '1.0', completed, runId: id, completedAtUtc: iso(ms) });
  try {
    const path = join(directory, 'watchdog.json');
    let state = heartbeatTransition(null, null, 0);
    assert.equal(state.watchStartedAtUtc, iso(0)); assert.equal(state.silent, false); assert.equal(state.heartbeatValid, false);
    await atomicJson(path, state);
    state = heartbeatTransition(await readJson(path), null, 720001);
    assert.equal(state.silent, true); assert.equal(state.pendingEvents[0].type, 'monitor-silent');
    state = heartbeatTransition(null, hb('expired', -720001), 0); assert.equal(state.silent, true);
    for (const [id, time] of [['start-one', 100], ['start-two', 200]]) {
      state = heartbeatTransition(state, hb(id, time, false), time);
      assert.equal(state.silent, true); assert.equal(state.completedRecovery, 0); assert.equal(state.lastRunId, null);
    }
    state = heartbeatTransition(state, hb('valid-one', 300), 300); assert.equal(state.silent, true); assert.equal(state.completedRecovery, 1);
    state = heartbeatTransition(state, hb('start-three', 400, false), 400); assert.equal(state.silent, true); assert.equal(state.completedRecovery, 1);
    state = heartbeatTransition(state, hb('valid-two', 500), 500); assert.equal(state.silent, false);
    assert.deepEqual(state.pendingEvents.map(x => x.type), ['monitor-silent', 'monitor-resumed']);
  } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
test('watchdog CLI without first heartbeat returns incomplete and persists its timer before detecting >12min silence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alegria-checker-watchdog-cli-'));
  try {
    const statePath = join(directory, 'state.json'), heartbeatPath = join(directory, 'absent-heartbeat.json');
    const args = ['cli.mjs', 'watchdog', '--state', statePath, '--heartbeat', heartbeatPath];
    const first = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(first.status, 2); assert.equal(JSON.parse(first.stdout).checks[0].errorClass, 'monitor/no-completed-heartbeat');
    const state = await readJson(statePath); assert.ok(Number.isFinite(Date.parse(state.watchStartedAtUtc))); assert.equal(state.silent, false);
    state.watchStartedAtUtc = iso(Date.now() - 720001); await atomicJson(statePath, state);
    const second = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(second.status, 1); assert.equal(JSON.parse(second.stdout).checks[0].errorClass, 'monitor/silent'); assert.equal((await readJson(statePath)).silent, true);
  } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
test('atomic state, exclusive lock, failed delivery retained and retry acknowledged once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alegria-checker-'));
  try {
    const path = join(directory, 'state.json'); await atomicJson(path, { n: 1 }); await atomicJson(path, { n: 2 }); assert.equal((await readJson(path)).n, 2);
    const unlock = await acquireLock(path + '.lock'); await assert.rejects(acquireLock(path + '.lock')); await unlock();
    const state = { pendingEvents: [{ id: 'fixture-event', type: 'product-alert' }] };
    await assert.rejects(deliverPending(state, { notify: async () => { throw Error('private transport error'); } }, async () => {})); assert.equal(state.pendingEvents.length, 1);
    let sends = 0; await deliverPending(state, { notify: async () => { sends++; } }, async () => {}); await deliverPending(state, { notify: async () => { sends++; } }, async () => {}); assert.equal(sends, 1);
  } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
test('gate enforces 3 complete PASS >=5min apart and >=10min span with injectable test clock only', async () => {
  let clock = 0;
  const report = () => ({ schemaVersion: '1.0', startedAtUtc: iso(clock), finishedAtUtc: iso(clock), outcome: 'PASS', environment: 'fixture', expectedRelease: { api: API_SHA }, observedRelease: { instances: [{ apiSha: API_SHA, revision: 'fixture-r1', replica: 'fixture-one', correlationId: 'fixture-correlation' }] }, checks: [{ name: 'fixture', status: 'PASS' }] });
  const result = await runGate(async () => report(), { now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(result.accepted, true); assert.equal(clock, 600000); assert.equal(result.outcome, 'PASS');
  assert.equal(acceptedCycles([report(), report(), report()]), false); assert.equal(acceptedCycles(result.cycles.slice(0, 2)), false);
  assert.equal(acceptedCycles(result.cycles.map(cycle => ({ ...cycle, observedRelease: { instances: [] } }))), false);
  const failed = await runGate(async () => ({ ...report(), outcome: 'FAIL', checks: [{ name: 'fixture', status: 'FAIL' }] }), { now: () => clock }); assert.equal(failed.cycles.length, 1); assert.equal(failed.outcome, 'FAIL');
});
test('CLI configuration failure exits2 with parseable versioned report and no raw argument echo', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'monitor', '--unknown', 'DO_NOT_ECHO_SECRET'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 2); const report = JSON.parse(result.stdout); assert.equal(report.schemaVersion, '1.0'); assert.equal(report.outcome, 'INCOMPLETE'); assert.ok(!result.stdout.includes('DO_NOT_ECHO_SECRET'));
});
test('CLI real local browser monitor exits0, readiness-green broken catalog exits1, no-browser exits2; completion heartbeat and pending delivery retained', { timeout: 60000 }, async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'alegria-checker-cli-'));
  const manifest = join(directory, 'manifest.json'), state = join(directory, 'state.json'), heartbeat = join(directory, 'heartbeat.json'), adapter = join(directory, 'adapter.mjs');
  try {
    await writeFile(manifest, JSON.stringify(f.config.manifest)); await writeFile(adapter, 'export async function notify(){throw Error("DO_NOT_ECHO_SECRET")}');
    const args = ['monitor', '--local-fixture', '--api-base', f.api, '--apex-url', f.apex, '--www-url', f.www, '--api-http-base', f.config.apiHttpBase, '--aca-url', f.config.acaUrls[0], '--expected-api-release', API_SHA, '--expected-frontend-release', FRONTEND_SHA, '--manifest', manifest, '--state', state, '--heartbeat', heartbeat, '--screenshots', directory, '--output', join(directory, 'report.json')];
    if (f.config.playwrightModule) args.push('--playwright-module', f.config.playwrightModule);
    if (f.config.browserExecutable) args.push('--browser-executable', f.config.browserExecutable);
    async function run(extra = []) {
      const child = spawn(process.execPath, ['cli.mjs', ...args, ...extra], { cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'exit'); assert.ok(!stdout.includes('DO_NOT_ECHO_SECRET') && !stdout.includes('FIXTURE_SECRET') && !stderr.includes('DO_NOT_ECHO_SECRET'));
      return { code, report: JSON.parse(stdout) };
    }
    let result = await run(); assert.equal(result.code, 0, JSON.stringify(result.report.checks.filter(x => x.status !== 'PASS')));
    const completion = await readJson(heartbeat); assert.equal(completion.completed, true); assert.equal(completion.runId, result.report.runId); assert.equal(completion.completedAtUtc, result.report.finishedAtUtc);
    f.state.mode = 'categories'; result = await run(['--adapter', adapter]); assert.equal(result.code, 1);
    result = await run(['--adapter', adapter]); assert.equal(result.code, 1); assert.ok(result.report.checks.some(x => x.errorClass === 'monitor/notification-delivery')); assert.equal((await readJson(state)).pendingEvents.length, 1);
    f.state.mode = ''; result = await run(['--no-browser']); assert.equal(result.code, 2); assert.equal(result.report.outcome, 'INCOMPLETE');
    assert.equal((await readJson(heartbeat)).completed, true);
  } finally { await f.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
