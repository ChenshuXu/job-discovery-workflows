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
  parseMarkdownLinks: value => [...String(value ?? '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(match => ({ label: match[1], target: match[2] })),
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

// Failure cases: negative submission wording, mixed closed/real-process notes,
// uncertain results, unknown notes, changed identity, references and rollback.
test('ordinary closure/non-submission notes clean up without erasing real or uncertain processes', async () => {
  const fx = fixture();
  const ordinary = [
    '; Official Stripe Greenhouse posting closed on 2026-08-15; no submission made',
    '; 2026-08-23: exact LinkedIn posting 4452824666 is no longer accepting applications',
    '; Official LinkedIn posting says No longer accepting applications; no live apply control.',
    '; Official Quarterhill posting returned 404 and states the page no longer exists.',
    '; Official Uber Careers displayed Job removed; no submission attempted.',
    '; Official form is live; required legal-status category is unresolved.; User discarded without submitting; no matching official application receipt found.',
    '; Official form is live; User discarded without submitting; only a password-reset email was found, not an application receipt.',
    '; ATS blocked: Microsoft returned Ineligible to apply; no submission made',
    '; Gmail draft reminder received 2026-08-19; application not submitted',
    '; Ego Apply closeout: truthful H-1B transfer work-authorization blocker',
    '; Ashby rejected the submission as possible spam; no application created; no_retry.',
    '; Ashby rejected submission twice because a required field was reported missing; no application created, no_retry.',
    '; Permanent eligibility mismatch: official form requires authorization the candidate does not have. No submission.',
    '; Exact LinkedIn posting states No longer accepting applications; closed on 2026-08-23.',
    '; ATS blocked: Microsoft returned Ineligible to apply on 2026-08-15; no submission made',
    '; Official Microsoft position 123 is live and prepared; waiting for three required legal acknowledgments.; User discarded without submitting; no exact receipt for Microsoft position 123 found on 2026-08-21.',
    '; Official Google Careers blocked submission at 3 applications per 30 days; retry_on=2026-09-07; User discarded without submitting; no matching official receipt found; retry_on=clear.',
    '; Official Amazon Jobs preflight showed Sorry, the job you are looking for is not available; no application submitted.',
    '; Official Workday page states the page does not exist; closed on 2026-08-23.',
    '; No submit: official form states candidates requiring sponsorship will be rejected.; Permanent ineligibility confirmed on official application: candidates requiring sponsorship will be rejected. No submission was attempted.',
    '; Exact LinkedIn posting is no longer accepting applications; separate frozen posting 4457171702 remains independently reviewable.',
    '; Official Uber Careers displayed Job removed; residual Apply link was not used.',
    '; Exact posting resolves to official Uber job 300641. Official Uber Careers displayed Not found and The page you are looking for does not exist. No application attempted.',
    '; Permanent eligibility mismatch: official form asks for authorization; candidate does not have that authorization. No submission.',
    '; official BMS page states no longer accepting applications; R1602672',
    '; LinkedIn posting explicitly shows No longer accepting applications; verified 2026-08-23.',
    '; Daily Scan 20260907-143823 report audit correction: The role explicitly does not provide required visa sponsorship. (original run preserved).',
  ];
  const protectedNotes = [
    '; Official posting closed; ATS submission confirmed 2026-08-23',
    '; Official posting closed; application received by employer',
    '; Official posting closed; applied on 2026-08-21',
    '; Official posting closed; Gmail interview assignment received',
    '; Official posting closed; Intro call completed; candidate withdrew',
    '; Official posting closed; final action uncertain; no acceptance evidence; no_retry',
    '; Official posting closed; final submit produced no confirmation; ambiguous submission, no_retry',
    '; Official posting closed; application delivery failed',
    '; Official posting closed; acceptance unconfirmed after Submit; email verification pending',
    '; User discarded without submitting; earlier application was submitted successfully',
    '; Official posting closed; application sent on 2026-08-21',
    '; Official posting closed and the application was already received by employer',
    '; Official posting closed; submission confirmation is missing',
    '; Official posting closed but an application receipt exists',
    '; Official posting closed; user withdrew after the phone screen',
    '; retry later',
    '; Official posting closed; preserve my notes',
    '; 2026-10-13 audit: verify before applying - official source says Job removed but another exact source has Apply Now.',
  ];
  const jobs = [...ordinary, ...protectedNotes].map((noteSuffix, index) => addJob(fx, {
    number: index + 1, date: '2026-08-20', id: `500${index}`, noteSuffix,
    status: index % 2 ? 'Discarded' : 'Evaluated',
  }));
  const history = addJob(fx, { number: 100, date: '2026-08-20', id: '5100', status: 'Discarded', noteSuffix: ordinary[0] });
  const referenced = addJob(fx, { number: 101, date: '2026-08-20', id: '5101', noteSuffix: ordinary[0] });
  const changedIdentity = addJob(fx, { number: 102, date: '2026-08-20', id: '5102', noteSuffix: ordinary[0] });
  changedIdentity.row = changedIdentity.row.replace('live-role/Apply verification is deferred.', 'reviewed identity manually.');
  writeFixture(fx, [...jobs, history, referenced, changedIdentity]);
  const statusLog = '100\t2026-08-21\tEvaluated\tApplied\tweb\n100\t2026-08-22\tApplied\tDiscarded\tweb\n';
  writeFileSync(path.join(fx.career, 'data/status-log.tsv'), statusLog);
  writeFileSync(path.join(fx.career, 'data/follow-ups.md'), 'Follow up on #101\n');
  const result = await cleanupExpiredEvaluated({
    runRoot: fx.run, careerRoot: fx.career, asOfDate: '2026-09-04',
    runtime: { retention: { evaluated_unapplied_ttl_days: 7 } }, interfaces: fakeInterfaces(fx),
  });
  assert.deepEqual(result.audit.cleaned.map(item => item.tracker_number), ordinary.map((_, index) => index + 1));
  assert.equal(result.audit.protected.find(item => item.tracker_number === 100)?.reason, 'STATUS_HISTORY');
  assert.equal(result.audit.protected.find(item => item.tracker_number === 101)?.reason, 'FOLLOW_UP');
  assert.equal(result.audit.protected.find(item => item.tracker_number === 102)?.reason, 'MANUAL_NOTE');
  assert.equal(result.audit.protected.length, protectedNotes.length + 3);
  const remaining = readFileSync(fx.tracker, 'utf8');
  for (const job of jobs.slice(ordinary.length).concat(history, referenced, changedIdentity)) {
    assert.ok(remaining.includes(job.row));
    assert.ok(existsSync(path.join(fx.career, job.reportPath)));
    assert.ok(existsSync(path.join(fx.career, job.jdPath)));
    assert.ok(readFileSync(fx.history, 'utf8').includes(job.history));
  }
  for (const job of jobs.slice(0, ordinary.length)) {
    assert.equal(remaining.includes(job.row), false);
    assert.equal(existsSync(path.join(fx.career, job.reportPath)), false);
    assert.equal(existsSync(path.join(fx.career, job.jdPath)), false);
    assert.equal(readFileSync(fx.history, 'utf8').includes(job.history), false);
  }
  assert.equal(readFileSync(path.join(fx.career, 'data/status-log.tsv'), 'utf8'), statusLog);
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
  const job = addJob(fx, { number: 1, date: '2026-08-28', id: '3001', status: 'Discarded', noteSuffix: '; Official posting closed; no submission made' });
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
