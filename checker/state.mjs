import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CheckError, iso } from './contracts.mjs';

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new CheckError('monitor/state-read', 'INCOMPLETE'); }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true }); let handle;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, startedAtUtc: iso(Date.now()) })); }
  catch { throw new CheckError('monitor/overlap-or-lock', 'INCOMPLETE'); }
  return async () => { await handle.close(); await unlink(path); };
}
const fresh = () => ({ schemaVersion: '1.0', incidentOpen: false, failures: 0, successes: 0, state: 'healthy', pendingEvents: [] });
export function productTransition(previous, report) {
  const state = previous ? structuredClone(previous) : fresh();
  if (state.schemaVersion !== '1.0' || !Array.isArray(state.pendingEvents) || !Number.isInteger(state.failures) || !Number.isInteger(state.successes) || typeof state.incidentOpen !== 'boolean') throw new CheckError('monitor/state-schema', 'INCOMPLETE');
  if (report.outcome === 'PASS') {
    state.failures = 0; state.successes = Math.min(2, state.successes + 1);
    if (state.incidentOpen && state.successes >= 2) {
      state.incidentOpen = false;
      state.pendingEvents.push({ id: randomUUID(), type: 'product-recovery', runId: report.runId, completedAtUtc: report.finishedAtUtc });
    }
    state.state = state.incidentOpen ? 'pending-recovery' : 'healthy';
  } else {
    state.successes = 0; state.failures = Math.min(2, state.failures + 1);
    if (!state.incidentOpen && state.failures >= 2) {
      state.incidentOpen = true;
      state.pendingEvents.push({ id: randomUUID(), type: 'product-alert', runId: report.runId, completedAtUtc: report.finishedAtUtc });
    }
    state.state = state.incidentOpen ? 'incident-open' : 'pending-failure';
  }
  state.lastCompletedAtUtc = report.finishedAtUtc; state.lastRunId = report.runId;
  return state;
}
export function heartbeatTransition(previous, heartbeat, now) {
  const state = previous ? structuredClone(previous) : { schemaVersion: '1.0', silent: false, completedRecovery: 0, lastRunId: null, pendingEvents: [], watchStartedAtUtc: iso(now) };
  if (state.schemaVersion !== '1.0' || !Array.isArray(state.pendingEvents) || typeof state.silent !== 'boolean' || !Number.isInteger(state.completedRecovery)) throw new CheckError('monitor/watchdog-state-schema', 'INCOMPLETE');
  const completed = heartbeat?.schemaVersion === '1.0' && heartbeat.completed === true && typeof heartbeat.runId === 'string' && Number.isFinite(Date.parse(heartbeat.completedAtUtc)) && Date.parse(heartbeat.completedAtUtc) <= now;
  if (!Number.isFinite(Date.parse(state.watchStartedAtUtc))) throw new CheckError('monitor/watchdog-state-schema', 'INCOMPLETE');
  state.heartbeatValid = completed;
  const stale = now - Date.parse(completed ? heartbeat.completedAtUtc : state.watchStartedAtUtc) > 12 * 60 * 1000;
  if (stale) {
    state.completedRecovery = 0;
    if (!state.silent) { state.silent = true; state.pendingEvents.push({ id: randomUUID(), type: 'monitor-silent', detectedAtUtc: iso(now) }); }
  } else if (completed && heartbeat.runId !== state.lastRunId) {
    state.lastRunId = heartbeat.runId;
    if (state.silent) {
      state.completedRecovery++;
      if (state.completedRecovery >= 2) { state.silent = false; state.completedRecovery = 0; state.pendingEvents.push({ id: randomUUID(), type: 'monitor-resumed', detectedAtUtc: iso(now) }); }
    }
  }
  return state;
}
export async function deliverPending(state, adapter, persist) {
  while (state.pendingEvents.length) {
    if (typeof adapter?.notify !== 'function') throw new CheckError('monitor/notification-adapter-missing', 'INCOMPLETE');
    const event = state.pendingEvents[0];
    try { await adapter.notify(event); } catch { throw new CheckError('monitor/notification-delivery'); }
    state.pendingEvents.shift(); await persist(state);
  }
}
