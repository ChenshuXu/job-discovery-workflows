import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildActiveInterviewCompanyIndex,
  localDate,
  parseArgs,
  parseDates,
  parseLimit,
  planBatch,
  selectReceipt,
} from '../.agents/skills/career-ops-ego-apply/scripts/application-batch.mjs';

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t, specs, runId = '20260819-100000') {
  const careerOpsRoot = mkdtempSync(join(tmpdir(), 'ego-apply-batch-test-'));
  t.after(() => rmSync(careerOpsRoot, { recursive: true, force: true }));
  mkdirSync(join(careerOpsRoot, 'reports'), { recursive: true });
  const rows = specs.map((spec, index) => {
    const reportPath = `reports/${spec.id}-test.md`;
    writeFileSync(join(careerOpsRoot, reportPath), [
      `**URL:** https://boards.greenhouse.io/acme/jobs/${900000 + spec.id}`,
      '## Machine Summary',
      '```yaml',
      `run_id: "${runId}"`,
      '```',
      '',
    ].join('\n'));
    return {
      trackerNum: index + 1,
      reportNum: String(spec.id),
      reportPath,
      date: spec.date || '2026-08-19',
      company: spec.company || 'Acme',
      role: spec.role || `Engineer ${spec.id}`,
      status: spec.status || 'Evaluated',
      notes: spec.notes || '',
    };
  });
  const receipt = {
    run_id: runId,
    status: 'COMPLETE',
    reports: specs.filter(spec => spec.inReceipt !== false).map(spec => ({
      posting_key: spec.postingKey || `greenhouse:acme:${900000 + spec.id}`,
      report_number: spec.id,
      report_path: `reports/${spec.id}-test.md`,
    })),
  };
  return { careerOpsRoot, rows, receipt, runId };
}

test('latest complete ignores a newer incomplete run', (t) => {
  const runsRoot = mkdtempSync(join(tmpdir(), 'ego-apply-runs-test-'));
  t.after(() => rmSync(runsRoot, { recursive: true, force: true }));
  writeJson(join(runsRoot, '20260819-100000', 'receipt.json'), {
    run_id: '20260819-100000', status: 'COMPLETE', reports: [{ report_number: 1, report_path: 'reports/1.md' }],
  });
  writeJson(join(runsRoot, '20260819-220000', 'receipt.json'), {
    run_id: '20260819-220000', status: 'INCOMPLETE', reports: [{ report_number: 2, report_path: 'reports/2.md' }],
  });

  assert.equal(selectReceipt(runsRoot, { latestComplete: true }).runId, '20260819-100000');
});

test('a specified run freezes only its receipt report IDs and emits all waves', (t) => {
  const fx = fixture(t, [
    { id: 101 },
    { id: 102, inReceipt: false },
    { id: 103 },
  ]);
  const result = planBatch(fx.rows, { ...fx, limit: 1 });

  assert.deepEqual(result.scope.frozenReportIds, [101, 103]);
  assert.deepEqual(result.waves.flatMap(wave => wave.reportIds), [101, 103]);
  assert.equal(result.waves.some(wave => wave.reportIds.includes(102)), false);
});

test('strict arguments reject partial integers, unknown flags, and impossible dates', () => {
  assert.throws(() => parseLimit('3.5'), /integer from 1 to 10/);
  assert.throws(() => parseLimit('3junk'), /integer from 1 to 10/);
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
  assert.throws(() => parseDates('2026-02-30'), /valid YYYY-MM-DD/);
  assert.equal(
    parseArgs(['--career-ops', '/career', '--active-interviews', '/career-docs/context/Interview/active-interviews.md', '--run', 'run-1'])['active-interviews'],
    '/career-docs/context/Interview/active-interviews.md',
  );
});

