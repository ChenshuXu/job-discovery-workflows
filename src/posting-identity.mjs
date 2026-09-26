/** Evidence-only posting identity parsing owned by Job Discovery. */

const TRACKING_PARAMS = new Set([
  'source', 'src', 'jobsite', 'gh_src', 'lever-source', 'utm_campaign',
  'utm_content', 'utm_medium', 'utm_source', 'utm_term',
]);

export function canonicalizePostingUrl(value) {
  const raw = String(value ?? '').trim().replace(/[),.;]+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || /^utm_/i.test(key)) url.searchParams.delete(key);
    }
    if (/jobs\.ashbyhq\.com$/i.test(url.hostname)) url.pathname = url.pathname.replace(/\/application\/?$/i, '');
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.searchParams.sort();
    return url.toString().replace(/\?$/, '');
  } catch {
    return null;
  }
}

const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:[-_][a-z]{2})?$/i;
const ID_LIKE_RE = /^[a-z0-9][a-z0-9._-]*\d[a-z0-9._-]*$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_EDGE_RE = /(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[-_])/i;
const LABELED_REQUISITION_RE = /(?:^|[-_])((?:ADOBUSR|JR|REQ|IRC|WJ|R)[-_]?\d[a-z0-9._-]*)$/i;
const WORKDAY_REQUISITION_RE = /^(?:\d+(?:-\d+)*|(?:P|B|H|Q|REF|JREQ|JOBREQ|JR|R|REQ|IRC|WJ)[A-Z0-9]*(?:[-_][A-Z0-9]+)*)$/i;
const WORKDAY_SUFFIX_RE = /^(?=[A-Z0-9_-]*\d)[A-Z0-9][A-Z0-9_-]*$/i;

const dropLocales = (segments) => segments.filter((segment) => !LOCALE_SEGMENT_RE.test(segment));

function workdayRequisition(segments) {
  const path = [...segments];
  while (path.at(-1)?.toLowerCase() === 'apply') path.pop();
  const job = path.findLastIndex(segment => segment.toLowerCase() === 'job');
  if (job < 0 || job === path.length - 1) return '';
  const slug = path.at(-1) || '';
  const delimiter = slug.indexOf('_');
  if (delimiter >= 0) {
    const suffix = slug.slice(delimiter + 1);
    return WORKDAY_SUFFIX_RE.test(suffix) ? suffix : '';
  }
  return WORKDAY_REQUISITION_RE.test(slug) ? slug : '';
}

/**
 * Reduce a posting URL to the stable triple that survives locale prefixes,
 * location paths, and tracking parameters: which ATS, whose tenant, which
 * requisition. Two URLs describe the same posting when the triple matches.
 * Returns null when the URL carries no usable requisition.
 */
