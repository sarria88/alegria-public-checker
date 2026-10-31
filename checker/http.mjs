import { CheckError, requireCheck, safeId, servedInstance } from './contracts.mjs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
export function authorityOptions(target, options) {
  const requestOptions = { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), signal: options.signal };
  if (target.protocol === 'https:') {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    // Node's HTTPS agent otherwise derives SNI from the overridden HTTP Host.
    // Pin DNS SNI and certificate identity independently to the connection URL;
    // IP literals use SAN verification without sending an IP address as SNI.
    requestOptions.servername = isIP(hostname) ? '' : hostname;
    requestOptions.rejectUnauthorized = true;
    requestOptions.checkServerIdentity = (_servername, certificate) => checkServerIdentity(hostname, certificate);
  }
  return requestOptions;
}
// Fetch implementations may rewrite/ignore Host. This narrow HTTP/1 authority
// probe preserves TLS verification against the URL while sending the real Host.
export function authorityRequest(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, authorityOptions(target, options), response => {
      const resultHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) resultHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      const noBody = [204, 205, 304].includes(response.statusCode);
      if (noBody) response.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers: resultHeaders }));
    });
    request.once('error', reject); request.end(options.body);
  });
}
export function networkError(error) {
  if (error instanceof CheckError) return error;
  const code = error?.cause?.code ?? error?.code ?? '';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return new CheckError('network/timeout');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return new CheckError('network/dns');
  if (/CERT|TLS|SSL/.test(code)) return new CheckError('network/tls');
  return new CheckError('network/request');
}
export async function boundedText(response, maximum = 2 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      requireCheck(bytes <= maximum, 'response/oversized'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export function createHttp(config, signal, fetcher = fetch) {
  return async function request(url, options = {}) {
    try {
      const transport = new Headers(options.headers).has('host') ? authorityRequest : fetcher;
      const response = await transport(url, { ...options, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]) });
      const text = await boundedText(response);
      return {
        status: response.status, headers: response.headers, text,
        correlationId: safeId(response.headers.get('x-correlation-id')),
        revision: safeId(response.headers.get('x-alegria-revision')),
        instance: servedInstance(response.headers),
        json() {
          requireCheck(response.status === 200, response.status >= 300 && response.status < 400 ? 'http/unexpected-redirect' : 'http/status');
          requireCheck(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'response/content-type');
          requireCheck(text.trim().length > 0, 'response/empty');
          try { return JSON.parse(text); } catch { throw new CheckError('response/json'); }
        },
      };
    } catch (error) { throw networkError(error); }
  };
}
export function cookieFlags(headers) {
  const cookies = headers.getSetCookie?.() ?? [];
  requireCheck(cookies.length > 0, 'session/csrf-cookie-missing');
  for (const value of cookies) {
    const [pair, ...attributes] = value.split(';').map(x => x.trim());
    const name = pair.split('=')[0], lower = attributes.map(x => x.toLowerCase());
    requireCheck(name === '__Host-AlegriaCsrf', 'session/unexpected-cookie');
    requireCheck(lower.includes('secure') && lower.includes('httponly') && lower.includes('path=/') && lower.includes('samesite=strict') && !lower.some(x => x.startsWith('domain=')), 'session/cookie-flags');
  }
  return { csrf: true, secure: true, httpOnly: true, hostOnly: true, path: '/', sameSite: 'Strict' };
}
export async function frontendDocument(request, start, config) {
  let url = new URL(start); const chain = [];
  const allowed = new Set([config.apexUrl, config.wwwUrl]);
  for (let hop = 0; hop <= 2; hop++) {
    requireCheck(allowed.has(url.origin) && (config.localFixture || url.protocol === 'https:'), 'frontend/redirect-target');
    const response = await request(url);
    chain.push({ origin: url.origin, status: response.status });
    if (response.status === 200) {
      requireCheck(/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') && response.text.trim().length > 0, 'frontend/document');
      return { response, url, chain };
    }
    requireCheck(hop < 2 && [301, 302, 307, 308].includes(response.status), 'frontend/redirect');
    const location = response.headers.get('location'); requireCheck(location, 'frontend/redirect-location');
    try { url = new URL(location, url); } catch { throw new CheckError('frontend/redirect-target'); }
  }
}
