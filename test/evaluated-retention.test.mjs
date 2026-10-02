import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEvaluatedRetentionPlan, cleanupExpiredEvaluated } from '../src/evaluated-retention.mjs';
import { prepareDailyScan } from '../src/prepare-daily-scan.mjs';
import { trackerIdentityNote } from '../src/render-scan-reports.mjs';

const columns = { num: 1, date: 2, company: 3, role: 4, score: 5, status: 6, pdf: 7, report: 8, notes: 9 };
const parser = {
  resolveColumns: () => columns,
  parseTrackerRow(line) {
    const cells = line.split('|').map(value => value.trim());
    const num = Number(cells[columns.num]);
    if (!line.startsWith('|') || !Number.isInteger(num)) return null;
    return {
      num,
      date: cells[columns.date],
      company: cells[columns.company],
      role: cells[columns.role],
      score: cells[columns.score],
      status: cells[columns.status],
      pdf: cells[columns.pdf],
      report: cells[columns.report],
      notes: cells[columns.notes],
      raw: line,
    };
  },
};

const trackerHeader = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
const historyHeader = 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evaluated-retention-'));
  const career = path.join(root, 'career-ops');
  const run = path.join(root, 'job-discovery/runs/new-run');
  mkdirSync(path.join(career, 'data'), { recursive: true });
  mkdirSync(path.join(career, 'reports'), { recursive: true });
  mkdirSync(path.join(career, 'jds'), { recursive: true });
  return { root, career, run, tracker: path.join(career, 'data/applications.md'), history: path.join(career, 'data/scan-history.tsv') };
}

