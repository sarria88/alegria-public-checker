import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(process.env.MINIFLARE_MODULE ?? 'miniflare');
const source = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');
const env = { ENABLED: 'true', GITHUB_DISPATCH_TOKEN: 'github_pat_' + 'f'.repeat(40), GITHUB_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00Z' };

async function runtime(status, body = null, workerSource = source) {
  const outbound = [];
  const options = {
    // This installed workerd supports through 2026-10-30. Production's existing
    // 2026-10-31 compatibility setting is not modified by this test or fix.
    compatibilityDate: '2026-10-30',
    modules: [
      { type: 'ESModule', path: 'harness.mjs', contents: `import worker from './worker.mjs'; export default { async fetch(request, env) { try { await worker.scheduled({}, env); return new Response('accepted'); } catch (error) { return new Response(error.message, {status: 500}); } } };` },
      { type: 'ESModule', path: 'worker.mjs', contents: workerSource },
    ],
    bindings: env,
    outboundService: async request => {
      outbound.push({ url: request.url, method: request.method, body: await request.text() });
      return new Response(body, { status, ...(status >= 300 && status < 400 ? { headers: { Location: 'https://fixture.invalid/redirect-target' } } : {}) });
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  return { mf, outbound };
}
test('real workerd scheduled path accepts one mocked GitHub dispatch', async () => {
  const { mf, outbound } = await runtime(204);
  try {
    const response = await mf.dispatchFetch('http://local.test');
    assert.equal(response.status, 200, (await response.text()) + '; outboundCalls=' + outbound.length);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://api.github.com/repos/sarria88/alegria-public-checker/actions/workflows/public-checker.yml/dispatches');
    assert.equal(outbound[0].method, 'POST');
    assert.deepEqual(JSON.parse(outbound[0].body), { ref: 'main', inputs: { operation: 'cycle', bootstrap: false } });
  } finally { await mf.dispose(); }
});
test('real workerd reproduces legacy error mode before any outbound request', async () => {
  const legacy = source.replace("redirect: 'manual'", "redirect: 'error'");
  assert.notEqual(legacy, source);
  const { mf, outbound } = await runtime(204, null, legacy);
  try {
    const response = await mf.dispatchFetch('http://local.test');
    assert.equal(response.status, 500); assert.equal(await response.text(), 'dispatcher/network-failed');
    assert.equal(outbound.length, 0);
  } finally { await mf.dispose(); }
});
for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
  test('real workerd rejects ' + status + ' without following or retrying', async () => {
    const { mf, outbound } = await runtime(status);
    try {
      const response = await mf.dispatchFetch('http://local.test');
      assert.equal(response.status, 500); assert.equal(await response.text(), 'dispatcher/redirect-rejected');
      assert.equal(outbound.length, 1); assert.equal(outbound[0].url, 'https://api.github.com/repos/sarria88/alegria-public-checker/actions/workflows/public-checker.yml/dispatches');
    } finally { await mf.dispose(); }
  });
}
test('real workerd surfaces HTTP rejection separately from a pre-network failure', async () => {
  const { mf, outbound } = await runtime(403);
  try {
    const response = await mf.dispatchFetch('http://local.test');
    assert.equal(response.status, 500); assert.equal(await response.text(), 'dispatcher/github-dispatch-failed');
    assert.equal(outbound.length, 1);
  } finally { await mf.dispose(); }
});
