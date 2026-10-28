#!/usr/bin/env node
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { seedCandidate, seedScan, writeScoreParts, mergeAll, SCAN_DATE, EVIDENCE_TEXT } from './e2e-scan-inputs.mjs';
import { readCompactReportSummary } from '../../src/scan-report-contract.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'hiring-manager-review', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const heading = '## Hiring Manager Resume Review';
const question1 = '假设你现在是这个岗位的 hiring manager，这是你收到的一份简历。请列出你为什么不会给这个 candidate 面试。';
const question2 = '你为什么会得出这个结论？从我的简历里找依据。';
const resumeQuote = 'Two years building Python services for internal APIs.';
const requirement = 'At least five years building production services.';
const review = {
  summary: '模拟筛选：年限证据不足，另有 Kubernetes 经历未展示；这不是公司的真实决定。',
  concerns: [
    { reason: '简历明确写出的经验年限低于岗位要求。', jd_quote: requirement, resume_locator: 'cv.md/Experience',
      resume_quote: resumeQuote, evidence_type: 'documented', explanation: '岗位要求至少五年，简历明确写两年，因此可能在年限筛选时被拒。' },
    { reason: '简历未展示 Kubernetes 经历。', jd_quote: 'Experience with Kubernetes is preferred.', resume_locator: 'cv.md/Skills',
      resume_quote: 'Python, SQL.', evidence_type: 'not_demonstrated', explanation: '技能部分只列 Python、SQL，未展示这项加分条件；不能据此断定候选人不会。' },
  ],
};

