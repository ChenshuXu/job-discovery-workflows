import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCalibration } from '../src/linkedin-post-scan/query-plan.mjs';

const config = {
  phrase_groups: { P1: ['Hiring'], P2: ['Careers'] },
  role_groups: { BACKEND: ['Backend Engineer'] },
  location_groups: { SEATTLE: { query: 'Seattle' } },
  search: { default_strategy: 'combined', p1_phrase_groups: ['P1'], run_limit_minutes: 45, priority_hours: { P1: 24, P2: 48 } },
  schedule_reference: { times: ['12:30', '17:00', '21:00'] },
};
const captures = [{ sample_key: 'sample', variant: 'combined', post_ids: ['1'], actionable_post_ids: ['1'],
  elapsed_ms: 1000, deep_check_count: 1, deep_check_elapsed_ms_total: 1000, result_count: 1 }];

test('calibration uses the cyclic schedule gap only when one run covers every query', () => {
  const covered = summarizeCalibration(config, captures);
  assert.equal(covered.p1_max_gap_hours, 15.5);
  assert.equal(covered.p2_max_gap_hours, 15.5);
  assert.equal(covered.budget_complete, true);

  const pending = summarizeCalibration({ ...config, search: { ...config.search, run_limit_minutes: 0.0001 } }, captures);
  assert.equal(pending.schedule_coverage_complete, false);
  assert.equal(pending.budget_complete, false);
});

const postScanFixture = async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDatabase, beginRun } = await import('../src/linkedin-post-scan/db.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'post-scan-'));
  const db = openDatabase(path.join(dir, 'scan.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, beginRun };
};
const scanConfig = { post_signal: { dimensions: { fit: 5 }, ready_threshold: 4, review_minimum: 3.5 }, tombstone_days: 30 };
const post = (decision, body = 'We are hiring a backend engineer in Seattle.') => ({
  post_urn: 'urn:li:activity:7000000000000000001', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  body, author: { name: 'Recruiter', company: 'Acme' }, decision });
const exactDecision = postingKey => ({ route: 'EXACT_JOB', official_url: 'https://boards.greenhouse.io/acme/jobs/1234567', posting_key: postingKey,
  employer: 'Acme', title: 'Backend Engineer', location: 'Seattle, WA', exact_identity_evidence: { post_to_job: 'The post links the job.' },
  jd_text: 'Build backend services. '.repeat(20) });

test('a post whose first routing failed is processed again with the corrected decision', async t => {
  const { processCapturedPosts } = await import('../src/linkedin-post-scan/process-posts.mjs');
  const { db, beginRun } = await postScanFixture(t);
  beginRun(db, { runId: 'r1', mode: 'scan' });
  const first = processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(exactDecision('greenhouse:acme:9999999'))], config: scanConfig });
  assert.equal(first.errors.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0, 'a failed post leaves no stored row');
  const second = processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(exactDecision('greenhouse:acme:1234567'))], config: scanConfig });
  assert.deepEqual([second.errors.length, second.unchanged, second.exact_jobs], [0, 0, 1]);
});

test('a re-routed post with an unchanged body supersedes its earlier opportunity', async t => {
  const { processCapturedPosts } = await import('../src/linkedin-post-scan/process-posts.mjs');
  const { db, beginRun } = await postScanFixture(t);
  beginRun(db, { runId: 'r1', mode: 'scan' });
  const review = { route: 'REVIEW', employer: 'Acme', title: 'Backend Engineer', post_signal: { dimensions: { fit: 3.6 } }, missing_facts: ['location'] };
  const ready = { route: 'AUTO_PREPARE_READY', employer: 'Acme', title: 'Backend Engineer', post_signal: { dimensions: { fit: 4.5 } },
    contact: { member_id: 'm1', name: 'Recruiter' }, outreach: { draft: 'Hello' } };
  assert.equal(processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(review)], config: scanConfig }).review, 1);
  const rerouted = processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(ready)], config: scanConfig });
  assert.deepEqual([rerouted.errors.length, rerouted.unchanged, rerouted.outreach_ready], [0, 0, 1]);
  const statuses = db.prepare('SELECT kind, status, reason_code FROM opportunities ORDER BY kind').all().map(row => ({ ...row }));
  assert.deepEqual(statuses, [{ kind: 'CONTACT', status: 'AUTO_PREPARE_READY', reason_code: null }, { kind: 'REVIEW', status: 'SUPERSEDED', reason_code: 'POST_REROUTED' }]);
});

const handoffConfig = async () => {
  const path = await import('node:path');
  const { PROJECT_ROOT } = await import('../src/linkedin-post-scan/config.mjs');
  return { paths: { employer_exclusions: path.join(PROJECT_ROOT, 'config/jobspy-ego.json'), career_ops_root: '/nonexistent' } };
};

