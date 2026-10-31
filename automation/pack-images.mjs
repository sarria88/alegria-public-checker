import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, rm, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealDirectory } from './sealed-artifacts.mjs';
import { validLedger } from './storage-budget.mjs';
import { atomicJson, readJson } from '../checker/state.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const day = 86400000;
export async function losslessImage(png) {
  const webp = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  const before = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (before.info.width !== after.info.width || before.info.height !== after.info.height || !before.data.equals(after.data)) throw new Error('automation/screenshot-pixel-mismatch');
  return { webp, width: before.info.width, height: before.info.height, rgbaSha256: hash(before.data), webpSha256: hash(webp), pngSha256: hash(png) };
}
export async function existingImage(hashValue, env = process.env, fetcher = fetch, now = Date.now()) {
  if (!env.GH_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GH_REPO ?? '')) throw new Error('automation/artifact-lookup-unavailable');
  const name = 'checker-image-' + hashValue;
  const response = await fetcher('https://api.github.com/repos/' + env.GH_REPO + '/actions/artifacts?name=' + name + '&per_page=100', { headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('automation/artifact-lookup-unavailable');
  const result = await response.json();
  if (!Array.isArray(result.artifacts)) throw new Error('automation/artifact-lookup-unavailable');
  return result.artifacts.some(item => item.name === name && item.expired === false && item.workflow_run?.head_branch === 'main' && Date.parse(item.expires_at) > now + 7 * day + 3600000);
}
export async function packImages(env = process.env, lookup = existingImage) {
  const now = Date.now();
  const ledger = validLedger(await readJson('runtime/state/image-ledger.json'), now);
  let names;
  try { names = await readdir('runtime/evidence/screenshots'); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  if (names.length > 2 || names.some(name => !/^[A-Za-z0-9._-]+\.png$/.test(name))) throw new Error('automation/screenshot-set-invalid');
  const index = { version: 1, images: [] }, newObjects = new Set();
  for (const [i, name] of names.sort().entries()) {
    const png = await readFile(join('runtime/evidence/screenshots', name));
    const image = await losslessImage(png), objectName = 'checker-image-' + image.webpSha256;
    const known = ledger.objects.some(item => item[0] === image.webpSha256 && Date.parse(item[2]) > now + 7 * day + 3600000);
    const present = newObjects.has(image.webpSha256) || (known && await lookup(image.webpSha256, env, fetch, now));
    const needed = !present && !newObjects.has(image.webpSha256);
    if (needed) {
      if (ledger.objects.length >= 100) throw new Error('automation/image-budget-exceeded');
      const dir = 'runtime/images/' + i;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(dir + '/screenshot.webp', image.webp, { mode: 0o600 });
      await atomicJson(dir + '/image.json', { version: 1, width: image.width, height: image.height, rgbaSha256: image.rgbaSha256, webpSha256: image.webpSha256, pixelsVerified: true });
      const bytes = await sealDirectory(dir, 'sealed/images/' + i + '.sealed', 'image', 512 * 1024, env.CHECKER_ARTIFACT_KEY);
      ledger.objects.push([image.webpSha256, bytes, new Date(now + 14 * day).toISOString()]);
      newObjects.add(image.webpSha256);
    }
    index.images.push({ originalPath: 'screenshots/' + name, originalPngSha256: image.pngSha256, originalPngBytes: png.length, artifactName: objectName, webpSha256: image.webpSha256, rgbaSha256: image.rgbaSha256, width: image.width, height: image.height, losslessPixelsVerified: true });
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `image${i}_needed=${needed}\nimage${i}_name=${objectName}\n`);
  }
  await atomicJson('runtime/evidence/screenshot-index.json', index);
  await atomicJson('runtime/state/image-ledger.json', ledger);
  // Only temporary copies produced by this cycle are removed. Complete pixel
  // content remains in authenticated encrypted objects referenced by the index.
  for (const name of names) await rm(join('runtime/evidence/screenshots', name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await packImages(); } catch { process.stderr.write('automation/screenshot-packing-failed\n'); process.exitCode = 2; }
}
