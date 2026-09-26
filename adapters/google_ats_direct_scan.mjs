#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizePostingUrl, postingFingerprint, postingKey } from '../src/posting-identity.mjs';
import { collectHistoricalPostingKeys } from '../src/posting-history.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADAPTER_ID = 'google-ats-direct';
const MIN_JD_CHARS = 200;

function cliArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value, max = 100) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'unknown';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeHtml(value) {
  return clean(String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staged, file);
}

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${file}: ${error.message}`); }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || !value.length || value.some(item => !clean(item))) throw new Error(`${label} must be a non-empty string array`);
}

function validateRegexRules(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
  const ids = new Set();
  for (const rule of value) {
    if (!clean(rule?.id) || !clean(rule?.pattern) || !clean(rule?.reason)) throw new Error(`${label} rules require id, pattern, and reason`);
    if (ids.has(rule.id)) throw new Error(`${label} has duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    new RegExp(rule.pattern, rule.flags ?? 'i');
  }
}

export function loadGoogleAtsConfig(file = path.join(PROJECT_ROOT, 'config/google-ats-direct.json')) {
  const config = readJson(path.resolve(file), 'Google ATS Direct config');
  if (config.schema_version !== 1 || config.profile_id !== ADAPTER_ID) throw new Error('unsupported Google ATS Direct config schema/profile');
  if (config.provider?.name !== 'serpapi-google' || !clean(config.provider.endpoint) || !clean(config.provider.api_key_env)) {
    throw new Error('Google ATS Direct provider must be serpapi-google with endpoint and api_key_env');
  }
  if (config.provider.freshness_tbs !== 'qdr:d' || config.max_post_age_hours !== 24) {
    throw new Error('Google ATS Direct must enforce both SerpAPI qdr:d and max_post_age_hours=24');
  }
  for (const field of ['official_fetch_concurrency', 'http_timeout_ms']) {
    if (!Number.isInteger(config[field]) || config[field] < 1) throw new Error(`${field} must be a positive integer`);
  }
  if (!Array.isArray(config.serp_retry_delays_ms)
    || config.serp_retry_delays_ms.length !== 3
    || config.serp_retry_delays_ms.some(value => !Number.isInteger(value) || value < 0)) {
    throw new Error('serp_retry_delays_ms must contain exactly three non-negative integer delays');
  }
  for (const field of ['pages_per_query', 'results_per_page']) {
    if (!Number.isInteger(config.provider[field]) || config.provider[field] < 1) throw new Error(`provider.${field} must be a positive integer`);
  }
  assertStringArray(config.role_terms, 'role_terms');
  assertStringArray(config.location_terms, 'location_terms');
  if (!Array.isArray(config.negative_terms)) throw new Error('negative_terms must be an array');
  validateRegexRules(config.official_scope?.title_exclusions, 'official_scope.title_exclusions', true);
  validateRegexRules(config.official_scope?.location_allow_patterns, 'official_scope.location_allow_patterns');
  if (!Array.isArray(config.ats_sites) || !config.ats_sites.length) throw new Error('ats_sites must be a non-empty array');
  const requiredAts = new Set(['ashby', 'lever', 'greenhouse', 'workday', 'smartrecruiters']);
  for (const site of config.ats_sites) {
    if (!requiredAts.delete(site.id)) throw new Error(`unknown or duplicate ATS site: ${site.id}`);
    assertStringArray(site.domains, `ats_sites.${site.id}.domains`);
  }
  if (requiredAts.size) throw new Error(`Google ATS Direct config is missing ATS sites: ${[...requiredAts].join(', ')}`);
  for (const exclusion of config.employer_exclusions ?? []) {
    if (!clean(exclusion.id) || !clean(exclusion.pattern) || !clean(exclusion.reason)) throw new Error('employer exclusions require id, pattern, and reason');
    new RegExp(exclusion.pattern, 'i');
  }
  return config;
}

function quoteTerms(values) {
  return `(${values.map(value => `"${String(value).replaceAll('"', '')}"`).join(' OR ')})`;
}

