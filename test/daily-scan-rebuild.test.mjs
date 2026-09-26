import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { combineRun } from '../src/combine.mjs';
import { commitScan } from '../src/commit-scan.mjs';
import { planEvaluations } from '../src/plan-scan-evaluations.mjs';
import { renderScanReports, trackerIdentityNote } from '../src/render-scan-reports.mjs';
import { resolveCanonicalUrls } from '../src/resolve-canonical-urls.mjs';
import { validateRun } from '../src/run-contract.mjs';
import {
  auditScanReceipt,
  captureBaseline,
} from '../src/verify-scan-receipt.mjs';
import { loadCareerTrackerParser, parseTracker } from '../src/daily-scan-state.mjs';
import { loadDailyScanRuntime, workerIdsForRuntime } from '../src/daily-scan-runtime.mjs';
import { mergeWorkerResults } from '../src/merge-worker-results.mjs';
import { collectHistoricalSemanticContexts } from '../src/posting-history.mjs';
import { loadScanResults } from '../src/scan-results.mjs';
import { renderCompactReport, readCompactReportSummary } from '../src/scan-report-contract.mjs';
import { loadLocationPolicy } from '../src/location-scope.mjs';

const LONG = 'Build reliable distributed backend systems, APIs, databases, observability, testing, and production services with cross-functional ownership. '.repeat(4);

function write(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function markdown({ url, key, id, source, company = 'Example', role = 'Senior Backend Engineer', location = 'Seattle, WA', workplaceType = 'unknown', structuredRemoteSignal = false, extra = '', semanticToken = id ?? key ?? url }) {
  return `# ${role}\n\n**URL:** ${url}\n${key ? `**Posting Key:** ${key}\n` : ''}${id ? `**LinkedIn Job ID:** ${id}\n` : ''}**Company:** ${company}\n**Role:** ${role}\n**Location:** ${location}\n**Workplace Type:** ${workplaceType}\n**Workplace Type Source:** fixture\n**Structured Remote Signal:** ${structuredRemoteSignal}\n**Posted:** 2026-08-07\n**Source:** ${source}\n\n## Job Description\n\n${extra}\n${LONG}\n${semanticToken}\n`;
}

function source(run, adapter, jobs, options = {}) {
  const root = path.join(run, 'sources', adapter);
  mkdirSync(path.join(root, 'jobs'), { recursive: true });
  for (const [name, content] of Object.entries(jobs)) write(path.join(root, 'jobs', name), content);
  const status = options.status ?? (Object.keys(jobs).length ? 'SUCCESS' : 'EMPTY');
  const errors = options.errors ?? (status === 'FAILED' ? 1 : 0);
  write(path.join(root, 'summary.json'), {
    schema_version: 1, run_id: path.basename(run), adapter,
    status, raw_rows: Object.keys(jobs).length,
    unique_jobs: Object.keys(jobs).length, markdown_jobs: Object.keys(jobs).length, errors,
  });
  write(path.join(root, 'excluded-employers.json'), { schema_version: 1, run_id: path.basename(run), excluded_count: 0, results: [] });
}

function careerFixture(root) {
  const career = path.join(root, 'career-ops');
  for (const dir of ['data', 'reports', 'jds', 'batch/tracker-additions', 'output']) mkdirSync(path.join(career, dir), { recursive: true });
  write(path.join(career, 'cv.md'), '# CV\n\nMaster of Science in Computer Science\n');
  write(path.join(career, 'config/profile.yml'), `location:\n  visa_status: "H-1B"\n  needs_sponsorship: true\n  scan_policy: {"local_metros":["Seattle","Bellevue","Redmond","Kirkland","Bothell","Renton","Issaquah","SeaTac","Tacoma","Everett"],"remote_country":"United States","require_structured_remote":true,"ambiguous_action":"exclude"}\n`);
  write(path.join(career, 'modes/_profile.md'), '# Candidate profile\n');
  write(path.join(career, 'output/existing.txt'), 'unchanged\n');
  write(path.join(career, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  write(path.join(career, 'data/scan-history.tsv'), 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n');
  write(path.join(career, 'tracker-parse.mjs'), `
const aliases = { '#':'num', num:'num', date:'date', company:'company', empresa:'company', via:'via', role:'role', puesto:'role', location:'location', score:'score', status:'status', pdf:'pdf', report:'report', notes:'notes', url:'url' };
const legacy = { num:1,date:2,company:3,role:4,score:5,status:6,pdf:7,report:8,notes:9 };
export function resolveColumns(lines) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const map = {};
    line.split('|').map(value => value.trim().toLowerCase()).forEach((value, index) => { if (aliases[value]) map[aliases[value]] = index; });
    if (['num','company','role','score','status'].every(key => map[key] != null)) return map;
  }
  return legacy;
}
export function parseTrackerRow(line, columns = legacy) {
  if (!line.startsWith('|')) return null;
  const parts = line.split('|').map(value => value.trim());
  const num = Number.parseInt(parts[columns.num], 10);
  if (!Number.isInteger(num)) return null;
  const at = key => columns[key] == null ? '' : parts[columns[key]] || '';
  return { num, date:at('date'), company:at('company'), role:at('role'), score:at('score'), status:at('status'), pdf:at('pdf'), report:at('report'), notes:at('notes'), location:at('location'), via:at('via'), raw:line };
}
`);
  write(path.join(career, 'tracker-utils.mjs'), `
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const resolveTrackerPath = root => process.env.CAREER_OPS_TRACKER ? path.resolve(root, process.env.CAREER_OPS_TRACKER) : path.join(root, 'data/applications.md');
export const writeFileAtomic = (file, content) => { const staged = file + '.tmp-' + process.pid; writeFileSync(staged, content); renameSync(staged, file); };
export async function openTrackerTransaction(file) {
  let closed = false;
  return {
    read() { if (closed) throw new Error('closed'); return readFileSync(file, 'utf8'); },
    replace(content) { if (closed) throw new Error('closed'); writeFileAtomic(file, content); },
    close() { closed = true; return null; },
  };
}
`);
  write(path.join(career, 'pipeline-lock.mjs'), `
import { mkdirSync, rmSync } from 'node:fs';
export async function acquirePipelineLock(file) {
  const lock = file + '.lock';
  for (;;) {
    try { mkdirSync(lock, { recursive:false }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  let released = false;
  return { release() { if (!released) rmSync(lock, { recursive:true, force:true }); released = true; } };
}
export async function withPipelineLock(file, fn) { const lock = await acquirePipelineLock(file); try { return await fn(); } finally { lock.release(); } }
`);
  write(path.join(career, 'verify-pipeline.mjs'), "console.log('Pipeline Health: 0 errors, 0 warnings')\n");
  write(path.join(career, 'reserve-report-num.mjs'), `
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
mkdirSync('reports', { recursive: true });
const releaseAt = process.argv.indexOf('--release');
if (releaseAt >= 0) {
  const [start, end = start] = process.argv[releaseAt + 1].split('-').map(Number);
  for (let n = start; n <= end; n++) if (existsSync('reports/' + String(n).padStart(3, '0') + '-RESERVED.md')) unlinkSync('reports/' + String(n).padStart(3, '0') + '-RESERVED.md');
  process.exit(0);
}
const count = Number(process.argv[process.argv.indexOf('--count') + 1]);
const reportNums = readdirSync('reports').flatMap(name => [Number(name.match(/^(\\d+)-/)?.[1])].filter(Number.isFinite));
const trackerFile = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
const trackerNums = readFileSync(trackerFile, 'utf8').split(/\\r?\\n/).flatMap(line => [Number(line.match(/^\\|\\s*(\\d+)\\s*\\|/)?.[1])].filter(Number.isFinite));
const start = Math.max(0, ...reportNums, ...trackerNums) + 1;
for (let n = start; n < start + count; n++) writeFileSync('reports/' + String(n).padStart(3, '0') + '-RESERVED.md', 'reserved');
console.log(count === 1 ? String(start) : start + '-' + (start + count - 1));
`);
  write(path.join(career, 'scan.mjs'), `
import { appendFileSync } from 'node:fs';
const historyFile = process.env.CAREER_OPS_SCAN_HISTORY || 'data/scan-history.tsv';
export async function appendToScanHistory(offers, date, status) {
  await new Promise(resolve => setImmediate(resolve));
  appendFileSync(historyFile, offers.map(o => [o.url,date,o.source,o.title,o.company,status,o.location].join('\\t')).join('\\n') + '\\n');
}
export function appendScanRunSummary(c, file = 'data/scan-runs.tsv') { appendFileSync(file, JSON.stringify(c) + '\\n'); }
`);
  write(path.join(career, 'merge-tracker.mjs'), `
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
const additions = process.env.CAREER_OPS_ADDITIONS || 'batch/tracker-additions';
const trackerFile = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
let tracker = readFileSync(trackerFile, 'utf8').trimEnd();
for (const name of readdirSync(additions).filter(name => name.endsWith('.tsv'))) {
  const cells = readFileSync(additions + '/' + name, 'utf8').trim().split('\\n').at(-1).split('\\t');
  tracker += '\\n| ' + cells.join(' | ') + ' |';
  unlinkSync(additions + '/' + name);
}
writeFileSync(trackerFile, tracker + '\\n');
`);
  write(path.join(career, 'tracker.mjs'), "if (process.argv[2] !== 'sync') process.exitCode = 1;\n");
  write(path.join(career, 'cv-sync-check.mjs'), "console.log('All checks passed.')\n");
  return career;
}

async function parseCareerTracker(career, text = readFileSync(path.join(career, 'data/applications.md'), 'utf8')) {
  return parseTracker(text, await loadCareerTrackerParser(career));
}

function report() {
  return {
    archetype: 'Senior Backend Engineer', reason: 'Backend ownership aligns strongly.',
    evidence: [{ source: 'jd', quote: 'distributed backend systems', explanation: 'Matches target scope.' }],
    gaps: [], risk_level: 'Low', confidence: 'High',
    risk_summary: { classification: 'clear', culture: 'not_evaluated', interview_redflags: 'not_evaluated', ai_infra: 'consistent' },
    advertised_comp: null, company_confidential_evidence: null,
  };
}

function writeWorkerResults(run, createResult) {
  const plan = JSON.parse(readFileSync(path.join(run, 'assignments.json'), 'utf8'));
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json'), 'utf8'));
  const records = new Map(acquisition.acquired.map(record => [record.primary_key, record]));
  const batchSize = plan.runtime.scheduler.batch_size;
  for (const worker of workerIdsForRuntime(plan.runtime)) {
    const results = plan.assignments[worker].map(key => {
      const value = createResult(key, plan.runtime);
      if (String(value.status ?? '').toUpperCase() === 'FAILED') return value;
      const record = records.get(key);
      const excluded = value.hard_exclusion === true;
      return {
        posting_key: key,
        fit_score: value.score,
        work_authorization: value.work_authorization ?? { value: 'unstated', quote: null },
        level_signal: 'target',
        level_evidence: `JD: "**Role:** ${record.title}"`,
        eligibility_status: excluded ? 'ineligible' : 'eligible',
        eligibility_category: excluded ? 'citizenship' : null,
        eligibility_evidence: excluded ? value.hard_exclusion_evidence : null,
        legitimacy_tier: value.legitimacy_tier ?? 'High Confidence',
        rationale: value.rationale ?? null,
        report: value.report,
      };
    });
    for (let index = 0; index < results.length; index += batchSize) write(path.join(run, 'results', `${worker}.part-${Math.floor(index / batchSize) + 1}.json`), {
      result_schema_version: 4, worker, part: Math.floor(index / batchSize) + 1, results: results.slice(index, index + batchSize),
    });
    mergeWorkerResults(run, worker);
  }
}

function mergeTrackerAdditions(career) {
  const directory = path.join(career, 'batch/tracker-additions');
  const additions = readdirSync(directory).filter(name => name.endsWith('.tsv'));
  let tracker = readFileSync(path.join(career, 'data/applications.md'), 'utf8').trimEnd();
  for (const name of additions) {
    const cells = readFileSync(path.join(directory, name), 'utf8').trim().split('\n').at(-1).split('\t');
    tracker += `\n| ${cells.join(' | ')} |`;
    unlinkSync(path.join(directory, name));
  }
  write(path.join(career, 'data/applications.md'), `${tracker}\n`);
}

function writeHeaderAwareMerge(career, postingUrl) {
  write(path.join(career, 'merge-tracker.mjs'), `
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
const additions = process.env.CAREER_OPS_ADDITIONS;
const trackerFile = process.env.CAREER_OPS_TRACKER;
let tracker = readFileSync(trackerFile, 'utf8').trimEnd();
for (const name of readdirSync(additions).filter(name => name.endsWith('.tsv'))) {
  const c = readFileSync(additions + '/' + name, 'utf8').trim().split('\\n').at(-1).split('\\t');
  const row = [c[0], c[1], c[2], 'LinkedIn', c[3], 'Seattle, WA', c[5], c[4], c[6], ${JSON.stringify(postingUrl)}, c[7], c[8]];
  tracker += '\\n| ' + row.join(' | ') + ' |';
  unlinkSync(additions + '/' + name);
}
writeFileSync(trackerFile, tracker + '\\n');
`);
}

function bulkRun(count, extraForIndex = () => '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-bulk-'));
  const run = path.join(root, 'runs', 'run-1');
  const jobs = {};
  for (let index = 0; index < count; index++) {
    const id = String(50000000 + index);
    jobs[`${id}.md`] = markdown({ url: `https://www.linkedin.com/jobs/view/${id}`, id, source: 'jobspy', extra: extraForIndex(index) });
  }
  source(run, 'jobspy', jobs); source(run, 'ego-browser', {}); source(run, 'jobright', {});
  combineRun(run);
  return { root, run, career: careerFixture(root) };
}

function modeRuntime(root, semanticDedupMode) {
  const runtime = loadDailyScanRuntime();
  runtime.semantic_dedup_mode = semanticDedupMode;
  const file = path.join(root, 'daily-scan-runtime.json');
  write(file, runtime);
  return file;
}

function twoJobRun(root, runName, jobs) {
  const run = path.join(root, 'runs', runName);
  source(run, 'jobspy', Object.fromEntries(jobs.map(({ id, ...options }) => [
    `${id}.md`, markdown({ url: `https://www.linkedin.com/jobs/view/${id}`, id, source: 'jobspy', ...options }),
  ])));
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});
  combineRun(run);
  return run;
}

