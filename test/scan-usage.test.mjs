import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startScanUsage, bindScanWorkers, collectScanUsage, refreshScanUsage, recordScanSourceAttempt, compareScanUsage, renderScanUsage } from '../src/scan-usage.mjs';
import { writeReceiptCreateOnly } from '../src/verify-scan-receipt.mjs';

const parent = '11111111-1111-1111-1111-111111111111';
const child = '22222222-2222-2222-2222-222222222222';
const rootTurn = '33333333-3333-3333-3333-333333333333';
const at = '2026-09-07T21:00:00.000Z';
const done = '2026-09-07T21:01:00.000Z';
const tokens = { input_tokens: 100, cached_input_tokens: 70, uncached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 };
const capture = ({ rootTurnId = rootTurn } = {}) => ({ status: 'complete', coordinator_thread_id: parent, session_id: parent, root_turn_id: rootTurnId, captured_at: at, issues: [] });
const json = (file, value) => writeFileSync(file, JSON.stringify(value));

function fixture(t, { empty = false } = {}) {
  const runRoot = mkdtempSync(path.join(tmpdir(), 'scan-usage-'));
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));
  const assignments = { 'worker-1': empty ? [] : ['key'], 'worker-2': [] };
  const runtime = { worker: { model: 'requested', reasoning_effort: 'low' }, scheduler: { max_active_workers: 2, batch_size: 6 } };
  json(path.join(runRoot, 'assignments.json'), { assignments, runtime, semantic_identities: { key: { semantic_job_key: 'jd', posting_context_key: 'context' } }, candidate_sources: [{ label: 'cv', path: '/private/path', sha256: 'candidate' }] });
  json(path.join(runRoot, 'acquisition.json'), { acquired: [{ primary_key: 'key', company: 'Example', title: 'Engineer', location: 'US' }], sources: [{ adapter: 'jobspy', status: 'SUCCESS', markdown_jobs: 1 }] });
  return runRoot;
}

const observation = ({ scope, threadIds }) => ({ issues: [], threads: threadIds.map(thread_id => ({ thread_id, status: 'complete', tokens,
  observed_settings: [{ model: thread_id === parent ? 'coordinator-model' : 'worker-model', reasoning_effort: 'medium', tokens }],
  started_at: at, completed_at: done, wall_ms: 60000, issues: [], root_turn_id: scope.root_turn_id })) });

test('start/bind are idempotent; resume preserves exact scopes and no unrelated receipt fields change', t => {
  const runRoot = fixture(t);
  startScanUsage({ runRoot, capture, now: at });
  startScanUsage({ runRoot, capture, now: done });
  bindScanWorkers({ runRoot, workers: [`worker-1=${child}`, `worker-1=${child}`] });
  assert.throws(() => bindScanWorkers({ runRoot, workers: [`worker-2=${child}`] }), /nonempty/);
  assert.throws(() => bindScanWorkers({ runRoot, workers: [`worker-1=${parent}`] }), /another executor/);
  const first = readFileSync(path.join(runRoot, 'usage-context.json'), 'utf8');
  const value = JSON.parse(first);
  assert.equal(value.segments.length, 1);
  assert.match(value.implementation.files['config/worker-scoring.md'], /^[a-f0-9]{64}$/);
  assert.deepEqual(value.segments[0].workers['worker-1'], [child]);
  startScanUsage({ runRoot, capture, rootTurnId: 'next-root-turn', now: done });
  const after = JSON.parse(readFileSync(path.join(runRoot, 'usage-context.json')));
  assert.equal(after.segments.length, 2);
  assert.equal(after.workflow_started_at, at);
  assert.deepEqual(after.segments[0], value.segments[0]);
});

