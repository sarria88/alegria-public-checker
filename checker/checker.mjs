import { randomUUID } from 'node:crypto';
import { CheckError, iso, outcome, requireCheck, safeId, sha } from './contracts.mjs';
import { createHttp, cookieFlags, frontendDocument } from './http.mjs';
import { categories, countries, readiness, session, article, feed, feedPath } from './schemas.mjs';
import { validateManifest, verifyBytes, validateEvidence } from './manifest.mjs';
import { browserHome } from './browser.mjs';

export function createChecker(config, dependencies = {}) {
  let running = false;
  return async function cycle(mode = 'monitor') {
    if (running) throw new CheckError('monitor/overlap', 'INCOMPLETE');
    running = true;
    const now = dependencies.now ?? Date.now, started = now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.cycleTimeoutMs);
    const report = { schemaVersion: '1.0', runId: randomUUID(), mode, environment: config.localFixture ? 'literal-loopback-fixture' : 'public', startedAtUtc: iso(started), finishedAtUtc: null, durationMs: 0, expectedRelease: { api: config.expectedApiRelease ?? null, frontend: config.expectedFrontendRelease ?? null }, observedRelease: { api: [], frontend: null, instances: [] }, checks: [], outcome: 'INCOMPLETE' };
    function observe(instance) {
      if (instance && report.observedRelease.instances.length < 128 && !report.observedRelease.instances.some(value => value.apiSha === instance.apiSha && value.revision === instance.revision && value.replica === instance.replica && value.correlationId === instance.correlationId)) report.observedRelease.instances.push(instance);
    }
    const request = createHttp(config, controller.signal, dependencies.fetcher);
    let unidentifiedApiResponses = 0;
    async function check(name, target, action) {
      const begin = now(), row = { name, target, status: 'PASS', httpStatus: null, durationMs: 0, errorClass: null, correlationId: null };
      const receive = response => { row.httpStatus = response.status; row.correlationId = response.correlationId; if (response.revision && !report.observedRelease.api.includes(response.revision)) report.observedRelease.api.push(response.revision); observe(response.instance); return response; };
      try {
        if (controller.signal.aborted) throw new CheckError('monitor/cycle-timeout');
        const evidence = await action(receive); if (evidence) { row.evidence = evidence; if (row.httpStatus === null && Number.isInteger(evidence.httpStatus)) row.httpStatus = evidence.httpStatus; }
      } catch (error) { row.status = error instanceof CheckError ? error.status : 'FAIL'; row.errorClass = error instanceof CheckError ? error.errorClass : 'checker/internal'; if (Number.isInteger(error.httpStatus)) row.httpStatus = error.httpStatus; }
      row.durationMs = Math.max(0, now() - begin); report.checks.push(row); return row;
    }
    function release(response) {
      if (config.expectedApiRelease) requireCheck(response.revision === config.expectedApiRelease, 'release/api');
    }
    async function api(path, receive, options) {
      const response = receive(await request(config.apiBase + path, options)); release(response);
      if (mode === 'gate' && !response.instance) unidentifiedApiResponses++;
      return response;
    }
    let manifest;
    try {
      await check('release-config', 'release', async () => {
        if (!sha(config.expectedApiRelease) || !sha(config.expectedFrontendRelease)) throw new CheckError('configuration/expected-release', 'INCOMPLETE');
        manifest = validateManifest(config.manifest, config.expectedFrontendRelease);
      });
      await check('readiness', 'api/readiness', async receive => { readiness((await api('/health/ready', receive)).json()); });
      await check('categories', 'api/categories', async receive => { categories((await api('/api/categories', receive)).json()); });
      await check('countries', 'api/countries', async receive => { countries((await api('/api/countries', receive)).json()); });
      async function content(language, national = false) {
        let page;
        await check(`feed-${national ? 'national-es' : language}`, 'api/feed', async receive => {
          page = (await api(feedPath(language, national), receive)).json(); feed(page, { language, national, allowEmpty: national });
          return national && page.items.length === 0 ? { content: 'EMPTY_VALID' } : { items: page.items.length };
        });
        if (national) return;
        await check('detail-' + language, 'api/detail', async receive => {
          requireCheck(page?.items?.length > 0, 'content/detail-unavailable');
          let candidate = page.items[0];
          let response = await api(`/api/articles/${candidate.id}?lang=${language}`, receive);
          if (response.status === 404) {
            const reread = (await api(feedPath(language), receive)).json(); feed(reread, { language });
            candidate = reread.items.find(x => x.id !== candidate.id);
            requireCheck(candidate, 'content/detail-unavailable');
            response = await api(`/api/articles/${candidate.id}?lang=${language}`, receive);
          }
          requireCheck(response.status !== 404, 'content/detail-unavailable');
          const value = response.json(); article(value, language); requireCheck(value.id === candidate.id, 'content/detail-id');
          return { articleId: value.id };
        });
      }
      await content('es');
      if (mode === 'gate') { await content('en'); await content('es', true); }
      for (const [name, base] of [['apex', config.apexUrl], ['www', config.wwwUrl]]) {
        await check('document-' + name, 'frontend/' + name, async receive => {
          const document = await frontendDocument(request, base, config);
          receive(document.response);
          if (!manifest) throw new CheckError('evidence/frontend-manifest', 'INCOMPLETE');
          verifyBytes(manifest, '/', document.response.text);
          return { redirectChain: document.chain };
        });
        for (const language of mode === 'gate' ? ['es', 'en'] : ['es']) {
          await check(`home-${name}-${language}`, 'frontend/' + name, async () => {
            if (!manifest) throw new CheckError('evidence/frontend-manifest', 'INCOMPLETE');
            const result = await (dependencies.browserRunner ?? browserHome)(config, { base, language, manifest, signal: controller.signal, runId: report.runId, mode });
            for (const instance of result.instances ?? []) observe(instance);
            report.observedRelease.frontend = config.expectedFrontendRelease; return result;
          });
        }
      }
      const publicPaths = ['/api/categories', '/api/countries', feedPath()];
      for (const [index, origin] of [config.apexUrl, config.wwwUrl].entries()) {
        for (const [route, path] of publicPaths.entries()) {
          await check(`cors-get-${index}-${route}`, 'api/cors', async receive => {
            const response = await api(path, receive, { headers: { Origin: origin } }); response.json();
            requireCheck(response.headers.get('access-control-allow-origin') === origin && response.headers.get('access-control-allow-credentials') === 'true', 'cors/allowed-origin');
          });
        }
        for (const [route, [path, method]] of [...publicPaths.map(path => [path, 'GET']), ['/api/account/login', 'POST'], ['/api/articles/1/vote', 'POST']].entries()) {
          await check(`cors-options-${index}-${route}`, 'api/cors', async receive => {
            const response = await api(path, receive, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Content-Type,X-CSRF-TOKEN' } });
            const methods = (response.headers.get('access-control-allow-methods') ?? '').toUpperCase().split(',').map(x => x.trim());
            const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(x => x.trim());
            requireCheck(response.status === 204 && response.headers.get('access-control-allow-origin') === origin && response.headers.get('access-control-allow-credentials') === 'true' && methods.includes(method) && headers.includes('content-type') && headers.includes('x-csrf-token'), 'cors/preflight');
          });
        }
      }
      const foreign = ['https://foreign.invalid', 'https://alegrianews.com.attacker.invalid', 'http://alegrianews.com', 'https://preview.azurestaticapps.net'];
      for (const [index, origin] of foreign.entries()) {
        for (const method of ['GET', 'OPTIONS']) {
          await check(`cors-denied-${index}-${method}`, 'api/cors', async receive => {
            const response = await api('/api/categories', receive, { method, headers: { Origin: origin, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Content-Type,X-CSRF-TOKEN' } : {}) } });
            requireCheck(!response.headers.has('access-control-allow-origin') && !response.headers.has('access-control-allow-credentials'), 'cors/foreign-authorized');
            if (method === 'GET') response.json();
          });
        }
      }
      // Recheck approved origin after denied ones to expose incorrectly shared cached CORS grants.
      await check('cors-cache-isolation', 'api/cors', async receive => {
        const response = await api('/api/categories', receive, { headers: { Origin: config.apexUrl } }); response.json();
        requireCheck(response.headers.get('access-control-allow-origin') === config.apexUrl && response.headers.get('access-control-allow-credentials') === 'true', 'cors/cache-isolation');
      });
      await check('anonymous-session', 'api/session', async receive => {
        const response = await api('/api/account/session', receive); session(response.json());
        const control = response.headers.get('cache-control') ?? '';
        requireCheck(/(?:^|,)\s*(?:no-store|private)\b/i.test(control), 'session/cache');
        return { cookies: cookieFlags(response.headers), authenticated: false };
      });
      for (const [index, headers] of [{}, { 'X-Forwarded-Proto': 'https' }].entries()) {
        for (const [route, path] of ['/api/categories', '/api/account/session'].entries()) {
          await check(`public-http-${index}-${route}`, 'api/http', async receive => {
            const response = receive(await request(config.apiHttpBase + path, { headers }));
            const location = response.headers.get('location'); let target;
            try { target = new URL(location); } catch { /* checked below */ }
            requireCheck([301, 302, 307, 308].includes(response.status) && !response.headers.has('set-cookie') && target?.origin === config.apiBase && (config.localFixture || target.protocol === 'https:') && target.pathname === path, 'transport/public-http');
          });
        }
      }
      await check('authority-alternative', 'api/authority', async receive => {
        if (!config.alternativeAuthority) throw new CheckError('configuration/alternative-authority-target', 'INCOMPLETE');
        const response = receive(await request(config.apiBase + '/api/categories', { headers: { Host: config.alternativeAuthority, 'X-Forwarded-Host': new URL(config.apiBase).host } }));
        requireCheck(response.status === 400 && !response.headers.has('location'), 'transport/alternative-authority');
      });
      await check('authority-aca', 'api/authority', async receive => {
        if (config.acaUrls.length === 0) throw new CheckError('configuration/aca-authority-targets', 'INCOMPLETE');
        for (const url of config.acaUrls) {
          const response = receive(await request(url + '/api/categories', { headers: { 'X-Forwarded-Host': new URL(config.apiBase).host } }));
          requireCheck(response.status === 400 && !response.headers.has('location'), 'transport/aca-authority');
        }
      });
      for (const path of ['/admin', '/api/admin', '/api/account/dev-outbox']) {
        for (const method of ['GET', 'POST']) {
          await check('admin-hidden-' + path.replaceAll('/', '-') + '-' + method, 'api/admin', async receive => {
            const response = await api(path, receive, { method, headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': new URL(config.apiBase).host } });
            requireCheck(response.status === 404, 'security/admin-exposed');
          });
        }
      }
      await check('anonymous-mutation', 'api/community', async receive => {
        const response = await api('/api/articles/1/vote', receive, { method: 'POST', headers: { Origin: config.apexUrl, 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https' }, body: '{"value":1}' });
        requireCheck(response.status === 401, 'security/anonymous-mutation');
      });
      if (mode === 'gate') {
        await check('served-instance-identification', 'release/served-instances', async () => {
          if (unidentifiedApiResponses > 0 || report.observedRelease.instances.length === 0) throw new CheckError('evidence/served-instance', 'INCOMPLETE');
          return { identifiedResponses: report.observedRelease.instances.length, coverage: 'observed-only; not all replicas or distribution' };
        });
        await check('isolated-release-evidence', 'release/isolated-evidence', async () => validateEvidence(config.evidence, config.expectedApiRelease, config.expectedFrontendRelease));
      }
    } finally {
      clearTimeout(timer); running = false;
      report.finishedAtUtc = iso(now()); report.durationMs = Math.max(0, now() - started); report.outcome = outcome(report.checks);
    }
    return report;
  };
}
