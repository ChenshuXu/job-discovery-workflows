#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matchExcludedEmployer, validateEmployerExclusionRules } from '../src/employer-exclusions.mjs';
import { postingKey } from '../src/posting-identity.mjs';

const ADAPTER_ID = 'jobright';
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_JOBRIGHT_CONFIG = path.join(PROJECT_ROOT, 'config/jobright.json');

const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const cleanLines = value => String(value ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const uniqueStrings = values => [...new Set((values ?? []).map(clean).filter(Boolean))];
const normalizedSet = values => uniqueStrings(values).map(value => value.toLowerCase()).sort();

function sameSet(left, right) {
  return JSON.stringify(normalizedSet(left)) === JSON.stringify(normalizedSet(right));
}

function filterCodeSnapshot(value = {}) {
  const numberSet = field => [...new Set((Array.isArray(value[field]) ? value[field] : []).map(Number))].sort((left, right) => left - right);
  const locations = (Array.isArray(value.locations) ? value.locations : []).map(location => ({
    type: clean(location?.type).toLowerCase(),
    city: clean(location?.city),
    radiusRange: Number(location?.radiusRange),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    jobTypes: numberSet('jobTypes'),
    seniority: numberSet('seniority'),
    workModel: numberSet('workModel'),
    daysAgo: Number(value.daysAgo),
    minYearsOfExperienceRange: numberSet('minYearsOfExperienceRange'),
    country: clean(value.country),
    city: clean(value.city),
    locations,
    radiusRange: Number(value.radiusRange),
  };
}

function filterCodesMatch(expected, actual) {
  return JSON.stringify(filterCodeSnapshot(expected)) === JSON.stringify(filterCodeSnapshot(actual));
}

function json(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON ${file}: ${error.message}`); }
}

function validateFilterSnapshot(value, label) {
  if (!value || !clean(value.freshness) || !clean(value.sort) || !Array.isArray(value.values) || !value.values.length) {
    throw new Error(`${label} requires freshness, sort, and values`);
  }
}

export function loadJobrightConfig(file = DEFAULT_JOBRIGHT_CONFIG) {
  const resolved = path.resolve(file);
  const config = json(resolved);
  if (config.schema_version !== 1 || config.landing_url !== 'https://jobright.ai/jobs/recommend') {
    throw new Error(`unsupported Jobright config: ${resolved}`);
  }
  if (!Number.isInteger(config.max_post_age_hours) || config.max_post_age_hours !== 24) throw new Error('Jobright max_post_age_hours must be 24');
  if (!Number.isInteger(config.min_jd_chars) || config.min_jd_chars < 200) throw new Error('Jobright min_jd_chars must be at least 200');
  validateFilterSnapshot(config.filter_snapshot, 'config.filter_snapshot');
  const codes = config.filter_snapshot.codes;
  if (!codes || !['jobTypes', 'seniority', 'workModel', 'minYearsOfExperienceRange'].every(field => Array.isArray(codes[field]) && codes[field].length)
      || !Number.isFinite(codes.daysAgo) || !Number.isFinite(codes.radiusRange) || !clean(codes.country) || !clean(codes.city)
      || !Array.isArray(codes.locations) || !codes.locations.length) throw new Error('config.filter_snapshot.codes is incomplete');
  if (!Array.isArray(config.filter_snapshot.visible_controls) || !config.filter_snapshot.visible_controls.length) {
    throw new Error('config.filter_snapshot.visible_controls is required');
  }
  const traversal = config.traversal ?? {};
  for (const key of ['page_size', 'max_scroll_steps', 'stable_observations']) {
    if (!Number.isInteger(traversal[key]) || traversal[key] < 1) throw new Error(`config.traversal.${key} must be a positive integer`);
  }
  if (!Number.isFinite(traversal.settle_seconds) || traversal.settle_seconds <= 0) throw new Error('config.traversal.settle_seconds must be positive');
  validateEmployerExclusionRules(config.employer_exclusions);
  return { ...config, file: resolved };
}

function jobrightId(value) {
  const id = clean(value?.jobright_id ?? value?.jobrightId ?? value?.id);
  return /^[0-9a-f]{24}$/i.test(id) ? id.toLowerCase() : '';
}

function officialCandidates(detail) {
  return uniqueStrings([
    detail.official_url,
    detail.officialUrl,
    detail.original_url,
    detail.originalUrl,
    detail.apply_link,
    detail.applyLink,
    ...(Array.isArray(detail.official_url_candidates) ? detail.official_url_candidates : []),
  ]);
}

function officialIdentity(detail, fallbackUrl) {
  const candidates = officialCandidates(detail);
  for (const url of candidates) {
    const key = postingKey(url);
    if (key) return { url, key, original_url: url };
  }
  const key = postingKey(fallbackUrl);
  return key ? { url: fallbackUrl, key, original_url: candidates[0] || '' } : null;
}

function metadata(value) {
  return clean(value).replace(/[\r\n]+/g, ' ');
}

function markdownForJob(job, runId) {
  return `# ${metadata(job.company)} - ${metadata(job.title)}

**URL:** ${job.official_url}
**Posting Key:** ${job.posting_key}
**Source Job ID:** ${job.jobright_id}
**Jobright URL:** ${job.jobright_url}
${job.original_job_url ? `**Original Job URL:** ${job.original_job_url}\n` : ''}**Company:** ${metadata(job.company)}
**Role:** ${metadata(job.title)}
**Location:** ${metadata(job.location)}
**Employment Type:** ${metadata(job.employment_type) || 'unknown'}
**Employment Type Source:** jobright:employment_type
**Workplace Type:** ${metadata(job.workplace_type) || 'unknown'}
**Workplace Type Source:** jobright:workplace_type
**Structured Remote Signal:** ${String(job.workplace_type).toLowerCase() === 'remote'}
**Posted:** ${job.posted_at}
**Jobright Publish Time Raw:** ${metadata(job.publish_time_raw)}
**Card Posted Label:** ${metadata(job.publish_time_desc)}
**Reposted:** ${job.repost}
**Captured At:** ${job.captured_at}
**Discovery Timezone:** ${job.timezone}
**Source:** jobright
**Discovery Run:** ${runId}

## Job Description

${job.description}
`;
}

function filterMatches(expected, actual) {
  return actual?.verified !== false
    && clean(expected.freshness).toLowerCase() === clean(actual?.freshness).toLowerCase()
    && clean(expected.sort).toLowerCase() === clean(actual?.sort).toLowerCase()
    && sameSet(expected.values, actual?.values)
    && filterCodesMatch(expected.codes, actual?.codes);
}

function errorDetail(stage, message, id = '') {
  return { stage, ...(id ? { jobright_id: id } : {}), message: clean(message).slice(0, 500) };
}

/** Build the complete source artifact payload without reading or writing files. */
export function buildJobrightArtifacts({ runId, config, fixture, capturedAt = new Date().toISOString(), timezone = config?.timezone }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clean(runId))) throw new Error('runId may contain only letters, digits, dots, underscores, and hyphens');
  validateFilterSnapshot(config?.filter_snapshot, 'config.filter_snapshot');
  const actualFilter = fixture?.filter_snapshot ?? {};
  const batches = Array.isArray(fixture?.batches) ? fixture.batches : [];
  const validRows = batches.flatMap(batch => Array.isArray(batch) ? batch : []).filter(row => jobrightId(row));
  const invalidRows = batches.flatMap(batch => Array.isArray(batch) ? batch : []).length - validRows.length;
  const byId = new Map();
  for (const row of validRows) if (!byId.has(jobrightId(row))) byId.set(jobrightId(row), row);
  const rawRows = validRows.length;
  const duplicateRows = rawRows - byId.size;
  const terminationReason = clean(fixture?.termination_reason || 'stable_bottom');
  const errors = uniqueStrings(fixture?.source_errors).map(message => errorDetail('source', message));
  errors.push(...(fixture?.response_errors ?? []));
  if (invalidRows) errors.push(errorDetail('list', `${invalidRows} card(s) lacked a stable Jobright ID`));
  const filtersMatch = filterMatches(config.filter_snapshot, actualFilter);
  if (!filtersMatch) errors.push(errorDetail('filters', 'observed filters do not match the accepted snapshot'));
  if (!['stable_bottom', 'short_batch'].includes(terminationReason)) errors.push(errorDetail('list', `feed termination was not proven: ${terminationReason || 'unknown'}`));

  const details = fixture?.details && typeof fixture.details === 'object' ? fixture.details : {};
  const jobs = [];
  const exclusions = [];
  const dispositions = [];
  for (const [id, card] of byId) {
    const jobrightUrl = `https://jobright.ai/jobs/info/${id}`;
    if (!filtersMatch) {
      dispositions.push({ jobright_id: id, status: 'failed', reason: 'filter_mismatch' });
      continue;
    }
    const detail = details[id] ?? details[String(card.id ?? '')];
    if (!detail || detail.error) {
      const reason = clean(detail?.error || 'detail_missing');
      dispositions.push({ jobright_id: id, status: 'failed', reason });
      errors.push(errorDetail('detail', reason, id));
      continue;
    }
    if (detail.freshness_eligible === false || detail.outside_window === true) {
      dispositions.push({ jobright_id: id, status: 'freshness_excluded', reason: 'outside_past_24_hours', evidence: metadata(detail.publish_time_desc ?? card.publish_time_desc) });
      continue;
    }
    const company = clean(detail.company ?? card.company);
    const title = clean(detail.title ?? detail.role ?? card.title);
    const description = cleanLines(detail.description ?? detail.body ?? detail.jd);
    const exclusion = matchExcludedEmployer({ company, description }, config.employer_exclusions);
    if (exclusion) {
      const row = { jobright_id: id, jobright_url: jobrightUrl, company, title, exclusion_id: exclusion.id, reason: exclusion.reason, source: exclusion.source, evidence: exclusion.evidence };
      exclusions.push(row);
      dispositions.push({ jobright_id: id, status: 'employer_excluded', reason: exclusion.reason, evidence: exclusion.evidence });
      continue;
    }
    const identity = officialIdentity(detail, jobrightUrl);
    if (!identity) {
      const evidence = officialCandidates(detail).join(' | ');
      dispositions.push({ jobright_id: id, status: 'failed', reason: 'identity_unresolved', ...(evidence ? { evidence } : {}) });
      errors.push(errorDetail('identity', `identity_unresolved${evidence ? `: ${evidence}` : ''}`, id));
      continue;
    }
    if (!company || !title || description.length < config.min_jd_chars) {
      const reason = `incomplete_detail company=${Boolean(company)} title=${Boolean(title)} description_chars=${description.length}`;
      dispositions.push({ jobright_id: id, status: 'failed', reason });
      errors.push(errorDetail('detail', reason, id));
      continue;
    }
    const workplace = clean(detail.workplace_type ?? detail.workplaceType ?? card.workplace_type).toLowerCase() || 'unknown';
    const postedAt = config.publish_time_has_timezone === true && /(?:Z|[+-]\d\d:\d\d)$/i.test(clean(detail.publish_time_raw))
      ? clean(detail.publish_time_raw) : '';
    const job = {
      jobright_id: id,
      jobright_url: jobrightUrl,
      official_url: identity.url,
      original_job_url: identity.original_url !== identity.url ? identity.original_url : '',
      posting_key: identity.key,
      company,
      title,
      location: clean(detail.location ?? card.location),
      employment_type: clean(detail.employment_type ?? detail.employmentType ?? card.employment_type) || 'unknown',
      workplace_type: /remote/.test(workplace) ? 'remote' : /hybrid/.test(workplace) ? 'hybrid' : /on[ -]?site/.test(workplace) ? 'onsite' : 'unknown',
      publish_time_raw: clean(detail.publish_time_raw ?? detail.publishTime ?? card.publish_time_raw),
      publish_time_desc: clean(detail.publish_time_desc ?? detail.publishTimeDesc ?? card.publish_time_desc),
      repost: Boolean(detail.repost ?? card.repost),
      posted_at: postedAt,
      captured_at: capturedAt,
      timezone: timezone || 'America/Los_Angeles',
      description,
    };
    const filename = `${id}.md`;
    jobs.push({ filename, markdown: markdownForJob(job, runId), job });
    dispositions.push({ jobright_id: id, status: 'captured', posting_key: identity.key, jd_path: `jobs/${filename}` });
  }

  const counts = Object.fromEntries(['captured', 'employer_excluded', 'freshness_excluded', 'failed'].map(status => [status, dispositions.filter(row => row.status === status).length]));
  if (dispositions.length !== byId.size || Object.values(counts).reduce((sum, count) => sum + count, 0) !== byId.size) {
    errors.push(errorDetail('conservation', 'unique Jobright IDs do not have exactly one terminal disposition'));
  }
  if (rawRows - duplicateRows !== byId.size) errors.push(errorDetail('conservation', 'raw_rows - duplicate_rows does not equal unique_list_jobs'));
  const status = errors.length ? 'FAILED' : jobs.length ? 'SUCCESS' : byId.size ? 'EMPTY' : 'EMPTY';
  const summary = {
    schema_version: 1,
    run_id: runId,
    adapter: ADAPTER_ID,
    status,
    raw_rows: rawRows,
    unique_jobs: jobs.length,
    markdown_jobs: jobs.length,
    errors: errors.length,
    error_details: errors,
    ...(fixture?.response_errors?.length ? { retryable: false } : {}),
    captured_at: capturedAt,
    discovery_timezone: timezone || 'America/Los_Angeles',
    max_post_age_hours: config.max_post_age_hours,
    filter_snapshot: {
      landing_url: config.landing_url,
      freshness: clean(actualFilter.freshness),
      sort: clean(actualFilter.sort),
      values: uniqueStrings(actualFilter.values),
      codes: filterCodeSnapshot(actualFilter.codes),
      observed_controls: uniqueStrings(actualFilter.observed_controls),
      matched: filtersMatch,
    },
    list_capture: {
      batch_count: batches.length,
      unique_list_jobs: byId.size,
      duplicate_rows: duplicateRows,
      termination_reason: terminationReason,
      dispositions,
    },
  };
  return {
    summary,
    jobs,
    excludedEmployers: { schema_version: 1, run_id: runId, excluded_count: exclusions.length, results: exclusions },
  };
}

function writeJsonAtomic(file, value) {
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(staged, file);
}

export function writeJobrightArtifacts(sourceRoot, artifacts) {
  const root = path.resolve(sourceRoot);
  if (existsSync(root)) throw new Error(`Jobright source artifacts already exist: ${root}`);
  mkdirSync(path.join(root, 'jobs'), { recursive: true });
  for (const job of artifacts.jobs) writeFileSync(path.join(root, 'jobs', job.filename), job.markdown, { flag: 'wx' });
  writeJsonAtomic(path.join(root, 'excluded-employers.json'), artifacts.excludedEmployers);
  writeJsonAtomic(path.join(root, 'summary.json'), artifacts.summary);
  return artifacts.summary;
}

function requireBrowserHelpers() {
  for (const name of ['useOrCreateTaskSpace', 'openOrReuseTab', 'gotoAndWait', 'waitForLoad', 'wait', 'js', 'pageInfo', 'cdp', 'drainEvents']) {
    if (typeof globalThis[name] !== 'function') throw new Error(`${name} is available only inside ego-browser nodejs`);
  }
}

function controlKey(value) {
  return clean(value).toLowerCase().replace(/\(\s*\+\s*(\d+)\s*\)/g, '(+$1)');
}

async function readVisibleFilterSnapshot(config) {
  const controls = await globalThis.js(String.raw`(() => [...document.querySelectorAll('button, .ant-select-selection-item')]
    .map(control => (control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))()`);
  const observed = uniqueStrings(controls);
  const missing = config.filter_snapshot.visible_controls.filter(expected => !observed.some(actual => controlKey(actual) === controlKey(expected)));
  return {
    freshness: config.filter_snapshot.freshness,
    sort: config.filter_snapshot.sort,
    values: [...config.filter_snapshot.values],
    observed_controls: observed.filter(value => config.filter_snapshot.visible_controls.some(expected => controlKey(value) === controlKey(expected))),
    verified: missing.length === 0,
    missing_controls: missing,
  };
}

function stringLeaves(value) {
  const leaves = [];
  const visit = item => {
    if (typeof item === 'string') { if (clean(item)) leaves.push(item); return; }
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return uniqueStrings(leaves);
}

function markdownList(value) {
  return stringLeaves(value).map(item => `- ${cleanLines(item)}`).join('\n');
}

function descriptionFromJobResult(job) {
  const coreSkills = (Array.isArray(job.jdCoreSkills) ? job.jdCoreSkills : [])
    .map(item => typeof item === 'string' ? item : item?.skill);
  const sections = [
    ['Summary', cleanLines(job.jobSummary)],
    ['Responsibilities', markdownList(job.coreResponsibilities)],
    ['Qualifications', [
      markdownList(job.qualifications?.mustHave),
      markdownList(job.qualifications?.preferredHave),
    ].filter(Boolean).join('\n\n')],
    ['Skills', markdownList(coreSkills)],
    ['Education', markdownList(job.educationSummaries)],
    ['Benefits', markdownList(job.benefitsSummaries)],
    ['Why Join Us', cleanLines(job.whyJoinUs)],
  ];
  return sections.filter(([, body]) => body).map(([heading, body]) => `### ${heading}\n\n${body}`).join('\n\n');
}

function fromNetworkItem(item) {
  const job = item?.jobResult ?? {};
  const id = jobrightId({ id: job.jobId });
  if (!id) return null;
  const locations = stringLeaves([job.jobLocation, job.jobLocations]);
  return {
    jobright_id: id,
    card: { jobright_id: id, publish_time_desc: clean(job.publishTimeDesc), repost: Boolean(job.repost) },
    detail: {
      jobright_id: id,
      company: clean(item?.companyResult?.companyName),
      title: clean(job.jobTitle),
      location: locations.join('; '),
      employment_type: clean(job.employmentType),
      workplace_type: job.isRemote === true ? 'remote' : clean(job.workModel),
      publish_time_raw: clean(job.publishTime),
      publish_time_desc: clean(job.publishTimeDesc),
      repost: Boolean(job.repost),
      original_url: clean(job.originalUrl),
      apply_link: clean(job.applyLink),
      description: descriptionFromJobResult(job),
    },
  };
}

export async function drainJobrightBatches(responseCounts = { jobs: 0, filter: 0 }) {
  const batches = [];
  const errors = [];
  let filterCodes = null;
  for (const event of await globalThis.drainEvents()) {
    if ((event.method || event.type) !== 'Network.responseReceived') continue;
    const params = event.params || event;
    const url = params.response?.url || '';
    const isJobs = url.includes('/swan/recommend/list/jobs');
    const isFilter = url.includes('/swan/filter/get/filter');
    if (!isJobs && !isFilter) continue;
    const endpoint = isJobs ? 'jobs' : 'filter';
    const batch_index = ++responseCounts[endpoint];
    const http_status = Number.isInteger(params.response?.status) ? params.response.status : null;
    let payload;
    const fail = (classification, message) => {
      const fields = value => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)).sort().slice(0, 40) : [];
      const application_codes = {};
      for (const key of ['code', 'errorCode', 'statusCode']) {
        const value = payload?.[key];
        if ((Number.isInteger(value) && Math.abs(value) <= 999999999)
          || (typeof value === 'string' && /^(?:-?\d{1,9}|UNAUTHORIZED|FORBIDDEN|RATE_LIMITED|TOO_MANY_REQUESTS|ERROR|SUCCESS)$/.test(value))) application_codes[key] = value;
      }
      errors.push({ stage: 'response', endpoint, batch_index, http_status,
        body_available: classification !== 'body_unavailable',
        classification: http_status === 401 || http_status === 403 ? 'authentication' : http_status === 429 ? 'rate_limit' : classification,
        message, application_codes, top_level_fields: fields(payload), result_fields: fields(payload?.result) });
    };
    let response;
    try { response = await globalThis.cdp('Network.getResponseBody', { requestId: params.requestId }); }
    catch {
      await globalThis.wait(0.5);
      try { response = await globalThis.cdp('Network.getResponseBody', { requestId: params.requestId }); }
      catch { fail('body_unavailable', 'response body unavailable'); continue; }
    }
    try {
      const text = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      payload = JSON.parse(text);
      if (http_status === null || http_status < 200 || http_status >= 300) {
        fail('http_error', 'Jobright response has unsuccessful HTTP status'); continue;
      }
      if (['UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'ERROR'].includes(payload?.errorCode)
        || ['UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'ERROR'].includes(payload?.code)) {
        fail('application_error', 'Jobright response contains an application error'); continue;
      }
      if (isFilter) {
        const observed = payload?.result;
        if (!observed || typeof observed !== 'object' || Array.isArray(observed)) fail('unknown_structure', 'Jobright filter response has no result object');
        else if (filterCodes && !filterCodesMatch(filterCodes, observed)) fail('filter_changed', 'Jobright filters changed during traversal');
        else filterCodes = observed;
        continue;
      }
      const list = payload?.result?.jobList;
      if (!Array.isArray(list)) { fail('unknown_structure', 'Jobright list response has no result.jobList array'); continue; }
      const parsed = list.map(fromNetworkItem).filter(Boolean);
      if (parsed.length !== list.length) fail('invalid_job_id', `${list.length - parsed.length} Jobright list item(s) lacked a stable 24-character jobId`);
      batches.push(parsed);
    } catch { fail('invalid_response', 'invalid Jobright response'); }
  }
  return { batches, errors, filterCodes };
}

async function scrollJobrightFeed() {
  return await globalThis.js(String.raw`(() => {
    const scroller = document.querySelector('#jobs-page-main-content')
    if (!scroller) return { found: false, height: 0, at_bottom: false }
    const height = scroller.scrollHeight
    scroller.scrollTop = height
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    return { found: true, height, at_bottom: height - scroller.clientHeight - scroller.scrollTop <= 2 }
  })()`);
}

async function jobrightFeedState() {
  return await globalThis.js(String.raw`(() => {
    const scroller = document.querySelector('#jobs-page-main-content')
    if (!scroller) return { found: false, height: 0, at_bottom: false }
    return { found: true, height: scroller.scrollHeight, at_bottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2 }
  })()`);
}

/** Runs only inside ego-browser's Node runtime; it never calls Jobright's private /swan endpoints. */
export async function collectJobrightRecommendations({ config, runId }) {
  requireBrowserHelpers();
  const taskSpaceName = `jobright recommendations ${runId}`;
  await globalThis.useOrCreateTaskSpace(taskSpaceName);
  // Capture one navigation: reloading a loaded feed leaves events whose bodies CDP discarded.
  await globalThis.openOrReuseTab('about:blank', { wait: true, timeout: 30 });
  await globalThis.cdp('Network.enable');
  await globalThis.drainEvents();
  await globalThis.gotoAndWait(config.landing_url, { timeout: 30, settle: 2 });
  await globalThis.waitForLoad({ timeout: 20 }).catch(() => {});
  await globalThis.wait(2);
  const info = await globalThis.pageInfo();
  const pageText = clean(await globalThis.js(`(document.body?.innerText || '').slice(0, 4000)`));
  if (info?.url !== config.landing_url || /captcha|verify you are human|sign in|log in/i.test(`${info?.title || ''} ${pageText}`)) {
    throw new Error(`Jobright login/challenge check failed at ${info?.url || 'unknown URL'}`);
  }
  const filterSnapshot = await readVisibleFilterSnapshot(config);
  if (!filterSnapshot.verified) {
    return { filter_snapshot: filterSnapshot, batches: [], details: {}, termination_reason: 'filter_mismatch', source_errors: [`missing filter controls: ${filterSnapshot.missing_controls.join(', ')}`] };
  }

  const batches = [];
  const details = {};
  const sourceErrors = [];
  const responseErrors = [];
  const responseCounts = { jobs: 0, filter: 0 };
  let responseCount = 0;
  let filterCodes = null;
  let stalls = 0;
  let priorHeight = 0;
  let terminationReason = 'max_scroll_steps';
  for (let step = 0; step < config.traversal.max_scroll_steps; step += 1) {
    await globalThis.wait(config.traversal.settle_seconds);
    const observed = await drainJobrightBatches(responseCounts);
    responseErrors.push(...observed.errors);
    if (observed.filterCodes) filterCodes = observed.filterCodes;
    for (const batch of observed.batches) {
      responseCount += 1;
      batches.push(batch.map(item => item.card));
      for (const item of batch) details[item.jobright_id] = item.detail;
      if (batch.length < config.traversal.page_size) { terminationReason = 'short_batch'; break; }
    }
    if (observed.errors.length) { terminationReason = 'response_error'; break; }
    if (terminationReason === 'short_batch') break;
    const scroll = await scrollJobrightFeed();
    await globalThis.wait(config.traversal.settle_seconds);
    const state = await jobrightFeedState();
    const noBatch = observed.batches.length === 0;
    stalls = noBatch && scroll.found && state.at_bottom && state.height === scroll.height && state.height === priorHeight ? stalls + 1 : 0;
    priorHeight = state.height;
    if (stalls >= config.traversal.stable_observations) { terminationReason = 'stable_bottom'; break; }
  }
  if (!responseCount) sourceErrors.push('no UI-triggered Jobright list response was captured');
  filterSnapshot.codes = filterCodeSnapshot(filterCodes || {});
  if (!filterCodes) sourceErrors.push('no UI-triggered Jobright filter response was captured');
  else if (!filterCodesMatch(config.filter_snapshot.codes, filterCodes)) sourceErrors.push('observed filter codes do not match the accepted snapshot');
  filterSnapshot.verified = filterSnapshot.verified && Boolean(filterCodes) && filterCodesMatch(config.filter_snapshot.codes, filterCodes);
  return { filter_snapshot: filterSnapshot, batches, details, termination_reason: terminationReason, source_errors: sourceErrors, response_errors: responseErrors };
}

function browserProgram(payload) {
  return `import { pathToFileURL } from 'node:url'\nconst payload = JSON.parse(${JSON.stringify(JSON.stringify(payload))})\nconst mod = await import(pathToFileURL(payload.adapter_file).href)\nconst config = mod.loadJobrightConfig(payload.config_file)\nlet fixture\ntry { fixture = await mod.collectJobrightRecommendations({ config, runId: payload.run_id }) }\ncatch (error) { fixture = { filter_snapshot: { ...config.filter_snapshot, verified: false }, batches: [], details: {}, termination_reason: 'failed', source_errors: [error.message] } }\nconst artifacts = mod.buildJobrightArtifacts({ runId: payload.run_id, config, fixture, capturedAt: payload.captured_at, timezone: payload.timezone })\nmod.writeJobrightArtifacts(payload.source_root, artifacts)\ncliLog('JOBRIGHT_ARTIFACTS_WRITTEN=' + artifacts.summary.status)\nif (artifacts.summary.status === 'FAILED') process.exitCode = 1\n`;
}

function cleanupProgram(taskSpaceName) {
  return `const taskSpaceName = ${JSON.stringify(taskSpaceName)}\nconst result = await completeTaskSpace(taskSpaceName, { keep: false })\nif (!result?.done) throw new Error('Task space cleanup skipped: ' + JSON.stringify(result))\ncliLog('JOBRIGHT_TASK_SPACE_CLOSED=' + taskSpaceName)\n`;
}

export async function runJobrightRecommendations({
  discoveryRoot = PROJECT_ROOT,
  runId,
  configFile = DEFAULT_JOBRIGHT_CONFIG,
  fixtureFile,
  capturedAt = new Date().toISOString(),
  timezone,
} = {}) {
  const config = loadJobrightConfig(configFile);
  const root = path.resolve(discoveryRoot);
  const sourceRoot = path.join(root, 'runs', runId, 'sources', ADAPTER_ID);
  if (existsSync(sourceRoot)) throw new Error(`Jobright source artifacts already exist: ${sourceRoot}`);
  if (fixtureFile) {
    const artifacts = buildJobrightArtifacts({ runId, config, fixture: json(path.resolve(fixtureFile)), capturedAt, timezone: timezone || config.timezone });
    writeJobrightArtifacts(sourceRoot, artifacts);
    return artifacts.summary;
  }
  const taskSpaceName = `jobright recommendations ${runId}`;
  const payload = {
    adapter_file: fileURLToPath(import.meta.url),
    config_file: path.resolve(configFile),
    run_id: runId,
    captured_at: capturedAt,
    timezone: timezone || config.timezone,
    source_root: sourceRoot,
  };
  const result = spawnSync('ego-browser', ['nodejs'], { input: browserProgram(payload), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const cleanup = spawnSync('ego-browser', ['nodejs'], { input: cleanupProgram(taskSpaceName), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (cleanup.stdout) process.stdout.write(cleanup.stdout);
  if (cleanup.stderr) process.stderr.write(cleanup.stderr);
  if (cleanup.status !== 0) throw new Error(cleanup.error?.message || `ego-browser task-space cleanup exited ${cleanup.status}`);
  if (!existsSync(path.join(sourceRoot, 'summary.json'))) throw new Error(result.error?.message || `ego-browser exited ${result.status}`);
  return json(path.join(sourceRoot, 'summary.json'));
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const runId = arg('--run-id');
  if (!runId) throw new Error('Usage: node adapters/jobright_recommendations_scan.mjs --run-id ID [--fixture fixture.json] [--discovery-root PATH] [--config config/jobright.json]');
  const configFile = arg('--config') || DEFAULT_JOBRIGHT_CONFIG;
  if (process.argv.includes('--dry-run')) {
    const config = loadJobrightConfig(configFile);
    console.log(JSON.stringify({ run_id: runId, config: config.file, landing_url: config.landing_url, filter_snapshot: config.filter_snapshot }, null, 2));
    return 0;
  }
  const summary = await runJobrightRecommendations({
    discoveryRoot: arg('--discovery-root') || PROJECT_ROOT,
    runId,
    configFile,
    fixtureFile: arg('--fixture'),
    capturedAt: arg('--captured-at') || new Date().toISOString(),
    timezone: arg('--timezone'),
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary.status === 'FAILED' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