test('a failed source still contributes its validated captured JDs without satisfying source liveness', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-partial-source-'));
  const run = path.join(root, 'runs', 'run-1');
  source(run, 'jobspy', {
    'linked-in.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000021', id: '50000021', source: 'jobspy' }),
  });
  source(run, 'ego-browser', {
    'captured-before-error.md': markdown({
      url: 'https://boards.greenhouse.io/acme/jobs/7654321',
      key: 'greenhouse:acme:7654321',
      source: 'ego-browser',
    }),
  }, { status: 'FAILED', errors: 1 });
  source(run, 'jobright', {});

  const acquisition = combineRun(run);
  assert.deepEqual(acquisition.keys.sort(), ['greenhouse:acme:7654321', 'linkedin:linkedin.com:50000021']);
  assert.equal(acquisition.sources.find(item => item.adapter === 'ego-browser').status, 'FAILED');
  assert.match(validateRun(run).warnings.join('\n'), /degraded acquisition/);
});

test('failed-source JDs cannot satisfy the minimum successful adapter requirement', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-failed-only-'));
  const run = path.join(root, 'runs', 'run-1');
  source(run, 'jobspy', {});
  source(run, 'ego-browser', {
    'captured-before-error.md': markdown({
      url: 'https://boards.greenhouse.io/acme/jobs/7654322',
      key: 'greenhouse:acme:7654322',
      source: 'ego-browser',
    }),
  }, { status: 'FAILED', errors: 1 });
  source(run, 'jobright', {});
  assert.throws(() => combineRun(run), /requires 1 successful adapter/);
});

test('an EMPTY source cannot claim Markdown jobs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-invalid-empty-'));
  const run = path.join(root, 'runs', 'run-1');
  source(run, 'jobspy', {
    'impossible.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000022', id: '50000022', source: 'jobspy' }),
  }, { status: 'EMPTY', errors: 0 });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});
  assert.throws(() => combineRun(run), /EMPTY requires zero jobs and zero errors/);
});

