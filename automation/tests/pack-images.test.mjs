import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { losslessImage, packImages } from '../pack-images.mjs';
import { unseal } from '../sealed-artifacts.mjs';
import { storageEnvelope, validLedger } from '../storage-budget.mjs';

test('lossless screenshot object retains exact dimensions and RGBA pixels', async () => {
  const png = await sharp({ create: { width: 23, height: 17, channels: 4, background: { r: 9, g: 100, b: 220, alpha: 0.5 } } }).png().toBuffer();
  const image = await losslessImage(png);
  assert.equal(image.width, 23); assert.equal(image.height, 17);
  assert.deepEqual(await sharp(image.webp).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
});
test('identical screenshots share one encrypted object and each cycle keeps original mapping', async () => {
  const previous = process.cwd(), root = await mkdtemp(join(tmpdir(), 'checker-image-fixture-'));
  const key = Buffer.alloc(32, 11).toString('base64');
  try {
    process.chdir(root); await mkdir('runtime/state', { recursive: true }); await mkdir('runtime/evidence/screenshots', { recursive: true });
    await writeFile('runtime/state/image-ledger.json', JSON.stringify({ version: 1, objects: [] }));
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#347abc' } }).png().toBuffer();
    await writeFile('runtime/evidence/screenshots/fixture-apex-es.png', png); await writeFile('runtime/evidence/screenshots/fixture-www-es.png', png);
    const env = { CHECKER_ARTIFACT_KEY: key, GITHUB_OUTPUT: 'step-output.txt' };
    await packImages(env, async () => { throw Error('first appearance must not claim existing artifact'); });
    let index = JSON.parse(await readFile('runtime/evidence/screenshot-index.json', 'utf8'));
    assert.equal(index.images.length, 2); assert.equal(index.images[0].artifactName, index.images[1].artifactName);
    assert.equal(index.images[0].originalPngSha256, createHash('sha256').update(png).digest('hex'));
    const sealed = unseal(await readFile('sealed/images/0.sealed'), key, 'image');
    assert.equal(sealed.some(item => item.path === 'screenshot.webp'), true);
    assert.match(await readFile('step-output.txt', 'utf8'), /image0_needed=true/); assert.match(await readFile('step-output.txt', 'utf8'), /image1_needed=false/);
    await writeFile('runtime/evidence/screenshots/fixture-apex-es.png', png); await writeFile('step-output.txt', '');
    await packImages(env, async () => true);
    assert.match(await readFile('step-output.txt', 'utf8'), /image0_needed=false/);
    assert.equal(JSON.parse(await readFile('runtime/state/image-ledger.json', 'utf8')).objects.length, 1);
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }); }
});
test('reserved envelope and bounded image ledger reject unverified or exhausted storage', () => {
  assert.throws(() => storageEnvelope({}), /budget-unverified/);
  assert.throws(() => storageEnvelope({ CHECKER_EVIDENCE_LIMIT_BYTES: '32768', CHECKER_RESERVED_STORAGE_BYTES: '1000' }), /budget-insufficient/);
  const budget = storageEnvelope({ CHECKER_EVIDENCE_LIMIT_BYTES: '32768', CHECKER_RESERVED_STORAGE_BYTES: String(300 * 1024 * 1024) });
  assert.ok(budget.envelope < 250 * 1024 * 1024);
  assert.throws(() => validLedger({ version: 1, objects: Array.from({ length: 101 }, () => ['a'.repeat(64), 1, new Date().toISOString()]) }), /ledger-invalid/);
});
