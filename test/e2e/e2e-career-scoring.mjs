#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, content, treeManifest } from './e2e-career-fixture.mjs';
import { EVIDENCE_TEXT, SCAN_DATE, seedCandidate, seedScan, scoreReport, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';
import { readCompactReportSummary } from '../../src/scan-report-contract.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'scoring', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const manifest = root => JSON.stringify(treeManifest(root));
try {
  seedCandidate(fx);
  const runRoot = seedScan(fx, { jobs: [
    { id: '88000001', company: 'Fictional Medium Co' }, { id: '88000002', company: 'Fictional High Co' },
    { id: '88000003', company: 'Fictional Unknown CV Co' }, { id: '88000004', company: 'Fictional Unknown Evidence Co' },
    { id: '88000005', company: 'Fictional Conditional Co', verification: true },
  ] });
  fx.run('plan', script('plan-scan-evaluations.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, runRoot, key => {
    if (key.endsWith('2')) return { report: scoreReport({ confidence: 'High', statuses: { compensation: 'supported' } }) };
    if (key.endsWith('3')) return { report: scoreReport({ confidence: 'Low', statuses: { cv_match: 'unknown' } }) };
    if (key.endsWith('4')) return { report: scoreReport({ confidence: 'Low', statuses: { compensation: 'unknown', culture: 'unknown' } }) };
    if (!key.endsWith('5')) return {};
    const report = scoreReport({ confidence: 'Low', statuses: { red_flags: 'partial' }, verification: true });
    report.score_evidence.red_flags.source = `JD: ${EVIDENCE_TEXT.uncertainty}`;
    report.score_evidence.red_flags.observation = 'Role-specific eligibility remains conditional.';
    return { eligibility_status: 'needs_verification', eligibility_category: 'work_authorization',
      eligibility_evidence: `JD: "${EVIDENCE_TEXT.uncertainty}"`,
      work_authorization: { value: 'needs_verification', quote: EVIDENCE_TEXT.uncertainty }, report };
  });
  fx.check('planner freezes schema 8 and separate factual/rule sources', plan.result_schema_version === 8
    && plan.candidate_sources.length === 3 && plan.rule_sources.length === 6
    && plan.candidate_sources.every(source => source.path.startsWith(fx.dataRoot))
    && plan.rule_sources.find(source => source.label === 'modes/_shared.md').path.startsWith(fx.codeRoot));
  const candidateHashes = plan.candidate_sources.map(source => [source.path, content(readFileSync(source.path))]);
  mergeAll(fx, runRoot, plan);
  const firstWorker = Object.keys(plan.assignments).find(worker => plan.assignments[worker].includes('linkedin:linkedin.com:88000001'));
  const partFile = path.join(runRoot, 'results', `${firstWorker}.part-1.json`);
  const originalPart = readFileSync(partFile, 'utf8');
  const firstFinal = path.join(runRoot, 'results', `${firstWorker}.json`);
  const originalFinal = readFileSync(firstFinal, 'utf8');
  const dataBeforeReject = manifest(fx.dataRoot);
  const bad = JSON.parse(originalPart);
  bad.results.find(item => item.posting_key.endsWith('1')).report.confidence = 'High';
  fx.write(partFile, bad);
  const rejected = fx.run('reject-inconsistent-confidence', script('merge-worker-results.mjs'), ['--run', runRoot, '--worker', firstWorker], { expect: 1 });
  fx.check('conflicting High rejected with Medium requirement', rejected.stderr.includes('confidence must be Medium'));
  fx.check('rejection leaves Career-Ops and existing final unchanged', manifest(fx.dataRoot) === dataBeforeReject && readFileSync(firstFinal, 'utf8') === originalFinal);
  fx.write(partFile, originalPart);
  for (const [variable, relative] of [['CAREER_OPS_TRACKER', 'redirected-tracker.md'], ['CAREER_OPS_SCAN_HISTORY', 'redirected-history.tsv']]) {
    const beforeRun = manifest(runRoot);
    const redirected = path.join(fx.root, relative);
    const mismatch = fx.run(`reject-${variable.toLowerCase()}-drift`, script('merge-worker-results.mjs'), ['--run', runRoot, '--worker', firstWorker], {
      env: { [variable]: redirected }, expect: 1,
    });
    fx.check(`${variable} drift rejects before persisted mutations`, mismatch.stderr.includes('tracker/history paths changed')
      && manifest(runRoot) === beforeRun && manifest(fx.dataRoot) === dataBeforeReject && !existsSync(redirected));
    if (variable === 'CAREER_OPS_TRACKER') {
      const rejectedRun = path.join(fx.root, 'path-drift-commit', path.basename(runRoot));
      cpSync(runRoot, rejectedRun, { recursive: true });
      fx.run('reject-tracker-drift-at-commit', script('commit-scan.mjs'), ['--run', rejectedRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], {
        env: { CAREER_OPS_TRACKER: redirected }, expect: 1,
      });
      fx.check('tracker-drift commit leaves original data and redirected target untouched', manifest(fx.dataRoot) === dataBeforeReject && !existsSync(redirected));
    }
  }
  const redirectedData = path.join(fx.root, 'redirected-data');
  const dataMismatch = fx.run('reject-data-root-drift', script('merge-worker-results.mjs'), ['--run', runRoot, '--worker', firstWorker], {
    env: { CAREER_OPS_ROOT: redirectedData }, expect: 1,
  });
  fx.check('data-root drift rejects before writes', dataMismatch.stderr.includes('data root changed') && !existsSync(redirectedData));
  for (const sourceLabel of ['modes/_shared.md', 'modes/_custom.md', 'templates/discard-reasons.yml']) {
    const source = plan.rule_sources.find(item => item.label === sourceLabel);
    const content = readFileSync(source.path, 'utf8');
    fx.write(source.path, `${content}\nIntentional E2E stale-rule mutation.\n`);
    const beforeRun = manifest(runRoot);
    const name = sourceLabel.includes('custom') ? 'custom' : sourceLabel.includes('templates') ? 'vocabulary' : 'shared';
    const stale = fx.run(`reject-stale-${name}-merge`, script('merge-worker-results.mjs'), ['--run', runRoot, '--worker', firstWorker], { expect: 1 });
    fx.check(`${name} hash mismatch is a whole-assignment blocker`, stale.stderr.includes(`rule source content changed: ${sourceLabel}`));
    fx.run(`reject-stale-${name}-planner`, script('plan-scan-evaluations.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot], { expect: 1 });
    fx.check(`${name} rejection leaves run artifacts unchanged`, manifest(runRoot) === beforeRun);
    if (name === 'custom') {
      const rejectedRun = path.join(fx.root, 'stale-commit', path.basename(runRoot));
      cpSync(runRoot, rejectedRun, { recursive: true });
      const beforeData = manifest(fx.dataRoot);
      fx.run('reject-stale-rules-at-commit', script('commit-scan.mjs'), ['--run', rejectedRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
      fx.check('stale-rule commit records failure without changing Career-Ops', manifest(fx.dataRoot) === beforeData
        && parse(path.join(rejectedRun, 'receipt.json')).status === 'FAILED');
    }
    fx.write(source.path, content);
  }
  // Legacy compatibility is an explicit read-only mode; it never writes a final.
  const legacyRoot = path.join(fx.root, 'legacy-v4');
  const legacyPlan = { ...plan, result_schema_version: 4, career_ops_root: fx.dataRoot };
  delete legacyPlan.hiring_manager_review_version;
  delete legacyPlan.rule_sources; delete legacyPlan.career_ops_data_root;
  fx.write(path.join(legacyRoot, 'assignments.json'), legacyPlan);
  fx.write(path.join(legacyRoot, 'acquisition.json'), parse(path.join(runRoot, 'acquisition.json')));
  const acquisition = parse(path.join(runRoot, 'acquisition.json'));
  for (const record of acquisition.acquired) fx.write(path.join(legacyRoot, record.jd_path), readFileSync(path.join(runRoot, record.jd_path), 'utf8'));
  for (const worker of Object.keys(plan.assignments)) {
    const part = parse(path.join(runRoot, 'results', `${worker}.part-1.json`));
    part.result_schema_version = 4;
    for (const item of part.results) { delete item.report.hiring_manager_review; delete item.report.score_evidence; delete item.report.confidence_gaps; delete item.report.discard_reasons; delete item.report.fixed_term_evidence; delete item.report.keywords; delete item.report.requirement_importance; }
    fx.write(path.join(legacyRoot, 'results', `${worker}.part-1.json`), part);
    const final = parse(path.join(runRoot, 'results', `${worker}.json`));
    final.result_schema_version = 4;
    for (const item of final.results) { delete item.report.hiring_manager_review; delete item.report.score_evidence; delete item.report.confidence_gaps; delete item.report.discard_reasons; delete item.report.fixed_term_evidence; delete item.report.keywords; delete item.report.requirement_importance; }
    fx.write(path.join(legacyRoot, 'results', `${worker}.json`), final);
  }
  const legacyScript = fx.write(path.join(fx.root, 'inspect-legacy.mjs'), `import { loadScanResults } from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};\nconst result = loadScanResults(process.argv[2], { allowLegacy: true });\nconsole.log(JSON.stringify({errors: result.errors, evaluated: result.evaluated.length}));\nif(result.errors.length) process.exit(1);\n`);
  const legacyBefore = manifest(legacyRoot);
  fx.run('inspect-legacy-v4-read-only', legacyScript, [legacyRoot]);
  fx.run('reject-legacy-new-merge', script('merge-worker-results.mjs'), ['--run', legacyRoot, '--worker', firstWorker], { expect: 1 });
  fx.check('legacy inspection and rejected write preserve historical artifacts', manifest(legacyRoot) === legacyBefore);
  fx.run('commit-through-official-writers', script('commit-scan.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(runRoot, 'receipt.json'));
  fx.check('five evaluations complete through real official writers and receipt', receipt.status === 'COMPLETE'
    && receipt.terminal_equation.valid && receipt.reports.length === 5 && receipt.committed_evaluated_keys.length === 5, receipt);
  const expected = { '1': 'Medium', '2': 'High', '3': 'Low', '4': 'Low', '5': 'Low' };
  for (const mapping of receipt.reports) {
    const file = path.join(fx.dataRoot, mapping.report_path);
    const document = readFileSync(file, 'utf8');
    const summary = readCompactReportSummary(document.slice(document.indexOf('## Machine Summary')));
    fx.check(`${mapping.posting_key}: canonical confidence and preserved five evidence dimensions`, summary.confidence === expected[mapping.posting_key.at(-1)]
      && Object.keys(summary.score_evidence).join(',') === 'cv_match,north_star,compensation,culture,red_flags'
      && document.includes('## Score Evidence') && document.includes(EVIDENCE_TEXT.compensation));
  }
  fx.check('candidate sources unchanged by commit', candidateHashes.every(([file, hash]) => content(readFileSync(file)) === hash));
  fx.check('code-root has no reports/tracker/data writes', !existsSync(path.join(fx.codeRoot, 'reports')) && !existsSync(path.join(fx.codeRoot, 'data')));
  console.log(JSON.stringify(fx.finish({ runRoot, receipt: path.join(runRoot, 'receipt.json'), scope: 'Frozen fictional inputs through real planner, merger, renderer and official writers; no live model/acquisition quality claim.' }), null, 2));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
