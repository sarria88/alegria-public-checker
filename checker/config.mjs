import { CheckError, sha } from './contracts.mjs';
const loopback = host => host === '127.0.0.1' || host === '[::1]';
function origin(value, fixture) {
  let url;
  try { url = new URL(value); } catch { throw new CheckError('configuration/url', 'INCOMPLETE'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (fixture ? !loopback(url.hostname) || !['http:', 'https:'].includes(url.protocol) : url.protocol !== 'https:')) throw new CheckError('configuration/origin', 'INCOMPLETE');
  return url.origin;
}
function duration(value, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new CheckError('configuration/timeout', 'INCOMPLETE');
  return parsed;
}
export function configuration(input = {}) {
  const fixture = input.localFixture === true;
  const apiBase = origin(input.apiBase ?? 'https://api.alegrianews.com', fixture);
  const apexUrl = origin(input.apexUrl ?? 'https://alegrianews.com', fixture);
  const wwwUrl = origin(input.wwwUrl ?? 'https://www.alegrianews.com', fixture);
  if (!fixture && (new URL(apexUrl).hostname !== 'alegrianews.com' || new URL(wwwUrl).hostname !== 'www.alegrianews.com')) throw new CheckError('configuration/frontend-host', 'INCOMPLETE');
  if (input.expectedApiRelease !== undefined && !sha(input.expectedApiRelease) || input.expectedFrontendRelease !== undefined && !sha(input.expectedFrontendRelease)) throw new CheckError('configuration/release', 'INCOMPLETE');
  const apiHttp = new URL(apiBase); apiHttp.protocol = 'http:';
  const acaUrls = (input.acaUrls ?? []).map(value => origin(value, fixture));
  // An invented Host can be rejected by ACA routing before the application.
  // Use an operator-observed routable authority, distinct from the canonical API.
  const alternative = acaUrls.map(value => new URL(value).host).find(host => host !== new URL(apiBase).host);
  return {
    ...input, apiBase, apexUrl, wwwUrl, localFixture: fixture,
    apiHttpBase: input.apiHttpBase ? origin(input.apiHttpBase, fixture) : apiHttp.origin,
    alternativeAuthority: input.alternativeAuthority ?? alternative,
    acaUrls,
    requestTimeoutMs: duration(input.requestTimeoutMs, 15000, 15000),
    navigationTimeoutMs: duration(input.navigationTimeoutMs, 30000, 30000),
    cycleTimeoutMs: duration(input.cycleTimeoutMs, 120000, 120000),
    browser: input.browser !== false,
    screenshots: input.screenshots ?? 'artifacts/public-checker/screenshots',
  };
}
export function parseArguments(args, env = process.env) {
  const [command = 'monitor', ...rest] = args;
  if (!['monitor', 'gate', 'watchdog', 'manifest'].includes(command)) throw new CheckError('configuration/command', 'INCOMPLETE');
  const input = { apiBase: env.API_BASE, apexUrl: env.APEX_URL, wwwUrl: env.WWW_URL, expectedApiRelease: env.EXPECTED_API_RELEASE, expectedFrontendRelease: env.EXPECTED_FRONTEND_RELEASE };
  const files = {};
  const switches = { '--local-fixture': ['localFixture', true], '--no-browser': ['browser', false] };
  const values = { '--api-base': 'apiBase', '--apex-url': 'apexUrl', '--www-url': 'wwwUrl', '--api-http-base': 'apiHttpBase', '--expected-api-release': 'expectedApiRelease', '--expected-frontend-release': 'expectedFrontendRelease', '--request-timeout-ms': 'requestTimeoutMs', '--navigation-timeout-ms': 'navigationTimeoutMs', '--cycle-timeout-ms': 'cycleTimeoutMs', '--browser-executable': 'browserExecutable', '--playwright-module': 'playwrightModule' };
  const fileOptions = { '--output': 'output', '--manifest': 'manifest', '--evidence': 'evidence', '--state': 'state', '--heartbeat': 'heartbeat', '--adapter': 'adapter', '--artifact': 'artifact', '--screenshots': 'screenshots' };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (switches[arg]) { const [key, value] = switches[arg]; input[key] = value; }
    else if ((values[arg] || fileOptions[arg] || arg === '--aca-url') && rest[i + 1] && !rest[i + 1].startsWith('--')) {
      const value = rest[++i];
      if (arg === '--aca-url') (input.acaUrls ??= []).push(value);
      else if (values[arg]) input[values[arg]] = value;
      else files[fileOptions[arg]] = value;
    } else throw new CheckError('configuration/argument', 'INCOMPLETE');
  }
  return { command, input, files };
}