function fingerprint(value, legacyGeneric) {
  const canonicalUrl = canonicalizePostingUrl(value);
  if (!canonicalUrl) return null;
  let url;
  try { url = new URL(canonicalUrl); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const build = (ats, tenant, requisitionId) => (tenant && requisitionId
    ? { ats, tenant: String(tenant).toLowerCase(), requisitionId: String(requisitionId).toUpperCase(), canonicalUrl }
    : null);

  if (/\.myworkdayjobs\.com$/.test(host)) {
    const path = dropLocales(segments);
    const isCxs = path[0]?.toLowerCase() === 'wday' && path[1]?.toLowerCase() === 'cxs';
    const tenant = isCxs ? path[2] || '' : host.split('.')[0];
    const site = isCxs ? path[3] || '' : path[0] || '';
    return build('workday', `${tenant}/${site}`, workdayRequisition(path));
  }
  if (/(?:^|\.)greenhouse\.io$/.test(host)) {
    const jobs = segments.indexOf('jobs');
    if (jobs > 0) return build('greenhouse', segments[jobs - 1], segments[jobs + 1]);
    const token = url.searchParams.get('token');
    const tenant = /^\/embed\/job_app\/?$/.test(url.pathname) ? url.searchParams.get('for') : null;
    if (!token) return null;
    return /^[a-z0-9][a-z0-9_-]*$/i.test(tenant || '')
      ? build('greenhouse', tenant, token)
      : build('greenhouse', host, token);
  }
  if (/(?:^|\.)lever\.co$/.test(host)) return build('lever', segments[0], segments[1]);
  if (/(?:^|\.)ashbyhq\.com$/.test(host)) {
    const ids = url.searchParams.getAll('ashby_jid');
    if (!legacyGeneric && ids.length) {
      if (host !== 'jobs.ashbyhq.com' || ids.length !== 1 || !UUID_RE.test(ids[0])
          || !/^[a-z0-9][a-z0-9_-]*$/i.test(segments[0] || '')
          || segments.length > 2 || segments[1] && segments[1].toUpperCase() !== ids[0].toUpperCase()) return null;
      return build('ashby', segments[0], ids[0]);
    }
    return build('ashby', segments[0], segments[1]);
  }
  if (/(?:^|\.)smartrecruiters\.com$/.test(host)) {
    const raw = segments[1] || '';
    const requisition = raw.match(/^(\d{6,}|[0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1] || raw;
    return build('smartrecruiters', segments[0], requisition);
  }
  if (/\.icims\.com$/.test(host)) {
    const jobs = segments.indexOf('jobs');
    return jobs >= 0 ? build('icims', host, segments[jobs + 1]) : null;
  }
  if (/(?:^|\.)linkedin\.com$/.test(host)) {
    const view = segments.indexOf('view');
    const segment = view >= 0 ? segments[view + 1] : '';
    const id = segment.match(/(?:^|-)(\d{8,})$/)?.[1] || segment;
    return build('linkedin', 'linkedin.com', legacyGeneric ? segment : id);
  }
  if (host === 'jobright.ai') {
    const info = segments.findIndex((segment, index) => segment.toLowerCase() === 'info' && segments[index - 1]?.toLowerCase() === 'jobs');
    const id = info >= 0 ? segments[info + 1] : '';
    return /^[0-9a-f]{24}$/i.test(id) ? build('jobright', 'jobright.ai', id) : null;
  }
  // Exact verified public redirect; do not infer other postings from this tenant.
  if (!legacyGeneric && host === 'elastic.ongig.com' && segments[0] === 'jobs' && segments.at(-1) === '8079636') {
    return build('greenhouse', 'elastic', '8079636');
  }

  if (!legacyGeneric && /\.tbe\.taleo\.net$/.test(host)) {
    const tail = segments.slice(-4).map(segment => segment.toLowerCase()).join('/');
    const org = url.searchParams.get('org');
    const cws = url.searchParams.get('cws');
    const rid = url.searchParams.get('rid');
    return tail === 'ats/careers/v2/viewrequisition' && org && cws && rid
      ? build('taleo', `${host}/${org}/${cws}`, rid)
      : null;
  }
  if (!legacyGeneric && host === 'careers.adobe.com') {
    const job = segments.indexOf('job');
    const requisition = job >= 0 ? segments[job + 1] : '';
    return /^ADOBUSR\d[A-Z0-9]*EXTERNAL[A-Z0-9]*$/i.test(requisition)
      ? build('phenom', 'adobe', requisition)
      : null;
  }
  const isGoogleCareers = host === 'careers.google.com'
    || (host === 'google.com' && segments.slice(0, 5).map(segment => segment.toLowerCase()).join('/') === 'about/careers/applications/jobs/results');
  if (!legacyGeneric && isGoogleCareers) {
    const results = segments.indexOf('results');
    const requisition = results >= 0 ? segments[results + 1]?.match(/^(\d+)(?:-|$)/)?.[1] : '';
    return build('google-careers', 'google', requisition);
  }
  if (!legacyGeneric && host === 'app.careerpuck.com') {
    const board = segments.indexOf('job-board');
    const tenant = board >= 0 ? segments[board + 1] : '';
    const job = board >= 0 && segments[board + 2] === 'job' ? segments[board + 3] : '';
    const greenhouseId = url.searchParams.get('gh_jid');
    return job && greenhouseId === job ? build('greenhouse', tenant, job) : null;
  }
  if (!legacyGeneric && host === 'tnl2.jometer.com') return null;
  if (!legacyGeneric && host === 'ziprecruiter.com' && segments[0]?.toLowerCase() === 'kn') return null;
  if (!legacyGeneric && host === 'recruit.hirebridge.com') {
    const tail = segments.map(segment => segment.toLowerCase()).join('/');
    const jid = url.searchParams.get('jid');
    const cid = url.searchParams.get('cid');
    return tail === 'v3/careercenter/v2/details.aspx' && /^\d+$/.test(jid || '') && /^\d+$/.test(cid || '')
      ? build('hirebridge', `${host}/${cid}`, jid)
      : null;
  }
  if (!legacyGeneric && /\.myworkdaysite\.com$/.test(host)) {
    const recruiting = segments.indexOf('recruiting');
    const tenant = recruiting >= 0 ? segments[recruiting + 1] : '';
    const site = recruiting >= 0 ? segments[recruiting + 2] : '';
    return build('workday', `${tenant}/${site}`, workdayRequisition(segments));
  }

  const tail = [...segments].reverse().find(segment => ID_LIKE_RE.test(segment));
  if (legacyGeneric) return tail ? build('generic', host, tail) : null;
  if (!tail) return null;
  if (/^\d+$/.test(tail) || UUID_RE.test(tail)) return build('generic', host, tail);
  const leadingNumber = tail.match(/^(\d+)(?:-|_)/)?.[1];
  if (leadingNumber) return build('generic', host, leadingNumber);
  const uuid = tail.match(UUID_EDGE_RE)?.[1];
  if (uuid) return build('generic', host, uuid);
  const labeled = tail.match(LABELED_REQUISITION_RE)?.[1];
  return labeled ? build('generic', host, labeled) : null;
}

export function postingFingerprint(value) { return fingerprint(value, false); }

/** Validation-only compatibility for immutable artifacts written by the original parser. */
export function legacyPostingFingerprint(value) { return fingerprint(value, true); }

export function postingKey(value) {
  const fingerprint = typeof value === 'string' ? postingFingerprint(value) : value;
  if (!fingerprint?.ats || !fingerprint?.tenant || !fingerprint?.requisitionId) return null;
  return `${fingerprint.ats}:${fingerprint.tenant}:${fingerprint.requisitionId}`;
}

export function legacyPostingKey(value) {
  const parsed = legacyPostingFingerprint(value);
  return parsed ? `${parsed.ats}:${parsed.tenant}:${parsed.requisitionId}` : null;
}

export function matchesStoredPostingKey(value, key, { identityParserVersion = 2 } = {}) {
  const parsed = postingKey(value);
  if (parsed === key) return true;
  if (Number(identityParserVersion) < 2) return legacyPostingKey(value) === key;
  let url;
  try { url = new URL(canonicalizePostingUrl(value)); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (Number(identityParserVersion) !== 2) return false;
  if (host === 'elastic.ongig.com' && parsed === 'greenhouse:elastic:8079636') return key === 'generic:elastic.ongig.com:8079636';
  if (host === 'google.com') return key === parsed?.replace(/^google-careers:google:/, 'generic:google.com:');
  const segments = url.pathname.split('/').filter(Boolean);
  const view = segments.indexOf('view');
  const oldLinkedInSegment = view >= 0 ? segments[view + 1] : '';
  return /(?:^|\.)linkedin\.com$/.test(host) && /-\d{8,}$/.test(oldLinkedInSegment)
    && key === `linkedin:linkedin.com:${oldLinkedInSegment.toUpperCase()}`;
}

export function normalizePostingKeys(value) {
  const values = Array.isArray(value) ? value : value?.posting_keys ?? [value];
  return [...new Set(values.map(item => String(item ?? '').trim()).filter(Boolean))].sort((left, right) => {
    const leftLinkedIn = left.startsWith('linkedin:');
    const rightLinkedIn = right.startsWith('linkedin:');
    return leftLinkedIn === rightLinkedIn ? left.localeCompare(right) : leftLinkedIn ? 1 : -1;
  });
}

export function primaryPostingKey(value) {
  return normalizePostingKeys(value)[0] ?? null;
}

export function postingRequisition(value) {
  const key = typeof value === 'string' ? value : primaryPostingKey(value);
  return key ? key.split(':').at(-1) : null;
}

/** True when two URLs or posting-key collections share an exact identity. */
export function samePosting(left, right) {
  if (Array.isArray(left) || Array.isArray(right) || left?.posting_keys || right?.posting_keys) {
    const rightKeys = new Set(normalizePostingKeys(right));
    return normalizePostingKeys(left).some(key => rightKeys.has(key));
  }
  const a = postingFingerprint(left);
  const b = postingFingerprint(right);
  if (!a || !b) return false;
  return a.ats === b.ats && a.tenant === b.tenant && a.requisitionId === b.requisitionId;
}

const LABELED_ID_RE = /\b(?:linkedin\s+(?:job|posting)\s+id|linkedin\s+id|job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/gi;
const URL_RE = /https?:\/\/[^\s<>'"`|)]+/gi;

export function extractPostingIdentity(text) {
  const source = String(text ?? '');
  const ids = new Set();
  for (const match of source.matchAll(LABELED_ID_RE)) ids.add(match[1].toUpperCase());
  for (const match of source.matchAll(/linkedin\.com\/jobs\/view\/(\d+)/gi)) ids.add(match[1]);
  const urls = new Set();
  for (const match of source.matchAll(URL_RE)) {
    const canonical = canonicalizePostingUrl(match[0]);
    if (canonical) urls.add(canonical);
  }
  return { ids: [...ids], urls: [...urls] };
}
