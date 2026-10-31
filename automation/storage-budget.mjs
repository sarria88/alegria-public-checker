import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function storageEnvelope(env = process.env) {
  const evidenceLimit = Number(env.CHECKER_EVIDENCE_LIMIT_BYTES);
  const reserved = Number(env.CHECKER_RESERVED_STORAGE_BYTES);
  if (!Number.isSafeInteger(evidenceLimit) || evidenceLimit < 1 || evidenceLimit > 2 * 1024 * 1024 || !Number.isSafeInteger(reserved) || reserved < 1) throw new Error('automation/storage-budget-unverified');
  // Three complete retention windows plus a conservative ZIP/service buffer.
  // Extra manual runs and other account usage need separately reserved headroom.
  const envelope = (evidenceLimit + 16384) * 2016 + 4096 * 8640 + 50 * 1024 * 1024 + 100 * 512 * 1024;
  if (envelope > reserved) throw new Error('automation/storage-budget-insufficient');
  return { evidenceLimit, reserved, envelope };
}
export function validLedger(ledger, now = Date.now()) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.objects) || ledger.objects.length > 100) throw new Error('automation/image-ledger-invalid');
  for (const item of ledger.objects) {
    if (!Array.isArray(item) || item.length !== 3 || !/^[a-f0-9]{64}$/.test(item[0]) || !Number.isSafeInteger(item[1]) || item[1] < 1 || item[1] > 512 * 1024 || !Number.isFinite(Date.parse(item[2]))) throw new Error('automation/image-ledger-invalid');
  }
  return { version: 1, objects: ledger.objects.filter(item => Date.parse(item[2]) > now) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { storageEnvelope(); } catch { process.stderr.write('automation/storage-budget-not-ready\n'); process.exitCode = 2; }
}