test('a handoff whose planning never finished starts again in a new run', async t => {
  const { processCapturedPosts } = await import('../src/linkedin-post-scan/process-posts.mjs');
  const { prepareHandoffRun, finalizeHandoff } = await import('../src/linkedin-post-scan/career-ops.mjs');
  const { db, beginRun } = await postScanFixture(t);
  beginRun(db, { runId: 'r1', mode: 'scan' });
  processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(exactDecision('greenhouse:acme:1234567'))], config: scanConfig });
  const config = await handoffConfig();
  const first = prepareHandoffRun(db, config, 'greenhouse:acme:1234567');
  assert.throws(() => finalizeHandoff(db, config, 'greenhouse:acme:1234567'), /planning has not finished/);
  const second = prepareHandoffRun(db, config, 'greenhouse:acme:1234567');
  assert.equal(second.existing, false);
  assert.notEqual(second.runId, first.runId);
  assert.equal(db.prepare('SELECT run_id FROM career_ops_handoffs WHERE posting_key=?').get('greenhouse:acme:1234567').run_id, second.runId);
});

test('an excluded employer ends the exact opportunity instead of failing every handoff', async t => {
  const { existsSync, readdirSync } = await import('node:fs');
  const path = await import('node:path');
  const { processCapturedPosts } = await import('../src/linkedin-post-scan/process-posts.mjs');
  const { runHandoffPlanning } = await import('../src/linkedin-post-scan/career-ops.mjs');
  const { POST_SCAN_ROOT } = await import('../src/linkedin-post-scan/config.mjs');
  const { db, beginRun } = await postScanFixture(t);
  beginRun(db, { runId: 'r1', mode: 'scan' });
  const decision = { ...exactDecision('greenhouse:acme:1234567'), employer: 'Amazon' };
  processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [post(decision)], config: scanConfig });
  const config = await handoffConfig();
  const runsRoot = path.join(POST_SCAN_ROOT, 'runs');
  const runDirs = () => existsSync(runsRoot) ? (readdirSync(runsRoot)).length : 0;
  const before = runDirs();
  for (let attempt = 0; attempt < 2; attempt += 1) assert.equal(runHandoffPlanning(db, config, 'greenhouse:acme:1234567').status, 'EMPLOYER_EXCLUDED');
  const row = db.prepare("SELECT status, reason_code FROM opportunities WHERE posting_key=?").get('greenhouse:acme:1234567');
  assert.deepEqual({ ...row }, { status: 'EMPLOYER_EXCLUDED', reason_code: 'amazon-aws' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM career_ops_handoffs').get().n, 0);
  assert.equal(runDirs(), before, 'no run directory is created for an excluded employer');
});

test('a candidate name shared by two contacts is refused instead of guessed', async t => {
  const { processCapturedPosts } = await import('../src/linkedin-post-scan/process-posts.mjs');
  const { autoPreparePackage } = await import('../src/linkedin-post-scan/outreach.mjs');
  const { db, beginRun } = await postScanFixture(t);
  beginRun(db, { runId: 'r1', mode: 'scan' });
  const ready = (urnDigit, memberId) => ({ ...post({ route: 'AUTO_PREPARE_READY', employer: `Acme ${urnDigit}`, title: 'Backend Engineer',
    post_signal: { dimensions: { fit: 4.5 } }, contact: { member_id: memberId, name: 'John Smith' }, outreach: { draft: 'Hello' } }),
  post_urn: `urn:li:activity:700000000000000000${urnDigit}`, post_url: `https://www.linkedin.com/feed/update/urn:li:activity:700000000000000000${urnDigit}/` });
  const counts = processCapturedPosts(db, { runId: 'r1', queryKey: 'q', posts: [ready(2, 'm1'), ready(3, 'm2')], config: scanConfig });
  assert.equal(counts.outreach_ready, 2);
  assert.throws(() => autoPreparePackage(db, 'John Smith'), /AMBIGUOUS_CANDIDATE/);
  assert.doesNotThrow(() => autoPreparePackage(db, 'm1'));
});

test('status sees a run another writer has open, and a stale run can be cleared', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDatabase, openDatabaseReadOnly, beginRun, statusSnapshot } = await import('../src/linkedin-post-scan/db.mjs');
  const { PROJECT_ROOT } = await import('../src/linkedin-post-scan/config.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'post-scan-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scan.db');
  const writer = openDatabase(file);
  beginRun(writer, { runId: 'killed-run', mode: 'scan' });
  const reader = openDatabaseReadOnly(file);
  assert.equal(statusSnapshot(reader).active_run?.run_id, 'killed-run');
  reader.close();
  writer.close();
  const cli = args => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'src/linkedin-post-scan/cli.mjs'), ...args, '--db', file], { encoding: 'utf8' });
  const cleared = cli(['clear-stale-run']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).cleared_run_id, 'killed-run');
  const after = openDatabase(file);
  t.after(() => after.close());
  assert.deepEqual({ ...after.prepare("SELECT status, stop_code FROM runs WHERE run_id='killed-run'").get() }, { status: 'STOPPED', stop_code: 'STALE_RUN_CLEARED' });
  assert.doesNotThrow(() => beginRun(after, { runId: 'next-run', mode: 'scan' }));
});
