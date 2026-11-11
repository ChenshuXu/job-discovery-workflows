import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLinkedIn } from '../src/adapters/egobrowser_linkedin_scan.mjs';

const JOBSPY = fileURLToPath(new URL('../src/adapters/jobspy_linkedin_scan.py', import.meta.url));
const EGO = fileURLToPath(new URL('../src/adapters/egobrowser_linkedin_scan.mjs', import.meta.url));
const CONFIG = fileURLToPath(new URL('../config/jobspy-ego.json', import.meta.url));

test('both LinkedIn adapters derive scope from jobspy-ego.json with no local fallback', () => {
  const expected = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const jobspy = JSON.parse(execFileSync('python3', [JOBSPY, '--dry-run', '--run-id', 'scope-test'], { encoding: 'utf8' }));
  const ego = JSON.parse(execFileSync(process.execPath, [EGO, '--dry-run', '--run-id', 'scope-test'], { encoding: 'utf8' }));
  for (const actual of [jobspy, ego]) {
    assert.equal(actual.location, expected.location);
    assert.equal(actual.hours_old, expected.max_post_age_hours);
    assert.equal(actual.results_wanted, expected.results_wanted);
    assert.deepEqual(actual.queries, expected.queries);
    assert.deepEqual(actual.employer_exclusions, expected.employer_exclusions);
    assert.equal(actual.discovery_root.startsWith('/'), true);
  }
  assert.deepEqual(ego.direct_search, expected.direct_search);
  assert.deepEqual(ego.top_applicant_recommendations, expected.top_applicant_recommendations);
});

test('adapter scope overrides are rejected', () => {
  for (const [command, args] of [
    ['python3', [JOBSPY, '--dry-run', '--query', 'override']],
    [process.execPath, [EGO, '--dry-run', '--location', 'override']],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unrecognized arguments|Unknown argument/);
  }
});

test('LinkedIn direct search and recommendations can be selected independently', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-source-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config.direct_search = { enabled: false, required: false };
  config.top_applicant_recommendations = { ...config.top_applicant_recommendations, enabled: true, required: true };
  delete config.queries;
  writeFileSync(configFile, JSON.stringify(config));

  const recommendationOnly = JSON.parse(execFileSync(process.execPath, [EGO, '--dry-run', '--config', configFile], { encoding: 'utf8' }));
  assert.equal(recommendationOnly.direct_search.enabled, false);
  assert.equal(recommendationOnly.top_applicant_recommendations.enabled, true);

  config.top_applicant_recommendations = { ...config.top_applicant_recommendations, enabled: false, required: false };
  writeFileSync(configFile, JSON.stringify(config));
  const none = spawnSync(process.execPath, [EGO, '--dry-run', '--config', configFile], { encoding: 'utf8' });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /at least one LinkedIn source must be enabled/);
});