test('an empty metadata value stays empty instead of consuming the next field', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-empty-location-'));
  const run = path.join(root, 'runs', 'run-1');
  const jd = markdown({ url: 'https://www.linkedin.com/jobs/view/50000023', id: '50000023', source: 'jobspy', location: '' }).replace(/\n/g, '\r\n');
  source(run, 'jobspy', { 'empty-location.md': jd });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});
  const career = careerFixture(root);
  captureBaseline({ runRoot: run, careerRoot: career });
  const acquisition = combineRun(run);
  assert.equal(acquisition.acquired[0].location, '');
  assert.deepEqual(acquisition.acquired[0].locations, []);
  assert.equal(acquisition.acquired[0].workplace_type, 'unknown');
  planEvaluations(run, undefined, career);
  const audit = JSON.parse(readFileSync(path.join(run, 'triage/location-scope.json'), 'utf8'));
  assert.equal(audit.results[0].decision, 'AMBIGUOUS_MISSING_LOCATION');
});

test('parser-v2 migration rewrites normalized JD identity metadata', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-identity-migration-'));
  const run = path.join(root, 'runs', 'run-1');
  const url = 'https://careers.adobe.com/us/en/job/ADOBUSR100001EXTERNALENUS/Example-Engineer-5';
  const legacy = 'generic:careers.adobe.com:EXAMPLE-ENGINEER-5';
  source(run, 'jobspy', {
    'legacy.md': markdown({ url, key: legacy, source: 'jobspy' }),
  });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});

  const acquisition = combineRun(run);
  const record = acquisition.acquired[0];
  const jd = readFileSync(path.join(run, record.jd_path), 'utf8');
  assert.equal(record.primary_key, 'phenom:adobe:ADOBUSR100001EXTERNALENUS');
  assert.match(jd, /^\*\*Posting Key:\*\* phenom:adobe:ADOBUSR100001EXTERNALENUS$/m);
  assert.match(jd, new RegExp(`^\\*\\*URL:\\*\\* ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(validateRun(run).errors.length, 0);
});

test('parser-v2 Google generic artifacts replay into the canonical requisition identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-google-identity-migration-'));
  const run = path.join(root, 'runs', 'run-1');
  const requisition = '10000000000000003';
  const url = `https://www.google.com/about/careers/applications/jobs/results/${requisition}-software-engineer-iii?page=40`;
  source(run, 'jobspy', {
    'legacy-google.md': markdown({ url, key: `generic:google.com:${requisition}`, source: 'jobspy' }),
  });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});

  const acquisition = combineRun(run);
  const record = acquisition.acquired[0];
  assert.equal(record.primary_key, `google-careers:google:${requisition}`);
  assert.match(readFileSync(path.join(run, record.jd_path), 'utf8'), new RegExp(`^\\*\\*Posting Key:\\*\\* google-careers:google:${requisition}$`, 'm'));
  assert.equal(validateRun(run).errors.length, 0);
});

test('parser-v2 LinkedIn slug artifacts replay into the numeric job identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-linkedin-identity-migration-'));
  const run = path.join(root, 'runs', 'run-1');
  const id = '1000000102';
  const segment = `full-time-remote-canada-at-exampleco-${id}`;
  const url = `https://ca.linkedin.com/jobs/view/${segment}`;
  source(run, 'jobspy', {
    'legacy-linkedin.md': markdown({ url, key: `linkedin:linkedin.com:${segment.toUpperCase()}`, source: 'jobspy' }),
  });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});

  const acquisition = combineRun(run);
  const record = acquisition.acquired[0];
  assert.equal(record.primary_key, `linkedin:linkedin.com:${id}`);
  assert.match(readFileSync(path.join(run, record.jd_path), 'utf8'), new RegExp(`^\\*\\*Posting Key:\\*\\* linkedin:linkedin.com:${id}$`, 'm'));
  assert.equal(validateRun(run).errors.length, 0);
});

test('combine never promotes an unparseable declared key into parser-v2 identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-unparseable-declared-key-'));
  const run = path.join(root, 'runs', 'run-1');
  source(run, 'jobspy', {
    'valid.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000024', id: '50000024', source: 'jobspy' }),
    'unsafe-jometer.md': markdown({
      url: 'https://tnl2.jometer.com/v2/job?jz=not-a-unique-posting-id',
      key: 'generic:tnl2.jometer.com:V2',
      source: 'jobspy',
    }),
  });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});
  assert.throws(() => combineRun(run), /URL has no parser-v2 exact posting identity/);
});

test('exact merge persists merged context metadata into the canonical JD', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-context-metadata-'));
  const run = path.join(root, 'runs', 'run-1');
  const options = { url: 'https://www.linkedin.com/jobs/view/50000009', id: '50000009', location: 'United States', workplaceType: 'remote' };
  source(run, 'jobspy', { 'job.md': markdown({ ...options, source: 'jobspy', structuredRemoteSignal: true }) });
  source(run, 'ego-browser', { 'job.md': markdown({ ...options, source: 'ego-browser', structuredRemoteSignal: false }) });
  source(run, 'jobright', {});
  combineRun(run);
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json'), 'utf8'));
  assert.equal(acquisition.acquired[0].structured_remote_signal, true);
  const captured = readFileSync(path.join(run, acquisition.acquired[0].jd_path), 'utf8');
  assert.match(captured, /^\*\*Location:\*\* United States$/m);
  assert.match(captured, /^\*\*Workplace Type:\*\* remote$/m);
  assert.match(captured, /^\*\*Structured Remote Signal:\*\* true$/m);
});

test('semantic history joins a committed row only to its run-owned JD', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-history-owner-'));
  const career = careerFixture(root);
  const id = '50000019';
  const url = `https://www.linkedin.com/jobs/view/${id}`;
  const keySuffix = `linkedin-linkedin.com-${id}`;
  const historyFile = path.join(career, 'data/scan-history.tsv');
  writeFileSync(historyFile, `${readFileSync(historyFile, 'utf8')}${url}\t2026-08-30\tjobspy\tSenior Software Engineer\tAcme\tdaily-scan:new-run\tSeattle, WA\n`);
  write(path.join(career, 'jds', `discovery-old-run-${keySuffix}.md`), markdown({ url, id, extra: 'Old body.' }));
  const policy = loadLocationPolicy(path.join(career, 'config/profile.yml'));
  assert.equal(collectHistoricalSemanticContexts({ careerRoot: career, locationPolicy: policy }).size, 0);
  write(path.join(career, 'jds', `discovery-new-run-${keySuffix}.md`), markdown({ url, id, location: 'Portland, OR | Seattle, WA', extra: 'Current body.' }));
  const otherId = '50000020';
  const otherUrl = `https://www.linkedin.com/jobs/view/${otherId}`;
  writeFileSync(historyFile, `${readFileSync(historyFile, 'utf8')}${otherUrl}\t2026-08-30\tjobspy\tSenior Software Engineer\tOther\tdaily-scan:other-run\tSeattle, WA\n`);
  write(path.join(career, 'jds', `discovery-other-run-linkedin-linkedin.com-${otherId}.md`), markdown({ url: otherUrl, id: otherId, company: 'Other', extra: 'Other body.' }));
  const rebuilt = JSON.stringify([...collectHistoricalSemanticContexts({ careerRoot: career, locationPolicy: policy })]);
  assert.equal(rebuilt, JSON.stringify([...collectHistoricalSemanticContexts({ careerRoot: career, locationPolicy: policy })]));
  assert.equal(JSON.parse(rebuilt).flatMap(([, matches]) => matches).length, 2);
});