export function buildGoogleQueries(config) {
  const roles = quoteTerms(config.role_terms);
  const locations = quoteTerms(config.location_terms);
  const negatives = config.negative_terms.map(term => `-${String(term).replace(/\s+/g, '-')}`).join(' ');
  return config.ats_sites.map(site => ({
    ats: site.id,
    domains: site.domains,
    query: `${site.domains.length === 1 ? `site:${site.domains[0]}` : `(${site.domains.map(domain => `site:${domain}`).join(' OR ')})`} ${roles} ${locations} ${negatives}`.trim(),
  }));
}

function hostnameMatches(hostname, domain) {
  const host = hostname.toLowerCase();
  const expected = domain.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function classifyAtsUrl(value, config) {
  let url;
  try { url = new URL(value); } catch { return null; }
  for (const site of config.ats_sites) {
    if (site.domains.some(domain => hostnameMatches(url.hostname, domain))) return site.id;
  }
  return null;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete('api_key');
    return url.toString();
  } catch { return value; }
}

function sanitizeForAudit(value) {
  if (Array.isArray(value)) return value.map(sanitizeForAudit);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'api_key')
      .map(([key, item]) => [key, sanitizeForAudit(item)]));
  }
  return typeof value === 'string' && /^https?:/i.test(value) ? sanitizeUrl(value) : value;
}

function parseJsonLd(html) {
  const found = [];
  for (const match of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (types.includes('JobPosting')) found.push(item);
      }
    } catch { /* malformed publisher JSON-LD is handled as missing evidence */ }
  }
  return found[0] ?? null;
}

function organizationName(value) {
  if (typeof value === 'string') return clean(value);
  return clean(value?.name);
}

function locationName(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(item => {
    const address = item?.address ?? item;
    if (typeof address === 'string') return clean(address);
    return [address?.addressLocality, address?.addressRegion, address?.addressCountry].map(clean).filter(Boolean).join(', ');
  }).filter(Boolean).join('; ');
}

function employmentType(value) {
  return (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean).join(', ');
}

function fromJsonLd(item) {
  if (!item) return {};
  return {
    title: clean(item.title),
    company: organizationName(item.hiringOrganization),
    location: locationName(item.jobLocation) || clean(item.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
    employment_type: employmentType(item.employmentType),
    employment_type_source: item.employmentType ? 'schema.org:employmentType' : '',
    posted_at: clean(item.datePosted),
    description: decodeHtml(item.description),
    canonical_url: clean(item.url),
    source_job_id: clean(item.identifier?.value ?? item.identifier),
  };
}

function mergePosting(primary, fallback) {
  const out = {};
  for (const key of ['title', 'company', 'location', 'employment_type', 'employment_type_source', 'posted_at', 'description', 'canonical_url', 'apply_url', 'source_job_id']) {
    out[key] = clean(primary?.[key]) || clean(fallback?.[key]);
  }
  return out;
}

function parsePosted(value, now) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis);
  }
  const text = clean(value);
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const number = Number(text);
    return new Date(text.length === 10 ? number * 1000 : number);
  }
  const exact = new Date(text);
  if (!Number.isNaN(exact.getTime())) return exact;
  if (/^posted\s+today$/i.test(text)) return new Date(now);
  const relative = text.match(/^(?:posted\s+)?(\d+)\s+(minute|hour)s?\s+ago$/i);
  if (relative) {
    const unit = relative[2].toLowerCase() === 'minute' ? 60_000 : 3_600_000;
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  return null;
}

function normalizePosted(posting, now) {
  const parsed = parsePosted(posting.posted_at, now);
  return { ...posting, posted_at: parsed?.toISOString() ?? '' };
}

function workdayApiUrl(url, fingerprint) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIndex = segments.indexOf('job');
  if (jobIndex < 0) return null;
  const site = segments[0];
  const tenant = fingerprint.tenant.split('/')[0];
  return `${parsed.origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/job/${segments.slice(jobIndex + 1).map(encodeURIComponent).join('/')}`;
}