try {
  fx.write(path.join(fx.root, 'failure-plan.json'), parse(path.join(DISCOVERY_ROOT, 'test/hiring-manager-review-e2e.plan.json')));
  seedCandidate(fx);
  fx.write(path.join(fx.dataRoot, 'cv.md'), `# Fictional Candidate\n\n## Experience\n${resumeQuote}\nOwned services through design, delivery and production support.\n\n## Skills\nPython, SQL.\n`);
  const run = seedScan(fx, { jobs: [
    { id: '88000001', company: 'Fictional Review Co', body: `${Object.values(EVIDENCE_TEXT).join('\n')}\n${requirement}\nExperience with Kubernetes is preferred.\nTesting and debugging are part of backend service ownership.\n${'The engineer designs and operates distributed systems, APIs and observability with the platform team. '.repeat(4)}` },
    { id: '88000002', company: 'Fictional Below Threshold Co' },
  ] });
  fx.run('plan', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, run, key => key.endsWith('2') ? { fit_score: 3.5, rationale: 'Below threshold.', report: null } : {});
  fx.check('new plans freeze hiring-manager review version 1', plan.hiring_manager_review_version === 1);
  const worker = Object.keys(plan.assignments).find(id => plan.assignments[id].includes('linkedin:linkedin.com:88000001'));
  const file = path.join(run, 'results', worker + '.part-1.json');
  const part = parse(file); part.results[0].report.hiring_manager_review = review; fx.write(file, part);
  const original = readFileSync(file, 'utf8'), before = JSON.stringify(treeManifest(fx.dataRoot));
  fx.write(path.join(run, 'assignments.json'), { ...plan, hiring_manager_review_version: 99 });
  const wrongVersion = fx.run('reject-policy-version', script('merge-worker-results.mjs'), ['--run', run, '--worker', worker], { expect: 1 });
  fx.check('unsupported review version is rejected', wrongVersion.stderr.includes('hiring_manager_review_version'));
  fx.write(path.join(run, 'assignments.json'), plan);
  for (const [name, mutate, error] of [
    ['missing-review', report => delete report.hiring_manager_review, 'hiring_manager_review'],
    ['missing-answer', report => delete report.hiring_manager_review.summary, 'summary'],
    ['foreign-jd', report => { report.hiring_manager_review.concerns[0].jd_quote = 'Unrelated requirement'; }, 'substring'],
    ['invented-cv-quote', report => { report.hiring_manager_review.concerns[0].resume_quote = 'Ten years of Kubernetes expertise.'; }, 'cv.md quote'],
    ['wrong-candidate-source', report => { report.hiring_manager_review.concerns[0].resume_locator = 'modes/_profile.md/Experience'; }, 'cv.md/'],
    ['missing-documented-evidence', report => { report.hiring_manager_review.concerns[0].resume_quote = null; }, 'resume_quote'],
    ['invalid-evidence-type', report => { report.hiring_manager_review.concerns[1].evidence_type = 'cannot_do'; }, 'evidence_type'],
    ['extra-field', report => { report.hiring_manager_review.confidence = 'High'; }, 'unsupported'],
    ['too-many-concerns', report => { report.hiring_manager_review.concerns.push(...structuredClone(report.hiring_manager_review.concerns)); }, '0-3'],
    ['duplicate-concern', report => { report.hiring_manager_review.concerns[1] = structuredClone(report.hiring_manager_review.concerns[0]); }, 'duplicate'],
  ]) {
    const bad = JSON.parse(original); mutate(bad.results[0].report); fx.write(file, bad);
    const rejected = fx.run(`reject-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker], { expect: 1 });
    fx.check(`${name}: specific error and no candidate/report mutation`, rejected.stderr.includes(error) && JSON.stringify(treeManifest(fx.dataRoot)) === before);
    fx.write(file, original);
  }
  for (const [name, value] of [
    ['no-supported-concerns', { summary: '当前简历和 JD 没有支持明确拒面的证据。', concerns: [] }],
    ['honest-missing-evidence', { ...review, concerns: [{ ...review.concerns[1], resume_quote: null }] }],
  ]) {
    const valid = JSON.parse(original); valid.results[0].report.hiring_manager_review = value; fx.write(file, valid);
    fx.run(`accept-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker, '--validate-through-part', '1']);
    fx.write(file, original);
  }
  mergeAll(fx, run, plan);
  const historical = path.join(fx.root, 'historical', path.basename(run)); cpSync(run, historical, { recursive: true });
  const oldPlan = parse(path.join(historical, 'assignments.json')); delete oldPlan.hiring_manager_review_version;
  fx.write(path.join(historical, 'assignments.json'), oldPlan);
  for (const id of Object.keys(plan.assignments)) for (const suffix of ['.part-1.json', '.json']) {
    if (suffix.startsWith('.part') && !plan.assignments[id].length) continue;
    const oldFile = path.join(historical, 'results', id + suffix), artifact = parse(oldFile);
    for (const item of artifact.results) if (item.report) delete item.report.hiring_manager_review;
    fx.write(oldFile, artifact);
  }
  const inspect = fx.write(path.join(fx.root, 'inspect-historical.mjs'), `import assert from 'node:assert/strict';
import {loadScanResults} from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};
import {renderCompactReport,readCompactReportSummary} from ${JSON.stringify(pathToFileURL(script('scan-report-contract.mjs')).href)};
import fs from 'node:fs';import path from 'node:path';
const r=loadScanResults(process.argv[2]);assert.deepEqual(r.errors,[]);
const records=JSON.parse(fs.readFileSync(path.join(r.root,'acquisition.json'))).acquired;
for(const result of r.candidates){const body=renderCompactReport({result,record:records.find(x=>x.primary_key===result.posting_key),runId:r.plan.run_id});readCompactReportSummary(body);assert(!body.includes(${JSON.stringify(heading)}));}
console.log('Historical v8 reads without backfill');`);
  const historicalBefore = JSON.stringify(treeManifest(historical)); fx.run('read-historical-v8', inspect, [historical]);
  fx.check('historical artifacts remain byte-identical', JSON.stringify(treeManifest(historical)) === historicalBefore);
  fx.run('commit', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('review does not alter scoring or report selection', receipt.status === 'COMPLETE' && receipt.reports.length === 1 && receipt.below_threshold_count === 1);
  const reportFile = path.join(fx.dataRoot, receipt.reports[0].report_path), markdown = readFileSync(reportFile, 'utf8');
  fx.write(path.join(fx.root, 'compact-report.md'), markdown);
  const body = markdown.slice(markdown.indexOf('## Machine Summary'));
  fx.check('persisted compact report contains both questions and exact resume evidence', markdown.includes(question1) && markdown.includes(question2) && markdown.includes(resumeQuote) && markdown.includes('cv.md/Experience') && markdown.includes('未展示') && readCompactReportSummary(body).score === 4.2);
  const prepared = JSON.parse(fx.run('prepare-expansion', script('expand-scan-report.mjs'), ['prepare', path.basename(reportFile), '--career-ops', fx.codeRoot, '--discovery', fx.root]).stdout);
  const preparedFile = fx.write(path.join(fx.root, 'prepared.json'), prepared);
  const fixed = body.split('\n').find(line => line === 'No fixed term disclosed in the supplied JD.');
  const draft = fx.write(path.join(fx.root, 'expanded-draft.md'), [body.split('\n\n## Verdict')[0],
    '## A) Role Summary\nFictional role.', `## B) Match with CV\nSource-bound fit.\n\n${fixed}`,
    '## C) Level and Strategy\nSenior target.', '## D) Comp and Demand\nKeep original evidence.',
    '## E) Customization Plan\nPreserve facts.', '## F) Interview Plan\nDiscuss platform ownership.',
    '## G) Posting Legitimacy\nKeep the original conclusion.', '## Risk Summary\nKeep original gaps.',
    '## Keywords extracted\n- distributed systems'].join('\n\n'));
  fx.run('commit-expansion', script('expand-scan-report.mjs'), ['commit', path.basename(reportFile), draft, '--prepared', preparedFile, '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  const expanded = readFileSync(reportFile, 'utf8');
  const reviewSection = body.split(/(?=^## )/m).find(section => section.startsWith(heading)).trim();
  fx.check('expansion preserves both answers verbatim once outside evidence appendix', expanded.includes(reviewSection) && expanded.split(heading).length === 2 && expanded.indexOf(heading) < expanded.indexOf('## Original Evaluation Evidence'));
  console.log(JSON.stringify(fx.finish({ receipt: path.join(run, 'receipt.json'), report: reportFile, compact: path.join(fx.root, 'compact-report.md'), scope: 'Fictional end-to-end verification; does not prove live model judgment or real hiring outcomes.' })));
} catch (error) { fx.write(path.join(fx.root, 'failure.json'), { error: error.stack }); console.error(error.stack); process.exitCode = 1; }
