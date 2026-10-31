import { atomicJson, readJson } from '../state.mjs';

export function validatePairedState(monitor, provider) {
  const validProvider = provider?.schemaVersion === '1.0'
    && (provider.incidentId === null || /^\d+$/.test(provider.incidentId ?? ''))
    && (provider.lastEventId === null || /^[a-f0-9-]{36}$/i.test(provider.lastEventId ?? ''));
  if (monitor?.schemaVersion !== '1.0' || typeof monitor.incidentOpen !== 'boolean' || !Array.isArray(monitor.pendingEvents) || !validProvider) throw new Error('better-stack/paired-state-invalid');
  const needsIncident = monitor.incidentOpen && !monitor.pendingEvents.some(event => event.type === 'product-alert');
  const unresolvedRecovery = monitor.pendingEvents.some(event => event.type === 'product-recovery' && event.id !== provider.lastEventId);
  if ((needsIncident || unresolvedRecovery) && provider.incidentId === null) throw new Error('better-stack/paired-state-invalid');
}

// Provider values are never included in errors, reports or console output.
export function createBetterStackAdapter({ env = process.env, fetcher = fetch, load = readJson, save = atomicJson } = {}) {
  const fail = () => new Error('better-stack/delivery-failed');
  const statePath = env.BETTER_STACK_STATE_PATH;
  const instance = env.BETTER_STACK_INSTANCE;
  function configuration() {
    if (!statePath || !/^[a-zA-Z0-9_-]{1,80}$/.test(instance ?? '') || !env.BETTER_STACK_API_TOKEN || !env.BETTER_STACK_REQUESTER_EMAIL) throw fail();
  }
  async function request(path, body, allowConflict = false) {
    try {
      const response = await fetcher('https://incidents.betterstack.com/api/v3/' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + env.BETTER_STACK_API_TOKEN, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
      });
      if (allowConflict && response.status === 409) return null;
      if (!response.ok) throw fail();
      return await response.json();
    } catch { throw fail(); }
  }
  return {
    async notify(event) {
      configuration();
      if (!['product-alert', 'product-recovery'].includes(event.type) || !/^[a-f0-9-]{36}$/i.test(event.id)) throw fail();
      const state = await load(statePath, null);
      if (state?.schemaVersion !== '1.0') throw fail();
      if (state.lastEventId === event.id) return;
      if (event.type === 'product-alert') {
        // Reconcile a previous POST whose acknowledgement was lost. The stable
        // event UUID is stored at the provider before local acknowledgement.
        const query = new URLSearchParams({ 'metadata[checker_event][][value]': event.id, 'metadata[checker_instance][][value]': instance });
        const previous = await request('incidents?' + query);
        if (!Array.isArray(previous?.data)) throw fail();
        let id = previous.data[0]?.id;
        if (!id) {
          const created = await request('incidents', {
            requester_email: env.BETTER_STACK_REQUESTER_EMAIL,
            name: 'Alegria portable public checker',
            summary: 'Two consecutive public checker cycles failed or were incomplete.',
            description: 'INFRA-001 product incident. Review restricted checker evidence. Event ' + event.id,
            email: true, call: false, sms: false, push: false, critical_alert: false,
            metadata: { checker_event: event.id, checker_instance: instance },
          });
          id = created?.data?.id;
        }
        if (!/^\d+$/.test(String(id))) throw fail();
        state.incidentId = String(id);
      } else {
        if (!/^\d+$/.test(state.incidentId ?? '')) throw fail();
        await request('incidents/' + state.incidentId + '/resolve', { resolved_by: 'Alegria checker: two consecutive PASS cycles' }, true);
        state.incidentId = null;
      }
      state.lastEventId = event.id;
      await save(statePath, state);
    },
    async heartbeat(completion) {
      if (completion?.schemaVersion !== '1.0' || completion.completed !== true || !Number.isFinite(Date.parse(completion.completedAtUtc))) throw fail();
      let url;
      try { url = new URL(env.BETTER_STACK_COMPLETION_HEARTBEAT_URL); } catch { throw fail(); }
      if (url.origin !== 'https://incidents.betterstack.com' || !/^\/api\/v1\/heartbeat\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw fail();
      try {
        const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw fail();
      } catch { throw fail(); }
    },
  };
}

const adapter = createBetterStackAdapter();
export const notify = adapter.notify;
export const heartbeat = adapter.heartbeat;
