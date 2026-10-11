#!/usr/bin/env node
import { cpSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';
import { readMachineSummary } from '../src/scan-report-contract.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'report-v6', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = root => JSON.stringify(treeManifest(root));
try {
  seedCandidate(fx);
  const run = seedScan(fx, { jobs: Array.from({ length: 8 }, (_, i) => ({ id: `8700000${i + 1}`, company: `Fictional V6 ${i + 1}` })) });
  const vocabulary = path.join(fx.codeRoot, 'templates/discard-reasons.yml');
  const originalVocabulary = readFileSync(vocabulary, 'utf8');
  for (const [name, content] of [['missing', null], ['empty', 'reasons: []'], ['malformed', 'reasons: ['],
    ['duplicate', 'reasons:\n  - id: salary_too_low\n    when: Low salary\n  - id: salary_too_low\n    when: Repeated\n'],
    ['no-definition', 'reasons:\n  - id: salary_too_low\n'], ['invalid-id', 'reasons:\n  - id: Wrong ID\n    when: Invalid\n']]) {
    if (content === null) rmSync(vocabulary); else fx.write(vocabulary, content);
    const before = manifest(run), data = manifest(fx.dataRoot);
    fx.run(`reject-vocabulary-${name}`, script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot], { expect: 1 });
    fx.check(`${name} vocabulary rejects before run/data mutation`, manifest(run) === before && manifest(fx.dataRoot) === data);
    fx.write(vocabulary, originalVocabulary);
  }
  fx.run('v6-plan', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const initial = parse(path.join(run, 'assignments.json'));
  for (const record of parse(path.join(run, 'acquisition.json')).acquired) {
    if (record.primary_key.endsWith('5') || record.primary_key.endsWith('8')) {
      fx.write(path.join(run, record.jd_path), readFileSync(path.join(run, record.jd_path), 'utf8') + '\nThis position is an 18-month contract.\n');
    } else if (record.primary_key.endsWith('6')) {
      fx.write(path.join(run, record.jd_path), readFileSync(path.join(run, record.jd_path), 'utf8') + '\nMaintain customer contracts and contract management software.\n');
    }
  }
  const plan = writeScoreParts(fx, run, key => {
    const id = Number(key.at(-1));
    if (id >= 7) return { fit_score: id === 7 ? 3.5 : 4.2, rationale: 'Below threshold or explicitly finite employment.', report: null,
      ...(id === 8 ? { eligibility_status: 'ineligible', eligibility_category: 'employment_type', eligibility_evidence: 'JD: "18-month contract"' } : {}) };
    if (id === 5) return { eligibility_status: 'needs_verification', eligibility_category: 'employment_type', eligibility_evidence: 'JD: "18-month contract"' };
    return id <= 4 ? { legitimacy_tier: 'Proceed with Caution' } : {};
  });
  const reasons = ['tech_stack_mismatch', 'salary_too_low', 'geo_restriction', 'Publisher and employer relationship needs clarification'];
  for (const [worker, keys] of Object.entries(plan.assignments)) {
    if (!keys.length) continue;
    const file = path.join(run, 'results', `${worker}.part-1.json`), part = parse(file);
    for (const item of part.results) {
      const id = Number(item.posting_key.at(-1));
      if (id <= 4) item.report.discard_reasons = [reasons[id - 1]];
      if (id === 5) {
        item.report.fixed_term_evidence = '18-month contract';
        item.report.confidence = 'Low';
        item.report.confidence_gaps = ['Resolve the conflicting permanent and finite employment terms.'];
      }
    }
    fx.write(file, part);
  }
  fx.check('v6 vocabulary locked as a rule, not candidate evidence', plan.result_schema_version === 6
    && plan.rule_sources.some(source => source.label === 'templates/discard-reasons.yml' && source.path === vocabulary)
    && !plan.candidate_sources.some(source => source.path === vocabulary));
  const worker = Object.keys(initial.assignments).find(id => initial.assignments[id].includes('linkedin:linkedin.com:87000005'));
  const partFile = path.join(run, 'results', `${worker}.part-1.json`), original = readFileSync(partFile, 'utf8');
  for (const [name, mutate] of [
    ['missing-evidence', item => delete item.report.fixed_term_evidence],
    ['forged-evidence', item => { item.report.fixed_term_evidence = '99-month contract'; }],
    ['spliced-evidence', item => { item.report.fixed_term_evidence = '18-month contract permanent full-time'; }],
    ['unexpected-reason', item => { item.report.discard_reasons = ['salary_too_low']; }],
    ['missing-reasons', item => delete item.report.discard_reasons],
    ['duplicate-reasons', item => { item.report.discard_reasons = ['same', 'same']; }],
  ]) {
    const part = JSON.parse(original), item = part.results.find(row => row.posting_key.endsWith('5'));
    mutate(item); fx.write(partFile, part);
    const before = manifest(fx.dataRoot);
    fx.run(`reject-v6-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker], { expect: 1 });
    fx.check(`${name} rejection leaves data unchanged`, manifest(fx.dataRoot) === before);
    fx.write(partFile, original);
  }
  mergeAll(fx, run, plan);
  const oldRun = path.join(fx.root, 'historical-v5');
  cpSync(run, oldRun, { recursive: true });
  const oldPlan = parse(path.join(oldRun, 'assignments.json'));
  oldPlan.result_schema_version = 5;
  oldPlan.rule_sources = oldPlan.rule_sources.filter(source => source.label !== 'templates/discard-reasons.yml');
  fx.write(path.join(oldRun, 'assignments.json'), oldPlan);
  for (const id of Object.keys(plan.assignments)) {
    for (const suffix of ['.part-1.json', '.json']) {
      const file = path.join(oldRun, 'results', id + suffix), artifact = parse(file);
      artifact.result_schema_version = 5;
      for (const item of artifact.results) if (item.report) { delete item.report.discard_reasons; delete item.report.fixed_term_evidence; }
      fx.write(file, artifact);
    }
  }
  // Historical finals used the original v5 renderer fields, without new metadata.
  const inspect = fx.write(path.join(fx.root, 'inspect-v5.mjs'), `import { loadScanResults } from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};\nconst result=loadScanResults(process.argv[2],{allowLegacy:true});console.log(JSON.stringify(result.errors));if(result.errors.length)process.exit(1);\n`);
  const beforeHistory = manifest(oldRun);
  fx.run('inspect-v5-read-only', inspect, [oldRun]);
  fx.run('reject-v5-new-merge', script('merge-worker-results.mjs'), ['--run', oldRun, '--worker', worker], { expect: 1 });
  fx.check('v5 history unchanged by read and rejected new merge', manifest(oldRun) === beforeHistory);
  fx.run('v6-commit', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('v6 complete keeps receipt v4 and report filtering', receipt.status === 'COMPLETE' && receipt.schema_version === 4
    && receipt.committed_evaluated_keys.length === 8 && receipt.reports.length === 6);
  const docs = receipt.reports.map(mapping => ({ mapping, document: readFileSync(path.join(fx.dataRoot, mapping.report_path), 'utf8') }));
  for (const { mapping, document } of docs) {
    const summary = readMachineSummary(document), id = Number(mapping.posting_key.at(-1));
    fx.check(`${id}: exact reasons and finite-term state persisted`, summary.result_schema_version === 6
      && JSON.stringify(summary.discard_reasons) === JSON.stringify(id <= 4 ? [reasons[id - 1]] : [])
      && summary.risk_summary.fixed_term === (id === 5 ? 'detected' : 'not_detected'));
    if (id === 5) fx.check('finite-term quote persisted without changing Research first', document.includes('18-month contract') && summary.final_decision === 'Research first');
  }
  const analytics = fx.write(path.join(fx.root, 'upstream-reasons.mjs'), `import { buildPredictedDiscardReasonSignals } from ${JSON.stringify(pathToFileURL(path.join(fx.codeRoot, 'analyze-patterns.mjs')).href)};\nimport fs from 'node:fs';const reports=JSON.parse(fs.readFileSync(process.argv[2]));console.log(JSON.stringify(buildPredictedDiscardReasonSignals(reports.map(machineSummary=>({report:{machineSummary,discardReasons:machineSummary.discard_reasons}})))));\n`);
  const analyticsInput = fx.write(path.join(fx.root, 'analytics-input.json'), docs.map(row => readMachineSummary(row.document)));
  const signals = JSON.parse(fx.run('actual-upstream-reason-statistics', analytics, [analyticsInput], { cwd: fx.codeRoot }).stdout);
  fx.check('actual upstream separates canonical ids and free text', signals.predictedDiscardReasonStats.length === 3
    && signals.predictedDiscardReasonStats.every(row => reasons.slice(0, 3).includes(row.reason))
    && signals.predictedDiscardReasonOther.entries === 1);
  console.log(JSON.stringify(fx.finish({ receipt: path.join(run, 'receipt.json'), scope: 'Frozen expectations and actual CLIs; semantic model behavior is a separate check.' })));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
