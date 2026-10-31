import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CheckError, digest, requireCheck, sha } from './contracts.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateManifest(manifest, release) {
  if (!manifest || manifest.schemaVersion !== '1.0' || !sha(release) || manifest.frontendRelease !== release || !manifest.files || Object.keys(manifest.files).length < 3 || Object.keys(manifest.files).length > 128) throw new CheckError('evidence/frontend-manifest', 'INCOMPLETE');
  const entries = Object.entries(manifest.files);
  if (!entries.every(([path, value]) => /^\/(?:assets\/[a-zA-Z0-9_.\/-]+\.(?:js|css))?$/.test(path) && !path.includes('..') && digest(value)) || !manifest.files['/'] || !entries.some(([path]) => path.endsWith('.js')) || !entries.some(([path]) => path.endsWith('.css'))) throw new CheckError('evidence/frontend-manifest', 'INCOMPLETE');
  return manifest;
}
export async function buildManifest(root, release) {
  if (!sha(release)) throw new CheckError('configuration/release', 'INCOMPLETE');
  const files = { '/': hash(await readFile(resolve(root, 'index.html'))) };
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new CheckError('configuration/artifact-symlink', 'INCOMPLETE');
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), `${prefix}${entry.name}/`);
      else if (/\.(js|css)$/.test(entry.name)) files[prefix + entry.name] = hash(await readFile(resolve(directory, entry.name)));
    }
  }
  await visit(resolve(root, 'assets'), '/assets/');
  return validateManifest({ schemaVersion: '1.0', frontendRelease: release, files }, release);
}
export function verifyBytes(manifest, path, bytes) {
  requireCheck(manifest.files[path] && hash(bytes) === manifest.files[path], 'release/frontend-bytes');
}
export function validateEvidence(evidence, apiSha, frontendSha) {
  const incomplete = () => { throw new CheckError('evidence/isolated-release', 'INCOMPLETE'); };
  if (!evidence || evidence.schemaVersion !== '1.0' || evidence.apiSha !== apiSha || evidence.frontendSha !== frontendSha || !sha(apiSha) || !sha(frontendSha) || evidence.result !== 'PASS' || !/^[a-zA-Z0-9._:@/-]{1,160}$/.test(evidence.reviewedBy ?? '') || !Number.isFinite(Date.parse(evidence.completedAtUtc)) || Date.parse(evidence.completedAtUtc) > Date.now() || !Array.isArray(evidence.references) || evidence.references.length === 0 || evidence.references.length > 32 || !evidence.references.every(x => typeof x === 'string' && x.length > 0 && x.length <= 300 && !/[\r\n]/.test(x))) incomplete();
  const required = ['auth', 'roles', 'revocation', 'origin', 'csrf', 'writerNotInvoked', 'authenticatedPositive', 'privateProfiles', 'limiterRealHttp', 'lateralListener', 'rotation', 'newRevision', 'tlsIngress', 'wireParsing'];
  if (!required.every(name => evidence.checks?.[name] === 'PASS') || evidence.isolated !== true || !/^sha256:[a-f0-9]{64}$/.test(evidence.imageDigest ?? '') || !Array.isArray(evidence.replicas) || evidence.replicas.length < 2 || evidence.replicas.length > 32) incomplete();
  if (new Set(evidence.replicas.map(x => x.id)).size !== evidence.replicas.length || evidence.replicas.some(x => !/^[a-zA-Z0-9._-]{1,160}$/.test(x.id ?? '') || !/^[a-zA-Z0-9._-]{1,160}$/.test(x.revision ?? '') || !Number.isInteger(x.reads) || x.reads < 1 || !Array.isArray(x.correlationIds) || x.correlationIds.length === 0 || x.correlationIds.length > 100 || !x.correlationIds.every(id => /^[a-zA-Z0-9._:-]{1,160}$/.test(id)))) incomplete();
  if (evidence.replicas.reduce((sum, x) => sum + x.reads, 0) < 24) incomplete();
  return { apiSha, frontendSha, imageDigest: evidence.imageDigest, replicas: evidence.replicas.map(({ id, revision, reads }) => ({ id, revision, reads })), provenance: 'operator-attestation; references reviewed outside checker; no cryptographic proof or sampled-distribution claim' };
}
