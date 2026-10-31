import { randomUUID } from 'node:crypto';
import { iso, outcome, pause, servedInstance } from './contracts.mjs';
export const gateSpacingMs = 300000;
function identifiedCycle(cycle) {
  const instances = cycle.observedRelease?.instances;
  return cycle.outcome === 'PASS' && Array.isArray(instances) && instances.length > 0 && instances.every(instance => {
    const valid = servedInstance({ 'x-alegria-revision': instance.apiSha, 'x-alegria-container-revision': instance.revision, 'x-alegria-replica': instance.replica, 'x-correlation-id': instance.correlationId });
    return valid && instance.apiSha === cycle.expectedRelease?.api;
  });
}
export function acceptedCycles(cycles) {
  return cycles.length === 3 && cycles.every(identifiedCycle) && cycles.every((cycle, index) => index === 0 || Date.parse(cycle.startedAtUtc) - Date.parse(cycles[index - 1].startedAtUtc) >= gateSpacingMs) && Date.parse(cycles[2].startedAtUtc) - Date.parse(cycles[0].startedAtUtc) >= 600000;
}
export async function runGate(cycle, { now = Date.now, sleep = pause, onCycle = async () => {} } = {}) {
  const started = now(), cycles = [];
  for (let index = 0; index < 3; index++) {
    if (index) await sleep(Math.max(0, Date.parse(cycles[index - 1].startedAtUtc) + gateSpacingMs - now()));
    const result = await cycle('gate'); cycles.push(result); await onCycle(result);
    if (result.outcome !== 'PASS') break;
  }
  const checks = cycles.flatMap((result, index) => result.checks.map(check => ({ ...check, name: `cycle-${index + 1}/${check.name}` })));
  let result = outcome(checks);
  if (!acceptedCycles(cycles) && result === 'PASS') { result = 'INCOMPLETE'; checks.push({ name: 'three-cycle-window', target: 'gate', status: 'INCOMPLETE', errorClass: 'gate/window', httpStatus: null, durationMs: 0, correlationId: null }); }
  return { schemaVersion: '1.0', runId: randomUUID(), mode: 'gate', environment: cycles[0]?.environment ?? 'unknown', startedAtUtc: iso(started), finishedAtUtc: iso(now()), durationMs: Math.max(0, now() - started), expectedRelease: cycles[0]?.expectedRelease ?? null, observedRelease: cycles.map(cycle => cycle.observedRelease), checks, cycles, outcome: result, accepted: acceptedCycles(cycles) };
}
