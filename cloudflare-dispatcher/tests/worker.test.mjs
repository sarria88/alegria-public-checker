import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { dispatch, DISPATCH_URL } from '../worker.mjs';

const env = { ENABLED: 'true', GITHUB_DISPATCH_TOKEN: 'github_pat_' + 'f'.repeat(40), GITHUB_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00Z' };
test('disabled by default and no request made', async () => {
  let calls = 0;
  assert.deepEqual(await dispatch({}, { fetcher: async () => { calls++; } }), { status: 'disabled' });
  assert.equal(calls, 0);
});
test('one exact TLS target, main cycle and no bootstrap; overrides ignored', async () => {
  let calls = 0;
  await dispatch({ ...env, DISPATCH_URL: 'https://example.invalid', operation: 'provider-test', bootstrap: 'true' }, { fetcher: async (url, request) => {
    calls++; assert.equal(url, DISPATCH_URL); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.deepEqual(JSON.parse(request.body), { ref: 'main', inputs: { operation: 'cycle', bootstrap: false } });
    assert.equal(request.headers.Authorization, 'Bearer ' + env.GITHUB_DISPATCH_TOKEN);
    assert.equal(request.headers['X-GitHub-Api-Version'], '2026-03-10');
    return { status: 200, text: () => { throw Error('must not read response'); }, headers: new Proxy({}, { get() { throw Error('must not inspect headers'); } }) };
  } });
  assert.equal(calls, 1);
});
test('legacy accepted response works without body parsing', async () => {
  assert.deepEqual(await dispatch(env, { fetcher: async () => ({ status: 204 }) }), { status: 'accepted' });
});
test('expired or incomplete credentials fail before network', async () => {
  let calls = 0;
  await assert.rejects(dispatch({ ...env, GITHUB_TOKEN_EXPIRES_AT: '2000-01-01T00:00:00Z' }, { fetcher: async () => { calls++; } }), { message: 'dispatcher/token-expired' });
  await assert.rejects(dispatch({ ...env, GITHUB_DISPATCH_TOKEN: 'classic-or-malformed' }, { fetcher: async () => { calls++; } }), { message: 'dispatcher/configuration-incomplete' });
  assert.equal(calls, 0);
});
test('redirect and HTTP errors yield fixed error without reading response', async () => {
  for (const status of [301, 302, 401, 403, 429, 500]) {
    await assert.rejects(dispatch(env, { fetcher: async () => ({ status, text: () => { throw Error('must not read body'); } }) }), { message: 'dispatcher/github-dispatch-failed' });
  }
});
test('network error is sanitized and abort bounds the request to ten seconds', async () => {
  await assert.rejects(dispatch(env, { fetcher: async () => { throw Error(env.GITHUB_DISPATCH_TOKEN); } }), { message: 'dispatcher/network-failed' });
  let milliseconds, cleared = false;
  await assert.rejects(dispatch(env, {
    setTimer: (callback, delay) => { milliseconds = delay; queueMicrotask(callback); return 1; },
    clearTimer: () => { cleared = true; },
    fetcher: async (_url, request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(Error('private abort data')))),
  }), { message: 'dispatcher/timeout' });
  assert.equal(milliseconds, 10000); assert.equal(cleared, true);
});
test('every HTTP method returns 404 and cannot dispatch', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await worker.fetch(new Request('https://example.invalid/trigger', { method }), env);
    assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found');
  }
});
test('native Cron remains backward compatible until explicit validated clock switch', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/public-checker.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '2-59\/5 \* \* \* \*'/);
  assert.match(workflow, /\(github\.event_name != 'schedule' \|\| vars\.CHECKER_CLOCK != 'external'\)/);
  assert.match(workflow, /github\.event_name == 'schedule' && vars\.CHECKER_CLOCK == 'external' && 'external-public-checker-native-disabled'/);
  const admitted = (event, clock) => event !== 'schedule' || clock !== 'external';
  assert.equal(admitted('schedule', undefined), true); assert.equal(admitted('schedule', 'external'), false);
  assert.equal(admitted('workflow_dispatch', 'external'), true);
  const group = (event, operation, clock) => event === 'workflow_dispatch' && operation === 'provider-test' ? 'test' : event === 'schedule' && clock === 'external' ? 'native-disabled' : 'product';
  assert.notEqual(group('schedule', undefined, 'external'), group('workflow_dispatch', 'cycle', 'external'));
  assert.equal(group('schedule', undefined, undefined), group('workflow_dispatch', 'cycle', undefined));
  assert.equal(group('workflow_dispatch', 'provider-test', 'external'), 'test');
});
