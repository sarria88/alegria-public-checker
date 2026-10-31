import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const magic = Buffer.from('ALCKR01\0');
const maxBytes = 32 * 1024 * 1024;
const fail = () => new Error('automation/sealed-artifact-invalid');
const kinds = new Set(['state', 'evidence', 'metrics', 'image']);
function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw fail();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw fail();
  return key;
}
function validPath(name, kind) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name)
    && name.split('/').every(segment => segment && segment !== '.' && segment !== '..')
    && (kind === 'state' ? ['monitor-state.json', 'better-stack-state.json', 'completed-heartbeat.json', 'image-ledger.json'].includes(name)
      : kind === 'metrics' ? /^aggregate\.json$/.test(name)
        : kind === 'image' ? ['screenshot.webp', 'image.json'].includes(name)
          : ['monitor.json', 'stdout.json', 'stderr.txt', 'screenshot-index.json'].includes(name));
}
export function seal(entries, keyValue, kind) {
  if (!kinds.has(kind) || !Array.isArray(entries) || !entries.length || entries.length > 100) throw fail();
  let total = 0;
  for (const entry of entries) {
    if (!validPath(entry.path, kind) || !Buffer.isBuffer(entry.bytes)) throw fail();
    total += entry.bytes.length;
  }
  if (total > maxBytes || new Set(entries.map(entry => entry.path)).size !== entries.length) throw fail();
  const payload = gzipSync(Buffer.from(JSON.stringify(entries.map(entry => ({ path: entry.path, bytes: entry.bytes.toString('base64') })))));
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes(keyValue), nonce);
  cipher.setAAD(Buffer.from('alegria-checker:v1:' + kind));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([magic, nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal(buffer, keyValue, kind) {
  try {
    if (!kinds.has(kind) || buffer.length < 37 || buffer.length > maxBytes * 2 || !buffer.subarray(0, 8).equals(magic)) throw fail();
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(keyValue), buffer.subarray(8, 20));
    decipher.setAAD(Buffer.from('alegria-checker:v1:' + kind)); decipher.setAuthTag(buffer.subarray(20, 36));
    const zipped = Buffer.concat([decipher.update(buffer.subarray(36)), decipher.final()]);
    const entries = JSON.parse(gunzipSync(zipped, { maxOutputLength: maxBytes * 2 }).toString('utf8'));
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw fail();
    let total = 0;
    const result = entries.map(entry => {
      if (!validPath(entry.path, kind) || typeof entry.bytes !== 'string') throw fail();
      const bytes = Buffer.from(entry.bytes, 'base64'); total += bytes.length;
      if (bytes.toString('base64') !== entry.bytes || total > maxBytes) throw fail();
      return { path: entry.path, bytes };
    });
    if (new Set(result.map(entry => entry.path)).size !== result.length) throw fail();
    return result;
  } catch { throw fail(); }
}
async function entriesFrom(directory, kind) {
  const files = []; let total = 0;
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, item.name);
      if (item.isSymbolicLink()) throw fail();
      if (item.isDirectory()) await walk(path);
      else {
        const name = relative(resolve(directory), path).split(sep).join('/');
        const stat = await lstat(path); total += stat.size;
        if (!validPath(name, kind) || !stat.isFile() || total > maxBytes || files.length >= 100) throw fail();
        files.push({ path: name, bytes: await readFile(path) });
      }
    }
  }
  await walk(resolve(directory)); return files;
}
export async function sealDirectory(directory, output, kind, limit, key = process.env.CHECKER_ARTIFACT_KEY) {
  const encrypted = seal(await entriesFrom(directory, kind), key, kind);
  if (!Number.isSafeInteger(limit) || limit < 1 || encrypted.length > limit) throw new Error('automation/artifact-budget-exceeded');
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  await writeFile(output, encrypted, { flag: 'wx', mode: 0o600 });
  return encrypted.length;
}
export async function unsealDirectory(input, directory, kind, key = process.env.CHECKER_ARTIFACT_KEY) {
  const entries = unseal(await readFile(input), key, kind);
  for (const entry of entries) {
    const destination = resolve(directory, entry.path);
    if (!destination.startsWith(resolve(directory) + sep)) throw fail();
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, input, output, kind, limit] = process.argv.slice(2);
    if (command === 'seal') await sealDirectory(input, output, kind, Number(limit));
    else if (command === 'unseal') await unsealDirectory(input, output, kind);
    else throw fail();
  } catch { process.stderr.write('automation/sealed-artifact-operation-failed\n'); process.exitCode = 2; }
}