function atsApiRequest(ats, url, fingerprint) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(segments[0])}?includeCompensation=true`;
  if (ats === 'lever') {
    const eu = parsed.hostname.toLowerCase().includes('.eu.');
    return `https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}`;
  }
  if (ats === 'greenhouse') {
    const jobs = segments.indexOf('jobs');
    return jobs > 0 ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(segments[jobs - 1])}/jobs/${encodeURIComponent(segments[jobs + 1])}?content=true` : null;
  }
  if (ats === 'workday') return workdayApiUrl(url, fingerprint);
  if (ats === 'smartrecruiters') return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(segments[0])}/postings/${encodeURIComponent(fingerprint.requisitionId)}`;
  return null;
}

function normalizeApiPosting(ats, data, url, fingerprint) {
  if (ats === 'ashby') {
    const job = (data.jobs ?? []).find(item => postingKey(item.jobUrl) === postingKey(fingerprint));
    if (!job) return {};
    return {
      title: job.title, company: fingerprint.tenant, location: [job.location, ...(job.secondaryLocations ?? []).map(item => item.location)].filter(Boolean).join('; '),
      employment_type: employmentType(job.employmentType), employment_type_source: job.employmentType ? 'ashby-api:employmentType' : '',
      posted_at: job.publishedAt, description: job.descriptionPlain || job.descriptionHtml,
      canonical_url: job.jobUrl, apply_url: job.applyUrl, source_job_id: fingerprint.requisitionId,
    };
  }
  if (ats === 'lever') return {
    title: data.text, company: fingerprint.tenant, location: data.categories?.allLocations?.join('; ') || data.categories?.location,
    employment_type: employmentType(data.categories?.commitment), employment_type_source: data.categories?.commitment ? 'lever-api:categories.commitment' : '',
    posted_at: data.createdAt, description: data.descriptionPlain || data.description,
    canonical_url: data.hostedUrl, apply_url: data.applyUrl, source_job_id: data.id || fingerprint.requisitionId,
  };
  if (ats === 'greenhouse') {
    const typeMetadata = (Array.isArray(data.metadata) ? data.metadata : []).find(item => /^(?:employment|job|time) type$/i.test(clean(item?.name)));
    return {
      title: data.title, company: data.company_name || fingerprint.tenant, location: data.location?.name,
      employment_type: employmentType(typeMetadata?.value), employment_type_source: typeMetadata ? 'greenhouse-api:metadata' : '',
      posted_at: data.date_posted || data.created_at, description: data.content,
      canonical_url: data.absolute_url || url, source_job_id: data.id || fingerprint.requisitionId,
    };
  }
  if (ats === 'workday') {
    const info = data.jobPostingInfo ?? data;
    return {
      title: info.title, company: info.company || fingerprint.tenant.split('/')[0], location: info.location || info.locationDescriptor,
      employment_type: employmentType(info.timeType || info.workerType), employment_type_source: info.timeType ? 'workday-api:timeType' : info.workerType ? 'workday-api:workerType' : '',
      posted_at: info.startDate || info.postedOn, description: info.jobDescription,
      canonical_url: info.externalUrl || url, source_job_id: info.jobReqId || fingerprint.requisitionId,
    };
  }
  if (ats === 'smartrecruiters') {
    const sections = data.jobAd?.sections ?? {};
    const description = [sections.companyDescription?.text, sections.jobDescription?.text, sections.qualifications?.text, sections.additionalInformation?.text].filter(Boolean).join('\n\n');
    const location = data.location ?? {};
    return {
      title: data.name, company: data.company?.name || data.company?.identifier || fingerprint.tenant,
      employment_type: employmentType(data.typeOfEmployment?.label || data.typeOfEmployment?.id), employment_type_source: data.typeOfEmployment ? 'smartrecruiters-api:typeOfEmployment' : '',
      location: [location.city, location.region, location.country].filter(Boolean).join(', '), posted_at: data.releasedDate,
      description, canonical_url: data.ref || url, source_job_id: data.id || fingerprint.requisitionId,
    };
  }
  return {};
}

class HttpClient {
  constructor(fixture, timeoutMs = 20_000) { this.fixture = fixture; this.timeoutMs = timeoutMs; this.jsonCache = new Map(); this.textCache = new Map(); }
  async json(url, options = {}) {
    if (this.jsonCache.has(url)) return this.jsonCache.get(url);
    if (this.fixture) {
      const hit = this.fixture.http?.[url];
      if (!hit) throw new Error(`fixture has no HTTP response for ${url}`);
      if (Number(hit.status ?? 200) >= 400) throw new Error(`HTTP ${hit.status} for ${url}`);
      const value = hit.json ?? JSON.parse(hit.body);
      this.jsonCache.set(url, value);
      return value;
    }
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'job-discovery-google-ats/1.0' }, signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const value = await response.json();
    this.jsonCache.set(url, value);
    return value;
  }
  async text(url, options = {}) {
    if (this.textCache.has(url)) return this.textCache.get(url);
    if (this.fixture) {
      const hit = this.fixture.http?.[url];
      if (!hit) throw new Error(`fixture has no HTTP response for ${url}`);
      if (Number(hit.status ?? 200) >= 400) throw new Error(`HTTP ${hit.status} for ${url}`);
      const value = hit.body ?? JSON.stringify(hit.json);
      this.textCache.set(url, value);
      return value;
    }
    const response = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'job-discovery-google-ats/1.0' }, signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const value = await response.text();
    this.textCache.set(url, value);
    return value;
  }
}

async function mapLimit(items, concurrency, worker) {
  let next = 0;
  const results = new Array(items.length);
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

async function fetchOfficialPosting(candidate, config, http, now) {
  const ats = classifyAtsUrl(candidate.link, config);
  const fingerprint = postingFingerprint(candidate.link);
  if (!ats || !fingerprint || fingerprint.ats !== ats) throw new Error('candidate URL has no supported ATS posting identity');
  const apiUrl = atsApiRequest(ats, candidate.link, fingerprint);
  let apiPosting = {};
  let apiError = null;
  if (apiUrl) {
    try { apiPosting = normalizeApiPosting(ats, await http.json(apiUrl), candidate.link, fingerprint); }
    catch (error) { apiError = error; }
  }
  let pagePosting = {};
  if (!apiPosting.posted_at || !apiPosting.description || !apiPosting.company || !apiPosting.employment_type || apiError) {
    try { pagePosting = fromJsonLd(parseJsonLd(await http.text(candidate.link))); }
    catch (error) {
      if (apiError || !apiPosting.description) throw new Error(`ATS API/page fetch failed: ${apiError?.message ?? '-'}; ${error.message}`);
    }
  }
  const merged = normalizePosted(mergePosting(apiPosting, pagePosting), now);
  merged.description = decodeHtml(merged.description);
  const finalUrl = canonicalizePostingUrl(merged.canonical_url || candidate.link);
  const finalFingerprint = postingFingerprint(finalUrl);
  if (!finalFingerprint || postingKey(finalFingerprint) !== postingKey(fingerprint)) throw new Error('official ATS response changed posting identity');
  return {
    ...merged,
    ats,
    posting_key: postingKey(finalFingerprint),
    source_job_id: merged.source_job_id || finalFingerprint.requisitionId,
    canonical_url: finalUrl,
    api_url: apiUrl,
    api_warning: apiError?.message ?? '',
  };
}

function exclusionFor(company, config) {
  return (config.employer_exclusions ?? []).find(item => new RegExp(item.pattern, 'i').test(clean(company))) ?? null;
}

function regexRuleMatch(value, rules) {
  return rules.find(rule => new RegExp(rule.pattern, rule.flags ?? 'i').test(value)) ?? null;
}

export function evaluateOfficialTitle(title, config) {
  const value = clean(title);
  const excluded = regexRuleMatch(value, config.official_scope.title_exclusions);
  if (excluded) return { allowed: false, exclusion_id: `title-${excluded.id}`, reason: excluded.reason };
  const matchedTerm = config.role_terms.find(term => new RegExp(`\\b${String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value));
  if (!matchedTerm) return { allowed: false, exclusion_id: 'title-no-target-role-term', reason: 'Official title does not contain a configured target engineering role' };
  return { allowed: true, matched_rule: matchedTerm };
}

