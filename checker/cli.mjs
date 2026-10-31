#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuration, parseArguments } from './config.mjs';
import { CheckError, exitCode, iso, outcome } from './contracts.mjs';
import { createChecker } from './checker.mjs';
import { runGate } from './gate.mjs';
import { buildManifest } from './manifest.mjs';
import { acquireLock, atomicJson, readJson, productTransition, heartbeatTransition, deliverPending } from './state.mjs';

export function humanReport(report) {
  const counts = Object.fromEntries(['PASS', 'FAIL', 'INCOMPLETE'].map(status => [status, report.checks.filter(check => check.status === status).length]));
  return [`${report.outcome} ${report.mode} ${report.runId}`, `${report.startedAtUtc} → ${report.finishedAtUtc} (${report.durationMs} ms)`, `${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.INCOMPLETE} INCOMPLETE`, ...report.checks.filter(check => check.status !== 'PASS').map(check => `${check.status} ${check.name}: ${check.errorClass}`)].join('\n');
}
function failureReport(error, mode = 'configuration') {
  const timestamp = iso(Date.now());
  return { schemaVersion: '1.0', runId: randomUUID(), mode, startedAtUtc: timestamp, finishedAtUtc: timestamp, durationMs: 0, expectedRelease: null, observedRelease: null, checks: [{ name: 'execution', target: 'checker', status: error instanceof CheckError ? error.status : 'INCOMPLETE', httpStatus: null, durationMs: 0, errorClass: error instanceof CheckError ? error.errorClass : 'checker/execution', correlationId: null }], outcome: error instanceof CheckError ? error.status : 'INCOMPLETE' };
}
async function adapterFrom(path) {
  if (!path) return null;
  try { return await import(pathToFileURL(resolve(path)).href); } catch { throw new CheckError('configuration/adapter', 'INCOMPLETE'); }
}
async function timedAdapter(adapter, method, value) {
  let timer;
  try {
    await Promise.race([adapter[method](value), new Promise((_, reject) => { timer = setTimeout(() => reject(new CheckError('monitor/adapter-timeout')), 15000); })]);
  } finally { clearTimeout(timer); }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed, releaseLock, report;
  try {
    parsed = parseArguments(args, env);
    const { command, input, files } = parsed;
    if (command === 'manifest') {
      if (!files.artifact || !files.output) throw new CheckError('configuration/manifest-paths', 'INCOMPLETE');
      const manifest = await buildManifest(files.artifact, input.expectedFrontendRelease); await atomicJson(files.output, manifest);
      process.stderr.write('PASS reviewed frontend byte manifest written\n'); return 0;
    }
    const statePath = files.state ?? 'artifacts/public-checker/' + (command === 'watchdog' ? 'watchdog-state.json' : 'monitor-state.json');
    const heartbeatPath = files.heartbeat ?? 'artifacts/public-checker/heartbeat.json';
    releaseLock = await acquireLock(statePath + '.lock');
    const adapter = await adapterFrom(files.adapter);
    const boundedAdapter = adapter ? { notify: value => timedAdapter(adapter, 'notify', value) } : null;
    if (command === 'watchdog') {
      const timestamp = iso(Date.now());
      const state = heartbeatTransition(await readJson(statePath), await readJson(heartbeatPath), Date.now());
      await atomicJson(statePath, state);
      const heartbeatStatus = state.silent ? 'FAIL' : state.heartbeatValid ? 'PASS' : 'INCOMPLETE';
      report = { schemaVersion: '1.0', runId: randomUUID(), mode: 'watchdog', startedAtUtc: timestamp, finishedAtUtc: timestamp, durationMs: 0, expectedRelease: null, observedRelease: null, checks: [{ name: 'completed-heartbeat', target: 'monitor', status: heartbeatStatus, errorClass: state.silent ? 'monitor/silent' : state.heartbeatValid ? null : 'monitor/no-completed-heartbeat', httpStatus: null, durationMs: 0, correlationId: null }], outcome: heartbeatStatus };
      try { await deliverPending(state, boundedAdapter, state => atomicJson(statePath, state)); }
      catch (error) { report.checks.push(failureReport(error).checks[0]); report.outcome = outcome(report.checks); }
    } else {
      const config = configuration({ ...input, manifest: files.manifest ? await readJson(files.manifest) : null, evidence: files.evidence ? await readJson(files.evidence) : null, screenshots: files.screenshots ?? resolve(dirname(files.output ?? 'artifacts/public-checker/report.json'), 'screenshots') });
      const cycle = createChecker(config);
      const finish = async result => {
        // Completion is persisted before notification delivery. No heartbeat is emitted at cycle start.
        const heartbeat = { schemaVersion: '1.0', completed: true, runId: result.runId, completedAtUtc: result.finishedAtUtc, outcome: result.outcome };
        await atomicJson(heartbeatPath, heartbeat);
        if (typeof adapter?.heartbeat === 'function') {
          try { await timedAdapter(adapter, 'heartbeat', heartbeat); }
          catch { result.checks.push({ name: 'heartbeat-delivery', target: 'monitor', status: 'FAIL', httpStatus: null, durationMs: 0, errorClass: 'monitor/heartbeat-delivery', correlationId: null }); result.outcome = outcome(result.checks); }
        }
        if (command === 'monitor') {
          const state = productTransition(await readJson(statePath), result); await atomicJson(statePath, state);
          try { await deliverPending(state, boundedAdapter, state => atomicJson(statePath, state)); }
          catch (error) { result.checks.push(failureReport(error).checks[0]); result.outcome = outcome(result.checks); }
        }
      };
      if (command === 'gate') report = await runGate(cycle, { onCycle: finish });
      else { report = await cycle('monitor'); await finish(report); }
    }
  } catch (error) { report = failureReport(error, parsed?.command); }
  finally { if (releaseLock) await releaseLock().catch(() => {}); }
  try { if (parsed?.files.output) await atomicJson(parsed.files.output, report); }
  catch { report = failureReport(new CheckError('monitor/report-write', 'INCOMPLETE')); }
  process.stdout.write(JSON.stringify(report) + '\n'); process.stderr.write(humanReport(report) + '\n');
  return exitCode(report.outcome);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
