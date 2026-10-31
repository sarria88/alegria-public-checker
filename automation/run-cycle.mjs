import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function runCycle(env = process.env) {
  const required = ['BETTER_STACK_API_TOKEN', 'BETTER_STACK_COMPLETION_HEARTBEAT_URL', 'BETTER_STACK_REQUESTER_EMAIL', 'PUBLIC_CHECKER_MANIFEST_JSON', 'EXPECTED_API_RELEASE', 'EXPECTED_FRONTEND_RELEASE', 'CHECKER_ACA_APP_URL', 'CHECKER_ACA_REVISION_URL'];
  if (required.some(name => !env[name])) throw new Error('automation/configuration-missing');
  await mkdir('runtime/evidence', { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.from(env.PUBLIC_CHECKER_MANIFEST_JSON, 'utf8');
  if (manifestBytes.length >= 48 * 1024 || !JSON.parse(manifestBytes.toString('utf8'))) throw new Error('automation/manifest-invalid');
  await writeFile('runtime/manifest.json', manifestBytes, { mode: 0o600 });
  const args = ['checker/cli.mjs', 'monitor', '--api-base', 'https://api.alegrianews.com', '--apex-url', 'https://alegrianews.com', '--www-url', 'https://www.alegrianews.com', '--manifest', 'runtime/manifest.json', '--aca-url', env.CHECKER_ACA_APP_URL, '--aca-url', env.CHECKER_ACA_REVISION_URL, '--adapter', 'checker/adapters/better-stack.mjs', '--cycle-timeout-ms', '120000', '--state', 'runtime/state/monitor-state.json', '--heartbeat', 'runtime/state/completed-heartbeat.json', '--output', 'runtime/evidence/monitor.json'];
  const stdout = createWriteStream('runtime/evidence/stdout.json', { mode: 0o600 });
  const stderr = createWriteStream('runtime/evidence/stderr.txt', { mode: 0o600 });
  const child = spawn(process.execPath, args, { env: { ...env, BETTER_STACK_STATE_PATH: resolve('runtime/state/better-stack-state.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let timer;
  const code = await new Promise((accept, reject) => {
    timer = setTimeout(() => { child.kill('SIGKILL'); }, 150000);
    child.once('error', () => reject(new Error('automation/process-failed')));
    child.once('close', value => accept(value ?? 2));
  }).finally(() => clearTimeout(timer));
  await Promise.all([new Promise(done => stdout.closed ? done() : stdout.once('close', done)), new Promise(done => stderr.closed ? done() : stderr.once('close', done))]);
  return code;
}

try { process.exitCode = await runCycle(); }
catch { process.stderr.write('automation/cycle-unavailable\n'); process.exitCode = 2; }