export function evaluateOfficialLocation(location, config) {
  const value = clean(location);
  const matched = regexRuleMatch(value, config.official_scope.location_allow_patterns);
  if (!matched) return { allowed: false, exclusion_id: 'location-outside-us-scope', reason: 'Official location does not prove an eligible U.S. or unqualified Remote location' };
  return { allowed: true, matched_rule: matched.id, reason: matched.reason };
}

function markdownFor(posting, query, runId) {
  const workplaceType = /\bremote\b/i.test(clean(posting.location)) ? 'remote' : 'unknown';
  return `# ${posting.company} - ${posting.title}\n\n**Posting Key:** ${posting.posting_key}\n**Source Job ID:** ${posting.source_job_id}\n**ATS:** ${posting.ats}\n**URL:** ${posting.canonical_url}\n**Company:** ${posting.company}\n**Role:** ${posting.title}\n**Location:** ${posting.location}\n**Employment Type:** ${posting.employment_type || 'unknown'}\n**Employment Type Source:** ${posting.employment_type_source || 'unknown'}\n**Workplace Type:** ${workplaceType}\n**Workplace Type Source:** official-ats-location\n**Structured Remote Signal:** ${workplaceType === 'remote'}\n**Posted:** ${posting.posted_at}\n**Source:** Google ATS Direct via SerpAPI\n**Search Query:** ${query}\n**Discovery Run:** ${runId}\n\n## Job Description\n\n${posting.description.trim()}\n`;
}

