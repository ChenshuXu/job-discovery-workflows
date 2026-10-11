#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createCareerFixture, DISCOVERY_ROOT, PUBLIC_FIXTURE_ROOT, sha256, treeManifest } from './e2e-career-fixture.mjs';
import { SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'blacklist', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = root => JSON.stringify(treeManifest(root));
const list = rows => '# Blacklist\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n' + rows.map(row => `| ${row[0]} | 2026-10-03 | ${row[1]} | Fictional E2E hold |\n`).join('');
const key = id => `linkedin:linkedin.com:${id}`;
const single = (label, company, url, postingKey, extra = [], expect = 0) => fx.run(label, script('career-ops-blacklist.mjs'),
  ['--career-ops', fx.codeRoot, '--company', company, '--url', url, '--posting-key', postingKey, ...extra], { expect });
try {
  seedCandidate(fx);
  const blacklistFile = path.join(fx.dataRoot, 'data/blacklist.md');
  single('absent-list-allowed', 'Blocked Co.', 'https://www.linkedin.com/jobs/view/89000001', key('89000001'));
  const initial = list([['Blocked Co.', 'company'], ['hold.example', 'domain'], ['Second Hold', 'company']]);
  fx.write(blacklistFile, initial);
  single('case-punctuation-held', 'BLOCKED CO', 'https://www.linkedin.com/jobs/view/89000001', key('89000001'), [], 2);
  single('subdomain-held', 'Unrelated label', 'https://jobs.hold.example/roles/123', 'generic:jobs.hold.example:123', [], 2);
  single('domain-suffix-boundary', 'Unrelated label', 'https://nothold.example/roles/123', 'generic:nothold.example:123');
  single('subsidiary-not-inferred', 'Blocked Co Subsidiary', 'https://www.linkedin.com/jobs/view/89000003', key('89000003'));
  single('exact-single-override', 'Blocked Co', 'https://www.linkedin.com/jobs/view/89000001', key('89000001'), ['--allow-blacklisted', key('89000001')]);
  single('reject-out-of-scope-override', 'Blocked Co', 'https://www.linkedin.com/jobs/view/89000001', key('89000001'), ['--allow-blacklisted', key('89000002')], 1);
  single('reject-key-url-mismatch-override', 'Blocked Co', 'https://www.linkedin.com/jobs/view/89000002', key('89000001'), ['--allow-blacklisted', key('89000001')], 1);
  const scannerFile = path.join(fx.codeRoot, 'scan.mjs');
  const scanner = readFileSync(scannerFile, 'utf8');
  const forbiddenFile = path.join(fx.dataRoot, 'parser-import-side-effect.txt');
  const injection = `\nwriteFileSync(${JSON.stringify(forbiddenFile)}, 'unexpected import write');\n`;
  fx.write(path.join(fx.root, 'parser-import-failure-injection.json'), { target: scannerFile, original_sha256: sha256(scanner), appended_code: injection });
  const beforeImport = manifest(fx.dataRoot);
  fx.write(scannerFile, scanner + injection);
  try {
    const denied = single('reject-write-during-native-parser-import', 'Blocked Co', 'https://www.linkedin.com/jobs/view/89000001', key('89000001'), [], 1);
    fx.check('native parser import cannot mutate Career-Ops', denied.stderr.includes('ERR_ACCESS_DENIED') && !existsSync(forbiddenFile) && manifest(fx.dataRoot) === beforeImport);
  } finally { fx.write(scannerFile, scanner); }

  const jobs = [
    { id: '89000001', company: 'BLOCKED CO' }, { id: '89000002', company: 'Allowed Co' },
    { id: '89000003', company: 'Blocked Co Subsidiary' },
  ];
  let runRoot = seedScan(fx, { jobs });
  fx.run('plan-company-hold', script('plan-scan-evaluations.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, runRoot);
  const audit = parse(path.join(runRoot, 'triage/blacklist.json'));
  const assigned = Object.values(plan.assignments).flat();
  fx.check('only exact blacklisted company is held before assignment', audit.excluded_count === 1 && audit.results[0].posting_key === key('89000001')
    && assigned.length === 2 && !assigned.includes(key('89000001')));
  fx.check('held source evidence is preserved', existsSync(path.join(runRoot, 'sources/jobspy/jobs/89000001.md')));
  mergeAll(fx, runRoot, plan);
  fx.write(blacklistFile, initial + '| Allowed Co | 2026-10-03 | company | Added after planning |\n');
  const beforeDrift = manifest(fx.dataRoot);
  const drift = fx.run('reject-drift-before-commit', script('commit-scan.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
  fx.check('blacklist drift blocks persistence without data writes', (drift.stdout + drift.stderr).includes('blacklist changed') && manifest(fx.dataRoot) === beforeDrift);
  fx.check('failed run keeps an auditable terminal receipt', parse(path.join(runRoot, 'receipt.json')).status === 'FAILED');
  fx.write(blacklistFile, initial);
  runRoot = seedScan(fx, { name: 'accepted-scan', jobs });
  fx.run('replan-after-drift', script('plan-scan-evaluations.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot]);
  mergeAll(fx, runRoot, writeScoreParts(fx, runRoot));
  fx.run('commit-allowed-through-official-writers', script('commit-scan.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(runRoot, 'receipt.json'));
  fx.check('held posting never persisted and eligible receipt completes', receipt.status === 'COMPLETE' && receipt.reports.length === 2
    && !receipt.reports.some(item => item.posting_key === key('89000001')));
  const tracker = readFileSync(path.join(fx.dataRoot, 'data/applications.md'), 'utf8');
  fx.check('tracker preserves scores with no blocked row', !tracker.includes('89000001') && tracker.includes('4.2'));

  const active = fx.write(path.join(fx.root, 'active-interviews.md'), readFileSync(path.join(PUBLIC_FIXTURE_ROOT, 'examples/active-interviews.md'), 'utf8'));
  const batch = path.join(DISCOVERY_ROOT, '.agents/skills/career-ops-ego-apply/scripts/application-batch.mjs');
  const batchArgs = ['--career-ops', fx.codeRoot, '--active-interviews', active, '--runs-root', path.dirname(runRoot), '--run', path.basename(runRoot), '--json'];
  fx.write(blacklistFile, initial + '| Allowed Co | 2026-10-03 | company | Added before application |\n');
  const beforeApply = manifest(fx.dataRoot);
  const heldBatch = JSON.parse(fx.run('application-batch-current-list', batch, batchArgs).stdout);
  fx.check('application preparation rechecks current blacklist', heldBatch.summary.selectableRows === 1 && heldBatch.blacklist.excluded_count === 1
    && heldBatch.skipped.some(item => item.reason.startsWith('blacklist hold:')));
  single('single-pre-submit-current-list', 'Allowed Co', 'https://www.linkedin.com/jobs/view/89000002', key('89000002'), [], 2);
  const allowedBatch = JSON.parse(fx.run('application-exact-override', batch, [...batchArgs, '--allow-blacklisted', key('89000002')]).stdout);
  fx.check('application override records the exact key', allowedBatch.summary.selectableRows === 2
    && JSON.stringify(allowedBatch.blacklist.overrides) === JSON.stringify([key('89000002')]));
  fx.run('application-reject-unmatched-override', batch, [...batchArgs, '--allow-blacklisted', key('89000003')], { expect: 1 });
  fx.check('application preparation leaves tracker/reports/scores unchanged', manifest(fx.dataRoot) === beforeApply);

  fx.write(blacklistFile, initial);
  const overrideRun = seedScan(fx, { name: 'exact-override', jobs: [
    { id: '89000004', company: 'Blocked Co' }, { id: '89000005', company: 'Second Hold' },
  ] });
  fx.run('scan-exact-override', script('plan-scan-evaluations.mjs'), ['--run', overrideRun, '--career-ops', fx.codeRoot, '--allow-blacklisted', key('89000004')]);
  const overridePlan = parse(path.join(overrideRun, 'assignments.json'));
  const overrideAudit = parse(path.join(overrideRun, 'triage/blacklist.json'));
  fx.check('scan exception cannot release other blacklisted postings', JSON.stringify(Object.values(overridePlan.assignments).flat()) === JSON.stringify([key('89000004')])
    && overrideAudit.results.find(item => item.posting_key === key('89000005')).disposition === 'BLACKLIST_HOLD');
  console.log(JSON.stringify(fx.finish({ runRoot, scope: 'Official parser and real scan/application CLI workflows with fictional data. No application submitted.' }), null, 2));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
