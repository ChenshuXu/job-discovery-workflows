#!/usr/bin/env node
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';
import { postingKey } from '../../src/posting-identity.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'requirements-listing', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = root => JSON.stringify(treeManifest(root));
const requirements = [
  { requirement: 'distributed systems', jd_signal: 'This role requires backend service ownership and experience with distributed systems', evidence: 'stated', importance: 'critical', match: 'partial' },
  { requirement: 'APIs', jd_signal: '## Job Description', evidence: 'structural', importance: 'high', match: 'strong' },
  { requirement: 'observability', jd_signal: null, evidence: 'inferred', importance: 'meaningful', match: 'partial' },
];
try {
  seedCandidate(fx);
  const historyFile = path.join(fx.dataRoot, 'data/scan-history.tsv');
  const unrelatedHistory = readFileSync(historyFile, 'utf8') + 'https://boards.greenhouse.io/Unrelated/jobs/999999\t2026-10-16\tfixture\tUnrelated role\tUnrelated\tadded\tSeattle\n';
  fx.write(historyFile, unrelatedHistory);
  const urls = [
    'https://boards.greenhouse.io/ExactBoard/jobs/000501',
    'https://jobs.lever.co/ExactBoard/aBcDef01-2345-6789-aBcd-012345678901',
    'https://jobs.ashbyhq.com/ExactBoard/ABCdef02-2345-6789-abCD-012345678901',
    'https://www.linkedin.com/jobs/view/88000004',
    'https://boards.greenhouse.io/ExactBoard/jobs/000505',
  ];
  const run = seedScan(fx, { jobs: urls.map((url, i) => ({ id: `8800000${i + 1}`, company: `Fictional Requirement ${i + 1}`, url, key: postingKey(url) })) });
  fx.run('plan-v8', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, run, key => key === postingKey(urls[4]) ? { fit_score: 3.5, rationale: 'Fictional below-threshold evaluation.', report: null } : {});
  fx.check('planner freezes v8', plan.result_schema_version === 8);
  const acquisition = parse(path.join(run, 'acquisition.json'));
  for (const record of acquisition.acquired) {
    const jd = path.join(run, record.jd_path);
    fx.write(jd, readFileSync(jd, 'utf8') + '\nRequired:\n' + Array.from({ length: 80 }, (_, i) => `- Requirement ${i + 1}`).join('\n'));
  }
  for (const worker of Object.keys(plan.assignments)) {
    if (!plan.assignments[worker].length) continue;
    const file = path.join(run, 'results', `${worker}.part-1.json`), part = parse(file);
    for (const item of part.results) if (item.report) item.report.requirement_importance = requirements;
    fx.write(file, part);
  }
  const worker = Object.keys(plan.assignments).find(id => plan.assignments[id].includes(postingKey(urls[0])));
  const partFile = path.join(run, 'results', `${worker}.part-1.json`), original = readFileSync(partFile, 'utf8');
  const before = manifest(fx.dataRoot);
  fx.write(path.join(fx.root, 'before-data.json'), treeManifest(fx.dataRoot));
  for (const [name, mutate] of [
    ['missing', report => delete report.requirement_importance],
    ['forged-requirement', report => { report.requirement_importance[0].requirement = 'quantum computing'; }],
    ['forged-signal', report => { report.requirement_importance[0].jd_signal = 'Requires quantum computing'; }],
    ['spliced-signal', report => { report.requirement_importance[0].jd_signal = 'APIs and observability required'; }],
    ['inferred-high', report => { report.requirement_importance[2].importance = 'high'; }],
    ['inferred-signal', report => { report.requirement_importance[2].jd_signal = 'observability'; }],
    ['bad-enum', report => { report.requirement_importance[0].match = 'expert'; }],
    ['duplicate', report => { report.requirement_importance.push(report.requirement_importance[0]); }],
    ['order', report => { report.requirement_importance.reverse(); }],
    ['unmet-last', report => { report.requirement_importance = [{ ...requirements[1], importance: 'critical' }, requirements[0]]; }],
    ['unknown-field', report => { report.requirement_importance[0].score = 5; }],
    ['row-budget', report => { report.requirement_importance = Array.from({ length: 13 }, (_, i) => ({ requirement: `Requirement ${i + 1}`, jd_signal: 'Required:', evidence: 'structural', importance: 'meaningful', match: 'partial' })); }],
    ['total-budget', report => { report.requirement_importance = Array.from({ length: 80 }, (_, i) => ({ requirement: `Requirement ${i + 1}`, jd_signal: 'Required:', evidence: 'structural', importance: 'high', match: 'partial' })); }],
  ]) {
    const bad = JSON.parse(original); mutate(bad.results.find(item => item.posting_key === postingKey(urls[0])).report); fx.write(partFile, bad);
    const rejected = fx.run(`reject-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker], { expect: 1 });
    fx.check(`${name} rejected specifically without Career-Ops mutation`, /requirement_importance|exceeds 12000/.test(rejected.stderr) && manifest(fx.dataRoot) === before);
    fx.write(partFile, original);
  }
  for (const [name, rows] of [['empty', []], ['thirteen-high', Array.from({ length: 13 }, (_, i) => ({ requirement: `Requirement ${i + 1}`, jd_signal: 'Required:', evidence: 'structural', importance: 'high', match: 'partial' }))]]) {
    const valid = JSON.parse(original); valid.results.find(item => item.posting_key === postingKey(urls[0])).report.requirement_importance = rows;
    fx.write(partFile, valid); fx.run(`accept-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker, '--validate-through-part', '1']); fx.write(partFile, original);
  }
  mergeAll(fx, run, plan);
  const oldRoot = path.join(fx.root, 'historical-v7', path.basename(run)); cpSync(run, oldRoot, { recursive: true });
  const oldPlan = parse(path.join(oldRoot, 'assignments.json')); oldPlan.result_schema_version = 7;
  delete oldPlan.hiring_manager_review_version;
  fx.write(path.join(oldRoot, 'assignments.json'), oldPlan);
  for (const id of Object.keys(plan.assignments)) for (const suffix of ['.part-1.json', '.json']) {
    if (suffix.startsWith('.part') && !plan.assignments[id].length) continue;
    const file = path.join(oldRoot, 'results', id + suffix), artifact = parse(file); artifact.result_schema_version = 7;
    for (const item of artifact.results) if (item.report) { delete item.report.hiring_manager_review; delete item.report.requirement_importance; }
    fx.write(file, artifact);
  }
  const readOld = fx.write(path.join(fx.root, 'read-v7.mjs'), `
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadScanResults} from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};
import {renderCompactReport,readCompactReportSummary} from ${JSON.stringify(pathToFileURL(script('scan-report-contract.mjs')).href)};
const r=loadScanResults(process.argv[2],{allowLegacy:true});assert.deepEqual(r.errors,[]);
const records=JSON.parse(fs.readFileSync(path.join(r.root,'acquisition.json'))).acquired;
for(const item of r.candidates){const body=renderCompactReport({result:item,record:records.find(row=>row.primary_key===item.posting_key),runId:r.plan.run_id});const summary=readCompactReportSummary(body);assert.equal(summary.result_schema_version,7);assert(!Object.hasOwn(summary,'requirement_importance'));}
console.log('Historical v7 remains v7 without synthesized requirements');`);
  const oldBefore = manifest(oldRoot);
  fx.run('read-v7-without-migration', readOld, [oldRoot]);
  fx.run('reject-v7-new-merge', script('merge-worker-results.mjs'), ['--run', oldRoot, '--worker', worker], { expect: 1 });
  fx.check('historical bytes unchanged', manifest(oldRoot) === oldBefore);
  const missingRoot = path.join(fx.root, 'missing-interface', path.basename(run)); cpSync(run, missingRoot, { recursive: true });
  const identityModule = path.join(fx.codeRoot, 'listing-fingerprint.mjs'), identitySource = readFileSync(identityModule, 'utf8');
  fx.write(identityModule, 'export const unavailable = true;\n');
  const noInterface = fx.run('reject-missing-official-identity', script('commit-scan.mjs'), ['--run', missingRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
  fx.check('missing identity API rejects before data writes', /listing.*interface/i.test(noInterface.stderr) && manifest(fx.dataRoot) === before);
  fx.write(identityModule, identitySource);
  const malformedRoot = path.join(fx.root, 'malformed-key', path.basename(run)); cpSync(run, malformedRoot, { recursive: true });
  const malformedIdentity = identitySource.replace('listing_key: strong ? keyFor(strong) : null', 'listing_key: undefined');
  fx.check('malformed-key fault injection reaches real identity function', malformedIdentity !== identitySource);
  fx.write(identityModule, malformedIdentity);
  fx.run('reject-malformed-official-key', script('commit-scan.mjs'), ['--run', malformedRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
  const malformedFailure = parse(path.join(malformedRoot, 'commit-failure.json'));
  fx.check('malformed key is a system failure with canonical rollback', malformedFailure.trigger_errors.some(error => error.includes('invalid listing_key'))
    && JSON.stringify(treeManifest(fx.dataRoot).filter(item => item.path !== 'data/applications.db')) === before);
  fx.write(identityModule, identitySource);
  const droppedRoot = path.join(fx.root, 'dropped-key', path.basename(run)); cpSync(run, droppedRoot, { recursive: true });
  const scanModule = path.join(fx.codeRoot, 'scan.mjs'), scanSource = readFileSync(scanModule, 'utf8');
  const dropped = scanSource.replace("listing_key: typeof offer.listingKey === 'string' ? offer.listingKey : ''", "listing_key: ''");
  fx.check('drop-key fault injection reaches real writer', dropped !== scanSource); fx.write(scanModule, dropped);
  const droppedCommit = fx.run('reject-silently-dropped-listing-key', script('commit-scan.mjs'), ['--run', droppedRoot, '--career-ops', fx.codeRoot, '--date', SCAN_DATE], { expect: 1 });
  const failure = parse(path.join(droppedRoot, 'commit-failure.json'));
  const canonicalAfter = treeManifest(fx.dataRoot).filter(item => item.path !== 'data/applications.db');
  fx.check('post-write key audit fails and rolls back canonical data', failure.trigger_errors.some(error => error.includes('listing_key'))
    && JSON.stringify(canonicalAfter) === before && failure.rollback_attempts.every(attempt => attempt.status === 'COMPLETE'));
  const checkIndex = fx.write(path.join(fx.root, 'check-empty-index.mjs'), `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[2],{readOnly:true});if(db.prepare('SELECT COUNT(*) AS count FROM applications').get().count!==0)throw new Error('compensated index retains rows');db.close();console.log('compensated index is empty');`);
  fx.run('verify-compensated-index', checkIndex, [path.join(fx.dataRoot, 'data/applications.db')]);
  fx.write(scanModule, scanSource);
  fx.run('commit-v8', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('five evaluations and four reports conserve', receipt.status === 'COMPLETE' && receipt.terminal_equation.valid && receipt.committed_evaluated_keys.length === 5 && receipt.reports.length === 4);
  fx.check('unrelated history remains verbatim', readFileSync(historyFile, 'utf8').startsWith(unrelatedHistory));
  const inspect = fx.write(path.join(fx.root, 'inspect-upstream.mjs'), `
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {parseReportGaps} from ${JSON.stringify(pathToFileURL(path.join(fx.codeRoot, 'upskill.mjs')).href)};
import {rankSkipBlockers} from ${JSON.stringify(pathToFileURL(path.join(fx.codeRoot, 'skip-blockers.mjs')).href)};
import {computeListingFingerprint} from ${JSON.stringify(pathToFileURL(identityModule).href)};
import {parseScanHistoryLine} from ${JSON.stringify(pathToFileURL(path.join(fx.codeRoot, 'lib/scan-history-columns.mjs')).href)};
import {loadDedupSnapshot,collectSeenUrls} from ${JSON.stringify(pathToFileURL(scanModule).href)};
import {listingIdentityFromUrl} from ${JSON.stringify(pathToFileURL(script('posting-identity.mjs')).href)};
const reports=JSON.parse(fs.readFileSync(process.argv[2])).reports.map((row,i)=>({num:i+1,date:'2026-10-16',state:'discarded',...parseReportGaps(fs.readFileSync(path.join(${JSON.stringify(fx.dataRoot)},row.report_path),'utf8'))}));
assert.equal(reports[0].requirements.length,3);assert(reports.every(report=>report.score===4.2));const blockers=rankSkipBlockers(reports);assert.equal(blockers.blockers.length,1);assert.equal(blockers.blockers[0].partial,4);
const history=${JSON.stringify(path.join(fx.dataRoot, 'data/scan-history.tsv'))};const rows=fs.readFileSync(history,'utf8').trim().split('\\n').slice(1).map(parseScanHistoryLine).filter(row=>row.status.startsWith('daily-scan:'));
const keys=[];for(const row of rows){const strong=listingIdentityFromUrl(row.url);const expected=strong?computeListingFingerprint({url:row.url,strong}).listing_key:'';assert.equal(row.listing_key,expected);if(expected)keys.push(expected);}
assert.equal(keys.length,4);const snapshot=loadDedupSnapshot({},undefined,{scanHistoryPath:history,pipelinePath:${JSON.stringify(path.join(fx.dataRoot, 'data/pipeline.md'))},applicationsPath:${JSON.stringify(path.join(fx.dataRoot, 'data/applications.md'))}});assert(keys.every(key=>!snapshot.seen.has('listing:'+key)));
const accepted=fs.readFileSync(history,'utf8').split('\\n').map(line=>{const cells=line.split('\\t');if(cells[5]?.startsWith('daily-scan:'))cells[5]='added';return cells.join('\\t');}).join('\\n');
const promoted=collectSeenUrls({scanHistoryText:accepted},{},{extraTokensFor:(_url,_portal,key)=>key?'listing:'+key:null});assert(keys.every(key=>promoted.seen.has('listing:'+key)));
const first=${JSON.stringify(urls[0])};assert.deepEqual(listingIdentityFromUrl(first),{ats_provider:'greenhouse',board_slug:'ExactBoard',posting_id:'000501'});
assert.deepEqual(listingIdentityFromUrl('https://job-boards.greenhouse.io/ExactBoard/jobs/000501?gh_src=abc'),listingIdentityFromUrl(first));
assert.deepEqual(listingIdentityFromUrl('https://boards.greenhouse.io/embed/job_app?for=ExactBoard&token=000501'),listingIdentityFromUrl(first));
assert.deepEqual(listingIdentityFromUrl(${JSON.stringify(urls[1] + '/apply')}),listingIdentityFromUrl(${JSON.stringify(urls[1])}));assert.deepEqual(listingIdentityFromUrl(${JSON.stringify(urls[2] + '/application')}),listingIdentityFromUrl(${JSON.stringify(urls[2])}));
for(const url of ['https://boards.greenhouse.io.evil.invalid/ExactBoard/jobs/501','https://careers.example.invalid/jobs/501','https://boards.greenhouse.io/embed/job_app?token=501','https://boards.greenhouse.io/embed/job_app?for=ExactBoard&token=1&token=2','https://boards.greenhouse.io/ExactBoard/jobs/501?gh_jid=999','https://jobs.lever.co:8443/ExactBoard/aBcDef01-2345-6789-aBcd-012345678901','https://jobs.lever.co/ExactBoard','https://user:pass@jobs.ashbyhq.com/ExactBoard/ABCdef02-2345-6789-abCD-012345678901','https://jobs.lever.co/ExactBoard/a%2Fb'])assert.equal(listingIdentityFromUrl(url),null);
assert.notEqual(computeListingFingerprint({strong:listingIdentityFromUrl(first)}).listing_key,computeListingFingerprint({strong:listingIdentityFromUrl(first.replace('ExactBoard','exactboard'))}).listing_key);
assert.notEqual(computeListingFingerprint({strong:listingIdentityFromUrl(first)}).listing_key,computeListingFingerprint({strong:listingIdentityFromUrl(first.replace('000501','000502'))}).listing_key);
console.log(JSON.stringify({blockers,listing_keys:keys,rows:rows.length,native_daily_scan_promotion:false,accepted_status_control:true}));`);
  const upstream = JSON.parse(fx.run('inspect-official-consumers', inspect, [path.join(run, 'receipt.json')], { cwd: fx.codeRoot }).stdout);
  fx.check('upstream requirements analytics and native dedup accept persisted values', upstream.rows === 5 && upstream.listing_keys.length === 4, upstream);
  for (const report of receipt.reports) fx.run(`fictional-discard-${report.report_number}`, path.join(fx.codeRoot, 'set-status.mjs'), ['--report', String(report.report_number), 'Discarded', '--json'], { cwd: fx.codeRoot });
  const analysis = JSON.parse(fx.run('official-upskill-cli', path.join(fx.codeRoot, 'upskill.mjs'), ['--min-reports', '1'], { cwd: fx.codeRoot }).stdout);
  fx.check('actual tracker states and official upskill CLI expose the recurring requirement', analysis.skipBlockers.skips === 4
    && analysis.skipBlockers.blockers.length === 1 && analysis.skipBlockers.blockers[0].partial === 4);
  console.log(JSON.stringify(fx.finish({ receipt: path.join(run, 'receipt.json'), upstream, skip_blockers: analysis.skipBlockers,
    scope: 'Fictional frozen inputs through actual CLI writers, fictional discard transitions and upstream analytics/dedup; no production scan or model-quality claim.' })));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
