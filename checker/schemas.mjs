import { nonempty, requireCheck } from './contracts.mjs';
import { readFileSync } from 'node:fs';
const codes = new Set(JSON.parse(readFileSync(new URL('./country-codes.json', import.meta.url))));
const positive = value => Number.isSafeInteger(value) && value > 0;
export function category(value) {
  requireCheck(value && positive(value.id) && nonempty(value.name) && nonempty(value.slug) && Number.isSafeInteger(value.sortOrder), 'schema/category');
}
export function categories(value) {
  requireCheck(Array.isArray(value) && value.length > 0, 'content/categories-empty');
  value.forEach(category);
  requireCheck(new Set(value.map(x => x.id)).size === value.length && new Set(value.map(x => x.slug)).size === value.length, 'schema/category-duplicate');
}
export function countries(value) {
  requireCheck(Array.isArray(value) && value.length > 0, 'schema/countries');
  requireCheck(value.every(x => codes.has(x?.code) && ['es', 'en', 'fr'].every(lang => nonempty(x.names?.[lang]))) && new Set(value.map(x => x.code)).size === value.length, 'schema/countries');
}
export function article(value, language) {
  requireCheck(value && positive(value.id) && nonempty(value.title) && nonempty(value.source) && typeof value.url === 'string', 'schema/article');
  let url; try { url = new URL(value.url); } catch { /* checked below */ }
  requireCheck(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'schema/article-url');
  requireCheck(typeof value.publishedDate === 'string' && Number.isFinite(Date.parse(value.publishedDate)) && Array.isArray(value.categories) && value.userVote === 0, 'schema/article');
  value.categories.forEach(category);
  for (const field of ['language', 'contentLanguage']) {
    if (value[field] != null) requireCheck(value[field] === language || Array.isArray(value.availableLanguages) && !value.availableLanguages.includes(language) && value.availableLanguages.includes(value[field]), 'content/language');
  }
}
export function feed(value, { language = 'es', pageSize = 6, allowEmpty = false, national = false } = {}) {
  requireCheck(value && Array.isArray(value.items) && Number.isSafeInteger(value.total) && value.total >= value.items.length && value.page === 1 && value.pageSize === pageSize && value.items.length <= pageSize, 'schema/feed');
  requireCheck(allowEmpty || value.items.length > 0, 'content/feed-empty');
  value.items.forEach(x => article(x, language));
  requireCheck(new Set(value.items.map(x => x.id)).size === value.items.length, 'schema/article-duplicate');
  if (national) requireCheck(value.items.every(x => ['resolved', 'partial'].includes(x.geography?.resolutionStatus) && [x.geography?.primaryCountryCode, ...(x.geography?.additionalPlaces ?? []).map(p => p.countryCode)].includes('ES')), 'content/national-filter');
}
export function readiness(value) { requireCheck(value?.status === 'Healthy' && value.scope === 'database', 'schema/readiness'); }
export function session(value) { requireCheck(value?.authenticated === false && value.user === null && nonempty(value.csrfToken), 'schema/session'); }
export function feedPath(language = 'es', national = false) {
  return '/api/articles?' + (national ? 'section=national&country=ES&lang=es&sort=ranking&surface=home&page=1&pageSize=6' : `sort=ranking&lang=${language}&surface=home&section=international&page=1&pageSize=6`);
}
