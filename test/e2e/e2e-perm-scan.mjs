#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest, content } from './e2e-career-fixture.mjs';
import { EVIDENCE_TEXT, SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll, scoreReport } from './e2e-scan-inputs.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'perm-scan', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const key = id => `linkedin:linkedin.com:${id}`;
const manifest = () => JSON.stringify(treeManifest(fx.dataRoot));
const catalogFile = path.join(fx.root, 'perm-employers.json');
const catalog = {
  schema_version: 1, source_url: 'https://example.invalid/perm-tracker', source_snapshot_at: '2026-10-08T21:14:00Z',
  captured_at: '2026-10-14T06:30:00Z', selection: 'tracker-current-status', displayed_group_count: 2,
  companies: [{ company: 'Fictional Garden', aliases: ['Garden Labs'], status: '正常办理', information_date: '2026-10-08',
    source_count: 1, sources: [{ platform: 'Fictional source', status: '正常办理', published_label: '2026-10-08', url: 'https://example.invalid/source' }] }],
  unresolved_groups: [{ company: '未具名', status: '正常办理', information_date: '2026-10', source_count: 1,
    sources: [{ platform: 'Fictional source', status: '正常办理', published_label: '2026-10', url: null }] }],
};
const jobs = [
  { id: '89100001', company: 'FICTIONAL GARDEN, Inc.', body: [EVIDENCE_TEXT.scope, EVIDENCE_TEXT.compensation, EVIDENCE_TEXT.culture,
    EVIDENCE_TEXT.sponsorship, 'Build distributed systems with testing and debugging.', 'Official posting: https://boards.greenhouse.io/garden/jobs/89100001'].join('\n') },
  { id: '89100002', company: 'Garden Labs' },
  { id: '89100003', company: 'Fictional Garden Consulting' },
  { id: '89100004', company: 'Other Co', body: 'We use Fictional Garden products. '.repeat(25) },
  { id: '89100005', company: 'unknown' },
];
const plan = run => fx.run(`${path.basename(run)}-plan`, script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
try {
  fx.write(path.join(fx.root, 'failure-modes.json'), parse(path.join(DISCOVERY_ROOT, 'test/perm-scan-e2e.plan.json')));
  const importer = path.join(DISCOVERY_ROOT, '.agents/skills/career-ops-perm-scan/scripts/import-tracker.mjs');
  const snapshotFile = path.join(fx.root, 'tracker-snapshot.txt');
  const snapshotText = `text "数据截止 2026-10-08 21:14 UTC"\ntext "正常办理 2"\ntext "当前显示"\ntext "2"\n            container [ref=1]\n              heading\n                text "Fictional Garden"\n              text "正常办理"\n              text "岗位 · Other"\n              text "信息时间 2026-10"\n              text "1 条来源"\n              svg_root\n            container\n              text "Fictional source"\n              text "正常办理"\n              text "2026-10-08"\n              heading\n                anchor [ref=2, url=https://example.invalid/source]\n                  text "Company evidence"\n              paragraph\n                text "Public record."\n            container [ref=3]\n              heading\n                text "未具名"\n              text "正常办理"\n              text "岗位 · Other"\n              text "信息时间 2026-10"\n              text "1 条来源"\n              svg_root\n            container\n              text "Fictional source"\n              text "正常办理"\n              text "2026-10"\n              heading\n                text "Unnamed record"\n              paragraph\n                text "Public record."\n          container "AI 背景知识"\n            text "Never company evidence"\n`;
  const imported = path.join(fx.root, 'imported.json');
  fx.write(snapshotFile, snapshotText);
  fx.run('import-normal-groups', importer, ['--snapshot', snapshotFile, '--out', imported]);
  fx.check('import identifies companies and isolates unnamed groups', parse(imported).companies.length === 1 && parse(imported).unresolved_groups.length === 1);
  fx.write(snapshotFile, snapshotText.replace('正常办理 2', '正常办理 3'));
  fx.run('reject-truncated-tracker-capture', importer, ['--snapshot', snapshotFile, '--out', imported], { expect: 1 });
  fx.check('failed import preserves the previous catalog', parse(imported).companies.length === 1);
  seedCandidate(fx); fx.write(catalogFile, catalog);
  const run = seedScan(fx, { name: 'accepted-perm', jobs, permEmployers: catalogFile });
  fx.run('identity-resolution-before-perm-gate', script('resolve-canonical-urls.mjs'), ['--run', run]);
  plan(run);
  let assignment = parse(path.join(run, 'assignments.json'));
  const auditFile = path.join(run, 'triage/perm-employer-scope.json');
  const audit = parse(auditFile);
  const acquisition = parse(path.join(run, 'acquisition.json'));
  fx.check('only exact employer, legal suffix and explicit alias enter assignments',
    JSON.stringify(Object.values(assignment.assignments).flat().sort()) === JSON.stringify(['greenhouse:garden:89100001', key('89100002')]));
  fx.check('company gate conserves every posting and excludes mentions, substring and unknown',
    audit.pre_scope_count === 5 && audit.accepted_count === 2 && audit.excluded_count === 3 && acquisition.perm_exclusion_count === 3);
  fx.check('scope preserves original source JDs and liveness', jobs.every(job => existsSync(path.join(run, 'sources/jobspy/jobs', `${job.id}.md`)))
    && acquisition.sources[0].status === 'SUCCESS' && acquisition.sources[0].markdown_jobs === 5);
  fx.check('excluded combined JDs are removed', jobs.slice(2).every(job => !existsSync(path.join(run, 'jobs', `linkedin-linkedin.com-${job.id}.md`))));
  const baseline = parse(path.join(run, 'baseline.json'));
  fx.check('baseline and assignments freeze identical catalog', baseline.perm_employers && JSON.stringify(baseline.perm_employers) === JSON.stringify(assignment.perm_employers));
  plan(run);
  writeScoreParts(fx, run);
  const untouched = manifest();
  for (const [label, change] of [
    ['missing-audit', () => rmSync(auditFile)],
    ['forged-allow-decision', () => fx.write(auditFile, { ...audit, results: audit.results.map((item, i) => i === 2 ? { ...item, allowed: true } : item) })],
    ['missing-plan-snapshot', () => { const next = structuredClone(assignment); delete next.perm_employers; fx.write(path.join(run, 'assignments.json'), next); }],
    ['employer-leak', () => fx.write(path.join(run, 'acquisition.json'), { ...acquisition, acquired: acquisition.acquired.map((record, i) => i ? record : { ...record, company: 'Other Co' }) })],
  ]) {
    change();
    fx.run(`reject-${label}`, script('run-contract.mjs'), ['--run', run], { expect: 1 });
    fx.run(`worker-reject-${label}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', 'worker-1'], { expect: 1 });
    fx.write(auditFile, audit); fx.write(path.join(run, 'assignments.json'), assignment); fx.write(path.join(run, 'acquisition.json'), acquisition);
  }
  fx.check('contract rejection leaves Career-Ops unchanged', manifest() === untouched);
  mergeAll(fx, run, writeScoreParts(fx, run));
  fx.run('commit-perm-through-official-writers', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('PERM receipt and persisted reports contain only allowlisted keys', receipt.status === 'COMPLETE' && receipt.reports.length === 2
    && receipt.reports.every(item => ['greenhouse:garden:89100001', key('89100002')].includes(item.posting_key)) && receipt.perm_employer_scope.accepted_count === 2);

  const driftRun = seedScan(fx, { name: 'policy-drift', jobs: [{ id: '89100006', company: 'Garden Labs' }], permEmployers: catalogFile });
  plan(driftRun); const driftPlan = writeScoreParts(fx, driftRun);
  fx.write(catalogFile, { ...catalog, captured_at: '2026-10-14T07:00:00Z' });
  fx.run('reject-policy-drift-on-reuse', script('plan-scan-evaluations.mjs'), ['--run', driftRun, '--career-ops', fx.codeRoot], { expect: 1 });
  fx.run('reject-policy-drift-in-worker-merge', script('merge-worker-results.mjs'), ['--run', driftRun, '--worker', Object.keys(driftPlan.assignments)[0]], { expect: 1 });
  fx.run('completed-receipt-survives-catalog-refresh', script('run-contract.mjs'), ['--run', run]);
  fx.write(catalogFile, catalog); mergeAll(fx, driftRun, driftPlan);
  fx.write(catalogFile, { ...catalog, captured_at: '2026-10-14T07:01:00Z' });
  const beforeCommitDrift = manifest();
  fx.run('reject-policy-drift-before-commit', script('commit-scan.mjs'), ['--run', driftRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
  fx.check('policy drift prevents every Career-Ops write', manifest() === beforeCommitDrift);
  fx.write(catalogFile, catalog);

  const heldFile = path.join(fx.dataRoot, 'data/blacklist.md');
  fx.write(heldFile, '# Blacklist\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Garden Labs | 2026-10-03 | company | Fictional hold |\n');
  const heldRun = seedScan(fx, { name: 'blacklist-still-wins', jobs: [{ id: '89100007', company: 'Garden Labs' }], permEmployers: catalogFile });
  plan(heldRun);
  fx.check('PERM allowlist does not override blacklist', Object.values(parse(path.join(heldRun, 'assignments.json')).assignments).flat().length === 0);
  rmSync(heldFile);
  const emptyRun = seedScan(fx, { name: 'no-perm-jobs', jobs: [jobs[3]], permEmployers: catalogFile });
  plan(emptyRun); mergeAll(fx, emptyRun, writeScoreParts(fx, emptyRun));
  fx.run('empty-perm-set-cannot-claim-persistence', script('commit-scan.mjs'), ['--run', emptyRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });

  const normalRun = seedScan(fx, { name: 'ordinary-daily', jobs: [{ id: '89100008', company: 'Other Co' }] });
  plan(normalRun);
  assignment = parse(path.join(normalRun, 'assignments.json'));
  fx.check('ordinary Daily Scan keeps unrelated employer eligible', !assignment.perm_employers && Object.values(assignment.assignments).flat().includes(key('89100008')));
  const repairRun = seedScan(fx, { name: `perm-${SCAN_DATE.replaceAll('-', '')}-120000`, jobs: [{ id: '89100009', company: 'Garden Labs' }], permEmployers: catalogFile });
  plan(repairRun);
  const repairPlan = writeScoreParts(fx, repairRun, () => ({ report: null, work_authorization: undefined,
    eligibility_status: 'ineligible', eligibility_category: 'employment_type', eligibility_evidence: 'JD: \"**Employment Type:** Full-time\"', rationale: 'Confirm the employment relationship.' }));
  mergeAll(fx, repairRun, repairPlan);
  fx.run('commit-original-excluded-evaluation', script('commit-scan.mjs'), ['--run', repairRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const worker = Object.keys(repairPlan.assignments).find(id => repairPlan.assignments[id].length);
  const original = parse(path.join(repairRun, 'results', `${worker}.part-1.json`)).results[0];
  const correctedFile = path.join(fx.root, 'corrected-evaluation.json');
  const repairManifestFile = path.join(fx.root, 'repair-manifest.json');
  const setCorrection = result => {
    fx.write(correctedFile, result);
    fx.write(repairManifestFile, { run_id: path.basename(repairRun), entries: [{ posting_key: original.posting_key,
      report_number: null, decision: 'Research first', corrected_result: { path: correctedFile, content: readFileSync(correctedFile, 'utf8') } }] });
  };
  const corrected = { ...original, eligibility_status: 'needs_verification', rationale: 'Confirm the employment relationship.' };
  setCorrection(corrected);
  const beforeRepair = manifest();
  const repairArgs = ['--run', repairRun, '--career-ops', fx.codeRoot, '--manifest', repairManifestFile];
  fx.run('reject-corrected-candidate-without-report', script('repair-scan-reports.mjs'), repairArgs, { expect: 1 });
  fx.check('invalid correction leaves Career-Ops unchanged', manifest() === beforeRepair);
  setCorrection({ ...corrected, report: scoreReport({ confidence: 'Low', verification: true }), work_authorization: { value: 'unstated', quote: null } });
  fx.write(catalogFile, { ...catalog, captured_at: '2026-10-14T08:00:00Z' });
  const preview = fx.run('repair-completed-perm-after-refresh', script('repair-scan-reports.mjs'), repairArgs);
  const repair = JSON.parse(preview.stdout);
  const reviewedPlan = path.join(fx.root, 'reviewed-repair-plan.json'); fx.write(reviewedPlan, repair);
  fx.run('restore-corrected-perm-report', script('repair-scan-reports.mjs'), [...repairArgs, '--apply', '--plan-file', reviewedPlan]);
  fx.check('PERM restored report retains a valid scan date', repair.plan.effects[0].report_path.endsWith(`-${SCAN_DATE}.md`));
  fx.write(catalogFile, catalog);
  for (const [label, value] of [
    ['empty-list', { ...catalog, companies: [] }],
    ['non-normal-company', { ...catalog, companies: [{ ...catalog.companies[0], status: '已暂停' }] }],
    ['unnamed-company', { ...catalog, companies: [{ ...catalog.companies[0], company: '未具名' }] }],
    ['alias-collision', { ...catalog, displayed_group_count: 3, companies: [...catalog.companies, { ...catalog.companies[0], company: 'Garden Labs', aliases: [] }] }],
  ]) {
    fx.write(catalogFile, value);
    fx.run(`reject-${label}-before-baseline`, script('prepare-daily-scan.mjs'), ['--run', path.join(fx.root, 'runs', label), '--career-ops', fx.codeRoot, '--perm-employers', catalogFile], { expect: 1 });
    fx.check(`${label} cannot start retention`, !existsSync(path.join(fx.root, 'runs', label, 'maintenance/evaluated-retention.json')));
  }
  const result = fx.finish({ runRoot: run, scope: 'Fictional acquisition and scoring fixtures; real pipeline and official writers. No live scan, legal policy verification or application.' });
  console.log(JSON.stringify({ passed: result.passed, assertions: result.assertions.length, artifact: path.join(fx.root, 'result.json') }));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
