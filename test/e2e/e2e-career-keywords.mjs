#!/usr/bin/env node
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'keywords', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = root => JSON.stringify(treeManifest(root));
try {
  seedCandidate(fx);
  const run = seedScan(fx);
  fx.run('keyword-plan', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, run);
  fx.check('new plans require schema 8', plan.result_schema_version === 8);
  const record = parse(path.join(run, 'acquisition.json')).acquired[0];
  const jd = path.join(run, record.jd_path);
  const keywords = ['C++', 'C#', '.NET', 'CI/CD', 'Node.js', 'PostgreSQL', 'JavaScript', 'distributed systems',
    'APIs', 'observability', 'testing', 'debugging', 'deployment', 'reliability', 'incident response'];
  fx.write(jd, readFileSync(jd, 'utf8') + '\nRequired technologies: C++, C#, .NET, CI/CD, Node.js, PostgreSQL and JavaScript.\n');
  const worker = Object.keys(plan.assignments).find(id => plan.assignments[id].length);
  const partFile = path.join(run, 'results', `${worker}.part-1.json`);
  const part = parse(partFile);
  part.results[0].report.keywords = keywords;
  fx.write(partFile, part);
  const original = readFileSync(partFile, 'utf8');
  const before = manifest(fx.dataRoot);
  const budgetRun = path.join(fx.root, 'budget-run'); cpSync(run, budgetRun, { recursive: true });
  for (const [name, value] of [
    ['missing', undefined], ['empty', []], ['duplicate', ['APIs', 'apis']], ['invented', ['Kubernetes']],
    ['substring', ['Java']], ['comma', ['testing, debugging']], ['newline', ['testing\n## Injected']],
    ['markdown', ['[APIs](https://example.invalid)']], ['escaped', ['C\\#']], ['period', ['Node.js.']],
    ['too-many', Array.from({ length: 21 }, (_, i) => `term${i}`)], ['too-long', ['a'.repeat(81)]],
    ['budget', keywords],
  ]) {
    const bad = JSON.parse(original);
    if (value === undefined) delete bad.results[0].report.keywords; else bad.results[0].report.keywords = value;
    fx.write(partFile, bad);
    const testedRun = name === 'budget' ? budgetRun : run;
    const acquisitionFile = path.join(testedRun, 'acquisition.json'), acquisition = readFileSync(acquisitionFile, 'utf8');
    if (name === 'budget') {
      const inflated = JSON.parse(acquisition); inflated.acquired[0].company = 'Long company '.repeat(1200);
      fx.write(acquisitionFile, inflated);
      const budgetPartFile = path.join(testedRun, 'results', `${worker}.part-1.json`), budgetPart = parse(budgetPartFile);
      if (plan.research_version === 1) budgetPart.results[0].research.company = inflated.acquired[0].company;
      fx.write(budgetPartFile, budgetPart);
    }
    const rejected = fx.run(`reject-keywords-${name}`, script('merge-worker-results.mjs'), ['--run', testedRun, '--worker', worker], { expect: 1 });
    fx.check(`${name} fails for keyword/budget contract without data writes`,
      /keywords|exceeds 12000/.test(rejected.stderr) && manifest(fx.dataRoot) === before);
    fx.write(acquisitionFile, acquisition); fx.write(partFile, original);
  }
  // One truthful term is valid for a sparse JD; do not pad to fifteen.
  const sparse = JSON.parse(original); sparse.results[0].report.keywords = ['APIs']; fx.write(partFile, sparse);
  fx.run('validate-sparse-keywords', script('merge-worker-results.mjs'), ['--run', run, '--worker', worker, '--validate-through-part', '1']);
  fx.write(partFile, original);
  mergeAll(fx, run, plan);
  const historical = path.join(fx.root, 'historical-v6', path.basename(run)); cpSync(run, historical, { recursive: true });
  const oldPlan = parse(path.join(historical, 'assignments.json')); oldPlan.result_schema_version = 6;
  delete oldPlan.hiring_manager_review_version;
  fx.write(path.join(historical, 'assignments.json'), oldPlan);
  for (const id of Object.keys(plan.assignments)) {
    for (const suffix of ['.part-1.json', '.json']) {
      const file = path.join(historical, 'results', id + suffix);
      if (suffix.startsWith('.part') && !plan.assignments[id].length) continue;
      const artifact = parse(file); artifact.result_schema_version = 6;
      for (const item of artifact.results) if (item.report) { delete item.report.hiring_manager_review; delete item.report.keywords; delete item.report.requirement_importance; }
      fx.write(file, artifact);
    }
  }
  const inspect = fx.write(path.join(fx.root, 'inspect-v6.mjs'), `
import {loadScanResults} from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};
import {renderCompactReport,readCompactReportSummary} from ${JSON.stringify(pathToFileURL(script('scan-report-contract.mjs')).href)};
import fs from 'node:fs'; import path from 'node:path';
const r=loadScanResults(process.argv[2],{allowLegacy:true});
if(r.errors.length)throw new Error(r.errors.join('; '));
const record=JSON.parse(fs.readFileSync(path.join(r.root,'acquisition.json'))).acquired[0];
const body=renderCompactReport({result:r.evaluated[0],record,runId:r.plan.run_id});
const summary=readCompactReportSummary(body);
if(summary.result_schema_version!==6||body.includes('## Keywords extracted'))throw new Error('v6 was migrated');
console.log(JSON.stringify({version:summary.result_schema_version,rule_hashes_verified:r.historical_rule_snapshots_verified}));`);
  const historicalBefore = manifest(historical);
  fx.run('read-v6', inspect, [historical]);
  fx.run('reject-v6-new-merge', script('merge-worker-results.mjs'), ['--run', historical, '--worker', worker], { expect: 1 });
  const oldPlanRejected = fx.run('reject-v6-new-plan', script('plan-scan-evaluations.mjs'), ['--run', historical, '--career-ops', fx.codeRoot], { expect: 1 });
  fx.check('v6 planning stops at schema gate', oldPlanRejected.stderr.includes('result_schema_version must be 8'));
  fx.check('historical v6 remains byte-identical', manifest(historical) === historicalBefore);
  fx.run('keyword-commit', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('official persistence and conservation pass', receipt.status === 'COMPLETE' && receipt.terminal_equation.valid && receipt.reports.length === 1);
  const report = path.join(fx.dataRoot, receipt.reports[0].report_path);
  const document = readFileSync(report, 'utf8');
  fx.check('one keyword block survives official writer', (document.match(/^## Keywords extracted$/gm) ?? []).length === 1);
  const coverage = JSON.parse(fx.run('official-keyword-match', path.join(fx.codeRoot, 'keyword-match.mjs'), [report, '--json'], { cwd: fx.codeRoot }).stdout);
  fx.check('official matcher uses report with lossless symbols and genuine missing words', coverage.keywordSource === 'report'
    && coverage.total === keywords.length && coverage.missing.includes('C++') && coverage.present.includes('APIs')
    && JSON.stringify([...coverage.present, ...coverage.missing].sort()) === JSON.stringify([...keywords].sort()), coverage);
  fx.run('keyword-expansion-prepare', script('expand-scan-report.mjs'), ['prepare', report, '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  console.log(JSON.stringify(fx.finish({ receipt: path.join(run, 'receipt.json'), coverage,
    scope: 'Actual planner, validator, official writers and keyword matcher; fictional frozen inputs, no model or live source coverage claim.' })));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
