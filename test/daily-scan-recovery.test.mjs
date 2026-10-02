import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotAdapterProfile } from '../src/adapter-registry.mjs';
import { sourceRecord, writeAcquisition } from '../src/combine.mjs';
import { semanticIdentity } from '../src/semantic-jd-identity.mjs';
import { prepareFailedScanRecovery } from '../src/prepare-failed-scan-recovery.mjs';
import { validateRun } from '../src/run-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
const json = file => JSON.parse(readFileSync(file));
const tree = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(x => x.isFile()).map(x => {
  const file = path.join(x.parentPath, x.name); return [path.relative(root, file), hash(readFileSync(file))];
}));
const policy = { local_metros: ['Seattle'], remote_country: 'United States', require_structured_remote: true, ambiguous_action: 'exclude' };
const body = 'Build distributed backend services, reliable APIs, testing, observability and production systems with engineering partners. '.repeat(3);
const jd = (url, token) => `**URL:** ${url}\n**Company:** Example\n**Role:** Backend Engineer\n**Location:** Seattle, WA\n**Employment Type:** Full-time\n**Employment Type Source:** platform\n**Workplace Type:** onsite\n**Workplace Type Source:** platform\n**Structured Remote Signal:** false\n**Discovery Run:** original\n\n## Job Description\n\n${body}${token}\n`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'failed-scan-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original'), career = path.join(root, 'career-ops'), destination = path.join(root, 'recovered');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const gitFile = file => execFileSync('git', ['show', `${revision}:${file}`]);
  const profile = snapshotAdapterProfile();
  profile.registry_sha256 = hash(gitFile('config/discovery-adapters.v1.json'));
  for (const value of Object.values(profile.adapter_definitions)) value.config_sha256 = hash(gitFile(value.config));
  const runtime = JSON.parse(gitFile('config/daily-scan-runtime.json'));
  const failedKey = 'greenhouse:example:12345', failedUrl = 'https://boards.greenhouse.io/example/jobs/12345';
  const linkedKey = 'linkedin:linkedin.com:11111111', linkedUrl = 'https://www.linkedin.com/jobs/view/11111111';
  const passedKey = 'linkedin:linkedin.com:22222222', passedUrl = 'https://www.linkedin.com/jobs/view/22222222';
  const sourceJobs = { jobspy: ['passed.md', jd(passedUrl, 'passed')], 'ego-browser': ['failed-linkedin.md', jd(linkedUrl, 'failed')], jobright: ['failed-embed.md', jd('https://boards.greenhouse.io/embed/job_app?token=12345', 'failed')] };
  const summaries = [];
  for (const adapter of profile.adapters) {
    const [name, markdown] = sourceJobs[adapter];
    write(path.join(source, 'sources', adapter, 'jobs', name), markdown);
    const summary = { schema_version: 1, run_id: 'original', adapter, status: 'SUCCESS', raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0 };
    summaries.push(summary);
    write(path.join(source, 'sources', adapter, 'summary.json'), summary);
    write(path.join(source, 'sources', adapter, 'excluded-employers.json'), { schema_version: 1, run_id: 'original', excluded_count: 0, results: [] });
  }
  const failedRecord = { ...sourceRecord(source, 'ego-browser', path.join(source, 'sources/ego-browser/jobs/failed-linkedin.md')),
    primary_key: failedKey, primary_url: failedUrl, posting_keys: [failedKey, linkedKey], sources: ['ego-browser', 'jobright'],
    source_keys: { 'ego-browser': linkedKey, jobright: failedKey }, posting_urls: { [failedKey]: failedUrl, [linkedKey]: linkedUrl } };
  const passedRecord = sourceRecord(source, 'jobspy', path.join(source, 'sources/jobspy/jobs/passed.md'));
  const acquired = writeAcquisition(source, profile, summaries, [failedRecord, passedRecord], { rawSourceJobs: 3 });
  for (const record of acquired.acquired) {
    record.location_scope = { decision: 'ALLOW_LOCAL', allowed: true };
    Object.assign(record, semanticIdentity({ record, markdown: readFileSync(path.join(source, record.jd_path), 'utf8') }));
  }
  write(path.join(source, 'acquisition.json'), acquired);
  const candidateSources = Object.entries({ 'cv.md': '# CV\n', 'config/profile.yml': `location:\n  scan_policy: ${JSON.stringify(policy)}\n`, 'modes/_profile.md': '# Profile\n' }).map(([label, text]) => {
    const file = path.join(career, label); write(file, text); return { label, path: file, sha256: hash(text) };
  });
  write(path.join(career, 'verify-pipeline.mjs'), "console.log('Pipeline Health: 0 errors, 0 warnings')\n");
  write(path.join(career, 'data/scan-history.tsv'), 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n');
  write(path.join(source, 'baseline.json'), { schema_version: 3, run_id: 'original', adapter_profile: profile, location_policy: policy, pipeline: { exit_code: 0, errors: 0 } });
  const assignments = { schema_version: 1, result_schema_version: 3, run_id: 'original', career_ops_root: career, runtime,
    assignments: Object.fromEntries(Array.from({ length: runtime.scheduler.max_active_workers }, (_, i) => [`worker-${i + 1}`, i ? [] : [failedKey, passedKey]])), candidate_sources: candidateSources,
    semantic_identities: Object.fromEntries(acquired.acquired.map(record => [record.primary_key, { semantic_job_key: record.semantic_job_key, posting_context_key: record.posting_context_key }])) };
  write(path.join(source, 'assignments.json'), assignments);
  const failure = { posting_key: failedKey, status: 'FAILED', attempts: runtime.failure.per_job_retry_limit + 1, error: 'unsupported restriction', report: null };
  const results = [failure, { posting_key: passedKey, status: 'EVALUATED' }];
  write(path.join(source, 'results/worker-1.part-1.json'), { result_schema_version: 3, worker: 'worker-1', part: 1, results });
  write(path.join(source, 'results/worker-1.json'), { result_schema_version: 3, worker: 'worker-1', results });
  write(path.join(source, 'receipt.json'), { schema_version: 4, run_id: 'original', status: 'COMPLETE', acquired_keys: [failedKey, passedKey], committed_evaluated_keys: [passedKey], job_issue_keys: [failedKey],
    job_issues: [{ posting_key: failedKey, code: 'WORKER_FAILED', reason: failure.error }], failed: [{ posting_key: failedKey, error: failure.error }] });
  write(path.join(source, 'triage/canonical-url-resolutions.json'), { schema_version: 1, run_id: 'original', results: [
    { posting_key: 'greenhouse:boards.greenhouse.io:12345', status: 'RESOLVED', official_key: failedKey, official_url: failedUrl, replaced_key: 'greenhouse:boards.greenhouse.io:12345' },
    { posting_key: linkedKey, status: 'RESOLVED', official_key: failedKey, official_url: failedUrl },
    { posting_key: passedKey, status: 'UNRESOLVED' },
  ] });
  return { source, career, destination, failedKey, failedUrl, passedKey, options: { sourceRun: source, runRoot: destination, careerRoot: career, sourceRevision: revision } };
}