test('planner excludes nonlocal and ambiguous locations before worker assignment', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-location-scope-'));
  const run = path.join(root, 'runs', 'run-1');
  source(run, 'jobspy', {
    'local.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000001', id: '50000001', source: 'jobspy', location: 'Seattle, WA' }),
    'remote.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000002', id: '50000002', source: 'jobspy', location: 'United States', workplaceType: 'remote', structuredRemoteSignal: true }),
    'new-york.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000003', id: '50000003', source: 'jobspy', location: 'New York, NY' }),
    'san-francisco.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000004', id: '50000004', source: 'jobspy', location: 'San Francisco, CA' }),
    'sunnyvale.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000005', id: '50000005', source: 'jobspy', location: 'Sunnyvale, CA' }),
    'us-ambiguous.md': markdown({ url: 'https://www.linkedin.com/jobs/view/50000006', id: '50000006', source: 'jobspy', location: 'United States' }),
  });
  source(run, 'ego-browser', {});
  source(run, 'jobright', {});
  const career = careerFixture(root);
  captureBaseline({ runRoot: run, careerRoot: career });
  combineRun(run);
  const plan = planEvaluations(run, undefined, career).output;
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json')));
  assert.deepEqual(acquisition.keys.sort(), ['linkedin:linkedin.com:50000001', 'linkedin:linkedin.com:50000002']);
  assert.deepEqual(Object.values(plan.assignments).flat().sort(), acquisition.keys.sort());
  assert.equal(acquisition.location_exclusion_count, 4);
  assert.equal(acquisition.location_ambiguous_count, 1);
  const audit = JSON.parse(readFileSync(path.join(run, 'triage/location-scope.json')));
  assert.equal(audit.pre_scope_count, 6);
  assert.equal(audit.accepted_count, 2);
  assert.equal(audit.excluded_count, 4);
  assert.deepEqual(new Set(audit.results.filter(item => !item.allowed).map(item => item.decision)), new Set(['EXCLUDE_NONLOCAL', 'AMBIGUOUS_NO_REMOTE_SIGNAL']));
  assert.equal(validateRun(run).errors.length, 0);

  unlinkSync(path.join(run, 'assignments.json'));
  combineRun(run);
  const recovered = planEvaluations(run, undefined, career).output;
  assert.deepEqual(Object.values(recovered.assignments).flat().sort(), ['linkedin:linkedin.com:50000001', 'linkedin:linkedin.com:50000002']);
  assert.equal(validateRun(run).errors.length, 0, 'an audit-only interruption must be safely resumable');
});

test('semantic dedup report and candidate diff contains only same-context aliases', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-semantic-dedup-'));
  const run = twoJobRun(root, 'run-1', [
    { id: '50000101', company: 'Acme', location: 'Seattle, WA', workplaceType: 'onsite', semanticToken: 'same-job' },
    { id: '50000102', company: 'Acme', location: 'Seattle, WA', workplaceType: 'onsite', semanticToken: 'same-job' },
    { id: '50000103', company: 'Acme', location: 'United States', workplaceType: 'remote', structuredRemoteSignal: true, semanticToken: 'same-job' },
    { id: '50000104', company: 'Other', location: 'Seattle, WA', workplaceType: 'onsite', semanticToken: 'same-job' },
  ]);
  const career = careerFixture(root);
  write(path.join(career, 'reports/existing.md'), 'https://www.linkedin.com/jobs/view/50000101\n');
  captureBaseline({ runRoot: run, careerRoot: career });
  const shadow = planEvaluations(run, modeRuntime(root, 'shadow'), career).output;
  assert.equal(Object.values(shadow.assignments).flat().length, 3);
  let audit = JSON.parse(readFileSync(path.join(run, 'triage/canonical-url-resolutions.json'), 'utf8')).semantic_deduplication;
  assert.equal(audit.exact_history_duplicate_count, 1);
  assert.equal(audit.same_context_semantic_alias_count, 1);
  assert.equal(audit.enforced_semantic_alias_count, 0);
  let records = new Map(JSON.parse(readFileSync(path.join(run, 'acquisition.json'), 'utf8')).acquired.map(record => [record.primary_key, record]));
  writeWorkerResults(run, key => {
    const record = records.get(key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, key) };
  });
  const shadowResults = loadScanResults(run);
  assert.deepEqual(shadowResults.errors, []);
  const shadowCandidateKeys = shadowResults.candidates.map(item => item.posting_key).sort();
  const shadowReportKeys = shadowResults.candidates.map(item => readCompactReportSummary(renderCompactReport({ result: item, record: records.get(item.posting_key), runId: 'run-1' })).posting_key).sort();
  assert.deepEqual(shadowReportKeys, shadowCandidateKeys);

  unlinkSync(path.join(run, 'assignments.json'));
  combineRun(run);
  const enforce = planEvaluations(run, modeRuntime(root, 'enforce'), career).output;
  assert.equal(Object.values(enforce.assignments).flat().length, 2);
  audit = JSON.parse(readFileSync(path.join(run, 'triage/canonical-url-resolutions.json'), 'utf8')).semantic_deduplication;
  assert.equal(audit.enforced_semantic_alias_count, 1);
  const aliasKeys = audit.results.filter(item => item.disposition === 'SAME_CONTEXT_SEMANTIC_ALIAS').map(item => item.primary_key).sort();
  records = new Map(JSON.parse(readFileSync(path.join(run, 'acquisition.json'), 'utf8')).acquired.map(record => [record.primary_key, record]));
  writeWorkerResults(run, key => {
    const record = records.get(key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, key) };
  });
  const enforceResults = loadScanResults(run);
  assert.deepEqual(enforceResults.errors, []);
  const enforceCandidateKeys = enforceResults.candidates.map(item => item.posting_key).sort();
  const enforceReportKeys = enforceResults.candidates.map(item => readCompactReportSummary(renderCompactReport({ result: item, record: records.get(item.posting_key), runId: 'run-1' })).posting_key).sort();
  assert.deepEqual(enforceReportKeys, enforceCandidateKeys);
  assert.deepEqual(shadowCandidateKeys.filter(key => !enforceCandidateKeys.includes(key)), aliasKeys);
  assert.deepEqual(shadowReportKeys.filter(key => !enforceReportKeys.includes(key)), aliasKeys);
  assert.deepEqual(enforceCandidateKeys.filter(key => !shadowCandidateKeys.includes(key)), []);
  assert.deepEqual(enforceReportKeys.filter(key => !shadowReportKeys.includes(key)), []);
  assert.ok(enforceCandidateKeys.includes('linkedin:linkedin.com:50000103'), 'new posting context must remain a candidate');
  assert.ok(enforceCandidateKeys.includes('linkedin:linkedin.com:50000104'), 'different employer must remain a candidate');
});

test('planner preflights candidate sources before mutating an enforce run', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-plan-preflight-'));
  const run = twoJobRun(root, 'run-1', [
    { id: '50000121', company: 'Acme' },
    { id: '50000122', company: 'Acme' },
  ]);
  const career = careerFixture(root);
  captureBaseline({ runRoot: run, careerRoot: career });
  const before = readFileSync(path.join(run, 'acquisition.json'), 'utf8');
  const jobs = readdirSync(path.join(run, 'jobs')).sort();
  unlinkSync(path.join(career, 'modes/_profile.md'));
  assert.throws(() => planEvaluations(run, modeRuntime(root, 'enforce'), career), /approved candidate source missing/);
  assert.equal(readFileSync(path.join(run, 'acquisition.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(path.join(run, 'jobs')).sort(), jobs);
  assert.equal(existsSync(path.join(run, 'assignments.json')), false);
});

test('canonical resolution merges the Ashby query-link duplicate before assignment', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-ashby-query-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, 'runs', 'run-1');
  const id = '11111111-2222-4333-8444-555555555555';
  const key = `ashby:acme:${id.toUpperCase()}`;
  source(run, 'jobspy', {
    '1000000104.md': markdown({ url: 'https://www.linkedin.com/jobs/view/1000000104', id: '1000000104', source: 'jobspy', extra: `Official job: https://jobs.ashbyhq.com/acme?ashby_jid=${id}` }),
  });
  source(run, 'ego-browser', {
    'ashby.md': markdown({ url: `https://jobs.ashbyhq.com/acme/${id}`, key, source: 'ego-browser' }),
  });
  source(run, 'jobright', {});
  const career = careerFixture(root);
  captureBaseline({ runRoot: run, careerRoot: career });
  combineRun(run);
  await resolveCanonicalUrls(run);
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json')));
  assert.equal(acquisition.acquired.length, 1);
  assert.deepEqual(acquisition.acquired[0].posting_keys, [key, 'linkedin:linkedin.com:1000000104']);
  assert.deepEqual(Object.values(planEvaluations(run, undefined, career).output.assignments).flat(), [key]);
});

