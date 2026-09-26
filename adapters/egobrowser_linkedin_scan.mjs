#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function timestamp() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function loadOptions(args) {
  const options = { discovery_root: PROJECT_ROOT, config: path.join(PROJECT_ROOT, 'config/jobspy-ego.json'), run_id: timestamp() };
  const flags = { '--discovery-root': 'discovery_root', '--config': 'config', '--run-id': 'run_id' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--dry-run') options.dry_run = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (Object.hasOwn(flags, flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      options[flags[flag]] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function loadConfig(options) {
  const config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  const sources = [config.direct_search, config.top_applicant_recommendations];
  for (const [index, name] of ['direct_search', 'top_applicant_recommendations'].entries()) {
    const source = sources[index];
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${name} must be an object`);
    for (const flag of ['enabled', 'required']) {
      if (typeof source[flag] !== 'boolean') throw new Error(`${name}.${flag} must be boolean`);
    }
    if (!source.enabled && source.required) throw new Error(`${name} cannot be required when disabled`);
  }
  if (!sources.some(source => source.enabled)) throw new Error('at least one LinkedIn source must be enabled');
  if (config.direct_search.enabled && (!Array.isArray(config.queries) || !config.queries.length
      || !config.queries.every(query => typeof query === 'string' && query.trim()))) {
    throw new Error('direct_search requires non-empty queries');
  }
  const recommendations = config.top_applicant_recommendations;
  if (recommendations.enabled) {
    for (const key of ['landing_url', 'section_heading', 'show_all_aria_label', 'date_posted_filter']) {
      if (typeof recommendations[key] !== 'string' || !recommendations[key].trim()) throw new Error(`top_applicant_recommendations missing: ${key}`);
    }
    if (recommendations.date_posted_filter !== 'Past 24 hours' || config.max_post_age_hours !== 24) {
      throw new Error('top_applicant_recommendations requires Past 24 hours and max_post_age_hours=24');
    }
  }
  for (const key of ['results_wanted', 'max_post_age_hours']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`config ${key} must be a positive integer`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.run_id)) throw new Error('--run-id may contain only letters, digits, dots, underscores, and hyphens');
  if (!fs.statSync(options.discovery_root).isDirectory()) throw new Error(`Job Discovery root does not exist: ${options.discovery_root}`);
  if (typeof config.location !== 'string' || !config.location.trim()) throw new Error('config location must be a non-empty string');
  if (!Array.isArray(config.employer_exclusions)) throw new Error('config employer_exclusions must be an array');
  return { ...config, queries: config.queries ?? [], discovery_root: fs.realpathSync(options.discovery_root), run_id: options.run_id };
}

function runBrowser(input) {
  const result = spawnSync('ego-browser', ['nodejs'], { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

function main() {
  const options = loadOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node adapters/egobrowser_linkedin_scan.mjs [--discovery-root PATH] [--config PATH] [--run-id ID] [--dry-run] [-h|--help]');
    return 0;
  }
  const config = loadConfig(options);
  if (options.dry_run) {
    console.log(JSON.stringify({ discovery_root: config.discovery_root, config: options.config, run_id: config.run_id,
      location: config.location, results_wanted: config.results_wanted, hours_old: config.max_post_age_hours,
      direct_search: config.direct_search, top_applicant_recommendations: config.top_applicant_recommendations,
      queries: config.queries, employer_exclusions: config.employer_exclusions }, null, 2));
    return 0;
  }
  const runDir = path.join(config.discovery_root, 'runs', config.run_id, 'sources/ego-browser');
  if (fs.existsSync(runDir)) {
    let priorStatus;
    try { priorStatus = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')).status; } catch {}
    if (String(priorStatus).toUpperCase() === 'SUCCESS') throw new Error(`Successful ego-browser artifacts already exist for run ${config.run_id}`);
    const attemptsDir = path.join(config.discovery_root, 'runs', config.run_id, 'adapter-attempts');
    fs.mkdirSync(attemptsDir, { recursive: true });
    fs.renameSync(runDir, path.join(attemptsDir, `ego-browser-${timestamp()}-${process.pid}`));
  }
  let status;
  let cleanupStatus;
  try {
    status = runBrowser(`const { collectLinkedIn } = await import(${JSON.stringify(import.meta.url)})\nawait collectLinkedIn(${JSON.stringify(config)})\n`);
    if (!fs.existsSync(path.join(runDir, 'summary.json'))) {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ schema_version: 1, run_id: config.run_id, adapter: 'ego-browser', status: 'FAILED', raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, errors: 1 }, null, 2) + '\n');
      fs.writeFileSync(path.join(runDir, 'excluded-employers.json'), JSON.stringify({ schema_version: 1, run_id: config.run_id, excluded_count: 0, results: [] }, null, 2) + '\n');
      status ||= 1;
    }
  } finally {
    const taskSpaceName = `career-ops linkedin ego scan ${config.run_id}`;
    cleanupStatus = runBrowser(`const taskSpaceName = ${JSON.stringify(taskSpaceName)}\nconst result = await completeTaskSpace(taskSpaceName, { keep: false })\nif (!result?.done) throw new Error('Task space cleanup was skipped: ' + JSON.stringify(result))\ncliLog('TASK_SPACE_CLOSED=' + taskSpaceName)\n`);
    if (cleanupStatus) console.error(`LinkedIn adapter task space cleanup failed for run ${config.run_id}`);
  }
  return status || cleanupStatus;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}

// Runs inside ego-browser's Node runtime, which supplies the browser helpers.
export async function collectLinkedIn(config) {
const discoveryRoot = config.discovery_root
const runId = config.run_id
const locationText = config.location
const resultsWanted = Number(config.results_wanted || 50)
const hoursOld = Number(config.max_post_age_hours)
const directSearch = config.direct_search
const topApplicantRecommendations = config.top_applicant_recommendations
const queries = config.queries || []
const employerExclusions = config.employer_exclusions || []
const { matchExcludedEmployer } = await import(pathToFileURL(path.join(discoveryRoot, 'src/employer-exclusions.mjs')).href)

function sourceError(code, message, retryable = false) {
  const error = new Error(message)
  error.failureCode = code
  error.retryable = retryable
  return error
}

function failureFrom(error, fallbackCode = 'NAVIGATION_FAILED') {
  const message = error?.message || String(error)
  if (error?.failureCode) return { code: error.failureCode, retryable: error.retryable === true, message }
  if (/\b(?:403|429|captcha|checkpoint|challenge|sign[ -]?in)\b/i.test(message)) {
    return { code: 'ACCESS_LIMITED', retryable: false, message }
  }
  const retryable = /\b(?:timeout|timed out|network|navigation|ERR_[A-Z_]+)\b/i.test(message)
  return { code: fallbackCode, retryable, message }
}

function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim()
}

function slug(value, maxLen = 90) {
  const text = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (text.slice(0, maxLen).replace(/-+$/g, '') || 'unknown')
}

function dateFromMs(value) {
  const ms = Number(value || 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toISOString().slice(0, 10)
}

function workplaceType(values) {
  const normalized = (Array.isArray(values) ? values : [values])
    .map(value => clean(value).toLowerCase())
    .filter(Boolean)
    .map(value => {
      if (/remote/.test(value) || /:2$/.test(value)) return 'remote'
      if (/hybrid/.test(value) || /:3$/.test(value)) return 'hybrid'
      if (/on[ -]?site/.test(value) || /:1$/.test(value)) return 'onsite'
      return 'unknown'
    })
    .filter(value => value !== 'unknown')
  const unique = [...new Set(normalized)]
  return unique.length === 1 ? unique[0] : unique.length > 1 ? 'conflict' : 'unknown'
}

function formatDescription(value, attributes = []) {
  const listStarts = new Set(
    attributes
      .filter(attribute => attribute?.attributeKindUnion?.listItem || attribute?.type?.$type === 'com.linkedin.pemberly.text.ListItem')
      .map(attribute => Number(attribute.start))
      .filter(Number.isFinite)
  )
  const text = clean(value)
  let formatted = ''
  for (let index = 0; index < text.length; index++) {
    if (listStarts.has(index)) {
      if (formatted && !formatted.endsWith('\n')) formatted += '\n'
      formatted += '* '
    }
    formatted += text[index]
  }
  return formatted
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function markdownForJob(job) {
  const filename = `linkedin-${job.jobId}-${slug(job.company, 35)}-${slug(job.title, 70)}.md`
  const directUrl = job.applyUrl || ''
  const markdown = `# ${job.company} - ${job.title}

**URL:** ${job.url}
**LinkedIn Job ID:** ${job.jobId}
**Company:** ${job.company}
**Role:** ${job.title}
**Location:** ${job.location}
**Employment Type:** ${job.employmentType || 'unknown'}
**Employment Type Source:** linkedin-api:formattedEmploymentStatus
**Workplace Type:** ${job.workplaceType}
**Workplace Type Source:** linkedin-api:workplaceTypes
**Structured Remote Signal:** ${job.workplaceType === 'remote'}
**Posted:** ${job.posted}
**Card Posted Label:** ${job.cardPostedLabel || ''}
**LinkedIn Listed At Ms:** ${job.listedAtMs || ''}
**LinkedIn Original Listed At Ms:** ${job.originalListedAtMs || ''}
**Source:** LinkedIn
**Search Query:** ${job.query}
**Direct Job URL:** ${directUrl}
**Discovery Run:** ${runId}

## Job Description

${job.description}
`
  return { filename, markdown }
}

function searchUrl(query, start = 0) {
  const params = new URLSearchParams({
    keywords: query,
    location: locationText,
    f_TPR: `r${Math.max(3600, hoursOld * 3600)}`,
    sortBy: 'DD',
    start: String(start),
  })
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`
}

async function readCardsFromSearchPage() {
  return await js(String.raw`(() => {
    const cards = []
    const componentCards = [...document.querySelectorAll('[componentkey^="job-card-component-ref-"]')]
    for (const root of componentCards) {
      const id = root.getAttribute('componentkey')?.match(/^job-card-component-ref-(\d+)$/)?.[1]
      if (!id) continue
      const lines = (root.innerText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      const title = (lines[0] || '')
        .replace(/^Selected,\s*/i, '')
        .replace(/\s+\(Verified job\)$/i, '')
        .trim()
      if (!title) continue
      const duplicateTitle = (lines[1] || '').replace(/\s+\(Verified job\)$/i, '').trim() === title
      const companyIndex = duplicateTitle ? 2 : 1
      cards.push({
        jobId: id,
        url: 'https://www.linkedin.com/jobs/view/' + id,
        title,
        company: lines[companyIndex] || '',
        location: lines[companyIndex + 1] || '',
        posted: lines.find(line => /\b(ago|Within the past|Reposted|Promoted|Viewed)\b/i.test(line)) || '',
        cardText: lines.join(' | ').slice(0, 600),
      })
    }

    const anchors = [...document.querySelectorAll('a[href*="/jobs/view/"]')]
    for (const a of anchors) {
      const href = a.href || ''
      const id = href.match(/\/jobs\/view\/(\d+)/)?.[1]
      if (!id) continue
      const root = a.closest('li') || a.closest('[data-job-id]') || a.parentElement
      const lines = (root?.innerText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      const rawTitle = (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+with verification$/i, '').trim()
      if (!rawTitle) continue
      const titleIndex = lines.findIndex(line => line === rawTitle)
      const company = titleIndex >= 0 ? (lines[titleIndex + 1] || '') : (lines[1] || '')
      const location = lines.find(line => /\b(Remote|Hybrid|On-site|WA|United States|Seattle|Bellevue|Redmond)\b/i.test(line)) || ''
      const posted = lines.find(line => /\b(ago|Within the past|Reposted|Promoted|Viewed)\b/i.test(line)) || ''
      cards.push({
        jobId: id,
        url: 'https://www.linkedin.com/jobs/view/' + id,
        title: rawTitle,
        company,
        location,
        posted,
        cardText: lines.join(' | ').slice(0, 600),
      })
    }
    const seen = new Set()
    return cards.filter(card => {
      if (seen.has(card.jobId)) return false
      seen.add(card.jobId)
      return true
    })
  })()`)
}

async function scrollSearchResultsList(step = 700) {
  return await js(String.raw`(() => {
    const anchor = document.querySelector('[componentkey^="job-card-component-ref-"]')
      || document.querySelector('a[href*="/jobs/view/"]')
    let element = anchor
    while (element) {
      if (element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 250) {
        const before = element.scrollTop
        const max = element.scrollHeight - element.clientHeight
        element.scrollTop = Math.min(before + ${step}, element.scrollHeight)
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        return { before, after: element.scrollTop, max, moved: element.scrollTop > before }
      }
      element = element.parentElement
    }
    return { before: 0, after: 0, max: 0, moved: false }
  })()`)
}

async function resetSearchResultsList() {
  return await js(String.raw`(() => {
    const anchor = document.querySelector('[componentkey^="job-card-component-ref-"]')
      || document.querySelector('a[href*="/jobs/view/"]')
    let element = anchor
    while (element) {
      if (element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 250) {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        return true
      }
      element = element.parentElement
    }
    return false
  })()`)
}

async function fetchJobPosting(jobId) {
  return await js(`(async () => {
    const token = document.cookie
      .split('; ')
      .find(part => part.startsWith('JSESSIONID='))
      ?.split('=')[1]
      ?.replace(/^"|"$/g, '') || ''
    const res = await fetch('/voyager/api/jobs/jobPostings/${jobId}', {
      credentials: 'include',
      headers: {
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        'csrf-token': token,
        'x-restli-protocol-version': '2.0.0',
      },
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 500) }
    const json = JSON.parse(text)
    const data = json.data || {}
    return {
      ok: true,
      title: data.title || '',
      location: data.formattedLocation || '',
      listedAtMs: data.listedAt || 0,
      originalListedAtMs: data.originalListedAt || 0,
      description: data.description?.text || '',
      descriptionAttributes: data.description?.attributes || [],
      company: (() => {
        const companyUrn = data.companyDetails?.company || data.companyDetails?.companyResolutionResult?.entityUrn || ''
        const entity = (json.included || []).find(item => item?.entityUrn === companyUrn)
        return entity?.name || data.companyDetails?.companyResolutionResult?.name || ''
      })(),
      applyUrl: data.applyMethod?.companyApplyUrl || '',
      workplaceTypes: data.workplaceTypes || [],
      formattedEmploymentStatus: data.formattedEmploymentStatus || '',
      formattedExperienceLevel: data.formattedExperienceLevel || '',
    }
  })()`)
}

function topApplicantRecommendationPageUrl(showAllUrl, start = 0) {
  const url = new URL(showAllUrl)
  url.searchParams.set('f_TPR', `r${hoursOld * 3600}`)
  url.searchParams.set('start', String(start))
  return url.toString()
}

function isWithinMaxPostAge(postedAtMs) {
  const value = Number(postedAtMs || 0)
  if (!Number.isFinite(value) || value <= 0) return false
  const ageMs = Date.now() - value
  return ageMs >= -300000 && ageMs <= hoursOld * 60 * 60 * 1000
}

async function openResultsPage(url) {
  if (!searchTabReady) {
    await openOrReuseTab(url, { wait: true, timeout: 30 })
    searchTabReady = true
  } else {
    await gotoAndWait(url, { timeout: 30, settle: 2 })
  }
  await waitForLoad({ timeout: 20 }).catch(() => {})
  await wait(2)
}

async function pageHealth() {
  return await js(String.raw`(() => {
    const text = String(document.body?.innerText || '')
    const prefix = text.slice(0, 1200)
    return {
      page_url: location.href,
      page_title: document.title,
      login_form: Boolean(document.querySelector('input[name="session_key"], form[action*="login"]')),
      auth_path: /linkedin\.com\/(?:authwall|login|uas)(?:[/?#]|$)/i.test(location.href),
      login_text: /^\s*(?:sign in|log in)\b/im.test(prefix),
      challenge: /checkpoint|challenge|verify/i.test(location.href + ' ' + document.title + ' ' + prefix),
    }
  })()`)
}

async function requireHealthyPage(label) {
  const health = await pageHealth()
  if (health.login_form || health.auth_path || health.login_text || health.challenge) {
    throw sourceError('AUTH_OR_CHALLENGE', `${label}: LinkedIn authentication or challenge page detected`, false)
  }
  return health
}

async function findTopApplicantShowAllUrl(stat) {
  await openResultsPage(topApplicantRecommendations.landing_url)
  const ariaLabel = String(topApplicantRecommendations.show_all_aria_label)
  const sectionHeading = String(topApplicantRecommendations.section_heading)
  let health = await requireHealthyPage(sectionHeading)
  const discoveryStarted = Date.now()
  let result
  let discoveryAttempts = 0
  // LinkedIn renders this module after the document load event. Wait for its
  // exact scoped link; never substitute the earlier preferences "Show all".
  for (; discoveryAttempts < 11; discoveryAttempts++) {
    result = await js(`(() => {
    const ariaLabel = ${JSON.stringify(String(topApplicantRecommendations.show_all_aria_label))}
    const sectionHeading = ${JSON.stringify(String(topApplicantRecommendations.section_heading))}
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    const visible = node => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length))
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible)
    const expected = headings.filter(node => normalize(node.innerText) === normalize(sectionHeading))
    let scopedLinks = []
    if (expected.length === 1) {
      let container = expected[0].parentElement
      for (let depth = 0; depth < 7 && container; depth++, container = container.parentElement) {
        const containerHeadings = [...container.querySelectorAll('h1,h2,h3')].filter(visible)
        if (containerHeadings.length !== 1 || normalize(containerHeadings[0].innerText) !== normalize(sectionHeading)) break
        const links = [...container.querySelectorAll('a')].filter(visible)
        scopedLinks = links.filter(link => normalize(link.getAttribute('aria-label')) === normalize(ariaLabel))
        if (scopedLinks.length) break
      }
    }
    const allLinks = [...document.querySelectorAll('a')].filter(visible)
    const showAllCandidates = allLinks
      .filter(link => /show all/i.test((link.innerText || '') + ' ' + (link.getAttribute('aria-label') || '')))
      .slice(0, 10)
      .map(link => {
        let pathname = ''
        try { pathname = new URL(link.href).pathname } catch {}
        return { text: String(link.innerText || '').trim(), aria_label: String(link.getAttribute('aria-label') || '').trim(), pathname }
      })
    const bodyPrefix = String(document.body?.innerText || '').slice(0, 1200)
    return {
      href: scopedLinks.length === 1 ? scopedLinks[0].href : '',
      diagnostic: {
        page_url: location.href,
        page_title: document.title,
        login_form: Boolean(document.querySelector('input[name="session_key"], form[action*="login"]')),
        challenge: /checkpoint|challenge|verify/i.test(location.href + ' ' + document.title + ' ' + bodyPrefix),
        expected_heading_count: expected.length,
        exact_aria_link_count: allLinks.filter(link => normalize(link.getAttribute('aria-label')) === normalize(ariaLabel)).length,
        scoped_show_all_count: scopedLinks.length,
        candidate_headings: headings.map(node => String(node.innerText || '').trim()).filter(Boolean).slice(0, 10),
        candidate_show_all_links: showAllCandidates,
      },
    }
  })()`)
    if (result.href || result.diagnostic.expected_heading_count > 1
        || result.diagnostic.scoped_show_all_count > 1
        || result.diagnostic.login_form || result.diagnostic.challenge) break
    if (discoveryAttempts < 10) await wait(2)
  }
  health = await requireHealthyPage(sectionHeading)
  stat.diagnostic = {
    ...result.diagnostic,
    ...health,
    discovery_attempts: Math.min(discoveryAttempts + 1, 11),
    discovery_wait_ms: Date.now() - discoveryStarted,
    requested_filter: topApplicantRecommendations.date_posted_filter,
    effective_filter: null,
    filter_visible: false,
  }
  if (stat.diagnostic.login_form || stat.diagnostic.auth_path || stat.diagnostic.login_text || stat.diagnostic.challenge) {
    throw sourceError('AUTH_OR_CHALLENGE', `${sectionHeading}: LinkedIn authentication or challenge page detected`, false)
  }
  if (stat.diagnostic.expected_heading_count === 0) {
    throw sourceError('MODULE_ABSENT', `${sectionHeading}: configured recommendation module was not found`, false)
  }
  if (stat.diagnostic.expected_heading_count !== 1 || stat.diagnostic.scoped_show_all_count > 1) {
    throw sourceError('SELECTOR_AMBIGUOUS', `${sectionHeading}: recommendation module or Show all link was ambiguous`, false)
  }
  if (!result.href) {
    throw sourceError('SELECTOR_DRIFT', `${sectionHeading}: scoped Show all link was not found`, false)
  }
  const target = new URL(result.href)
  if (target.origin !== 'https://www.linkedin.com' || target.pathname !== '/jobs/search-results/') {
    throw sourceError('UNEXPECTED_DESTINATION', `${ariaLabel}: unexpected LinkedIn destination ${target.origin}${target.pathname}`, false)
  }
  return target.toString()
}

async function verifyTopApplicantFilter(stat) {
  const health = await requireHealthyPage('top applicant recommendations')
  const filter = await js(`(() => {
    const expected = ${JSON.stringify(String(topApplicantRecommendations.date_posted_filter))}
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    const visible = node => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length))
    const activeControls = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter(node => normalize(node.innerText) === normalize(expected))
    return {
      effective_filter: new URL(location.href).searchParams.get('f_TPR'),
      active_filter_control_count: activeControls.length,
      filter_visible: activeControls.length === 1,
    }
  })()`)
  Object.assign(stat.diagnostic, {
    effective_url: health.page_url,
    page_title: health.page_title,
    effective_filter: filter.effective_filter,
    active_filter_control_count: filter.active_filter_control_count,
    filter_visible: filter.filter_visible,
  })
  const effective = new URL(health.page_url)
  const expectedFilter = `r${hoursOld * 3600}`
  if (effective.origin !== 'https://www.linkedin.com' || effective.pathname !== '/jobs/search-results/'
      || filter.effective_filter !== expectedFilter || !filter.filter_visible) {
    throw sourceError('FILTER_NOT_APPLIED', `top applicant recommendations: ${topApplicantRecommendations.date_posted_filter} was not applied`, false)
  }
}

async function collectResultCards(pageUrl, limit, label, stat, verifyPage = null) {
  const cards = new Map()
  for (let pageStart = 0; pageStart < limit; pageStart += 25) {
    await openResultsPage(pageUrl(pageStart))
    if (verifyPage) await verifyPage(pageStart)
    await resetSearchResultsList()
    await wait(1)

    const pageCards = new Map()
    let stalled = 0
    for (let step = 0; step < 10; step++) {
      const visibleCards = await readCardsFromSearchPage()
      const before = pageCards.size
      for (const card of visibleCards) pageCards.set(card.jobId, card)
      stalled = pageCards.size === before ? stalled + 1 : 0
      if (cards.size + pageCards.size >= limit) break
      const scrollState = await scrollSearchResultsList()
      if (!scrollState.moved && stalled >= 1) break
      await wait(1)
    }

    for (const [jobId, card] of pageCards) cards.set(jobId, card)
    stat.pageRows.push(pageCards.size)
    cliLog(`${label} page start ${pageStart}: captured ${pageCards.size}, total ${cards.size}`)
    if (cards.size >= limit) break
  }
  return [...cards.values()].slice(0, limit)
}

function newCaptureStat(fields = {}) {
  return {
    ...fields,
    rawRows: 0,
    pageRows: [],
    newJobs: 0,
    alreadyHandled: 0,
    excluded: 0,
    stale: 0,
    skipped: 0,
    status: 'PENDING',
    failure: null,
    _usableIds: new Set(),
  }
}

function bump(stats, field) {
  for (const stat of new Set(stats)) stat[field] += 1
}

function markUsable(stats, jobId) {
  for (const stat of new Set(stats)) stat._usableIds.add(jobId)
}

async function captureCards(cards, stats, discoveryLabel, enforceFreshness = true) {
  const statList = Array.isArray(stats) ? stats : [stats]
  for (const card of cards) {
    let detail = detailCache.get(card.jobId)
    try {
      if (!detail) detail = await fetchJobPosting(card.jobId)
    } catch (error) {
      skipped.push({ jobId: card.jobId, title: card.title, company: card.company, reason: `detail fetch failed: ${error.message}` })
      bump(statList, 'skipped')
      continue
    }

    if (!detail?.ok) {
      skipped.push({ jobId: card.jobId, title: card.title, company: card.company, reason: `detail API HTTP ${detail?.status || 'unknown'}` })
      bump(statList, 'skipped')
      if ([401, 403, 429, 999].includes(Number(detail?.status))) {
        throw sourceError('ACCESS_LIMITED', `LinkedIn detail API HTTP ${detail.status}`, false)
      }
      continue
    }
    detailCache.set(card.jobId, detail)
    if (enforceFreshness && !isWithinMaxPostAge(detail.listedAtMs)) {
      skipped.push({ jobId: card.jobId, title: card.title, company: card.company, reason: `outside configured ${hoursOld}-hour window by LinkedIn listedAt` })
      handledIds.add(card.jobId)
      bump(statList, 'stale')
      bump(statList, 'skipped')
      continue
    }

    const description = formatDescription(detail.description, detail.descriptionAttributes)
    if (description.length < 400) {
      skipped.push({ jobId: card.jobId, title: card.title, company: card.company, reason: `missing/short description (${description.length} chars)` })
      bump(statList, 'skipped')
      continue
    }

    const job = {
      jobId: card.jobId,
      url: card.url,
      company: clean(detail.company || card.company) || 'Unknown',
      title: clean(detail.title || card.title),
      location: clean(detail.location || card.location),
      employmentType: clean(detail.formattedEmploymentStatus),
      workplaceType: workplaceType(detail.workplaceTypes),
      posted: dateFromMs(detail.listedAtMs) || dateFromMs(detail.originalListedAtMs) || clean(card.posted),
      cardPostedLabel: clean(card.posted) || null,
      listedAtMs: Number(detail.listedAtMs) || null,
      originalListedAtMs: Number(detail.originalListedAtMs) || null,
      applyUrl: clean(detail.applyUrl),
      query: discoveryLabel,
      description,
    }
    const exclusion = matchExcludedEmployer({ company: job.company, description: job.description }, employerExclusions)
    if (exclusion) {
      if (!excludedIds.has(card.jobId)) {
        excluded.push({
          jobId: card.jobId,
          title: job.title,
          company: job.company,
          reason: exclusion.reason,
          matchedSource: exclusion.source,
          evidence: exclusion.evidence,
          query: discoveryLabel,
        })
        excludedIds.add(card.jobId)
      }
      handledIds.add(card.jobId)
      bump(statList, 'excluded')
      continue
    }
    markUsable(statList, card.jobId)
    if (handledIds.has(card.jobId)) {
      bump(statList, 'alreadyHandled')
      continue
    }
    const { filename, markdown } = markdownForJob(job)
    fs.writeFileSync(path.join(jobsDir, filename), markdown)
    seen.add(card.jobId)
    handledIds.add(card.jobId)
    bump(statList, 'newJobs')
  }
}

const runDir = path.join(discoveryRoot, 'runs', runId, 'sources', 'ego-browser')
const jobsDir = path.join(runDir, 'jobs')
fs.mkdirSync(jobsDir, { recursive: true })

const task = await useOrCreateTaskSpace(`career-ops linkedin ego scan ${runId}`)
cliLog('task space id: ' + task.id)

const seen = new Set()
const handledIds = new Set()
const detailCache = new Map()
const excludedIds = new Set()
const blockingErrors = []
const optionalFailures = []
const skipped = []
const excluded = []
const queryStats = []
let rawRows = 0
let searchTabReady = false

const directStat = newCaptureStat({
  enabled: directSearch.enabled,
  required: directSearch.required,
  source: 'LinkedIn direct search',
})
const recommendationStat = newCaptureStat({
  enabled: topApplicantRecommendations.enabled,
  required: topApplicantRecommendations.required,
  source: 'LinkedIn top applicant recommendations',
  landingUrl: topApplicantRecommendations.landing_url,
  showAllUrl: '',
  filteredUrl: '',
  diagnostic: null,
})

function failStat(stat, error, fallbackCode) {
  stat.failure = failureFrom(error, fallbackCode)
  stat.status = 'FAILED'
  return stat.failure
}

function registerPathFailure(name, stat) {
  const record = { source: name, ...stat.failure }
  if (stat.required) blockingErrors.push(record)
  else optionalFailures.push(record)
}

if (!recommendationStat.enabled) {
  recommendationStat.status = 'DISABLED'
} else {
  cliLog('=== LinkedIn top applicant recommendations ===')
  try {
    recommendationStat.showAllUrl = await findTopApplicantShowAllUrl(recommendationStat)
    recommendationStat.filteredUrl = topApplicantRecommendationPageUrl(recommendationStat.showAllUrl, 0)
    const cards = await collectResultCards(
      start => topApplicantRecommendationPageUrl(recommendationStat.showAllUrl, start),
      resultsWanted,
      'top applicant recommendations',
      recommendationStat,
      async () => await verifyTopApplicantFilter(recommendationStat),
    )
    if (cards.length === 0) throw sourceError('ZERO_CARDS', 'top applicant recommendations returned zero job cards', true)
    rawRows += cards.length
    recommendationStat.rawRows = cards.length
    await captureCards(cards, recommendationStat, recommendationStat.source, true)
    if (recommendationStat._usableIds.size === 0) {
      throw sourceError('ZERO_USABLE_JOBS', 'top applicant recommendations returned no usable jobs within Past 24 hours', true)
    }
    recommendationStat.status = 'SUCCESS'
    cliLog(`top applicant recommendations found ${cards.length}, usable ${recommendationStat._usableIds.size}`)
  } catch (error) {
    failStat(recommendationStat, error, 'RECOMMENDATION_FAILED')
    registerPathFailure('top_applicant_recommendations', recommendationStat)
    cliLog(`ERROR top applicant recommendations [${recommendationStat.failure.code}]: ${recommendationStat.failure.message}`)
  }
}

const directFailures = []
if (!directStat.enabled) {
  directStat.status = 'DISABLED'
} else {
  for (const query of queries) {
    cliLog(`=== LinkedIn query: ${query} ===`)
    const queryStat = newCaptureStat({ query })
    queryStats.push(queryStat)
    try {
      const cards = await collectResultCards(
        start => searchUrl(query, start),
        resultsWanted,
        `query ${query}`,
        queryStat,
        async () => await requireHealthyPage(`direct search ${query}`),
      )
      if (cards.length === 0) throw sourceError('ZERO_CARDS', `direct search ${query} returned zero job cards`, true)
      rawRows += cards.length
      directStat.rawRows += cards.length
      queryStat.rawRows = cards.length
      cliLog(`found ${cards.length}`)
      await captureCards(cards, [queryStat, directStat], query, true)
      if (queryStat._usableIds.size === 0) {
        throw sourceError('ZERO_USABLE_JOBS', `direct search ${query} returned no usable jobs within ${hoursOld} hours`, true)
      }
      queryStat.status = 'SUCCESS'
    } catch (error) {
      const failure = failStat(queryStat, error, 'DIRECT_SEARCH_FAILED')
      directFailures.push({ query, ...failure })
      cliLog(`ERROR ${query} [${failure.code}]: ${failure.message}`)
    } finally {
      directStat.pageRows.push(...queryStat.pageRows)
    }
  }

  const repeatedSingleCardCapture = queryStats.length > 0
    && queryStats.every(stat => stat.pageRows.length > 1 && stat.pageRows.every(count => count === 1))
  if (repeatedSingleCardCapture) {
    directFailures.push({
      query: '*',
      code: 'CAPTURE_HEALTH_FAILED',
      retryable: false,
      message: 'capture health failed: every query page returned exactly one job card',
    })
  }
  if (directStat._usableIds.size === 0 && directFailures.length === 0) {
    directFailures.push({ query: '*', code: 'ZERO_USABLE_JOBS', retryable: true, message: 'direct search returned no usable jobs' })
  }
  if (directFailures.length) {
    directStat.status = 'FAILED'
    directStat.failure = directFailures.length === 1
      ? { code: directFailures[0].code, retryable: directFailures[0].retryable, message: directFailures[0].message }
      : {
          code: 'MULTIPLE_FAILURES',
          retryable: directFailures.every(failure => failure.retryable),
          message: directFailures.map(failure => `${failure.query}: ${failure.code}: ${failure.message}`).join(' | '),
        }
    registerPathFailure('direct_search', directStat)
  } else {
    directStat.status = 'SUCCESS'
  }
}

const enabledStats = [directStat, recommendationStat].filter(stat => stat.enabled)
const successfulPaths = enabledStats.filter(stat => stat.status === 'SUCCESS')
if (successfulPaths.length === 0 && blockingErrors.length === 0) {
  blockingErrors.push(...optionalFailures)
  optionalFailures.length = 0
}

const markdownJobs = fs.readdirSync(jobsDir).filter(name => name.endsWith('.md')).length
if (blockingErrors.length) {
  fs.writeFileSync(path.join(runDir, 'errors.log'), blockingErrors.map(item => `${item.source}\n[${item.code}] ${item.message}`).join('\n\n'))
}
if (skipped.length) {
  fs.writeFileSync(path.join(runDir, 'skipped.json'), JSON.stringify(skipped, null, 2))
}
fs.writeFileSync(path.join(runDir, 'excluded-employers.json'), JSON.stringify({
  schema_version: 1, run_id: runId, excluded_count: excluded.length, results: excluded,
}, null, 2))

function captureSummary(stat) {
  return {
    raw_rows: stat.rawRows,
    page_rows: stat.pageRows,
    usable_jobs: stat._usableIds.size,
    unique_new_jobs: stat.newJobs,
    already_handled: stat.alreadyHandled,
    excluded_employers: stat.excluded,
    outside_max_post_age: stat.stale,
    skipped: stat.skipped,
  }
}

function failureSummary(stat) {
  return {
    failure_code: stat.failure?.code || null,
    retryable: stat.failure ? stat.failure.retryable : null,
    error: stat.failure?.message || null,
  }
}

const status = blockingErrors.length
  ? 'FAILED'
  : (successfulPaths.length > 0 && seen.size > 0 && markdownJobs > 0 ? 'SUCCESS' : 'EMPTY')
const summary = {
  schema_version: 1,
  run_id: runId,
  adapter: 'ego-browser',
  status,
  raw_rows: rawRows,
  unique_jobs: seen.size,
  markdown_jobs: markdownJobs,
  errors: blockingErrors.length,
  skipped: skipped.length,
  excluded_employers: excluded.length,
  ...(status === 'FAILED' ? {
    failure_class: blockingErrors.length === 1 ? blockingErrors[0].code : 'MULTIPLE_FAILURES',
    retryable: blockingErrors.length > 0 && blockingErrors.every(error => error.retryable),
  } : {}),
  degraded_subsources: optionalFailures.map(failure => failure.source),
  direct_search: {
    enabled: directStat.enabled,
    required: directStat.required,
    status: directStat.status,
    ...captureSummary(directStat),
    query_stats: queryStats.map(stat => ({
      query: stat.query,
      status: stat.status,
      ...captureSummary(stat),
      ...failureSummary(stat),
    })),
    ...failureSummary(directStat),
  },
  top_applicant_recommendations: {
    enabled: recommendationStat.enabled,
    required: recommendationStat.required,
    status: recommendationStat.status,
    landing_url: recommendationStat.landingUrl,
    show_all_url: recommendationStat.showAllUrl || null,
    filtered_url: recommendationStat.filteredUrl || null,
    ...captureSummary(recommendationStat),
    diagnostic: recommendationStat.diagnostic,
    ...failureSummary(recommendationStat),
  },
}
fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

cliLog(`RUN_DIR=${runDir}`)
cliLog(`RAW_ROWS=${rawRows}`)
cliLog(`UNIQUE_JOBS=${seen.size}`)
cliLog(`MARKDOWN_JOBS=${markdownJobs}`)
cliLog(`ERRORS=${blockingErrors.length}`)
cliLog(`SKIPPED=${skipped.length}`)
cliLog(`EXCLUDED_EMPLOYERS=${excluded.length}`)
cliLog(`DIRECT_SEARCH_STATUS=${directStat.status}`)
cliLog(`DIRECT_SEARCH_USABLE_JOBS=${directStat._usableIds.size}`)
cliLog(`TOP_APPLICANT_STATUS=${recommendationStat.status}`)
cliLog(`TOP_APPLICANT_USABLE_JOBS=${recommendationStat._usableIds.size}`)
if (status === 'FAILED') {
  process.exitCode = 1
} else if (seen.size === 0 || markdownJobs === 0) {
  cliLog('EMPTY_DISCOVERY=1')
  process.exitCode = 3
}
}
