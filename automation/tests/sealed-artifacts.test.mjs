import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seal, unseal, sealDirectory, unsealDirectory } from '../sealed-artifacts.mjs';
const key = Buffer.alloc(32, 7).toString('base64');
const entries = [{ path: 'monitor-state.json', bytes: Buffer.from('{"fixture":"confidential-marker"}') }];
test('AES GCM roundtrip randomizes ciphertext and does not expose plaintext', () => {
  const first = seal(entries, key, 'state'), second = seal(entries, key, 'state');
  assert.notDeepEqual(first, second); assert.equal(first.includes(Buffer.from('confidential-marker')), false);
  assert.deepEqual(unseal(first, key, 'state'), entries);
});
test('tamper, wrong key, cross-purpose replay and truncated payload fail closed', () => {
  const encoded = seal(entries, key, 'state');
  const altered = Buffer.from(encoded); altered[altered.length - 1] ^= 1;
  for (const [bytes, secret, kind] of [[altered,key,'state'], [encoded,Buffer.alloc(32,8).toString('base64'),'state'], [encoded,key,'evidence'], [encoded.subarray(0,20),key,'state']]) {
    assert.throws(() => unseal(bytes, secret, kind), { message: 'automation/sealed-artifact-invalid' });
  }
});
test('sealing rejects path traversal, unexpected files and invalid key', () => {
  assert.throws(() => seal([{ path: '../outside.json', bytes: Buffer.from('x') }], key, 'state'));
  assert.throws(() => seal([{ path: 'secret.env', bytes: Buffer.from('x') }], key, 'evidence'));
  assert.throws(() => seal(entries, 'short', 'state'));
});
test('directory encryption restores exact files and refuses over-budget upload payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checker-encryption-fixture-'));
  try {
    const input = join(root, 'input'), output = join(root, 'restored'); await mkdir(input);
    await writeFile(join(input, entries[0].path), entries[0].bytes);
    const archive = join(root, 'state.sealed'); await sealDirectory(input, archive, 'state', 10000, key);
    await unsealDirectory(archive, output, 'state', key);
    assert.deepEqual(await readFile(join(output, entries[0].path)), entries[0].bytes);
    await assert.rejects(sealDirectory(input, join(root, 'blocked.sealed'), 'state', 1, key), { message: 'automation/artifact-budget-exceeded' });
    await assert.rejects(readFile(join(root, 'blocked.sealed')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