test('fixture source merges one LinkedIn and Greenhouse posting, then completes exact-set closeout', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-multisource-'));
  const run = path.join(root, 'runs', 'run-1');
  const greenhouse = 'https://boards.greenhouse.io/acme/jobs/123456';
  source(run, 'jobspy', {
    '1000000105.md': markdown({ url: 'https://www.linkedin.com/jobs/view/1000000105', id: '1000000105', source: 'jobspy', extra: `Official job: ${greenhouse}` }),
    '1000000106.md': markdown({ url: 'https://www.linkedin.com/jobs/view/1000000106', id: '1000000106', source: 'jobspy', company: 'Other' }),
  });
  source(run, 'ego-browser', {
    'greenhouse.md': markdown({ url: greenhouse, key: 'greenhouse:acme:123456', source: 'ego-browser' }),
  });
  source(run, 'jobright', {});
  const career = careerFixture(root);
  captureBaseline({ runRoot: run, careerRoot: career });
  combineRun(run);
  mkdirSync(path.join(run, 'sources', 'disabled-source'));
  assert.ok(validateRun(run).errors.includes('unselected source artifacts present: disabled-source'));
  rmSync(path.join(run, 'sources', 'disabled-source'), { recursive: true });
  assert.equal(JSON.parse(readFileSync(path.join(run, 'acquisition.json'))).acquired.length, 3);
  await resolveCanonicalUrls(run);
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json')));
  assert.equal(acquisition.acquired.length, 2);
  const merged = acquisition.acquired.find(item => item.primary_key === 'greenhouse:acme:123456');
  assert.deepEqual(merged.posting_keys, ['greenhouse:acme:123456', 'linkedin:linkedin.com:1000000105']);
  const before = readFileSync(path.join(career, 'data/scan-history.tsv'), 'utf8');
  const plannedOnce = planEvaluations(run, undefined, career).output;
  const plannedTwice = planEvaluations(run, undefined, career).output;
  assert.deepEqual(plannedTwice.assignments, plannedOnce.assignments);
  assert.equal(Object.keys(plannedOnce.primary_urls).length, acquisition.acquired.length);
  assert.equal(plannedOnce.primary_urls['greenhouse:acme:123456'], greenhouse);
  assert.equal(existsSync(path.join(run, 'handoff.json')), false);
  assert.equal(existsSync(path.join(run, 'triage/canonical-url-fingerprints.json')), false);
  assert.equal(JSON.parse(readFileSync(path.join(run, 'triage/canonical-url-resolutions.json'))).history_deduplication.exact_set_verified, true);
  assert.equal(readFileSync(path.join(career, 'data/scan-history.tsv'), 'utf8'), before, 'pre-scoring stages must not write Career-Ops');
  writeWorkerResults(run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return key.startsWith('greenhouse:')
      ? { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) }
      : { posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null };
  });
  write(path.join(career, 'output/.DS_Store'), 'ignored');
  // A tailored-resume build running alongside the scan must not fail closeout.
  write(path.join(career, 'output/101-example-backend/cv/tailored/v004/cv.docx'), 'docx');
  write(path.join(career, 'output/101-example-backend/cv/tailored/v004/changes.md'), '# notes\n');
  const { receipt } = await commitScan(run, career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.deepEqual(receipt.candidate_keys, ['greenhouse:acme:123456']);
  assert.equal('cv_unchanged' in receipt, false);
  assert.equal('output_file_count_delta' in receipt, false);
  assert.equal('concurrent_resume_builds' in receipt, false);
  assert.equal(existsSync(path.join(career, 'output/101-example-backend/cv/tailored/v004/cv.docx')), true);
  assert.equal(existsSync(path.join(career, 'output/101-example-backend/cv/tailored/v004/changes.md')), true);
  const renderedReport = readFileSync(path.join(career, receipt.reports[0].report_path), 'utf8');
  assert.match(renderedReport, /\*\*Posting Key:\*\* greenhouse:acme:123456/);
  assert.match(renderedReport, /^via: "LinkedIn"$/m);
  assert.match(readFileSync(path.join(career, 'data/applications.md'), 'utf8'), /job id 123456/);
});

test('canonical URL resolution follows a Greenhouse tenant redirect without guessing from company or job id', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-greenhouse-redirect-'));
  const run = path.join(root, 'runs', 'run-1');
  const sourceUrl = 'https://app.greenhouse.io/embed/job_app?token=1000001';
  const intermediateUrl = 'https://boards.greenhouse.io/embed/job_app?token=1000001';
  const resolvedUrl = 'https://job-boards.greenhouse.io/embed/job_app?for=examplepay&token=1000001';
  source(run, 'jobspy', {});
  source(run, 'ego-browser', {});
  source(run, 'jobright', {
    'examplepay.md': markdown({
      url: sourceUrl,
      key: 'greenhouse:app.greenhouse.io:1000001',
      source: 'jobright',
      company: 'Example Pay',
      role: 'Backend API Engineer',
    }),
  });
  combineRun(run);

  const requests = [];
  await resolveCanonicalUrls(run, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 301, headers: { location: url === sourceUrl ? intermediateUrl : resolvedUrl } });
    },
  });

  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json')));
  assert.equal(acquisition.acquired.length, 1);
  assert.equal(acquisition.acquired[0].primary_key, 'greenhouse:examplepay:1000001');
  assert.equal(acquisition.acquired[0].primary_url, resolvedUrl);
  assert.deepEqual(acquisition.acquired[0].posting_keys, ['greenhouse:examplepay:1000001']);
  assert.deepEqual(acquisition.acquired[0].source_keys, { jobright: 'greenhouse:examplepay:1000001' });
  assert.deepEqual(acquisition.acquired[0].posting_urls, { 'greenhouse:examplepay:1000001': resolvedUrl });
  assert.deepEqual(requests, [sourceUrl, intermediateUrl].map(url => ({ url, options: { method: 'HEAD', redirect: 'manual' } })));
});

test('worker failures persist only committed history and complete whenever any posting succeeds', async () => {
  const fx = bulkRun(150, index => index === 5 ? 'U.S. citizenship is required.' : '');
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const failedKeys = new Set(JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json'))).keys.slice(0, 5));
  const hardExclusionKey = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json'))).keys.find(key => !failedKeys.has(key));
  writeWorkerResults(fx.run, (key, runtime) => {
    if (failedKeys.has(key)) return { posting_key: key, status: 'FAILED', attempts: runtime.failure.per_job_retry_limit + 1, error: 'model failed after configured retries', report: null };
    const hardExclusion = key === hardExclusionKey;
    return { posting_key: key, score: 3.5, hard_exclusion: hardExclusion, hard_exclusion_evidence: hardExclusion ? 'JD: "U.S. citizenship is required."' : null, rationale: hardExclusion ? 'The JD explicitly requires U.S. citizenship.' : 'Material baseline gaps keep this below the report threshold.', report: null };
  });
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.schema_version, 4);
  assert.equal(receipt.evaluated_keys.length, 145);
  assert.equal(receipt.failed.length, 5);
  assert.equal(receipt.job_issues.length, 5);
  assert.equal(receipt.persistence_decision.allowed, true);
  assert.equal(receipt.below_threshold_count, 144);
  assert.deepEqual(receipt.hard_exclusion_keys, [hardExclusionKey]);
  const history = readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:run-1'));
  assert.equal(history.length, 145);
  for (const key of failedKeys) assert.doesNotMatch(history.join('\n'), new RegExp(key.split(':').at(-1)));
});

test('even 96 percent job issues complete and persist the one successful posting', async () => {
  const fx = bulkRun(25);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const keys = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json'))).keys;
  const failed = new Set(keys.slice(0, 24));
  writeWorkerResults(fx.run, (key, runtime) => failed.has(key)
    ? { posting_key: key, status: 'FAILED', attempts: runtime.failure.per_job_retry_limit + 1, error: 'model failed after configured retries', report: null }
    : { posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null });
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.job_issue_ratio, 24 / 25);
  assert.equal(receipt.persistence_decision.allowed, true);
  assert.equal(receipt.committed_evaluated_keys.length, 1);
  assert.equal(receipt.job_issues.length, 24);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:run-1')).length, 1);
  assert.equal(readdirSync(path.join(fx.career, 'jds')).length, 1);
});

test('a single-candidate merge failure becomes a job issue and zero success leaves the run FAILED', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  const trackerBefore = readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8');
  const historyBefore = readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8');
  write(path.join(fx.career, 'merge-tracker.mjs'), "console.error('fixture merge failure'); process.exit(1);\n");
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.job_issues[0].code, 'TRACKER_MERGE_FAILED');
  assert.equal(receipt.persistence_decision.has_successful_posting, false);
  assert.deepEqual(readdirSync(path.join(fx.career, 'reports')), []);
  assert.deepEqual(readdirSync(path.join(fx.career, 'jds')), []);
  assert.deepEqual(readdirSync(path.join(fx.career, 'batch/tracker-additions')), []);
  assert.equal(readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8'), trackerBefore);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8'), historyBefore);
  assert.equal(existsSync(path.join(fx.run, 'handoff.json')), false);
  assert.equal(existsSync(path.join(fx.run, 'report-render-plan.json')), false);
  assert.equal(existsSync(path.join(fx.run, 'rendered-reports.json')), false);
  assert.equal(existsSync(path.join(fx.run, 'receipt.json')), true);
});