test('JobSpy adapter bootstraps into the repository venv before scanning', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jobspy-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(root, '.venv')]);
  const result = JSON.parse(execFileSync('python3', [JOBSPY, '--runtime-check', '--jobspy-root', root], { encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(path.resolve(result.prefix), path.resolve(result.venv));
});

test('Node LinkedIn launcher preserves exit codes, archives failures, and always cleans up', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'ego-browser');
  const log = path.join(root, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const input = fs.readFileSync(0, 'utf8');
if (input.includes('await collectLinkedIn(')) {
  const config = JSON.parse(input.match(/await collectLinkedIn\\((.*)\\)/)[1]);
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(config) + '\\n');
  if (process.env.WRITE_SUMMARY === 'yes') {
    const dir = path.join(config.discovery_root, 'runs', config.run_id, 'sources/ego-browser');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ status: process.env.SCAN_STATUS }));
  }
  process.exitCode = Number(process.env.SCAN_EXIT);
} else {
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ cleanup: true }) + '\\n');
  process.exitCode = Number(process.env.CLEANUP_EXIT);
}
`);
  chmodSync(executable, 0o755);
  const invoke = (runId, scanExit, cleanupExit, summary = '') => spawnSync(process.execPath,
    [EGO, '--discovery-root', '.', '--run-id', runId], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: root, CALL_LOG: log, SCAN_EXIT: String(scanExit), CLEANUP_EXIT: String(cleanupExit), WRITE_SUMMARY: summary ? 'yes' : 'no', SCAN_STATUS: summary },
    });
  for (const [id, scan, cleanup, summary, expected] of [
    ['success', 0, 0, 'SUCCESS', 0],
    ['empty', 3, 0, 'EMPTY', 3],
    ['failed', 7, 9, '', 7],
    // A tab left open is recorded on the summary; it does not fail a successful capture.
    ['cleanup-failed', 0, 9, 'SUCCESS', 0],
    ['missing-summary', 0, 0, '', 1],
  ]) {
    const result = invoke(id, scan, cleanup, summary);
    assert.equal(result.status, expected, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.at(-2).discovery_root, realpathSync(root));
    assert.deepEqual(calls.at(-1), { cleanup: true });
    if (id === 'cleanup-failed') {
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'runs', id, 'sources/ego-browser/summary.json'))).warnings, ['task_space_cleanup_failed']);
    }
    if (!summary) {
      const source = path.join(root, 'runs', id, 'sources/ego-browser');
      assert.equal(JSON.parse(readFileSync(path.join(source, 'summary.json'))).status, 'FAILED');
      assert.equal(JSON.parse(readFileSync(path.join(source, 'excluded-employers.json'))).excluded_count, 0);
    }
  }
  const before = readFileSync(log, 'utf8');
  assert.equal(invoke('success', 0, 0, 'SUCCESS').status, 2);
  assert.equal(readFileSync(log, 'utf8'), before);
  const failedSource = path.join(root, 'runs/failed/sources/ego-browser');
  writeFileSync(path.join(failedSource, 'evidence.txt'), 'keep me');
  assert.equal(invoke('failed', 0, 0, 'SUCCESS').status, 0);
  const attempts = path.join(root, 'runs/failed/adapter-attempts');
  assert.equal(readFileSync(path.join(attempts, readdirSync(attempts)[0], 'evidence.txt'), 'utf8'), 'keep me');
  assert.equal(existsSync(path.join(failedSource, 'evidence.txt')), false);
  for (const args of [['--run-id', '../escape'], ['--config'], ['--run-id', '--dry-run']]) {
    assert.equal(spawnSync(process.execPath, [EGO, '--dry-run', ...args], { encoding: 'utf8' }).status, 2);
  }
});

test('recommendation collector records missing modules, delayed wrong links and authentication failures', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-collector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  copyFileSync(new URL('../src/employer-exclusions.mjs', import.meta.url), path.join(root, 'src/employer-exclusions.mjs'));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const health = { login_form: false, challenge: false, auth_path: false, login_text: false };
  const absent = { ...health, href: '', diagnostic: { ...health, expected_heading_count: 0, scoped_show_all_count: 0 } };
  const wrong = { ...health, href: 'https://example.com/jobs/search-results/', diagnostic: { ...health, expected_heading_count: 1, scoped_show_all_count: 1 } };
  const helpers = { useOrCreateTaskSpace: async () => ({ id: 'fixture' }), cliLog() {},
    openOrReuseTab: async () => {}, waitForLoad: async () => {}, wait: async () => {}, js: undefined };
  const originals = Object.fromEntries(Object.keys(helpers).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    process.exitCode = exitCode;
  });
  Object.assign(globalThis, helpers);
  for (const [sequence, expected] of [
    [[absent], 'MODULE_ABSENT'],
    [[health, absent, wrong], 'UNEXPECTED_DESTINATION'],
    [[{ ...health, challenge: true }], 'AUTH_OR_CHALLENGE'],
  ]) {
    let calls = 0;
    globalThis.js = async () => sequence[Math.min(calls++, sequence.length - 1)];
    await collectLinkedIn({ ...config, discovery_root: root, run_id: expected,
      direct_search: { enabled: false, required: false },
      top_applicant_recommendations: { ...config.top_applicant_recommendations, enabled: true, required: true },
    });
    const summary = JSON.parse(readFileSync(path.join(root, 'runs', expected, 'sources/ego-browser/summary.json')));
    assert.equal(process.exitCode, 1);
    assert.equal(summary.status, 'FAILED');
    assert.equal(summary.failure_class, expected);
    assert.equal(summary.retryable, false);
    assert.equal(summary.markdown_jobs, 0);
    if (expected === 'UNEXPECTED_DESTINATION') assert.ok(summary.top_applicant_recommendations.diagnostic.discovery_attempts > 1);
  }
});

test('direct collector pins Seattle geography and rejects mismatched visible scope before capturing', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  copyFileSync(new URL('../src/employer-exclusions.mjs', import.meta.url), path.join(root, 'src/employer-exclusions.mjs'));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const helpers = { useOrCreateTaskSpace: async () => ({ id: 'fixture' }), cliLog() {},
    openOrReuseTab: async () => {}, gotoAndWait: async () => {}, waitForLoad: async () => {}, wait: async () => {}, js: undefined };
  const originals = Object.fromEntries(Object.keys(helpers).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    process.exitCode = exitCode;
  });
  Object.assign(globalThis, helpers);
  for (const [id, geo, label, time, expected] of [
    ['canada', '101174742', 'Canada', 'r86400', 'FILTER_NOT_APPLIED'],
    ['wrong-label', '90000091', 'Canada', 'r86400', 'FILTER_NOT_APPLIED'],
    ['wrong-id', '101174742', 'Greater Seattle Area', 'r86400', 'FILTER_NOT_APPLIED'],
    ['missing-label', '90000091', '', 'r86400', 'FILTER_NOT_APPLIED'],
    ['wrong-time', '90000091', 'Greater Seattle Area', 'r604800', 'FILTER_NOT_APPLIED'],
    ['hidden-time', '90000091', 'Greater Seattle Area', 'r86400', 'FILTER_NOT_APPLIED'],
    ['seattle', '90000091', 'Greater Seattle Area', 'r86400', 'ZERO_CARDS'],
  ]) {
    let captured = false;
    const urls = [];
    globalThis.openOrReuseTab = globalThis.gotoAndWait = async url => urls.push(url);
    globalThis.js = async input => {
      if (input.includes('page_title: document.title')) return { page_url: `https://www.linkedin.com/jobs/search-results/?geoId=${geo}&f_TPR=${time}`,
        effective_location: label, time_filter_visible: id !== 'hidden-time', login_form: false, challenge: false, auth_path: false, login_text: false };
      if (input.includes('const cards = []')) { captured = true; return []; }
      return { moved: false };
    };
    await collectLinkedIn({ ...config, discovery_root: root, run_id: id, queries: ['backend'], results_wanted: 25,
      top_applicant_recommendations: { ...config.top_applicant_recommendations, enabled: false, required: false } });
    const summary = JSON.parse(readFileSync(path.join(root, 'runs', id, 'sources/ego-browser/summary.json')));
    assert.equal(summary.failure_class, expected);
    assert.equal(summary.markdown_jobs, 0);
    assert.equal(captured, id === 'seattle');
    assert.equal(new URL(urls[0]).searchParams.get('geoId'), '90000091');
  }
});

