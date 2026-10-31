import { readFile, mkdir, writeFile } from 'node:fs/promises';

let report;
try { report = JSON.parse(await readFile('runtime/evidence/monitor.json', 'utf8')); } catch { report = null; }
const checks = Array.isArray(report?.checks) ? report.checks : [];
const aggregate = {
  version: 1,
  recordedAtUtc: new Date().toISOString(),
  outcome: ['PASS', 'FAIL', 'INCOMPLETE'].includes(report?.outcome) ? report.outcome : 'INCOMPLETE',
  durationMs: Number.isSafeInteger(report?.durationMs) ? report.durationMs : null,
  counts: Object.fromEntries(['PASS', 'FAIL', 'INCOMPLETE'].map(status => [status, checks.filter(check => check.status === status).length])),
};
await mkdir('runtime/metrics', { recursive: true, mode: 0o700 });
await writeFile('runtime/metrics/aggregate.json', JSON.stringify(aggregate), { mode: 0o600 });
process.stdout.write('Checker outcome: ' + aggregate.outcome + '\n');