test('a candidate merge failure is isolated and the remaining postings commit', async () => {
  const fx = bulkRun(5);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  const badKey = acquisition.keys[0];
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  write(path.join(fx.career, 'merge-tracker.mjs'), `
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
const additions = process.env.CAREER_OPS_ADDITIONS || 'batch/tracker-additions';
const trackerFile = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
let tracker = readFileSync(trackerFile, 'utf8').trimEnd();
for (const name of readdirSync(additions).filter(name => name.endsWith('.tsv'))) {
  const raw = readFileSync(additions + '/' + name, 'utf8');
  if (raw.includes(${JSON.stringify(`posting key ${badKey}`)})) { console.error('fixture scoped merge failure'); process.exit(1); }
  const cells = raw.trim().split('\\n').at(-1).split('\t');
  tracker += '\\n| ' + cells.join(' | ') + ' |';
  unlinkSync(additions + '/' + name);
}
writeFileSync(trackerFile, tracker + '\\n');
`);
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.job_issue_ratio, 0.2);
  assert.equal(receipt.persistence_decision.allowed, true);
  assert.deepEqual(receipt.job_issue_keys, [badKey]);
  assert.equal(receipt.job_issues[0].code, 'TRACKER_MERGE_FAILED');
  assert.equal(receipt.committed_evaluated_keys.length, 4);
  assert.equal(receipt.reports.length, 4);
  assert.equal((await parseCareerTracker(fx.career)).length, 4);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:run-1')).length, 4);
});

test('tracker savepoint restores an attempted existing-row rewrite and commits the other four candidates', async () => {
  const fx = bulkRun(5);
  const trackerFile = path.join(fx.career, 'data/applications.md');
  const seeded = `${readFileSync(trackerFile, 'utf8').trimEnd()}\n| 50 | 2026-01-01 | Legacy Co | Legacy Role | 3.0/5 | Evaluated | ❌ | [50](reports/050-legacy.md) | preserve me |\n`;
  write(trackerFile, seeded);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  const badKey = acquisition.keys[0];
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  write(path.join(fx.career, 'merge-tracker.mjs'), `
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
const additions = process.env.CAREER_OPS_ADDITIONS || 'batch/tracker-additions';
const trackerFile = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
let tracker = readFileSync(trackerFile, 'utf8').trimEnd();
for (const name of readdirSync(additions).filter(name => name.endsWith('.tsv'))) {
  const raw = readFileSync(additions + '/' + name, 'utf8');
  if (raw.includes(${JSON.stringify(`posting key ${badKey}`)})) tracker = tracker.replace('Legacy Co', 'Mutated Co');
  const cells = raw.trim().split('\\n').at(-1).split('\t');
  tracker += '\\n| ' + cells.join(' | ') + ' |';
  unlinkSync(additions + '/' + name);
}
writeFileSync(trackerFile, tracker + '\\n');
`);
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.job_issues[0].code, 'TRACKER_EXISTING_ROW_CHANGED');
  const finalTracker = readFileSync(trackerFile, 'utf8');
  assert.match(finalTracker, /\| 50 \| 2026-01-01 \| Legacy Co \|/);
  assert.doesNotMatch(finalTracker, /Mutated Co/);
  assert.equal((await parseCareerTracker(fx.career, finalTracker)).length, 5);
});

test('official merge isolation disables global PDF reconciliation and leaves the shared additions queue untouched', async () => {
  const fx = bulkRun(2);
  const trackerFile = path.join(fx.career, 'data/applications.md');
  const seeded = `${readFileSync(trackerFile, 'utf8').trimEnd()}\n| 1302 | 2026-01-01 | Tailscale | Software Engineer | 4.0/5 | Evaluated | ❌ | [1302](reports/1302-tailscale.md) | preserve me |\n`;
  write(trackerFile, seeded);
  write(path.join(fx.career, 'data/pdf-index.tsv'), '1302\toutput/1302-cover-letter.pdf\tletter\n');
  const unrelatedAddition = path.join(fx.career, 'batch/tracker-additions/unrelated.tsv');
  write(unrelatedAddition, 'leave this queue item alone\n');
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  write(path.join(fx.career, 'merge-tracker.mjs'), `
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
const additions = process.env.CAREER_OPS_ADDITIONS || 'batch/tracker-additions';
const pdfIndex = process.env.CAREER_OPS_PDF_INDEX || 'data/pdf-index.tsv';
const trackerFile = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
let tracker = readFileSync(trackerFile, 'utf8').trimEnd();
if (existsSync(pdfIndex) && readFileSync(pdfIndex, 'utf8').startsWith('1302\\t')) tracker = tracker.replace('| 1302 | 2026-01-01 | Tailscale | Software Engineer | 4.0/5 | Evaluated | ❌ |', '| 1302 | 2026-01-01 | Tailscale | Software Engineer | 4.0/5 | Evaluated | ✅ |');
for (const name of readdirSync(additions).filter(name => name.endsWith('.tsv'))) {
  const cells = readFileSync(additions + '/' + name, 'utf8').trim().split('\\n').at(-1).split('\\t');
  tracker += '\\n| ' + cells.join(' | ') + ' |';
  unlinkSync(additions + '/' + name);
}
writeFileSync(trackerFile, tracker + '\\n');
`);

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.reports.length, 2);
  const finalTracker = readFileSync(trackerFile, 'utf8');
  assert.match(finalTracker, /\| 1302 \| 2026-01-01 \| Tailscale \| Software Engineer \| 4\.0\/5 \| Evaluated \| ❌ \|/);
  assert.equal((await parseCareerTracker(fx.career, finalTracker)).length, 3);
  assert.equal(readFileSync(unrelatedAddition, 'utf8'), 'leave this queue item alone\n');
});

test('official tracker parsing supports Via, Location, and URL columns without fixed positions', async () => {
  const fx = bulkRun(1);
  const trackerFile = path.join(fx.career, 'data/applications.md');
  write(trackerFile, '# Applications Tracker\n\n| # | Date | Company | Via | Role | Location | Score | Status | PDF | URL | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n');
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  writeHeaderAwareMerge(fx.career, acquisition.acquired[0].primary_url);

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  const rows = await parseCareerTracker(fx.career);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parsed.via, 'LinkedIn');
  assert.equal(rows[0].parsed.location, 'Seattle, WA');
  assert.equal(rows[0].report_path, receipt.reports[0].report_path);
});

test('a blank or wrong authoritative tracker URL is isolated as a posting issue', async () => {
  const fx = bulkRun(1);
  write(path.join(fx.career, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Via | Role | Location | Score | Status | PDF | URL | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n');
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  writeHeaderAwareMerge(fx.career, 'https://example.com/wrong-posting');

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.job_issues[0].code, 'TRACKER_URL_MISMATCH');
  assert.equal((await parseCareerTracker(fx.career)).length, 0);
  assert.deepEqual(readdirSync(path.join(fx.career, 'reports')), []);
});

test('a concurrent tracker change stops safely without overwriting the external row', async () => {
  const fx = bulkRun(1);
  const hook = path.join(fx.career, 'data/inject-concurrent-row');
  write(hook, 'once\n');
  write(path.join(fx.career, 'tracker-utils.mjs'), `
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const resolveTrackerPath = root => path.join(root, 'data/applications.md');
export const writeFileAtomic = (file, content) => { const staged = file + '.tmp-' + process.pid; writeFileSync(staged, content); renameSync(staged, file); };
export async function openTrackerTransaction(file) {
  const hook = path.join(path.dirname(file), 'inject-concurrent-row');
  if (existsSync(hook)) {
    unlinkSync(hook);
    const current = readFileSync(file, 'utf8').trimEnd();
    writeFileAtomic(file, current + '\\n| 77 | 2026-08-07 | Concurrent Co | External Role | 3.0/5 | Applied | ❌ |  | external writer |\\n');
  }
  let closed = false;
  return {
    read() { if (closed) throw new Error('closed'); return readFileSync(file, 'utf8'); },
    replace(content) { if (closed) throw new Error('closed'); writeFileAtomic(file, content); },
    close() { closed = true; return null; },
  };
}
`);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.system_errors.join('\n'), /tracker changed while this candidate was prepared/);
  const tracker = readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8');
  assert.match(tracker, /\| 77 \| 2026-08-07 \| Concurrent Co \| External Role \|/);
  assert.equal((await parseCareerTracker(fx.career, tracker)).length, 1);
  assert.deepEqual(readdirSync(path.join(fx.career, 'reports')), []);
});