function linkedInHarness(t, name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `linkedin-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  copyFileSync(new URL('../src/employer-exclusions.mjs', import.meta.url), path.join(root, 'src/employer-exclusions.mjs'));
  const helpers = { useOrCreateTaskSpace: async () => ({ id: 'fixture' }), cliLog() {},
    openOrReuseTab: async () => {}, gotoAndWait: async () => {}, waitForLoad: async () => {}, wait: async () => {}, js: undefined };
  const originals = Object.fromEntries(Object.keys(helpers).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    process.exitCode = exitCode;
  });
  Object.assign(globalThis, helpers);
  return root;
}

const detailFor = id => ({ ok: true, title: `Backend Engineer ${id}`, location: 'Seattle, WA', listedAtMs: Date.now() - 3600000, originalListedAtMs: 0,
  description: 'Build distributed backend systems. '.repeat(20), descriptionAttributes: [], company: `Acme ${id}`, applyUrl: '', workplaceTypes: [],
  formattedEmploymentStatus: 'Full-time', formattedExperienceLevel: '' });
const cardFor = id => ({ jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}`, title: `Backend Engineer ${id}`, company: `Acme ${id}`, location: 'Seattle, WA', posted: '1 hour ago', cardText: '' });
const healthy = { login_form: false, challenge: false, auth_path: false, login_text: false };

