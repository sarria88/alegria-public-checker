// Owned fictitious news and disposable loopback listeners. Never reaches production or SQL.
import { createServer } from 'node:http';
import { hash } from '../manifest.mjs';
export const API_SHA = 'a'.repeat(40), FRONTEND_SHA = 'b'.repeat(40);
export const category = { id: 7, name: 'Ciencia', slug: 'ciencia', sortOrder: 1 };
export const story = (language = 'es', id = 101) => ({ id, title: `Owned fictitious story ${language} ${id}`, source: 'Owned QA fixture', url: 'https://example.invalid/owned-fixture', publishedDate: '2026-10-31T00:00:00Z', categories: [category], userVote: 0, language, contentLanguage: language, availableLanguages: ['es', 'en'], geography: { resolutionStatus: 'resolved', primaryCountryCode: 'ES' } });
export const page = (language = 'es', id = 101, size = 6) => ({ items: [story(language, id)], total: 1, page: 1, pageSize: size });
const html = '<!doctype html><html lang="es"><head><link rel="stylesheet" href="/assets/main.css"></head><body><main id="stories"></main><script src="/assets/main.js"></script></body></html>';
const css = 'body {font:16px sans-serif} article {display:block; min-height:100px}';
async function listen(handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
export async function fixture(options = {}) {
  const state = { mode: '', requests: [], detailMisses: 0, ...options };
  let apex, www, api;
  api = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid'); state.requests.push({ method: request.method, path: url.pathname });
    if (request.headers.host === 'invalid.example') { response.writeHead(state.acaRouting ? 404 : 400).end(); return; }
    if (aca && request.headers.host === new URL(aca.url).host) {
      state.alternativeRequests = [...(state.alternativeRequests ?? []), { host: request.headers.host, forwardedHost: request.headers['x-forwarded-host'] }];
      response.writeHead(state.alternativeStatus ?? 400, state.alternativeLocation ? { Location: state.alternativeLocation } : {}).end(); return;
    }
    response.setHeader('X-Alegria-Revision', state.mode === 'api-release' ? 'c'.repeat(40) : API_SHA);
    response.setHeader('X-Correlation-ID', 'fixture-' + state.requests.length);
    if (state.mode !== 'instance-missing') {
      response.setHeader('X-Alegria-Container-Revision', 'fixture-public-r1');
      response.setHeader('X-Alegria-Replica', state.mode === 'instance-malformed' ? 'invalid replica name' : 'fixture-public-replica-one');
    }
    const origin = request.headers.origin;
    if ([apex?.url, www?.url].includes(origin) || state.mode === 'cors-foreign' && origin) {
      response.setHeader('Access-Control-Allow-Origin', state.mode === 'cors-wrong' ? 'https://wrong.invalid' : origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true'); response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') { if ([apex?.url, www?.url].includes(origin)) { response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-TOKEN'); } response.writeHead(204).end(); return; }
    if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin') || url.pathname === '/api/account/dev-outbox') { response.writeHead(state.mode === 'admin' ? 200 : 404).end(); return; }
    if (request.method === 'POST') { response.writeHead(state.mode === 'mutation' ? 200 : 401).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    let value;
    if (url.pathname === '/health/ready') value = { status: 'Healthy', scope: 'database' };
    else if (url.pathname === '/api/categories') {
      if (state.mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 250));
      if (state.mode === 'redirect') { response.writeHead(302, { Location: '/health/ready' }).end(); return; }
      if (state.mode === 'invalid-json') { response.end('{bad'); return; }
      if (state.mode === 'empty') { response.end(); return; }
      if (state.mode === 'html') { response.setHeader('Content-Type', 'text/html'); response.end('<html/>'); return; }
      value = state.mode === 'categories' ? [] : state.mode === 'duplicate-categories' ? [category, category] : [category];
    } else if (url.pathname === '/api/countries') value = [{ code: state.mode === 'countries' ? 'ZZ' : 'ES', names: { es: 'España', en: 'Spain', fr: 'Espagne' } }];
    else if (url.pathname === '/api/account/session') {
      response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Set-Cookie', '__Host-AlegriaCsrf=FIXTURE_SECRET; Secure; HttpOnly; Path=/; SameSite=Strict');
      value = { authenticated: false, user: null, csrfToken: 'FIXTURE_SECRET' };
      if (state.mode === 'cookie') response.setHeader('Set-Cookie', '__Host-AlegriaCsrf=FIXTURE_SECRET; Path=/; SameSite=None');
    } else if (url.pathname === '/api/articles') {
      const language = url.searchParams.get('lang') ?? 'es', size = Number(url.searchParams.get('pageSize') ?? 6);
      value = page(language, state.mode === 'detail-race' && state.detailMisses ? 102 : 101, size);
      if (state.mode === 'feed-empty' || url.searchParams.get('section') === 'national' && state.mode !== 'national-invalid') value = { items: [], total: 0, page: 1, pageSize: size };
      if (state.mode === 'duplicate-feed') { value.items.push(value.items[0]); value.total = 2; }
      if (state.mode === 'national-invalid' && url.searchParams.get('section') === 'national') value.items[0].geography.primaryCountryCode = 'US';
    } else if (/^\/api\/articles\/\d+$/.test(url.pathname)) {
      if (state.mode === 'detail-missing' || state.mode === 'detail-race' && url.pathname.endsWith('/101')) { state.detailMisses++; response.writeHead(404).end('{}'); return; }
      const id = Number(url.pathname.split('/').at(-1)); value = story(url.searchParams.get('lang') ?? 'es', id);
    } else { response.writeHead(404).end('{}'); return; }
    response.end(JSON.stringify(value));
  });
  const script = `const params=new URLSearchParams(location.search), lang=${state.mode === 'wrong-language' ? "'fr'" : "params.get('lang')||'es'"};document.documentElement.lang=lang;
const api=${JSON.stringify(api.url + (state.mode === 'wrong-api' ? '/wrong' : ''))};async function boot(){
if(location.pathname.startsWith('/noticia/')){const id=location.pathname.split('/').pop(),r=await fetch(api+'/api/articles/'+id+'?lang='+lang);const a=await r.json();document.querySelector('main').outerHTML='<main id="article"><article><h1>'+a.title+'</h1><p>Owned fictitious detail</p></article></main>';return;}
const r=await fetch(api+'/api/articles?sort=ranking&lang='+lang+'&surface=home&section=international&page=1&pageSize=10'),p=await r.json();const a=p.items[0];if(a)document.querySelector('main').innerHTML='<section data-geo-section="international"><article data-article-id="'+a.id+'"><h2><a href="/noticia/'+a.id+'?lang='+lang+'">'+a.title+'</a></h2></article></section>';}
boot().catch(()=>{document.querySelector('main').innerHTML='<div role="alert">Fixture error</div>'});`;
  const handler = (request, response) => {
    const parsedUrl = new URL(request.url, 'http://fixture.invalid'), path = parsedUrl.pathname;
    if (state.mode === 'valid-redirect' && (request.headers.host === new URL(apex.url).host || path === '/bridge')) { response.writeHead(308, { Location: www.url + (path === '/bridge' ? '/' : '/bridge') + parsedUrl.search }).end(); return; }
    if (state.mode === 'redirect-loop') { state.documentRequests = (state.documentRequests ?? 0) + 1; response.writeHead(308, { Location: (request.headers.host === new URL(apex.url).host ? www.url : apex.url) + request.url }).end(); return; }
    if (state.mode === 'frontend-redirect') { response.writeHead(302, { Location: 'http://foreign.invalid/' }).end(); return; }
    if (path === '/assets/main.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
    if (path === '/assets/main.js') {
      if (state.mode === 'asset') { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'text/javascript'); response.end(state.mode === 'javascript' ? 'throw Error("owned fixture failure")' : state.mode === 'shell' ? '' : script); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end(html);
  };
  apex = await listen(handler); www = await listen(handler);
  const ingress = await listen((request, response) => response.writeHead(state.mode === 'http' ? 200 : 308, { Location: api.url + request.url }).end());
  const aca = await listen((_request, response) => response.writeHead(state.mode === 'aca' ? 200 : 400).end());
  return {
    state, api: api.url, apex: apex.url, www: www.url,
    config: { apiBase: api.url, apexUrl: apex.url, wwwUrl: www.url, apiHttpBase: ingress.url, acaUrls: [aca.url], localFixture: true, expectedApiRelease: API_SHA, expectedFrontendRelease: FRONTEND_SHA, requestTimeoutMs: 1000, navigationTimeoutMs: 2000, cycleTimeoutMs: 30000, manifest: { schemaVersion: '1.0', frontendRelease: FRONTEND_SHA, files: { '/': hash(html), '/assets/main.js': hash(script), '/assets/main.css': hash(css) } }, playwrightModule: process.env.PLAYWRIGHT_MODULE, browserExecutable: process.env.BROWSER_EXECUTABLE },
    async close() { await Promise.all([api, apex, www, ingress, aca].map(({ server }) => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); },
  };
}
export function releaseEvidence() {
  return { schemaVersion: '1.0', apiSha: API_SHA, frontendSha: FRONTEND_SHA, result: 'PASS', reviewedBy: 'owned-fixture-only', completedAtUtc: new Date().toISOString(), references: ['owned-fictitious-isolated-evidence'], isolated: true, imageDigest: 'sha256:' + 'd'.repeat(64), checks: Object.fromEntries(['auth', 'roles', 'revocation', 'origin', 'csrf', 'writerNotInvoked', 'authenticatedPositive', 'privateProfiles', 'limiterRealHttp', 'lateralListener', 'rotation', 'newRevision', 'tlsIngress', 'wireParsing'].map(name => [name, 'PASS'])), replicas: [{ id: 'fixture-one', revision: 'fixture-r1', reads: 12, correlationIds: ['fixture-1'] }, { id: 'fixture-two', revision: 'fixture-r2', reads: 12, correlationIds: ['fixture-2'] }] };
}