test('failed recovery selects only terminal failures and preserves original sources, retries and Career-Ops', t => {
  const fx = fixture(t), before = tree(fx.source), careerBefore = tree(fx.career);
  const result = prepareFailedScanRecovery(fx.options);
  assert.equal(result.selected_count, 1);
  assert.equal(result.assigned_count, 1);
  const acquisition = json(path.join(fx.destination, 'acquisition.json'));
  assert.deepEqual(acquisition.keys, [fx.failedKey]);
  assert.deepEqual(acquisition.sources.map(x => [x.adapter, x.status, x.markdown_jobs, x.live_acquisition]), [['jobspy', 'EMPTY', 0, false], ['ego-browser', 'SUCCESS', 1, false], ['jobright', 'SUCCESS', 1, false]]);
  assert.ok(acquisition.sources.every(x => x.acquisition_mode === 'frozen_subset_recovery'));
  const recovered = readFileSync(path.join(fx.destination, acquisition.acquired[0].jd_path), 'utf8');
  assert.match(recovered, /\*\*Discovery Run:\*\* recovered/);
  assert.match(recovered, /\*\*Posting Key:\*\* greenhouse:example:12345/);
  assert.match(readFileSync(path.join(fx.destination, 'sources/jobright/jobs/failed-embed.md'), 'utf8'), /\*\*Discovery Run:\*\* original/);
  const origin = json(result.origin);
  assert.equal(origin.retention_performed, false);
  assert.equal(origin.source_files.length, 2);
  assert.ok(origin.original_code.every(item => hash(readFileSync(path.join(fx.destination, item.snapshot))) === item.sha256));
  assert.ok(origin.inputs.some(item => item.path === 'receipt.json' && item.sha256 === before['receipt.json']));
  assert.deepEqual(tree(fx.source), before);
  assert.deepEqual(tree(fx.career), careerBefore);
  assert.deepEqual(readdirSync(path.join(fx.destination, 'results')), []);
  assert.equal(existsSync(path.join(fx.destination, 'receipt.json')), false);
  assert.equal(existsSync(path.join(fx.destination, 'maintenance')), false);
  assert.deepEqual(validateRun(fx.destination).errors, []);
  assert.throws(() => prepareFailedScanRecovery(fx.options), /new named run/);
});

test('failed recovery fails closed on candidate drift, source-body drift and missing canonical lineage', t => {
  for (const [change, error] of [
    [fx => write(path.join(fx.career, 'cv.md'), '# changed\n'), /candidate source hash changed/],
    [fx => { const file = path.join(fx.source, 'jobs/greenhouse-example-12345.md'); write(file, `${readFileSync(file, 'utf8')}changed\n`); }, /frozen JD or semantic identity changed/],
    [fx => { const file = path.join(fx.source, 'triage/canonical-url-resolutions.json'), value = json(file); value.results.shift(); write(file, value); }, /source lineage is missing jobright/],
    [fx => { const file = path.join(fx.source, 'baseline.json'), value = json(file); value.adapter_profile.adapter_definitions.jobright.config_sha256 = '0'.repeat(64); write(file, value); }, /source config\/revision provenance mismatch/],
  ]) {
    const fx = fixture(t); change(fx);
    const before = tree(fx.source);
    assert.throws(() => prepareFailedScanRecovery(fx.options), error);
    assert.equal(existsSync(fx.destination), false);
    assert.deepEqual(tree(fx.source), before);
  }
});

test('recovery planning respects a newly committed exact key without resetting the original failure', t => {
  const fx = fixture(t), before = tree(fx.source);
  write(path.join(fx.career, 'data/scan-history.tsv'), `url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n${fx.failedUrl}\t2026-09-07\tfixture\tBackend Engineer\tExample\tdaily-scan:other\tSeattle, WA\n`);
  const result = prepareFailedScanRecovery(fx.options);
  assert.equal(result.selected_count, 1);
  assert.equal(result.assigned_count, 0);
  assert.equal(json(path.join(fx.destination, 'acquisition.json')).historical_duplicate_count, 1);
  assert.deepEqual(tree(fx.source), before);
});