// A results page that repeats four sticky cards on every page, like LinkedIn's promoted slots.
function profileMatchPage({ pages, clicks, opened }) {
  const landing = 'https://www.linkedin.com/jobs/';
  const showAll = 'https://www.linkedin.com/jobs/search-results/?currentJobId=1&keywords=backend&origin=QUALIFICATION_LANDING&geoId=90000091';
  let current = landing;
  globalThis.openOrReuseTab = globalThis.gotoAndWait = async url => { current = url; opened.push(url); };
  const filterButton = { innerText: 'Past 24 hours', offsetWidth: 1, offsetHeight: 1, getClientRects: () => [{}] };
  globalThis.js = async input => {
    if (input.includes('/voyager/api/jobs/jobPostings/')) return detailFor(input.match(/\("(\d+)"\)\s*$/)?.[1] ?? '0');
    if (input.includes('const sectionHeading')) return { href: showAll, diagnostic: { ...healthy, expected_heading_count: 1, exact_aria_link_count: 1, scoped_show_all_count: 1 } };
    if (input.includes('.click()')) { clicks.push(current); current = showAll; return { clicked: true, count: 1 }; }
    if (input.includes('active_filter_control_count')) {
      const document = { querySelectorAll: () => [filterButton, { ...filterButton }] };
      return new Function('document', 'location', `return ${input}`)(document, { href: current });
    }
    if (input.includes('const cards = []')) return pages[Number(new URL(current).searchParams.get('start') ?? 0) / 25] ?? [];
    if (input.includes('page_title: document.title')) return { ...healthy, page_url: current, page_title: 'Jobs', effective_location: '', time_filter_visible: true };
    return { moved: false };
  };
}

const profileMatchPages = () => {
  const sticky = [1, 2, 3, 4];
  const ids = from => [...sticky, ...Array.from({ length: 21 }, (_, index) => from + index)];
  return [ids(100), ids(200), [...sticky, 300, 301, 302].map(String)].map(page => page.map(cardFor));
};

test('profile-match path clicks Show all, then captures every Past 24 hours page past results_wanted', async t => {
  const root = linkedInHarness(t, 'profile-match');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.equal(config.top_applicant_recommendations.section_heading, 'Jobs that match your profile');
  assert.equal(config.top_applicant_recommendations.show_all_aria_label, 'Show all jobs that match your profile');
  const clicks = [], opened = [];
  profileMatchPage({ pages: profileMatchPages(), clicks, opened });
  await collectLinkedIn({ ...config, discovery_root: root, run_id: 'all-pages', results_wanted: 30,
    direct_search: { enabled: false, required: false },
    top_applicant_recommendations: { ...config.top_applicant_recommendations, required: true } });
  const summary = JSON.parse(readFileSync(path.join(root, 'runs/all-pages/sources/ego-browser/summary.json')));
  const path_ = summary.top_applicant_recommendations;
  assert.equal(summary.status, 'SUCCESS', JSON.stringify(path_));
  assert.deepEqual(clicks, ['https://www.linkedin.com/jobs/']);
  assert.equal(path_.raw_rows, 49);
  assert.equal(summary.markdown_jobs, 49);
  assert.deepEqual(path_.page_rows, [25, 25, 7]);
  assert.equal(path_.cap_reached, false);
  const results = opened.filter(url => url.includes('search-results'));
  assert.deepEqual(results.map(url => new URL(url).searchParams.get('start')), ['0', '25', '50']);
  for (const url of results) {
    assert.equal(new URL(url).searchParams.get('f_TPR'), 'r86400');
    assert.equal(new URL(url).searchParams.has('currentJobId'), false);
    assert.equal(new URL(url).searchParams.get('origin'), 'QUALIFICATION_LANDING');
  }
});

test('the profile-match page limit is reported instead of silently truncating', async t => {
  const root = linkedInHarness(t, 'profile-cap');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const clicks = [], opened = [];
  profileMatchPage({ pages: profileMatchPages(), clicks, opened });
  await collectLinkedIn({ ...config, discovery_root: root, run_id: 'capped',
    direct_search: { enabled: false, required: false },
    top_applicant_recommendations: { ...config.top_applicant_recommendations, required: true, max_pages: 2 } });
  const summary = JSON.parse(readFileSync(path.join(root, 'runs/capped/sources/ego-browser/summary.json')));
  assert.equal(summary.top_applicant_recommendations.status, 'SUCCESS');
  assert.equal(summary.top_applicant_recommendations.cap_reached, true);
  assert.equal(opened.filter(url => url.includes('search-results')).length, 2);
});

test('profile-match config requires a positive page limit', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config.top_applicant_recommendations.max_pages = 0;
  const file = path.join(root, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  const result = spawnSync(process.execPath, [EGO, '--dry-run', '--config', file], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /max_pages/);
});