test('commit follows Career-Ops tracker root layout and scan-history lane overrides', async () => {
  const fx = bulkRun(1);
  const dataTracker = path.join(fx.career, 'data/applications.md');
  const rootTracker = path.join(fx.career, 'applications.md');
  write(rootTracker, readFileSync(dataTracker, 'utf8'));
  unlinkSync(dataTracker);
  const customHistory = path.join(fx.career, 'data/custom-history.tsv');
  write(customHistory, 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n');
  const previousTracker = process.env.CAREER_OPS_TRACKER;
  const previousHistory = process.env.CAREER_OPS_SCAN_HISTORY;
  process.env.CAREER_OPS_TRACKER = 'applications.md';
  process.env.CAREER_OPS_SCAN_HISTORY = 'data/custom-history.tsv';
  try {
    captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
    planEvaluations(fx.run, undefined, fx.career);
    const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
    writeWorkerResults(fx.run, key => {
      const record = acquisition.acquired.find(item => item.primary_key === key);
      return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
    });

    const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
    assert.equal(receipt.status, 'COMPLETE', JSON.stringify(receipt, null, 2));
    assert.equal(existsSync(dataTracker), false);
    assert.equal((await parseCareerTracker(fx.career, readFileSync(rootTracker, 'utf8'))).length, 1);
    assert.match(readFileSync(customHistory, 'utf8'), /daily-scan:run-1/);
    assert.doesNotMatch(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8'), /daily-scan:run-1/);
  } finally {
    if (previousTracker === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = previousTracker;
    if (previousHistory === undefined) delete process.env.CAREER_OPS_SCAN_HISTORY;
    else process.env.CAREER_OPS_SCAN_HISTORY = previousHistory;
  }
});

test('one post-score history duplicate among 210 postings is receipt-only and 209 commit', async () => {
  const fx = bulkRun(210);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  const duplicateKey = acquisition.keys[0];
  const duplicateId = duplicateKey.split(':').at(-1);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  write(path.join(fx.career, 'reports/102-existing.md'), `# Existing\n\n**URL:** https://apply.careers.microsoft.com/careers/job/1000000000000001\n**Posting Key:** generic:apply.careers.microsoft.com:1000000000000001\n**LinkedIn Job ID:** ${duplicateId}\n`);
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.committed_evaluated_keys.length, 209);
  assert.deepEqual(receipt.job_issue_keys, [duplicateKey]);
  assert.equal(receipt.job_issues[0].code, 'HISTORY_DUPLICATE');
  assert.equal(receipt.job_issues[0].existing_report, 'career-ops/reports/102-existing.md');
  assert.equal(readdirSync(path.join(fx.career, 'jds')).length, 209);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:run-1')).length, 209);
});

test('shared commit lock isolates a semantic history collision created while scoring', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-semantic-collision-'));
  const career = careerFixture(root);
  const runtime = modeRuntime(root, 'enforce');
  const first = twoJobRun(root, 'run-first', [{ id: '50000201', company: 'Acme', semanticToken: 'same-job' }]);
  const second = twoJobRun(root, 'run-second', [{ id: '50000202', company: 'Acme', semanticToken: 'same-job' }]);
  for (const run of [first, second]) {
    captureBaseline({ runRoot: run, careerRoot: career });
    planEvaluations(run, runtime, career);
    writeWorkerResults(run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  }
  const outcomes = await Promise.all([
    commitScan(first, career, '2026-08-30'),
    commitScan(second, career, '2026-08-30'),
  ]);
  const complete = outcomes.filter(item => item.receipt.status === 'COMPLETE');
  const failed = outcomes.filter(item => item.receipt.status === 'FAILED');
  assert.equal(complete.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].receipt.job_issues.length, 1);
  assert.equal(failed[0].receipt.job_issues[0].code, 'SEMANTIC_HISTORY_COLLISION');
  const policy = JSON.parse(readFileSync(path.join(first, 'assignments.json'), 'utf8')).location_policy;
  const history = [...collectHistoricalSemanticContexts({ careerRoot: career, locationPolicy: policy })];
  assert.equal(history.flatMap(([, matches]) => matches).length, 1);
  assert.equal(readFileSync(path.join(career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:')).length, 1);
  assert.equal(readdirSync(path.join(career, 'jds')).filter(name => name.endsWith('.md')).length, 1);
});

test('commit refuses a Career-Ops root different from the assignments snapshot', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  const otherCareer = careerFixture(mkdtempSync(path.join(os.tmpdir(), 'daily-other-career-')));
  await assert.rejects(commitScan(fx.run, otherCareer, '2026-08-30'), /Career-Ops root does not match/);
  assert.doesNotMatch(readFileSync(path.join(otherCareer, 'data/scan-history.tsv'), 'utf8'), /daily-scan:/);
});

test('report rendering is commit-internal and refuses a different Career-Ops root before reservation', () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  const otherCareer = careerFixture(mkdtempSync(path.join(os.tmpdir(), 'daily-other-render-root-')));
  let reserved = false;
  assert.throws(() => renderScanReports({
    runRoot: fx.run,
    careerRoot: otherCareer,
    date: '2026-08-30',
    validated: { run: validateRun(fx.run), results: loadScanResults(fx.run) },
    reserveBatch() { reserved = true; return []; },
  }), /Career-Ops root does not match/);
  assert.equal(reserved, false);
});

test('a missing JD after scoring is isolated while the remaining postings commit', async () => {
  const fx = bulkRun(5);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  const missing = acquisition.acquired[0];
  unlinkSync(path.join(fx.run, missing.jd_path));
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.deepEqual(receipt.job_issue_keys, [missing.primary_key]);
  assert.equal(receipt.job_issues[0].code, 'JD_CONTRACT_ERROR');
  assert.equal(receipt.scan_history_keys.length, 4);
  assert.equal(readdirSync(path.join(fx.career, 'jds')).length, 4);
});

test('one invalid report contract that reaches commit is isolated while four valid candidates commit', async () => {
  const fx = bulkRun(5);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  const badKey = acquisition.keys[0];
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    const payload = report(record.company, record.title, record.primary_url, record.primary_key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: payload };
  });
  const plan = JSON.parse(readFileSync(path.join(fx.run, 'assignments.json'), 'utf8'));
  const worker = Object.entries(plan.assignments).find(([, keys]) => keys.includes(badKey))[0];
  const workerFile = path.join(fx.run, 'results', `${worker}.json`);
  const workerResult = JSON.parse(readFileSync(workerFile, 'utf8'));
  const invalid = workerResult.results.find(item => item.posting_key === badKey);
  invalid.report.reason = '';
  write(workerFile, workerResult);
  const keyIndex = plan.assignments[worker].indexOf(badKey);
  const partNumber = Math.floor(keyIndex / plan.runtime.scheduler.batch_size) + 1;
  const partFile = path.join(fx.run, 'results', `${worker}.part-${partNumber}.json`);
  const part = JSON.parse(readFileSync(partFile, 'utf8'));
  const invalidPart = part.results.find(item => item.posting_key === badKey);
  invalidPart.report.reason = '';
  write(partFile, part);
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.deepEqual(receipt.job_issue_keys, [badKey]);
  assert.equal(receipt.job_issues[0].code, 'REPORT_CONTRACT_ERROR');
  assert.equal(receipt.reports.length, 4);
  assert.equal(receipt.tracker_keys.length, 4);
  assert.equal(receipt.scan_history_keys.length, 4);
});

test('pipeline warnings are ignored and are not written into the receipt', async () => {
  const fx = bulkRun(2);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  write(path.join(fx.career, 'verify-pipeline.mjs'), "console.log('⚠️ Schema drift without a posting identity'); console.log('Pipeline Health: 0 errors, 1 warning')\n");
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.deepEqual(receipt.career_ops_pipeline.after, { errors: 0, exit_code: 0 });
  assert.equal(JSON.stringify(receipt).includes('warning'), false);
  assert.equal(readdirSync(path.join(fx.career, 'jds')).length, 2);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:')).length, 2);
});