function addJob(fx, { number, date, id, runId = `run-${id}`, noteSuffix = '', status = 'Evaluated' }) {
  const key = `greenhouse:acme:${id}`;
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`;
  const reportPath = `reports/${String(number).padStart(3, '0')}-acme-role-${date}.md`;
  const jdPath = `jds/discovery-${runId}-${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`;
  const note = `${trackerIdentityNote({ primary_key: key })}${noteSuffix}`;
  const row = `| ${number} | ${date} | Acme | Role | 4.2/5 | ${status} | ❌ | [${number}](../${reportPath}) | ${note} |`;
  const report = `# Evaluation: Acme — Role\n\n**Report Number:** ${String(number).padStart(3, '0')}  \n**Date:** ${date}  \n**Score:** 4.2/5  \n**URL:** ${url}  \n**Posting Key:** ${key}  \n\n---\n\n## Machine Summary\n\`\`\`yaml\nrun_id: "${runId}"\nposting_key: "${key}"\nposting_url: "${url}"\n\`\`\`\n`;
  const jd = `# Acme - Role\n\n**URL:** ${url}\n**Discovery Run:** ${runId}\n`;
  writeFileSync(path.join(fx.career, reportPath), report);
  writeFileSync(path.join(fx.career, jdPath), jd);
  return { row, history: `${url}\t${date}\tjob-discovery:jobspy\tRole\tAcme\tdaily-scan:${runId}\tSeattle, WA`, reportPath, jdPath };
}

function writeFixture(fx, jobs) {
  writeFileSync(fx.tracker, `${trackerHeader}${jobs.map(job => job.row).join('\n')}\n`);
  writeFileSync(fx.history, `${historyHeader}${jobs.map(job => job.history).join('\n')}\n`);
}

function fakeInterfaces(fx, { syncTracker = () => {}, pipelineCheck = () => ({ exit_code: 0, errors: 0, warnings: 0 }) } = {}) {
  return {
    parser,
    trackerFile: fx.tracker,
    resolvePdfIndexPath: () => path.join(fx.career, 'data/pdf-index.tsv'),
    openTrackerTransaction: async file => ({
      read: () => readFileSync(file, 'utf8'),
      replace: text => writeFileSync(file, text),
      close: () => {},
    }),
    writeFileAtomic: (file, text) => writeFileSync(file, text),
    acquireCommitLock: async () => ({ release: () => {} }),
    withHistoryLock: async (_file, fn) => fn(),
    syncTracker,
    pipelineCheck,
  };
}

test('TTL uses local calendar days and protects manual/status-touched rows', () => {
  const fx = fixture();
  const expired = addJob(fx, { number: 1, date: '2026-08-28', id: '1001' });
  const recent = addJob(fx, { number: 2, date: '2026-08-29', id: '1002' });
  const manual = addJob(fx, { number: 3, date: '2026-08-20', id: '1003', noteSuffix: '; retry later' });
  const transitioned = addJob(fx, { number: 4, date: '2026-08-20', id: '1004' });
  writeFixture(fx, [expired, recent, manual, transitioned]);
  const plan = buildEvaluatedRetentionPlan({
    trackerText: readFileSync(fx.tracker, 'utf8'),
    scanHistoryText: readFileSync(fx.history, 'utf8'),
    careerRoot: fx.career,
    parser,
    asOfDate: '2026-09-04',
    ttlDays: 7,
    statusLogText: '4\t2026-08-21\tEvaluated\tApplied\tset-status\n',
  });
  assert.deepEqual(plan.cleaned.map(item => item.tracker_number), [1]);
  assert.equal(plan.protected.find(item => item.tracker_number === 3)?.reason, 'MANUAL_NOTE');
  assert.equal(plan.protected.find(item => item.tracker_number === 4)?.reason, 'STATUS_HISTORY');
  assert.equal(plan.protected.some(item => item.tracker_number === 2), false);
});

test('retention includes skipped/discarded evaluations but protects application history and references', () => {
  const fx = fixture();
  const statuses = ['SKIP', 'Skipped', 'Discarded', 'Discarded', 'SKIP', 'Discarded', 'SKIP', 'Discarded', 'Applied'];
  const jobs = statuses.map((status, index) => addJob(fx, {
    number: index + 1, date: index === 6 ? '2026-08-29' : '2026-08-28', id: `400${index}`, status,
  }));
  writeFixture(fx, jobs);
  const plan = buildEvaluatedRetentionPlan({
    trackerText: readFileSync(fx.tracker, 'utf8'), scanHistoryText: readFileSync(fx.history, 'utf8'),
    careerRoot: fx.career, parser, asOfDate: '2026-09-04', ttlDays: 7,
    statusLogText: [
      '1\t2026-08-29\tEvaluated\tSKIP\tweb',
      '3\t2026-08-29\tEvaluated\tSKIP\tweb',
      '3\t2026-08-30\tSKIP\tDiscarded\tweb',
      '4\t2026-08-29\tApplied\tInterview\tweb',
      '4\t2026-08-30\tInterview\tDiscarded\tweb',
      '5\t2026-08-29\tUnknown\tSKIP\tweb',
      '6\t2026-08-29\tEvaluated\tSKIP\tweb',
    ].join('\n'),
    activeInterviewsText: 'Archived interview for #8\n',
  });
  assert.deepEqual(plan.cleaned.map(item => item.tracker_number), [1, 2, 3]);
  assert.deepEqual(plan.cleaned.map(item => item.status), ['SKIP', 'Skipped', 'Discarded']);
  assert.deepEqual(plan.candidate_status_counts, { evaluated: 0, skip: 4, discarded: 4 });
  assert.deepEqual(plan.protected.map(item => [item.tracker_number, item.reason]), [
    [4, 'STATUS_HISTORY'], [5, 'STATUS_HISTORY'], [6, 'STATUS_HISTORY'], [8, 'ACTIVE_INTERVIEW'],
  ]);
});

test('cleanup removes mixed-status tracker/report/JD/history chains once and retains the status ledger', async () => {
  const fx = fixture();
  const jobs = ['Evaluated', 'SKIP', 'Discarded'].map((status, index) => addJob(fx, {
    number: index + 1, date: '2026-08-28', id: `200${index + 1}`, status,
  }));
  writeFixture(fx, jobs);
  const statusLog = '2\t2026-08-29\tEvaluated\tSKIP\tweb\n3\t2026-08-30\tEvaluated\tDiscarded\tweb\n';
  const statusFile = path.join(fx.career, 'data/status-log.tsv');
  writeFileSync(statusFile, statusLog);
  let syncs = 0;
  const options = {
    runRoot: fx.run,
    careerRoot: fx.career,
    asOfDate: '2026-09-04',
    runtime: { retention: { evaluated_unapplied_ttl_days: 7 } },
    interfaces: fakeInterfaces(fx, { syncTracker: () => { syncs += 1; } }),
  };
  const first = await cleanupExpiredEvaluated(options);
  assert.equal(first.audit.cleaned_count, 3);
  assert.deepEqual(first.audit.cleaned.map(item => item.status), ['Evaluated', 'SKIP', 'Discarded']);
  assert.equal(readFileSync(fx.tracker, 'utf8'), trackerHeader);
  assert.equal(readFileSync(fx.history, 'utf8'), historyHeader);
  assert.equal(readFileSync(statusFile, 'utf8'), statusLog);
  for (const job of jobs) {
    assert.equal(existsSync(path.join(fx.career, job.reportPath)), false);
    assert.equal(existsSync(path.join(fx.career, job.jdPath)), false);
  }
  assert.equal(existsSync(first.auditFile), true);
  await cleanupExpiredEvaluated(options);
  assert.equal(syncs, 1);
});

test('cleanup protects interview references in the default Career Docs register', async () => {
  const fx = fixture();
  const job = addJob(fx, { number: 1, date: '2026-08-28', id: '2002' });
  writeFixture(fx, [job]);
  const register = path.join(fx.root, 'career-docs/context/Interview/active-interviews.md');
  mkdirSync(path.dirname(register), { recursive: true });
  writeFileSync(register, 'Active interview for #1\n');
  const result = await cleanupExpiredEvaluated({ runRoot: fx.run, careerRoot: fx.career, asOfDate: '2026-09-04',
    runtime: { retention: { evaluated_unapplied_ttl_days: 7 } }, interfaces: fakeInterfaces(fx) });
  assert.equal(result.audit.cleaned_count, 0);
  assert.equal(result.audit.protected[0].reason, 'ACTIVE_INTERVIEW');
  assert.ok(existsSync(path.join(fx.career, job.reportPath)));
});

test('a failed sync restores every owned surface', async () => {
  const fx = fixture();
  const job = addJob(fx, { number: 1, date: '2026-08-28', id: '3001', status: 'Discarded' });
  writeFixture(fx, [job]);
  const trackerBefore = readFileSync(fx.tracker, 'utf8');
  const historyBefore = readFileSync(fx.history, 'utf8');
  let syncs = 0;
  await assert.rejects(cleanupExpiredEvaluated({
    runRoot: fx.run,
    careerRoot: fx.career,
    asOfDate: '2026-09-04',
    runtime: { retention: { evaluated_unapplied_ttl_days: 7 } },
    interfaces: fakeInterfaces(fx, { syncTracker: () => { if (++syncs === 1) throw new Error('sync failed'); } }),
  }), /sync failed/);
  assert.equal(readFileSync(fx.tracker, 'utf8'), trackerBefore);
  assert.equal(readFileSync(fx.history, 'utf8'), historyBefore);
  assert.equal(existsSync(path.join(fx.career, job.reportPath)), true);
  assert.equal(existsSync(path.join(fx.career, job.jdPath)), true);
  assert.equal(existsSync(path.join(fx.career, '.daily-scan-retention-recovery')), false);
});

test('Daily Scan preparation runs retention before baseline and records its summary', async () => {
  const order = [];
  const value = await prepareDailyScan({
    runRoot: '/tmp/run-1',
    careerRoot: '/tmp/career-ops',
    startUsage: () => { order.push('usage'); },
    cleanup: async () => {
      order.push('cleanup');
      return { auditFile: '/tmp/run-1/maintenance/evaluated-retention.json', audit: { as_of_date: '2026-09-04', ttl_days: 7, cutoff_date: '2026-08-28', cleaned_count: 2, protected_count: 1 } };
    },
    capture: options => { order.push('baseline'); return options; },
  });
  assert.deepEqual(order, ['usage', 'cleanup', 'baseline']);
  assert.equal(value.maintenance.evaluated_retention.cleaned_count, 2);
});