test('delayed session visibility can repair the same frozen scope, or an explicitly identified empty placeholder', t => {
  const runRoot = fixture(t);
  startScanUsage({ runRoot, now: at, capture: () => ({ ...capture(), status: 'unavailable', session_id: null }) });
  const repaired = startScanUsage({ runRoot, capture, now: done });
  assert.equal(repaired.segments.length, 1);
  assert.equal(repaired.segments[0].scope.session_id, parent);
  const delayed = fixture(t);
  startScanUsage({ runRoot: delayed, now: at, capture: () => ({ ...capture(), status: 'unavailable', session_id: null, root_turn_id: null }) });
  const bound = startScanUsage({ runRoot: delayed, capture, threadId: parent, rootTurnId: rootTurn, now: done });
  assert.equal(bound.segments.length, 1);
  assert.equal(bound.segments[0].scope.root_turn_id, rootTurn);
});

test('aggregation counts disjoint root scopes, reports actual settings, and never sums parallel latency', t => {
  const runRoot = fixture(t);
  startScanUsage({ runRoot, capture, now: at });
  bindScanWorkers({ runRoot, workers: [`worker-1=${child}`] });
  const value = refreshScanUsage({ runRoot, collect: observation, now: done });
  assert.equal(value.status, 'complete');
  assert.equal(value.tokens.total_tokens, 240);
  assert.equal(value.tokens.input_tokens, 200);
  assert.equal(value.tokens.uncached_input_tokens, 60);
  assert.equal(value.workers[0].requested_observed_mismatch, true);
  assert.equal(value.workers[1].status, 'no_model');
  assert.equal(value.timing.task_wall_ms, 60000);
  assert.equal(value.timing.worker_wall_ms_sum, 60000);
  assert.equal(value.efficiency.tokens_per_assigned_job, 240);
  assert.equal(value.outcome.semantic_quality, 'unreviewed');
  assert.equal(JSON.stringify(value).includes('/private/path'), false);
  assert.deepEqual(refreshScanUsage({ runRoot, collect: observation, now: done }), value);
});

test('unbound nonempty workers and absent sessions remain unknown; empty sets have null denominators', t => {
  const runRoot = fixture(t);
  assert.equal(collectScanUsage({ runRoot, collect: observation }).tokens, null);
  startScanUsage({ runRoot, capture, now: at });
  const partial = collectScanUsage({ runRoot, collect: observation, now: done });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.workers[0].tokens, null);
  assert.equal(partial.efficiency.tokens_per_assigned_job, null);
  assert.ok(partial.issues.includes('worker-1: execution_binding_missing'));
  bindScanWorkers({ runRoot, workers: [`worker-1=${child}`] });
  const missingChild = collectScanUsage({ runRoot, now: '2026-09-08T21:00:00Z', collect: options => ({ issues: ['child log missing'],
    threads: observation(options).threads.map(item => item.thread_id === child ? { ...item, status: 'unavailable', tokens: null, started_at: null, completed_at: null, wall_ms: null } : item) }) });
  assert.equal(missingChild.status, 'partial');
  assert.equal(missingChild.timing.observed_task_wall_ms, 60000, 'missing logs do not imply a still-running day-long task');
  const empty = fixture(t, { empty: true });
  startScanUsage({ runRoot: empty, capture, now: at });
  const emptyStats = collectScanUsage({ runRoot: empty, collect: observation, now: done });
  assert.equal(emptyStats.status, 'complete');
  assert.equal(emptyStats.worker_tokens.total_tokens, 0);
  assert.equal(emptyStats.efficiency.tokens_per_assigned_job, null);
});

test('source attempts are recorded separately; receipt hook is optional, create-only and nonblocking', t => {
  const runRoot = fixture(t);
  startScanUsage({ runRoot, capture, now: at });
  recordScanSourceAttempt(runRoot, { adapter_id: 'jobspy', wall_ms: 2000, started_at: at, completed_at: done, exit_code: 0 });
  const value = collectScanUsage({ runRoot, collect: observation, now: done });
  assert.equal(value.timing.source_wall_ms_sum, 2000);
  const receiptFile = path.join(runRoot, 'receipt.json');
  const receipt = { status: 'COMPLETE', run_id: path.basename(runRoot), reports: [] };
  writeReceiptCreateOnly(receiptFile, receipt);
  assert.deepEqual(JSON.parse(readFileSync(receiptFile)), receipt);
  assert.equal(JSON.parse(readFileSync(path.join(runRoot, 'usage.json'))).status, 'unavailable');
  assert.throws(() => writeReceiptCreateOnly(receiptFile, receipt), /EEXIST/);
  const failedRoot = fixture(t);
  json(path.join(failedRoot, 'usage-context.json'), { schema_version: 99 });
  const originalError = console.error;
  console.error = () => {};
  try { writeReceiptCreateOnly(path.join(failedRoot, 'receipt.json'), { status: 'FAILED' }); }
  finally { console.error = originalError; }
  assert.equal(JSON.parse(readFileSync(path.join(failedRoot, 'receipt.json'))).status, 'FAILED');
});

