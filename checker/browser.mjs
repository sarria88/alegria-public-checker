import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CheckError, requireCheck, servedInstance } from './contracts.mjs';
import { feed, article } from './schemas.mjs';
import { verifyBytes } from './manifest.mjs';
import { createHttp, frontendDocument } from './http.mjs';

export async function browserHome(config, { base, language, manifest, signal, runId, mode = 'monitor' }) {
  if (!config.browser) throw new CheckError('browser/omitted', 'INCOMPLETE');
  let chromium;
  try {
    const module = config.playwrightModule ? createRequire(import.meta.url)(resolve(config.playwrightModule)) : await import('playwright');
    chromium = module.chromium;
  } catch { throw new CheckError('browser/unavailable', 'INCOMPLETE'); }
  let browser, observedHttpStatus = null;
  try { browser = await chromium.launch({ headless: true, ...(config.browserExecutable ? { executablePath: config.browserExecutable } : {}) }); }
  catch { throw new CheckError('browser/unavailable', 'INCOMPLETE'); }
  const close = () => { browser.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new CheckError('network/timeout');
    const context = await browser.newContext({ locale: language === 'en' ? 'en-GB' : 'es-ES', ignoreHTTPSErrors: false });
    // A fulfilled test document has no socket address-space metadata. Permit
    // its loopback requests only in the origin-validated local fixture mode.
    if (config.localFixture) await context.grantPermissions(['local-network-access']);
    const page = await context.newPage(); page.setDefaultTimeout(config.navigationTimeoutMs); page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    const documentRequest = createHttp(config, signal);
    const errors = [], responseErrors = [], instances = [], assets = new Map(), feeds = [], details = [], tasks = [];
    function identify(response) {
      const instance = servedInstance(response.headers());
      if (mode === 'gate' && !instance) throw new CheckError('evidence/browser-served-instance', 'INCOMPLETE');
      if (instance && instances.length < 32) instances.push(instance);
    }
    page.on('pageerror', () => errors.push('javascript'));
    page.on('requestfailed', request => { if (['script', 'stylesheet', 'document'].includes(request.resourceType())) errors.push('asset'); });
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const url = new URL(request.url());
        let hops = 0, previous = request.redirectedFrom();
        while (previous && hops <= 2) { hops++; previous = previous.redirectedFrom(); }
        if (hops > 2 || ![config.apexUrl, config.wwwUrl].includes(url.origin) || !config.localFixture && url.protocol !== 'https:') { errors.push('navigation'); await route.abort(); return; }
      }
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // Browser routing is not invoked for every redirect hop. Resolve the
        // Home chain manually below, then forbid new/racing document redirects.
        const response = await documentRequest(request.url());
        if (response.status >= 300 && response.status < 400) { errors.push('frontend/redirect-race'); await route.abort(); return; }
        const headers = Object.fromEntries(response.headers);
        // Fetch decoded the document; framing/compression headers must match
        // the decoded bytes fulfilled into the browser's real page context.
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[name];
        await route.fulfill({ status: response.status, headers, body: response.text }); return;
      }
      await route.continue();
    });
    page.on('response', response => {
      const task = (async () => {
        const url = new URL(response.url()), kind = response.request().resourceType();
        if (['script', 'stylesheet'].includes(kind)) {
          requireCheck(response.status() === 200 && [config.apexUrl, config.wwwUrl].includes(url.origin), 'browser/asset');
          const bytes = await response.body(); requireCheck(bytes.length > 0, 'browser/asset');
          verifyBytes(manifest, url.pathname, bytes); assets.set(url.pathname, true);
        }
        if (url.origin === config.apiBase && url.pathname === '/api/articles' && url.searchParams.get('lang') === language && url.searchParams.get('surface') === 'home' && url.searchParams.get('section') === 'international' && url.searchParams.get('sort') === 'ranking' && url.searchParams.get('page') === '1') {
          requireCheck(response.status() === 200 && /^application\/json(?:\s*;|$)/i.test(response.headers()['content-type'] ?? ''), 'browser/feed');
          requireCheck(response.headers()['x-alegria-revision'] === config.expectedApiRelease, 'release/api');
          identify(response);
          const value = await response.json(), size = Number(url.searchParams.get('pageSize'));
          requireCheck(Number.isSafeInteger(size) && size > 0 && size <= 100, 'browser/feed-query'); feed(value, { language, pageSize: size }); feeds.push(value);
        }
        if (url.origin === config.apiBase && /^\/api\/articles\/\d+$/.test(url.pathname)) {
          requireCheck(response.status() === 200 && /^application\/json(?:\s*;|$)/i.test(response.headers()['content-type'] ?? ''), 'browser/detail');
          requireCheck(response.headers()['x-alegria-revision'] === config.expectedApiRelease, 'release/api');
          identify(response);
          const value = await response.json(); article(value, language); details.push(value);
        }
      })().catch(error => responseErrors.push(error instanceof CheckError ? error : new CheckError('browser/response')));
      tasks.push(task);
    });
    const home = new URL('/?lang=' + language + '&section=international', base);
    const inspected = await frontendDocument(documentRequest, home.href, config);
    const finalHome = new URL(inspected.url); finalHome.searchParams.set('lang', language); finalHome.searchParams.set('section', 'international');
    const document = await page.goto(finalHome.href, { waitUntil: 'load' });
    observedHttpStatus = document?.status() ?? null;
    requireCheck(document?.status() === 200, 'browser/document');
    verifyBytes(manifest, '/', await document.body());
    const redirects = inspected.chain.slice(0, -1); let predecessor = document.request().redirectedFrom();
    while (predecessor) {
      const response = await predecessor.response(), target = new URL(predecessor.url());
      requireCheck(redirects.length < 2 && [301, 302, 307, 308].includes(response?.status()) && [config.apexUrl, config.wwwUrl].includes(target.origin) && (config.localFixture || target.protocol === 'https:'), 'frontend/redirect');
      redirects.unshift({ origin: target.origin, status: response.status() }); predecessor = predecessor.redirectedFrom();
    }
    const link = page.locator('section[data-geo-section="international"] article[data-article-id] h2 a').first();
    await link.waitFor({ state: 'visible' });
    await Promise.all(tasks);
    if (responseErrors.length) throw responseErrors[0];
    requireCheck((await page.locator('html').getAttribute('lang')) === language && new URL(page.url()).searchParams.get('section') === 'international', 'browser/selection');
    requireCheck(await page.locator('[role="alert"]').count() === 0 && errors.length === 0, errors[0] ?? 'browser/fatal');
    const title = (await link.innerText()).trim(), href = new URL(await link.getAttribute('href'), page.url());
    const card = link.locator('xpath=ancestor::article[1]'), id = Number(await card.getAttribute('data-article-id'));
    requireCheck(title.length > 0 && /^\/noticia\/\d+$/.test(href.pathname) && href.pathname === '/noticia/' + id && [config.apexUrl, config.wwwUrl].includes(href.origin), 'browser/news-link');
    requireCheck(feeds.some(value => value.items.some(item => item.id === id && item.title === title)), 'browser/news-api-coherence');
    requireCheck([...assets.keys()].some(path => path.endsWith('.js')) && [...assets.keys()].some(path => path.endsWith('.css')), 'browser/essential-assets');
    const homeUrl = page.url(); let screenshot = null;
    if (config.screenshots) {
      await mkdir(config.screenshots, { recursive: true });
      screenshot = `${runId}-${base === config.apexUrl ? 'apex' : 'www'}-${language}.png`;
      await page.screenshot({ path: resolve(config.screenshots, screenshot), fullPage: false });
    }
    await link.click();
    const heading = page.locator('#article article h1').first(); await heading.waitFor({ state: 'visible' });
    await Promise.all(tasks);
    if (responseErrors.length) throw responseErrors[0];
    requireCheck(new URL(page.url()).pathname === href.pathname && (await heading.innerText()).trim() === title && details.some(value => value.id === id && value.title === title), 'browser/detail-visible');
    requireCheck(errors.length === 0 && await page.locator('#article [role="alert"]').count() === 0, errors[0] ?? 'browser/fatal');
    return { httpStatus: document.status(), finalOrigin: new URL(homeUrl).origin, finalPath: '/?lang=' + language + '&section=international', redirects, articleId: id, title: title.slice(0, 180), apiFeedObserved: true, detailVisible: true, essentialAssets: [...assets.keys()].sort(), screenshot, instances };
  } catch (error) {
    if (error instanceof CheckError) { error.httpStatus = observedHttpStatus; throw error; }
    const failure = new CheckError(signal.aborted || error.name === 'TimeoutError' ? 'browser/timeout' : 'browser/failed'); failure.httpStatus = observedHttpStatus; throw failure;
  } finally { signal.removeEventListener('abort', close); await browser.close().catch(() => {}); }
}