test('terminal statuses and no-retry or future-retry notes are not selected', (t) => {
  const fx = fixture(t, [
    { id: 201, status: 'Applied' },
    { id: 202, status: 'Discarded' },
    { id: 203, status: 'SKIP' },
    { id: 204, notes: 'submission uncertain; no_retry' },
    { id: 205, notes: 'temporary cap; retry_on=2026-09-10' },
    { id: 206 },
  ]);
  const result = planBatch(fx.rows, { ...fx, today: '2026-08-19' });

  assert.deepEqual(result.waves.flatMap(wave => wave.reportIds), [206]);
  assert.deepEqual(result.skipped.map(item => item.reportId), [201, 202, 203, 204, 205]);
});

test('companies in the active interview register are excluded without fuzzy matching', (t) => {
  const fx = fixture(t, [
    { id: 211, company: 'Acme, Inc.' },
    { id: 212, company: 'Acme Labs' },
    { id: 213, company: 'Other Company' },
  ]);
  const activeInterviewCompanies = buildActiveInterviewCompanyIndex([
    { Company: 'ACME INC', Status: 'Confirmed' },
  ]);
  const result = planBatch(fx.rows, { ...fx, activeInterviewCompanies });

  assert.deepEqual(result.waves.flatMap(wave => wave.reportIds), [212, 213]);
  assert.deepEqual(result.skipped.map(item => item.reportId), [211]);
  assert.equal(result.skipped[0].reason, 'active interview company: ACME INC');
});

test('active company index accepts the canonical process-schema row shape', () => {
  const companies = buildActiveInterviewCompanyIndex([
    { identity: 'tracker:#101', company: 'Active Co' },
  ]);
  assert.equal(companies.get('activeco'), 'Active Co');
});

test('receipt posting identity and canonical paths are hard constraints', (t) => {
  const mismatch = fixture(t, [{ id: 301, postingKey: 'greenhouse:acme:999999' }]);
  const mismatchResult = planBatch(mismatch.rows, mismatch);
  assert.deepEqual(mismatchResult.waves, []);
  assert.match(mismatchResult.unresolved[0].reason, /posting key/i);

  const traversal = fixture(t, [{ id: 302 }]);
  traversal.receipt.reports[0].report_path = '../reports/302-test.md';
  assert.throws(() => planBatch(traversal.rows, traversal), /non-canonical report path/i);

  const padded = fixture(t, [{ id: 303 }]);
  padded.receipt.reports[0].report_path = ' reports/303-test.md ';
  assert.throws(() => planBatch(padded.rows, padded), /non-canonical report path/i);
});

test('terminal status protection cannot be overridden by a status argument', (t) => {
  const fx = fixture(t, [{ id: 401, status: 'Applied' }]);
  assert.throws(() => planBatch(fx.rows, { ...fx, status: 'Applied' }), /status must be Evaluated/i);
});

test('hold markers use the last value, support clear, and use the Los Angeles date', (t) => {
  assert.equal(localDate(new Date('2026-09-10T05:30:00.000Z')), '2026-09-09');
  const fx = fixture(t, [
    { id: 501, notes: 'submission uncertain; no_retry; no_retry=clear' },
    { id: 502, notes: 'retry_on=2026-09-10; retry_on=2026-08-01' },
    { id: 503, notes: 'identity_review/no_submit; identity_review/no_submit=clear' },
    { id: 504, notes: 'retry_on=2026-09-10' },
    { id: 505, notes: 'submission uncertain; no_retry; no_retry=clearance' },
    { id: 506, notes: 'identity_review/no_submit; identity_review/no_submit=cleared' },
    { id: 507, notes: 'retry_on=2026-09-10; retry_on=clearance' },
  ]);
  const result = planBatch(fx.rows, { ...fx, today: '2026-09-09' });
  assert.deepEqual(result.waves.flatMap(wave => wave.reportIds), [501, 502, 503]);
  assert.deepEqual(result.skipped.map(item => item.reportId), [504, 505, 506, 507]);
});