test('historical backfill requires an explicit original scope and cannot pretend current code was frozen', t => {
  const runRoot = fixture(t);
  json(path.join(runRoot, 'baseline.json'), { captured_at: at });
  const receipt = { status: 'COMPLETE', run_id: path.basename(runRoot) };
  json(path.join(runRoot, 'receipt.json'), receipt);
  assert.throws(() => startScanUsage({ runRoot, capture }), /explicit/);
  const context = startScanUsage({ runRoot, threadId: parent, rootTurnId: rootTurn, capture });
  assert.equal(context.implementation, null);
  assert.equal(context.workflow_started_at, null);
  refreshScanUsage({ runRoot, collect: observation, now: done });
  assert.deepEqual(JSON.parse(readFileSync(path.join(runRoot, 'receipt.json'))), receipt);
});

test('comparison flags changed inputs and shared turns; CSV/JSON preserve unknown values and all token subsets', t => {
  const runRoot = fixture(t);
  startScanUsage({ runRoot, capture, now: at });
  bindScanWorkers({ runRoot, workers: [`worker-1=${child}`] });
  const one = collectScanUsage({ runRoot, collect: observation, now: done });
  const two = structuredClone(one);
  two.run_id = 'another'; two.fingerprints.sample = 'different';
  const result = compareScanUsage([one, two]);
  assert.ok(result.warnings.some(item => item.includes('sample: differs')));
  assert.ok(result.warnings.some(item => item.includes('totals overlap')));
  assert.match(renderScanUsage(result), /Partial totals are measured subtotals/);
  assert.match(renderScanUsage(result, 'csv'), /reasoning_output_tokens/);
  assert.match(renderScanUsage(result, 'csv'), /totals overlap/);
  assert.match(renderScanUsage(result), /workflow_seconds/);
  assert.deepEqual(JSON.parse(renderScanUsage(result, 'json')), result);
  const before = one.fingerprints.sample;
  const acquisition = JSON.parse(readFileSync(path.join(runRoot, 'acquisition.json')));
  acquisition.acquired[0].title = 'Staff Engineer';
  json(path.join(runRoot, 'acquisition.json'), acquisition);
  assert.notEqual(collectScanUsage({ runRoot, collect: observation }).fingerprints.sample, before);
});

test('CLI backfill/refresh creates only observability files and refuses ambiguous options', t => {
  const runRoot = fixture(t);
  const script = new URL('../src/scan-usage.mjs', import.meta.url);
  const sessions = path.join(runRoot, 'missing-sessions');
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' });
  assert.equal(run(['start', '--run', runRoot, '--coordinator-thread', parent, '--root-turn', rootTurn, '--sessions-dir', sessions]).status, 0);
  const refreshed = run(['refresh', '--run', runRoot, '--sessions-dir', sessions, '--json']);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).runs[0].status, 'unavailable');
  assert.notEqual(run(['compare', '--run', runRoot, '--json', '--csv']).status, 0);
  assert.notEqual(run(['bind', '--run', runRoot]).status, 0);
  assert.notEqual(run(['start', '--run', runRoot, '--root-turn', rootTurn, '--root-turn', rootTurn]).status, 0);
  const target = path.join(runRoot, 'protected.json'); json(target, { untouched: true });
  rmSync(path.join(runRoot, 'usage.json'));
  symlinkSync(target, path.join(runRoot, 'usage.json'));
  assert.notEqual(run(['refresh', '--run', runRoot, '--sessions-dir', sessions]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(target)), { untouched: true });
});
