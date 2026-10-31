import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuration } from '../config.mjs';
import { browserHome } from '../browser.mjs';
import { createChecker } from '../checker.mjs';
import { fixture, releaseEvidence } from './fixture.mjs';

test('real headless Home ES/EN apex/www with API feed, visible coherent detail, byte verification and screenshots', { timeout: 60000 }, async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'alegria-checker-browser-'));
  try {
    const report = await createChecker(configuration({ ...f.config, evidence: releaseEvidence(), screenshots: directory }))('gate');
    assert.equal(report.outcome, 'PASS', JSON.stringify(report.checks.filter(x => x.status !== 'PASS')));
    const homes = report.checks.filter(x => x.name.startsWith('home-')); assert.equal(homes.length, 4);
    assert.ok(homes.every(x => x.httpStatus === 200 && x.evidence.detailVisible && x.evidence.apiFeedObserved && x.evidence.screenshot));
    assert.ok(homes.every(x => x.evidence.instances.length >= 2 && x.evidence.instances.every(instance => instance.replica === 'fixture-public-replica-one' && instance.correlationId)));
    assert.equal((await readdir(directory)).filter(x => x.endsWith('.png')).length, 4);
  } finally { await f.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }
});
for (const mode of ['instance-missing', 'instance-malformed']) {
  test('browser gate requires actual response instance identifiers: ' + mode, async () => {
    const f = await fixture({ mode }), config = configuration({ ...f.config, screenshots: null });
    try { await assert.rejects(browserHome(config, { base: f.apex, language: 'es', manifest: config.manifest, signal: AbortSignal.timeout(10000), runId: randomUUID(), mode: 'gate' }), error => error.status === 'INCOMPLETE' && error.errorClass === 'evidence/browser-served-instance'); }
    finally { await f.close(); }
  });
}
for (const mode of ['shell', 'javascript', 'asset', 'feed-empty', 'detail-missing', 'api-release', 'frontend-redirect', 'wrong-api', 'wrong-language', 'redirect-loop']) {
  test('real browser rejects ' + mode + ' even when readiness is healthy', { timeout: 15000 }, async () => {
    const f = await fixture({ mode }), config = configuration({ ...f.config, navigationTimeoutMs: 1000, screenshots: null });
    try { await assert.rejects(browserHome(config, { base: f.apex, language: 'es', manifest: config.manifest, signal: AbortSignal.timeout(10000), runId: randomUUID() })); if (mode === 'redirect-loop') assert.ok(f.state.documentRequests <= 3); }
    finally { await f.close(); }
  });
}
test('without browser cannot pass; reviewed manifest mismatch cannot pass', async () => {
  const f = await fixture();
  try {
    const config = configuration({ ...f.config, browser: false });
    await assert.rejects(browserHome(config, { base: f.apex, language: 'es', manifest: config.manifest, signal: AbortSignal.timeout(5000), runId: randomUUID() }), error => error.status === 'INCOMPLETE');
    const wrong = { ...config.manifest, files: { ...config.manifest.files, '/': 'e'.repeat(64) } };
    await assert.rejects(browserHome({ ...config, browser: true }, { base: f.apex, language: 'es', manifest: wrong, signal: AbortSignal.timeout(5000), runId: randomUUID() }), error => error.errorClass === 'release/frontend-bytes');
  } finally { await f.close(); }
});
test('two allowed frontend redirects preserve final live Home URL and visible news', async () => {
  const f = await fixture({ mode: 'valid-redirect' }), config = configuration({ ...f.config, screenshots: null });
  try { const result = await browserHome(config, { base: f.apex, language: 'es', manifest: config.manifest, signal: AbortSignal.timeout(10000), runId: randomUUID() }); assert.equal(result.finalOrigin, f.www); assert.equal(result.redirects.length, 2); assert.equal(result.detailVisible, true); }
  finally { await f.close(); }
});
