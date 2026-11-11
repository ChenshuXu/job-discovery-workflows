// Fetches one official ATS posting (Greenhouse, Lever, Ashby, Workday, schema.org pages) and
// normalizes it. Used by the Career-Ops official-ATS source.
import { canonicalizePostingUrl, postingFingerprint, postingKey } from '../posting-identity.mjs';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hostnameMatches(hostname, domain) {
  const host = hostname.toLowerCase();
  const expected = domain.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

function classifyAtsUrl(value, config) {
  let url;
  try { url = new URL(value); } catch { return null; }
  for (const site of config.ats_sites) {
    if (site.domains.some(domain => hostnameMatches(url.hostname, domain))) return site.id;
  }
  return null;
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
    workplace_type: item.jobLocationType === 'TELECOMMUTE' ? 'remote' : 'unknown',
  };
}

function mergePosting(primary, fallback) {
  const out = {};
  for (const key of ['title', 'company', 'location', 'employment_type', 'employment_type_source', 'posted_at', 'description', 'canonical_url', 'apply_url', 'source_job_id']) {
    const normalize = key === 'description' ? value => String(value ?? '').trim() : clean;
    out[key] = normalize(primary?.[key]) || normalize(fallback?.[key]);
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
      workplace_type: clean(job.workplaceType).toLowerCase() || (job.isRemote === true ? 'remote' : 'unknown'),
    };
  }
  if (ats === 'lever') return {
    title: data.text, company: fingerprint.tenant, location: data.categories?.allLocations?.join('; ') || data.categories?.location,
    employment_type: employmentType(data.categories?.commitment), employment_type_source: data.categories?.commitment ? 'lever-api:categories.commitment' : '',
    posted_at: data.createdAt, description: [data.descriptionPlain || data.description,
      ...(data.lists ?? []).map(item => `${item.text || ''}\n${item.content || ''}`), data.additionalPlain || data.additional].filter(Boolean).join('\n\n'),
    canonical_url: data.hostedUrl, apply_url: data.applyUrl, source_job_id: data.id || fingerprint.requisitionId,
    workplace_type: clean(data.workplaceType).toLowerCase() || 'unknown',
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

export class HttpClient {
  // Caches the in-flight promise, so concurrent candidates on one board share one download.
  constructor(fixture, timeoutMs = 20_000) { this.fixture = fixture; this.timeoutMs = timeoutMs; this.jsonCache = new Map(); this.textCache = new Map(); }
  json(url, options = {}) { return this.cached(this.jsonCache, url, () => this.fetchJson(url, options)); }
  text(url, options = {}) { return this.cached(this.textCache, url, () => this.fetchText(url, options)); }
  cached(cache, url, load) {
    if (!cache.has(url)) cache.set(url, load().catch(error => { cache.delete(url); throw error; }));
    return cache.get(url);
  }
  fixtureHit(url) {
    const hit = this.fixture.http?.[url];
    if (!hit) throw new Error(`fixture has no HTTP response for ${url}`);
    if (Number(hit.status ?? 200) >= 400) throw new Error(`HTTP ${hit.status} for ${url}`);
    return hit;
  }
  async fetchJson(url, options) {
    if (this.fixture) { const hit = this.fixtureHit(url); return hit.json ?? JSON.parse(hit.body); }
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'job-discovery-official-ats/1.0' }, signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.json();
  }
  async fetchText(url, options) {
    if (this.fixture) { const hit = this.fixtureHit(url); return hit.body ?? JSON.stringify(hit.json); }
    const response = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'job-discovery-official-ats/1.0' }, signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  }
}

export async function mapLimit(items, concurrency, worker) {
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

export async function fetchOfficialPosting(candidate, config, http, now) {
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
  const structuredWorkplace = apiPosting.workplace_type && apiPosting.workplace_type !== 'unknown' ? apiPosting.workplace_type
    : pagePosting.workplace_type && pagePosting.workplace_type !== 'unknown' ? pagePosting.workplace_type : null;
  const workplaceType = structuredWorkplace ?? (/\bremote\b/i.test(merged.location) ? 'remote' : 'unknown');
  return {
    ...merged,
    ats,
    posting_key: postingKey(finalFingerprint),
    source_job_id: merged.source_job_id || finalFingerprint.requisitionId,
    canonical_url: finalUrl,
    api_url: apiUrl,
    api_warning: apiError?.message ?? '',
    workplace_type: workplaceType,
    workplace_type_source: structuredWorkplace ? 'official-ats-api/schema.org' : workplaceType === 'unknown' ? 'unknown' : 'location-text-heuristic',
    structured_remote_signal: structuredWorkplace === 'remote',
  };
}