test('a nonzero pipeline verifier exit cannot close COMPLETE after printing zero errors', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  write(path.join(fx.career, 'verify-pipeline.mjs'), "console.log('Pipeline Health: 0 errors, 0 warnings'); process.exit(1)\n");

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.system_errors.join('\n'), /pipeline verifier exited 1/);
});

test('tracker database sync failure is system-level and rolls back every Career-Ops write', async () => {
  const fx = bulkRun(2);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  write(path.join(fx.career, 'tracker.mjs'), "console.error('fixture database sync failure'); process.exit(1);\n");
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.system_errors.join('\n'), /tracker\.mjs failed: fixture database sync failure/);
  assert.equal(readdirSync(path.join(fx.career, 'jds')).length, 0);
  assert.equal(readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8').split('\n').filter(line => line.includes('daily-scan:')).length, 0);
});

test('system compensation removes only this run and preserves concurrent tracker and history rows', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  writeWorkerResults(fx.run, key => {
    const record = acquisition.acquired.find(item => item.primary_key === key);
    return { posting_key: key, score: 4.2, hard_exclusion: false, report: report(record.company, record.title, record.primary_url, record.primary_key) };
  });
  write(path.join(fx.career, 'tracker.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync('data/applications.md', '| 88 | 2026-08-07 | External Co | External Role | 3.0/5 | Applied | ❌ |  | external writer |\\n');
appendFileSync('data/scan-history.tsv', 'https://example.com/external\\t2026-08-07\\texternal\\tExternal Role\\tExternal Co\\texternal-writer\\tSeattle, WA\\n');
console.error('fixture database sync failure after concurrent writes');
process.exit(1);
`);

  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'FAILED');
  const tracker = readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8');
  assert.match(tracker, /\| 88 \| 2026-08-07 \| External Co \| External Role \|/);
  assert.doesNotMatch(tracker, /posting key linkedin:linkedin\.com:/);
  const history = readFileSync(path.join(fx.career, 'data/scan-history.tsv'), 'utf8');
  assert.match(history, /https:\/\/example\.com\/external/);
  assert.doesNotMatch(history, /daily-scan:run-1/);
  assert.deepEqual(readdirSync(path.join(fx.career, 'reports')), []);
  assert.deepEqual(readdirSync(path.join(fx.career, 'jds')), []);
});

test('committing a scan preserves candidate documents and existing output', async () => {
  const fx = bulkRun(1);
  const cvFile = path.join(fx.career, 'cv.md');
  const cvBefore = readFileSync(cvFile, 'utf8');
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  assert.throws(() => captureBaseline({ runRoot: fx.run, careerRoot: fx.career }), /baseline already exists/);
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  write(path.join(fx.career, 'cv-sync-check.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('cv.md', '# unauthorized mutation\\n');\n");
  const { receipt } = await commitScan(fx.run, fx.career, '2026-08-07');
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(readFileSync(cvFile, 'utf8'), cvBefore);
  assert.equal(existsSync(path.join(fx.career, 'output/existing.txt')), true);
});

test('tracker identity note protects requisitions with unsupported separators', () => {
  const key = 'generic:jobright.ai:B2B_1000000000000_101';
  const note = trackerIdentityNote({ primary_key: key });
  assert.match(note, /job id B2B-1000000000000-101/);
  assert.match(note, /source job id B2B_1000000000000_101/);
  const reqPattern = /\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/i;
  assert.equal(note.match(reqPattern)?.[1], 'B2B-1000000000000-101');
});

test('run contract rejects a sign-in placeholder before scoring', () => {
  const fx = bulkRun(1);
  const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json')));
  write(path.join(fx.run, acquisition.acquired[0].jd_path), `Sign in to view this job ${'x'.repeat(300)}`);
  assert.ok(validateRun(fx.run).errors.some(error => error.includes('blocked/error page')));
});

test('run contract rejects an excluded mirror employer before scoring', () => {
  for (const attribution of [
    'Amazon\n\nEmployees at Amazon are often offered comprehensive health benefits.\n\nFiling entity: Amazon Com Services Llc',
    'Amazon is an equal opportunity employer and values diversity in our workforce.',
  ]) {
    const fx = bulkRun(1, () => attribution);
    try {
      assert.ok(validateRun(fx.run).errors.some(error => error.includes('JD matches employer exclusion amazon-aws')));
      assert.throws(() => planEvaluations(fx.run, undefined, fx.career), /JD matches employer exclusion amazon-aws/);
      assert.equal(existsSync(path.join(fx.run, 'assignments.json')), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('receipt audit is pure and does not create a receipt', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  const committed = await commitScan(fx.run, fx.career, '2026-08-07');
  unlinkSync(committed.receiptFile);
  const audited = await auditScanReceipt({
    runRoot: fx.run,
    careerRoot: fx.career,
    committedEvaluatedKeys: committed.receipt.committed_evaluated_keys,
    eligibleEvaluatedKeys: committed.receipt.eligible_evaluated_keys,
  });
  assert.equal(audited.receipt.status, 'COMPLETE');
  assert.equal(existsSync(audited.receiptFile), false);
});

test('a pre-existing receipt is create-only and prevents every Career-Ops write', async () => {
  const fx = bulkRun(1);
  captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
  planEvaluations(fx.run, undefined, fx.career);
  writeWorkerResults(fx.run, key => ({ posting_key: key, score: 3.5, hard_exclusion: false, rationale: 'Material baseline gaps keep this below the report threshold.', report: null }));
  const receiptFile = path.join(fx.run, 'receipt.json');
  const original = '{"immutable":true}\n';
  write(receiptFile, original);
  const trackerBefore = readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8');
  await assert.rejects(commitScan(fx.run, fx.career, '2026-08-07'), /receipt already exists/);
  assert.equal(readFileSync(receiptFile, 'utf8'), original);
  assert.equal(readFileSync(path.join(fx.career, 'data/applications.md'), 'utf8'), trackerBefore);
  assert.deepEqual(readdirSync(path.join(fx.career, 'jds')), []);
});

test('committed report headers use authoritative tier, work authorization and Machine Summary archetype', async () => {
  const cases = [
    { tier: 'High Confidence', auth: 'sponsors', label: '✅ Sponsors', archetype: 'Site Reliability Engineer', display: 'Site Reliability Engineer', jd: 'Visa sponsorship is available for this role.' },
    { tier: 'Proceed with Caution', auth: 'unstated', label: '⚠️ Unstated', archetype: "Developer's tools", display: "Developer's tools", jd: '' },
    { tier: 'Suspicious', auth: 'not_needed', label: '➖ Not needed', archetype: null, display: 'Unstated', jd: '' },
  ];
  for (const sample of cases) {
    const fx = bulkRun(1, () => sample.jd);
    if (sample.auth === 'not_needed') write(path.join(fx.career, 'config/profile.yml'), readFileSync(path.join(fx.career, 'config/profile.yml'), 'utf8').replace('"H-1B"', '"unrestricted"').replace('needs_sponsorship: true', 'needs_sponsorship: false'));
    captureBaseline({ runRoot: fx.run, careerRoot: fx.career });
    planEvaluations(fx.run, undefined, fx.career);
    const acquisition = JSON.parse(readFileSync(path.join(fx.run, 'acquisition.json'), 'utf8'));
    writeWorkerResults(fx.run, key => {
      const source = acquisition.acquired.find(record => record.primary_key === key);
      const payload = report(source.company, source.title, source.primary_url, key);
      payload.archetype = sample.archetype;
      return { posting_key: key, score: 4.2, hard_exclusion: false, legitimacy_tier: sample.tier, work_authorization: { value: sample.auth, quote: sample.jd || null }, report: payload };
    });
    const loaded = loadScanResults(fx.run);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.candidates.length, 1);
    const { receipt } = await commitScan(fx.run, fx.career, '2026-09-06');
    assert.equal(receipt.status, 'COMPLETE');
    const rendered = readFileSync(path.join(fx.career, receipt.reports[0].report_path), 'utf8');
    assert.ok(rendered.includes(`**Legitimacy:** ${sample.tier}  \n`));
    assert.ok(rendered.includes(`**Work Auth:** ${sample.label}  \n`));
    assert.ok(rendered.includes(`**Archetype:** ${sample.display}  \n`));
    assert.ok(rendered.includes(`legitimacy_tier: "${sample.tier}"`));
    assert.ok(rendered.includes(`work_auth: "${sample.auth}"`));
  }
});