test('direct search stops at the first access limit and reports a reached result cap', async t => {
  const root = linkedInHarness(t, 'access-limit');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const run = async (id, detail, queries) => {
    const opened = [];
    let current = '';
    globalThis.openOrReuseTab = globalThis.gotoAndWait = async url => { current = url; opened.push(url); };
    globalThis.js = async input => {
      if (input.includes('/voyager/api/jobs/jobPostings/')) return detail(input.match(/\("(\d+)"\)\s*$/)?.[1] ?? '0');
      if (input.includes('const cards = []')) return Array.from({ length: 25 }, (_, index) => cardFor(1000 + index + (new URL(current).searchParams.get('keywords') === 'two' ? 100 : 0)));
      if (input.includes('page_title: document.title')) return { ...healthy, page_url: `https://www.linkedin.com/jobs/search-results/?geoId=90000091&f_TPR=r86400`,
        page_title: 'Jobs', effective_location: 'Greater Seattle Area', time_filter_visible: true };
      return { moved: false };
    };
    await collectLinkedIn({ ...config, discovery_root: root, run_id: id, queries, results_wanted: 25,
      top_applicant_recommendations: { ...config.top_applicant_recommendations, enabled: false, required: false } });
    return { opened, summary: JSON.parse(readFileSync(path.join(root, 'runs', id, 'sources/ego-browser/summary.json'))) };
  };
  const limited = await run('limited', () => ({ ok: false, status: 429, failureCode: 'DETAIL_HTTP_ERROR' }), ['one', 'two']);
  assert.equal(limited.summary.status, 'FAILED');
  assert.equal(limited.summary.retryable, false);
  assert.deepEqual([...new Set(limited.opened.map(url => new URL(url).searchParams.get('keywords')))], ['one']);
  const capped = await run('result-cap', detailFor, ['one']);
  assert.equal(capped.summary.status, 'SUCCESS');
  assert.equal(capped.summary.direct_search.query_stats[0].cap_reached, true);
});

const FAKE_JOBSPY_INIT = `import json, os
from jobspy.linkedin import LinkedIn

class Frame:
    def __init__(self, rows):
        self.rows = rows
    def to_dict(self, kind):
        return self.rows

def scrape_jobs(**kwargs):
    scenario = json.load(open(os.environ["FAKE_SCENARIO"]))
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"query": kwargs["search_term"], "delay": list(LinkedIn.delay), "fetch_description": kwargs.get("fetch_description"), "deprecated": "linkedin_fetch_description" in kwargs}) + "\\n")
    plan = scenario["queries"][kwargs["search_term"]]
    if plan.get("raise"):
        raise ConnectionError(plan["raise"])
    scraper = LinkedIn()
    rows = []
    for job_id in plan.get("jobs", []):
        details = scraper._fetch_details(job_id)
        rows.append({"job_url": "https://www.linkedin.com/jobs/view/" + job_id, "company": "Acme " + job_id, "title": "Backend " + job_id, "location": "Seattle, WA", "description": details.get("description")})
    if plan.get("search_failure"):
        scraper.fail(plan["search_failure"])
    return Frame(rows)
`;
const FAKE_LINKEDIN = `import json, os

class LinkedIn:
    delay = (3, 7)
    def fail(self, message):
        self.error = message
    def _fetch_details(self, job_id):
        scenario = json.load(open(os.environ["FAKE_SCENARIO"]))
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(json.dumps({"detail": job_id}) + "\\n")
        return {} if job_id in scenario.get("unavailable", []) else {"description": "Build backend systems. " * 30}
`;

function jobspyHarness(t, { linkedin = FAKE_LINKEDIN } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jobspy-pacing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobspyRoot = path.join(root, 'JobSpy');
  mkdirSync(path.join(jobspyRoot, 'jobspy/linkedin'), { recursive: true });
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(jobspyRoot, '.venv')]);
  writeFileSync(path.join(jobspyRoot, 'jobspy/__init__.py'), FAKE_JOBSPY_INIT);
  writeFileSync(path.join(jobspyRoot, 'jobspy/linkedin/__init__.py'), linkedin);
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  return (id, scenario, pacing = {}) => {
    const scan = { ...config, queries: Object.keys(scenario.queries), employer_exclusions: [], jobspy_pacing: { ...config.jobspy_pacing,
      search_delay_seconds: [11, 12], detail_delay_seconds: [0, 0], query_delay_seconds: [0, 0], failure_backoff_seconds: 0, ...pacing } };
    const configFile = path.join(root, `${id}.json`), scenarioFile = path.join(root, `${id}.scenario.json`), log = path.join(root, `${id}.log`);
    writeFileSync(configFile, JSON.stringify(scan));
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    writeFileSync(log, '');
    const result = spawnSync('python3', [JOBSPY, '--discovery-root', root, '--jobspy-root', jobspyRoot, '--config', configFile, '--run-id', id],
      { encoding: 'utf8', env: { ...process.env, FAKE_SCENARIO: scenarioFile, FAKE_LOG: log } });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { result, calls, summary: JSON.parse(readFileSync(path.join(root, 'runs', id, 'sources/jobspy/summary.json'))) };
  };
}

