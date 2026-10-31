export const DISPATCH_URL = 'https://api.github.com/repos/sarria88/alegria-public-checker/actions/workflows/public-checker.yml/dispatches';

// Only a Cron event can dispatch. The HTTP handler never authorizes work.
export async function dispatch(env, { fetcher = fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (env?.ENABLED !== 'true') return { status: 'disabled' };
  const token = env.GITHUB_DISPATCH_TOKEN;
  const expiryText = env.GITHUB_TOKEN_EXPIRES_AT ?? '';
  const expiry = Date.parse(expiryText);
  if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,240}$/.test(token) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiryText) || !Number.isFinite(expiry)) throw new Error('dispatcher/configuration-incomplete');
  if (expiry <= now()) throw new Error('dispatcher/token-expired');
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), 10000);
  try {
    let response;
    try {
      response = await fetcher(DISPATCH_URL, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'Alegria-monitor-dispatcher',
        },
        body: JSON.stringify({ ref: 'main', inputs: { operation: 'cycle', bootstrap: false } }),
      });
    } catch { throw new Error(controller.signal.aborted ? 'dispatcher/timeout' : 'dispatcher/network-failed'); }
    // Modern dispatch returns 200; older compatible API behavior returns 204.
    // No response body, header or credential is inspected or logged.
    try { await response.body?.cancel(); } catch { /* Discard unread data. */ }
    if (response.status !== 200 && response.status !== 204) throw new Error('dispatcher/github-dispatch-failed');
    return { status: 'accepted' };
  } finally { clearTimer(timer); }
}

export default {
  async fetch() { return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); },
  async scheduled(_controller, env) { await dispatch(env); },
};
