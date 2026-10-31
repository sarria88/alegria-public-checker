import { atomicJson, readJson } from '../checker/state.mjs';
import { validatePairedState } from '../checker/adapters/better-stack.mjs';
import { validLedger } from './storage-budget.mjs';

try {
  if (process.argv[2] === 'bootstrap') {
    if (await readJson('runtime/state/monitor-state.json') || await readJson('runtime/state/better-stack-state.json')) throw new Error('state exists');
    await atomicJson('runtime/state/monitor-state.json', { schemaVersion: '1.0', incidentOpen: false, failures: 0, successes: 0, state: 'healthy', pendingEvents: [] });
    await atomicJson('runtime/state/better-stack-state.json', { schemaVersion: '1.0', incidentId: null, lastEventId: null });
    await atomicJson('runtime/state/image-ledger.json', { version: 1, objects: [] });
  }
  validatePairedState(await readJson('runtime/state/monitor-state.json'), await readJson('runtime/state/better-stack-state.json'));
  validLedger(await readJson('runtime/state/image-ledger.json'));
} catch { process.stderr.write('automation/paired-state-unavailable\n'); process.exitCode = 2; }
