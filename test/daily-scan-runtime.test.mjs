import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadDailyScanRuntime, validateDailyScanRuntime, workerIdsForRuntime } from '../src/daily-scan-runtime.mjs';

test('runtime loads every value from the JSON source of truth', () => {
  const runtime = loadDailyScanRuntime();
  const configured = JSON.parse(readFileSync(new URL('../config/daily-scan-runtime.json', import.meta.url), 'utf8'));
  assert.deepEqual(runtime, configured);
});
test('runtime accepts safe non-default scheduler, reporting, and failure values', () => {
  const runtime = loadDailyScanRuntime();
  const configured = validateDailyScanRuntime({
    ...runtime,
    scheduler: { batch_size: 1, max_active_workers: 2 },
    reporting: { full_report_threshold: 3.5 },
    failure: { per_job_retry_limit: 2 },
    retention: { evaluated_unapplied_ttl_days: 3 },
  });
  assert.deepEqual(workerIdsForRuntime(configured), ['worker-1', 'worker-2']);
  assert.equal(configured.scheduler.batch_size, 1);
  assert.equal(configured.reporting.full_report_threshold, 3.5);
  assert.equal(configured.failure.per_job_retry_limit, 2);
  assert.equal(configured.retention.evaluated_unapplied_ttl_days, 3);
  assert.equal(validateDailyScanRuntime({ ...runtime, retention: { evaluated_unapplied_ttl_days: 5 } }).retention.evaluated_unapplied_ttl_days, 5);
});

test('runtime rejects unsafe numeric values', () => {
  const runtime = loadDailyScanRuntime();
  assert.throws(() => validateDailyScanRuntime({ ...runtime, scheduler: { ...runtime.scheduler, max_active_workers: 0 } }), /max_active_workers/);
  assert.throws(() => validateDailyScanRuntime({ ...runtime, scheduler: { ...runtime.scheduler, batch_size: 1.5 } }), /batch_size/);
  assert.throws(() => validateDailyScanRuntime({ ...runtime, reporting: { full_report_threshold: 5.1 } }), /between 1 and 5/);
  assert.throws(() => validateDailyScanRuntime({ ...runtime, failure: { per_job_retry_limit: -1 } }), /per_job_retry_limit/);
  for (const value of [undefined, '7', 0, -1, 1.5]) {
    assert.throws(() => validateDailyScanRuntime({ ...runtime, retention: { evaluated_unapplied_ttl_days: value } }), /evaluated_unapplied_ttl_days/);
  }
});
