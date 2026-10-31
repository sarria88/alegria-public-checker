export class CheckError extends Error {
  constructor(errorClass, status = 'FAIL') { super(errorClass); this.errorClass = errorClass; this.status = status; }
}
export function requireCheck(condition, errorClass) { if (!condition) throw new CheckError(errorClass); }
export const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
export function servedInstance(headers) {
  const read = name => typeof headers.get === 'function' ? headers.get(name) : headers[name];
  const apiSha = read('x-alegria-revision'), revision = safeId(read('x-alegria-container-revision')), replica = safeId(read('x-alegria-replica')), correlationId = safeId(read('x-correlation-id'));
  return sha(apiSha) && revision && replica && correlationId ? { apiSha, revision, replica, correlationId } : null;
}
export const iso = time => new Date(time).toISOString();
export function outcome(checks) { return checks.some(x => x.status === 'FAIL') ? 'FAIL' : checks.some(x => x.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'PASS'; }
export const exitCode = result => result === 'PASS' ? 0 : result === 'FAIL' ? 1 : 2;
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