test('JobSpy fetches each job detail once across queries and applies the configured search delay', t => {
  const run = jobspyHarness(t);
  const { result, calls, summary } = run('overlap', { unavailable: ['4'], queries: { one: { jobs: ['1', '2'] }, two: { jobs: ['2', '3', '4'] } } }, { max_consecutive_detail_failures: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.filter(call => call.detail).map(call => call.detail), ['1', '2', '3', '4', '4']);
  assert.deepEqual(calls.find(call => call.query).delay, [11, 12]);
  assert.equal(calls.find(call => call.query).fetch_description, true);
  assert.equal(calls.find(call => call.query).deprecated, false);
  assert.equal(summary.status, 'SUCCESS');
  assert.equal(summary.markdown_jobs, 3);
  assert.equal(summary.dropped_missing_description, 1);
  assert.equal(summary.pacing.detail_requests, 5);
  assert.equal(summary.pacing.detail_cache_hits, 1);
});

test('JobSpy stops at repeated detail failures, keeps its captures and reports a rate limit', t => {
  const run = jobspyHarness(t);
  const { result, calls, summary } = run('stopped', { unavailable: ['2', '3'], queries: { one: { jobs: ['1', '2', '3', '4'] }, two: { jobs: ['5'] } } }, { max_consecutive_detail_failures: 2 });
  assert.equal(result.status, 1);
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.failure_class, 'RATE_LIMITED');
  assert.equal(summary.retryable, false);
  assert.equal(summary.markdown_jobs, 1);
  assert.equal(summary.pacing.stopped, true);
  assert.deepEqual(calls.filter(call => call.query).map(call => call.query), ['one']);
  assert.equal(calls.some(call => call.detail === '4'), false);
});

test('a blocked JobSpy search page stops later queries instead of passing as success', t => {
  const run = jobspyHarness(t);
  const { summary, calls } = run('blocked', { queries: { one: { jobs: ['1'], search_failure: 'response status code 429 (blocked: use a proxy)' }, two: { jobs: ['2'] } } });
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.failure_class, 'RATE_LIMITED');
  assert.equal(summary.retryable, false);
  assert.equal(summary.markdown_jobs, 1);
  assert.deepEqual(calls.filter(call => call.query).map(call => call.query), ['one']);
});

test('JobSpy classifies network failures as retryable and an interface change as not', t => {
  const network = jobspyHarness(t)('network', { queries: { one: { raise: 'Read timed out.' } } });
  assert.equal(network.summary.status, 'FAILED');
  assert.equal(network.summary.retryable, true);
  const drifted = jobspyHarness(t, { linkedin: 'class LinkedIn:\n    delay = (3, 7)\n' })('drift', { queries: { one: { jobs: ['1'] } } });
  assert.equal(drifted.summary.status, 'FAILED');
  assert.equal(drifted.summary.failure_class, 'JOBSPY_INTERFACE_CHANGED');
  assert.equal(drifted.summary.retryable, false);
  assert.equal(drifted.calls.length, 0);
});

test('JobSpy requires valid pacing settings', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jobspy-pacing-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.ok(config.jobspy_pacing.detail_delay_seconds[0] > 0);
  assert.ok(config.jobspy_pacing.search_delay_seconds[0] > 3);
  const file = path.join(root, 'config.json');
  for (const pacing of [undefined, { ...config.jobspy_pacing, detail_delay_seconds: [5, 2] }, { ...config.jobspy_pacing, max_consecutive_detail_failures: 0 }]) {
    writeFileSync(file, JSON.stringify({ ...config, jobspy_pacing: pacing }));
    const result = spawnSync('python3', [JOBSPY, '--dry-run', '--config', file], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /jobspy_pacing/);
  }
});