function serpParameters(config, query, page, apiKey) {
  return {
    engine: config.provider.engine,
    google_domain: config.provider.google_domain,
    gl: config.provider.gl,
    hl: config.provider.hl,
    location: config.provider.location,
    tbs: config.provider.freshness_tbs,
    num: config.provider.results_per_page,
    start: page * config.provider.results_per_page,
    q: query,
    api_key: apiKey,
  };
}

async function searchSerpApi({ config, querySpec, page, apiKey, fixture, http }) {
  const fixtureKey = `${querySpec.ats}:${page}`;
  if (fixture) {
    const response = fixture.serp?.[fixtureKey];
    if (!response) throw new Error(`fixture has no SERP response for ${fixtureKey}`);
    return { response, parameters: serpParameters(config, querySpec.query, page, 'fixture-redacted') };
  }
  const parameters = serpParameters(config, querySpec.query, page, apiKey);
  const url = new URL(config.provider.endpoint);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return { response: await http.json(url.toString()), parameters };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchSerpApiWithRetry({ config, querySpec, page, apiKey, fixture, http }) {
  const delays = [0, ...config.serp_retry_delays_ms];
  let lastError;
  for (let attempt = 1; attempt <= delays.length; attempt += 1) {
    if (delays[attempt - 1] && !fixture) await delay(delays[attempt - 1]);
    try {
      const result = await searchSerpApi({ config, querySpec, page, apiKey, fixture, http });
      if (result.response.error) throw new Error(`SerpAPI error: ${result.response.error}`);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  const totalAttempts = delays.length;
  throw new Error(`${lastError.message} (failed after ${totalAttempts} attempts)`);
}

function parseArgs() {
  return {
    discoveryRoot: path.resolve(cliArg('--discovery-root') ?? PROJECT_ROOT),
    careerRoot: path.resolve(cliArg('--career-ops') ?? path.join(PROJECT_ROOT, '..', 'career-ops')),
    configFile: path.resolve(cliArg('--config') ?? path.join(PROJECT_ROOT, 'config/google-ats-direct.json')),
    runId: cliArg('--run-id') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15),
    fixtureFile: cliArg('--fixture') ? path.resolve(cliArg('--fixture')) : null,
    dryRun: process.argv.includes('--dry-run'),
  };
}

export async function runGoogleAtsDirect(options) {
  const config = loadGoogleAtsConfig(options.configFile);
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('invalid run timestamp');
  const queries = buildGoogleQueries(config);
  if (options.dryRun) return { profile_id: config.profile_id, max_post_age_hours: config.max_post_age_hours, queries, provider: sanitizeForAudit(config.provider) };

  const fixture = options.fixtureFile ? readJson(options.fixtureFile, 'Google ATS fixture') : null;
  const apiKey = fixture ? 'fixture-redacted' : clean(process.env[config.provider.api_key_env]);
  if (!apiKey) throw new Error(`missing SerpAPI credential in ${config.provider.api_key_env}`);
  const runRoot = path.join(options.discoveryRoot, 'runs', options.runId);
  const sourceRoot = path.join(runRoot, 'sources', ADAPTER_ID);
  if (existsSync(sourceRoot)) {
    let status = 'UNKNOWN';
    try { status = String(readJson(path.join(sourceRoot, 'summary.json'), 'prior Google ATS summary').status ?? '').toUpperCase(); } catch {}
    if (status === 'SUCCESS') throw new Error(`refusing to overwrite successful Google ATS Direct source: ${sourceRoot}`);
    const attempts = path.join(runRoot, 'adapter-attempts');
    mkdirSync(attempts, { recursive: true });
    renameSync(sourceRoot, path.join(attempts, `${ADAPTER_ID}-${new Date().toISOString().replace(/[:.]/g, '')}`));
  }
  mkdirSync(path.join(sourceRoot, 'jobs'), { recursive: true });
  mkdirSync(path.join(sourceRoot, 'serp'), { recursive: true });

  const http = new HttpClient(fixture, config.http_timeout_ms);
  const historical = collectHistoricalPostingKeys({ discoveryRoot: options.discoveryRoot, careerRoot: options.careerRoot, currentRunRoot: runRoot });
  const serpAudit = { schema_version: 1, run_id: options.runId, provider: config.provider.name, freshness_tbs: config.provider.freshness_tbs, requests: [], failures: [] };
  const candidates = [];
  const errors = [];
  for (const querySpec of queries) {
    for (let page = 0; page < config.provider.pages_per_query; page += 1) {
      const queryId = `${querySpec.ats}-page-${page + 1}`;
      try {
        const { response, parameters, attempts } = await searchSerpApiWithRetry({ config, querySpec, page, apiKey, fixture, http });
        const auditResponse = sanitizeForAudit(response);
        const responsePath = `serp/${queryId}.json`;
        writeJsonAtomic(path.join(sourceRoot, responsePath), auditResponse);
        const organic = Array.isArray(response.organic_results) ? response.organic_results : [];
        serpAudit.requests.push({ query_id: queryId, ats: querySpec.ats, query: querySpec.query, parameters: sanitizeForAudit(parameters), response_path: responsePath, response_sha256: sha256(JSON.stringify(auditResponse)), organic_results: organic.length, attempts });
        for (const result of organic) candidates.push({ ats_query: querySpec.ats, query: querySpec.query, query_id: queryId, position: result.position ?? null, title: clean(result.title), snippet: clean(result.snippet), result_date: clean(result.date), link: clean(result.link) });
      } catch (error) {
        const failure = { stage: 'serp', query_id: queryId, ats: querySpec.ats, attempts: config.serp_retry_delays_ms.length + 1, message: error.message };
        errors.push(failure);
        serpAudit.failures.push(failure);
      }
    }
  }
  writeJsonAtomic(path.join(sourceRoot, 'serp-audit.json'), serpAudit);

  const candidateAudit = [];
  const employerExclusions = [];
  const scopeExclusions = [];
  const sameRunDuplicates = [];
  const historicalDuplicates = [];
  const seenKeys = new Map();
  const captured = [];
  const pending = [];
  const cutoff = new Date(now.getTime() - config.max_post_age_hours * 3_600_000);
  for (const candidate of candidates) {
    const detectedAts = classifyAtsUrl(candidate.link, config);
    const initialKey = postingKey(candidate.link);
    if (!detectedAts || detectedAts !== candidate.ats_query || !initialKey) {
      candidateAudit.push({ ...candidate, status: 'SKIPPED_UNSUPPORTED_URL' });
      continue;
    }
    if (seenKeys.has(initialKey)) {
      const row = { posting_key: initialKey, url: candidate.link, first_query_id: seenKeys.get(initialKey), duplicate_query_id: candidate.query_id };
      sameRunDuplicates.push(row);
      candidateAudit.push({ ...candidate, posting_key: initialKey, status: 'SKIPPED_SAME_RUN_DUPLICATE' });
      continue;
    }
    seenKeys.set(initialKey, candidate.query_id);
    if (historical.has(initialKey)) {
      const row = { posting_key: initialKey, url: candidate.link, prior_artifacts: historical.get(initialKey) };
      historicalDuplicates.push(row);
      candidateAudit.push({ ...candidate, posting_key: initialKey, status: 'SKIPPED_HISTORICAL_DUPLICATE', prior_artifacts: row.prior_artifacts });
      continue;
    }
    pending.push({ candidate, initialKey });
  }
  await mapLimit(pending, config.official_fetch_concurrency, async ({ candidate, initialKey }) => {
    try {
      const posting = await fetchOfficialPosting(candidate, config, http, now);
      const exclusion = exclusionFor(posting.company, config);
      if (exclusion) {
        const row = { posting_key: posting.posting_key, source_job_id: posting.source_job_id, ats: posting.ats, company: posting.company, title: posting.title, url: posting.canonical_url, exclusion_id: exclusion.id, reason: exclusion.reason };
        employerExclusions.push(row);
        candidateAudit.push({ ...candidate, ...row, status: 'EXCLUDED_EMPLOYER' });
        return;
      }
      const posted = parsePosted(posting.posted_at, now);
      if (!posted) {
        candidateAudit.push({ ...candidate, posting_key: posting.posting_key, status: 'SKIPPED_MISSING_POSTED_AT', url: posting.canonical_url });
        return;
      }
      if (posted < cutoff || posted > new Date(now.getTime() + 5 * 60_000)) {
        candidateAudit.push({ ...candidate, posting_key: posting.posting_key, status: 'SKIPPED_OUTSIDE_24H', posted_at: posted.toISOString(), cutoff: cutoff.toISOString(), url: posting.canonical_url });
        return;
      }
      if (!posting.company || !posting.title || clean(posting.description).length < MIN_JD_CHARS) {
        throw new Error(`incomplete official JD: company=${Boolean(posting.company)} title=${Boolean(posting.title)} description_chars=${clean(posting.description).length}`);
      }
      const titleScope = evaluateOfficialTitle(posting.title, config);
      if (!titleScope.allowed) {
        const row = { posting_key: posting.posting_key, source_job_id: posting.source_job_id, ats: posting.ats, company: posting.company, title: posting.title, location: posting.location, url: posting.canonical_url, category: 'title', exclusion_id: titleScope.exclusion_id, reason: titleScope.reason };
        scopeExclusions.push(row);
        candidateAudit.push({ ...candidate, ...row, status: 'EXCLUDED_TITLE_SCOPE' });
        return;
      }
      const locationScope = evaluateOfficialLocation(posting.location, config);
      if (!locationScope.allowed) {
        const row = { posting_key: posting.posting_key, source_job_id: posting.source_job_id, ats: posting.ats, company: posting.company, title: posting.title, location: posting.location, url: posting.canonical_url, category: 'location', exclusion_id: locationScope.exclusion_id, reason: locationScope.reason };
        scopeExclusions.push(row);
        candidateAudit.push({ ...candidate, ...row, status: 'EXCLUDED_LOCATION_SCOPE' });
        return;
      }
      const filename = `${slug(posting.ats, 30)}-${slug(posting.source_job_id, 80)}-${slug(posting.company, 35)}-${slug(posting.title, 60)}.md`;
      const markdown = markdownFor(posting, candidate.query, options.runId);
      writeFileSync(path.join(sourceRoot, 'jobs', filename), markdown, { flag: 'wx' });
      captured.push({ ...posting, file: `jobs/${filename}`, jd_sha256: sha256(markdown) });
      candidateAudit.push({ ...candidate, posting_key: posting.posting_key, source_job_id: posting.source_job_id, ats: posting.ats, company: posting.company, title: posting.title, posted_at: posting.posted_at, url: posting.canonical_url, status: 'CAPTURED', jd_path: `jobs/${filename}` });
    } catch (error) {
      errors.push({ stage: 'official-jd', posting_key: initialKey, url: candidate.link, message: error.message });
      candidateAudit.push({ ...candidate, posting_key: initialKey, status: 'FAILED_OFFICIAL_JD', error: error.message });
    }
  });

  writeJsonAtomic(path.join(sourceRoot, 'candidate-audit.json'), { schema_version: 1, run_id: options.runId, results: candidateAudit });
  writeJsonAtomic(path.join(sourceRoot, 'excluded-employers.json'), { schema_version: 1, run_id: options.runId, excluded_count: employerExclusions.length, results: employerExclusions });
  writeJsonAtomic(path.join(sourceRoot, 'scope-exclusions.json'), { schema_version: 1, run_id: options.runId, excluded_count: scopeExclusions.length, title_excluded_count: scopeExclusions.filter(row => row.category === 'title').length, location_excluded_count: scopeExclusions.filter(row => row.category === 'location').length, results: scopeExclusions });
  writeJsonAtomic(path.join(sourceRoot, 'dedup-audit.json'), { schema_version: 1, run_id: options.runId, same_run_duplicate_count: sameRunDuplicates.length, historical_duplicate_count: historicalDuplicates.length, same_run_duplicates: sameRunDuplicates, historical_duplicates: historicalDuplicates });
  writeJsonAtomic(path.join(sourceRoot, 'capture-manifest.json'), { schema_version: 1, run_id: options.runId, captured });
  writeJsonAtomic(path.join(sourceRoot, 'errors.json'), { schema_version: 1, run_id: options.runId, errors });
  const queryErrors = errors.filter(error => error.stage === 'serp');
  const fatalErrors = errors.filter(error => error.stage !== 'serp');
  const allQueriesFailed = serpAudit.requests.length === 0;
  const status = allQueriesFailed || fatalErrors.length ? 'FAILED' : captured.length ? 'SUCCESS' : 'EMPTY';
  const summary = {
    schema_version: 1,
    run_id: options.runId,
    adapter: ADAPTER_ID,
    profile_id: config.profile_id,
    status,
    started_at: now.toISOString(),
    max_post_age_hours: config.max_post_age_hours,
    raw_rows: candidates.length,
    unique_jobs: captured.length,
    markdown_jobs: captured.length,
    errors: fatalErrors.length + (allQueriesFailed ? queryErrors.length : 0),
    query_errors: queryErrors.length,
    query_failures: serpAudit.failures,
    queries: serpAudit.requests.length,
    same_run_duplicates: sameRunDuplicates.length,
    historical_duplicates: historicalDuplicates.length,
    employer_exclusions: employerExclusions.length,
    title_exclusions: scopeExclusions.filter(row => row.category === 'title').length,
    location_exclusions: scopeExclusions.filter(row => row.category === 'location').length,
    outside_24_hours: candidateAudit.filter(row => row.status === 'SKIPPED_OUTSIDE_24H').length,
    missing_posted_at: candidateAudit.filter(row => row.status === 'SKIPPED_MISSING_POSTED_AT').length,
  };
  writeJsonAtomic(path.join(sourceRoot, 'summary.json'), summary);
  return summary;
}

async function main() {
  const args = parseArgs();
  try {
    const result = await runGoogleAtsDirect(args);
    console.log(JSON.stringify(result, null, 2));
    return result.status === 'FAILED' ? 1 : 0;
  } catch (error) {
    const runRoot = path.resolve(args.discoveryRoot, 'runs', args.runId);
    const sourceRoot = path.join(runRoot, 'sources', ADAPTER_ID);
    if (!existsSync(path.join(sourceRoot, 'summary.json'))) {
      mkdirSync(path.join(sourceRoot, 'jobs'), { recursive: true });
      writeJsonAtomic(path.join(sourceRoot, 'summary.json'), {
        schema_version: 1, run_id: args.runId, adapter: ADAPTER_ID, status: 'FAILED',
        raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, errors: 1,
      });
      writeJsonAtomic(path.join(sourceRoot, 'excluded-employers.json'), {
        schema_version: 1, run_id: args.runId, excluded_count: 0, results: [],
      });
    }
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
