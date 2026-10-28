#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { seedCandidate, seedScan, writeScoreParts, mergeAll, SCAN_DATE } from './e2e-scan-inputs.mjs';
import { assignKeys } from '../../src/plan-scan-evaluations.mjs';
import { snapshotAdapterProfile } from '../../src/adapter-registry.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'efficiency', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  fx.write(path.join(fx.root, 'failure-plan.json'), parse(path.join(DISCOVERY_ROOT, 'test/daily-scan-efficiency-e2e.plan.json')));
  fx.write(path.join(fx.root, 'implementation.json'), Object.fromEntries(['src/plan-scan-evaluations.mjs', 'src/merge-worker-results.mjs', 'src/scan-report-contract.mjs', 'src/scoring-safety.mjs', 'src/scoring-research.mjs', 'config/daily-scan-runtime.json'].map(file => [file, digest(path.join(DISCOVERY_ROOT, file))])));
  seedCandidate(fx);
  const jobs = Array.from({ length: 6 }, (_, i) => ({ id: String(88000001 + i), company: `Fictional ${Math.floor(i / 2)} Co` }));
  const run = seedScan(fx, { jobs });
  const planned = fx.run('plan-compact', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const plan = parse(path.join(run, 'assignments.json'));
  fx.check('planner default is bounded and links full frozen assignment', [...planned.stdout].length <= 2001 && JSON.parse(planned.stdout).artifact === path.join(run, 'assignments.json'));
  const expandedPlan = fx.run('plan-explicit-full', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--full']);
  fx.check('compact plan is smaller while complete snapshot is unchanged', planned.stdout.length < expandedPlan.stdout.length && JSON.stringify(JSON.parse(expandedPlan.stdout)) === JSON.stringify(plan));
  const measurements = { planner_stdout_chars: [...planned.stdout].length, full_planner_stdout_chars: [...expandedPlan.stdout].length };
  fx.check('new plan records employer-affinity policy', plan.assignment_policy === 'employer-affinity-v1');
  const records = new Map(parse(path.join(run, 'acquisition.json')).acquired.map(record => [record.primary_key, record]));
  for (const job of jobs) {
    const owners = Object.entries(plan.assignments).filter(([, keys]) => keys.some(k => records.get(k).company === job.company));
    fx.check(`${job.company}: one owner`, owners.length === 1);
  }
  const frozen = readFileSync(path.join(run, 'assignments.json'), 'utf8');
  fx.run('resume-preserves-plan', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  fx.check('existing assignment byte-for-byte unchanged', frozen === readFileSync(path.join(run, 'assignments.json'), 'utf8'));
  const keys = Array.from({ length: 17 }, (_, i) => `linkedin:test:${i}`);
  const map = new Map(keys.map((k, i) => [k, { company: i < 12 ? 'Large Employer' : i < 14 ? 'Dice' : 'Unknown' }]));
  const split = assignKeys(keys, 3, map);
  fx.check('oversized employer splits with bounded capacity and exact conservation', Object.values(split).every(v => v.length <= 6) && Object.values(split).flat().sort().join() === [...keys].sort().join());
  fx.check('grouping deterministic under input reordering', JSON.stringify(split) === JSON.stringify(assignKeys([...keys].reverse(), 3, map)));
  fx.check('empty assignment needs no model', Object.values(assignKeys([], 3, new Map())).every(v => v.length === 0));
  const singletonRecords = new Map(keys.slice(0, 6).map((k, i) => [k, { company: i < 3 ? 'Dice' : 'Ambiguous Co', employer_identity_status: i < 3 ? 'publisher' : 'ambiguous' }]));
  fx.check('publisher and ambiguous labels remain singleton scheduling groups', Object.values(assignKeys(keys.slice(0, 6), 3, singletonRecords)).every(v => v.length === 2 && v.some(k => singletonRecords.get(k).company === 'Dice')));

  writeScoreParts(fx, run);
  const worker = Object.keys(plan.assignments).find(id => plan.assignments[id].includes('linkedin:linkedin.com:88000001'));
  const file = path.join(run, 'results', worker + '.part-1.json');
  const original = readFileSync(file, 'utf8'), valid = JSON.parse(original);
  const part = JSON.parse(original), row = part.results[0];
  row.report.requirement_importance = [{ requirement: 'distributed systems', jd_signal: 'invented quote', evidence: 'stated', importance: 'high', match: 'missing' }];
  row.report.confidence_gaps = ['one', 'two', 'three', 'four'];
  row.report.keywords = ['inventedkeyword'];
  row.legitimacy_tier = 'invalid tier';
  row.work_authorization.quote = 'invented authorization quote';
  fx.write(file, part);
  const args = ['--run', run, '--worker', worker, '--validate-through-part', '1', '--json'];
  const invalid = fx.run('collect-independent-errors', script('merge-worker-results.mjs'), args, { expect: 1 });
  const summary = JSON.parse(invalid.stdout), diagnostics = parse(summary.artifact);
  const all = JSON.stringify(diagnostics);
  fx.check('first payload reports independent quote, gaps, keyword, enum and authorization errors', ['jd_signal', 'confidence_gaps', 'keywords', 'legitimacy_tier', 'work_authorization'].every(s => all.includes(s)));
  fx.check('diagnostics bounded with stable codes and exact keys', [...invalid.stdout].length <= 2001 && diagnostics.diagnostics.every(d => d.posting_key === row.posting_key && d.field && d.code));
  const ledgerFile = path.join(run, 'results', worker + '.validation-evidence.json');
  const ledgerBefore = readFileSync(ledgerFile, 'utf8');
  fx.run('same-rejected-payload', script('merge-worker-results.mjs'), args, { expect: 1 });
  fx.check('same payload preserves attempt ledger', ledgerBefore === readFileSync(ledgerFile, 'utf8') && parse(ledgerFile).failures[row.posting_key].attempts.length === 1);
  row.report.reason = 'x'.repeat(161); fx.write(file, part);
  fx.run('second-rejected-payload', script('merge-worker-results.mjs'), args, { expect: 1 });
  fx.check('second distinct rejected payload consumes original budget', parse(ledgerFile).failures[row.posting_key].attempts.length === 2);
  fx.run('terminalize-observed-failure', script('merge-worker-results.mjs'), ['--run', run, '--worker', worker, '--fail-key', row.posting_key, '--attempts', '2']);
  const terminal = parse(file).results[0];
  fx.check('terminal FAILED retains both actual rejected payloads', terminal.status === 'FAILED' && terminal.validation_evidence.attempts.length === 2);
  const repairRun = seedScan(fx, { name: 'authorization-repair' });
  fx.run('plan-authorization-repair', script('plan-scan-evaluations.mjs'), ['--run', repairRun, '--career-ops', fx.codeRoot]);
  const repairPlan = writeScoreParts(fx, repairRun);
  const repairWorker = Object.keys(repairPlan.assignments).find(w => repairPlan.assignments[w].length);
  const repairFile = path.join(repairRun, 'results', repairWorker + '.part-1.json');
  const repairPart = parse(repairFile), repairOriginal = structuredClone(repairPart);
  repairPart.results[0].report.reason = '';
  delete repairPart.results[0].work_authorization;
  fx.write(repairFile, repairPart);
  const repairArgs = ['--run', repairRun, '--worker', repairWorker, '--validate-through-part', '1', '--json'];
  const repairRejected = fx.run('report-and-missing-authorization', script('merge-worker-results.mjs'), repairArgs, { expect: 1 });
  const repairDiagnostics = parse(JSON.parse(repairRejected.stdout).artifact).diagnostics;
  fx.check('missing authorization and report error are diagnosed together with one repair left',
    ['report.reason', 'work_authorization'].every(field => repairDiagnostics.some(d => d.field === field))
    && repairDiagnostics.every(d => d.recorded_attempts === 1 && d.remaining_attempts === 1));
  fx.write(repairFile, repairOriginal);
  fx.run('one-repair-validates', script('merge-worker-results.mjs'), repairArgs);
  mergeAll(fx, repairRun, repairPlan);
  fx.check('one repair preserves authorization output and the single rejected attempt',
    parse(path.join(repairRun, 'results', repairWorker + '.validation-evidence.json')).failures[repairPart.results[0].posting_key].attempts.length === 1
    && parse(path.join(repairRun, 'results', repairWorker + '.json')).results[0].work_authorization.label === '✅ Sponsors');
  // Subsequent independent failure scenarios use copies, never reset the observed ledger.
  const probe = fx.write(path.join(fx.root, 'probe.mjs'), `import { validateStructuredReport } from ${JSON.stringify(new URL('../../src/scan-report-contract.mjs', import.meta.url).href)};
import { compactSummary } from ${JSON.stringify(new URL('../../src/scan-summary.mjs', import.meta.url).href)};
import { readFileSync } from 'node:fs';
const [mode,file]=process.argv.slice(2);
if(mode==='summary'){console.log(JSON.stringify(compactSummary({stage:'probe',status:'FAILED',artifact:file,errors:Array.from({length:12},(_,i)=>'error '+i+' '+ 'x'.repeat(400))})));}
else {const r=JSON.parse(readFileSync(file));try{validateStructuredReport(r.report,{jdText:r.jd,resumeText:r.resume,decision:'Apply'});}catch(e){console.log(JSON.stringify(e.issues));process.exitCode=1;}}
`);
  const badShape = fx.write(path.join(fx.root, 'bad-shape.json'), { report: { ...valid.results[0].report, score_evidence: null, requirement_importance: null, reason: '' }, jd: readFileSync(path.join(run, records.get(row.posting_key).jd_path), 'utf8'), resume: plan.candidate_sources.find(s => s.label === 'cv.md').content });
  const malformed = fx.run('bad-parent-guards', probe, ['report', badShape], { expect: 1 });
  fx.check('bad parent type reports its field and unrelated error without TypeError', malformed.stdout.includes('score_evidence') && malformed.stdout.includes('reason') && !malformed.stdout.includes('Cannot read'));
  const longFile = fx.write(path.join(fx.root, 'all-errors.json'), { errors: Array.from({ length: 12 }, (_, i) => 'error ' + i + 'x'.repeat(400)) });
  const long = fx.run('bounded-twelve-errors', probe, ['summary', longFile]);
  const bounded = JSON.parse(long.stdout);
  fx.check('all errors reachable with explicit truncation', bounded.error_count === 12 && bounded.preview_count <= 5 && bounded.truncated && [...long.stdout].length <= 2001 && parse(bounded.artifact).errors.length === 12);
  fx.run('missing-summary-artifact-fails', probe, ['summary', path.join(fx.root, 'missing.json')], { expect: 1 });

  // A fresh isolated run provides the mechanically identical successful payloads.
  const successRun = seedScan(fx, { name: 'valid-scan', jobs });
  fx.run('plan-valid', script('plan-scan-evaluations.mjs'), ['--run', successRun, '--career-ops', fx.codeRoot]);
  // Research reuse remains covered for historical plans, independently of the new default.
  const researchPlan = parse(path.join(successRun, 'assignments.json'));
  Object.assign(researchPlan, { research_version: 1, research_not_before: new Date().toISOString() });
  fx.write(path.join(successRun, 'assignments.json'), researchPlan);
  const successPlan = writeScoreParts(fx, successRun);
  const firstWorker = Object.keys(successPlan.assignments).find(w => successPlan.assignments[w].length);
  const firstFile = path.join(successRun, 'results', firstWorker + '.part-1.json');
  const reusePart = parse(firstFile);
  reusePart.results[1].research.sources = structuredClone(reusePart.results[0].research.sources);
  fx.write(firstFile, reusePart);
  const captures = structuredClone(reusePart.results[1].research.sources);
  const beforeData = JSON.stringify(treeManifest(fx.dataRoot));
  for (const [label, mutate] of [
    ['foreign-company', p => { p.results[0].research.company = 'Wrong employer'; }],
    ['stale-source', p => { p.results[0].research.sources[0].retrieved_at = '2000-01-01T00:00:00Z'; }],
    ['missing-query', p => { p.results[0].research.checks.culture.queries = []; }],
    ['foreign-key', p => { p.results[0].posting_key = 'foreign:1'; }],
    ['missing-hm', p => { delete p.results[0].report.hiring_manager_review; }],
  ]) {
    const copy = structuredClone(reusePart); mutate(copy); fx.write(firstFile, copy);
    fx.run('reject-' + label, script('merge-worker-results.mjs'), ['--run', successRun, '--worker', firstWorker], { expect: 1 });
    fx.check(label + ': no canonical writes', JSON.stringify(treeManifest(fx.dataRoot)) === beforeData);
    fx.write(firstFile, reusePart);
  }
  mergeAll(fx, successRun, successPlan);
  const finals = Object.keys(successPlan.assignments).flatMap(w => parse(path.join(successRun, 'results', w + '.json')).results);
  fx.check('source reuse preserves captures and all per-posting queries', JSON.stringify(finals.find(r => r.posting_key === reusePart.results[1].posting_key).research.sources) === JSON.stringify(captures) && finals.every(r => Object.values(r.research.checks).every(c => c.queries.length >= 1 && c.queries.length <= 3)));
  const beforeFinal = JSON.stringify(treeManifest(successRun));
  fx.run('finalized-validation-read-only', script('merge-worker-results.mjs'), ['--run', successRun, '--worker', firstWorker, '--validate-through-part', '1', '--json']);
  fx.check('finalized diagnostic reads do not write artifacts', JSON.stringify(treeManifest(successRun)) === beforeFinal);
  // Common synthetic captures isolate scheduling/serialization from model variability.
  const legacyRun = seedScan(fx, { name: 'legacy-scheduling', jobs });
  fx.run('plan-replay-baseline', script('plan-scan-evaluations.mjs'), ['--run', legacyRun, '--career-ops', fx.codeRoot]);
  const legacyPlan = parse(path.join(legacyRun, 'assignments.json'));
  legacyPlan.assignments = assignKeys(Object.values(successPlan.assignments).flat().sort(), successPlan.runtime.scheduler.max_active_workers);
  legacyPlan.research_version = successPlan.research_version;
  legacyPlan.research_not_before = successPlan.research_not_before; delete legacyPlan.assignment_policy;
  fx.write(path.join(legacyRun, 'assignments.json'), legacyPlan);
  const raw = new Map(Object.keys(successPlan.assignments).flatMap(w => parse(path.join(successRun, 'results', w + '.part-1.json')).results).map(row => [row.posting_key, row]));
  for (const [w, keys] of Object.entries(legacyPlan.assignments)) fx.write(path.join(legacyRun, 'results', w + '.part-1.json'), { result_schema_version: 8, worker: w, part: 1, results: keys.map(k => raw.get(k)) });
  mergeAll(fx, legacyRun, legacyPlan);
  const replayed = Object.keys(legacyPlan.assignments).flatMap(w => parse(path.join(legacyRun, 'results', w + '.json')).results);
  const byKey = rows => [...rows].sort((a, b) => a.posting_key.localeCompare(b.posting_key));
  fx.check('legacy and affinity merge preserve every business field per exact key', JSON.stringify(byKey(finals)) === JSON.stringify(byKey(replayed)));
  fx.run('commit-valid', script('commit-scan.mjs'), ['--run', successRun, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(successRun, 'receipt.json'));
  fx.check('all exact keys reach canonical commit', receipt.status === 'COMPLETE' && finals.length === jobs.length && finals.every(r => r.fit_score === 4.2));
  const runtime = parse(path.join(DISCOVERY_ROOT, 'config/daily-scan-runtime.json'));
  fx.check('JD-only policy preserves model effort threshold retries and HM review', JSON.stringify(plan.runtime) === JSON.stringify(runtime) && runtime.worker.model === 'gpt-6.1-sol' && runtime.worker.reasoning_effort === 'high' && runtime.reporting.full_report_threshold === 4 && runtime.failure.per_job_retry_limit === 1 && plan.research_version === 0 && plan.hiring_manager_review_version === 1);
  const contract = readFileSync(path.join(DISCOVERY_ROOT, '.agents/skills/career-ops-daily-linkedin-scan/references/workflow-contract.md'), 'utf8');
  fx.check('wait and exception protocol explicitly preserved', ['No-change timeout', '60 seconds', 'provider', 'replacement worker'].every(s => contract.includes(s)));
  const workspace = path.join(fx.root, 'source-workspace'), sourceRun = path.join(workspace, 'runs', 'source-probe');
  const profile = snapshotAdapterProfile(); profile.adapters = ['jobspy', 'jobright']; profile.minimum_successful_adapters = 1;
  profile.adapter_definitions = Object.fromEntries(profile.adapters.map(id => [id, profile.adapter_definitions[id]]));
  const fakeAdapter = fx.write(path.join(fx.root, 'fake-adapter.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';
const [id,root]=process.argv.slice(2),dir=path.join(root,'sources',id);mkdirSync(path.join(dir,'jobs'),{recursive:true});
const good=id==='jobspy';if(good)writeFileSync(path.join(dir,'jobs','one.md'),'complete fictional source capture');
writeFileSync(path.join(dir,'summary.json'),JSON.stringify({schema_version:1,run_id:path.basename(root),adapter:id,status:good?'SUCCESS':'FAILED',raw_rows:good?1:0,unique_jobs:good?1:0,markdown_jobs:good?1:0,errors:good?0:7,retryable:false}));
console.log('full-capture-'+id+'x'.repeat(12000));console.error('actual diagnostic '+id);process.exitCode=good?0:1;`);
  for (const id of profile.adapters) {
    const def = profile.adapter_definitions[id]; fx.write(path.join(workspace, def.config), def.config_content);
    def.command = [process.execPath, fakeAdapter, id, sourceRun];
  }
  fx.write(path.join(sourceRun, 'baseline.json'), { adapter_profile: profile });
  const sourceProbe = fx.write(path.join(fx.root, 'source-probe.mjs'), `import {runAdapters} from ${JSON.stringify(new URL('../../src/run-adapters.mjs', import.meta.url).href)};
import {compactSummary} from ${JSON.stringify(new URL('../../src/scan-summary.mjs', import.meta.url).href)};
const r=runAdapters({runRoot:process.argv[2],discoveryRoot:process.argv[3]});
console.log(JSON.stringify(compactSummary({stage:'sources',status:r.status,artifact:process.argv[2]+'/source-run.json',counts:{successful:r.successful_adapters.length,required:r.minimum_successful_adapters},errors:r.outcomes.filter(s=>s.status==='FAILED').map(s=>s.adapter+': FAILED; inspect source summary'),errorCount:r.outcomes.reduce((n,s)=>n+s.errors,0)})));`);
  const sourceResult = fx.run('capture-serial-source-logs', sourceProbe, [sourceRun, workspace]);
  const sourceView = JSON.parse(sourceResult.stdout), sourceValue = parse(sourceView.artifact);
  fx.check('child output fully captured without entering bounded coordinator stdout', [...sourceResult.stdout].length <= 2001 && !sourceResult.stdout.includes('full-capture') && sourceValue.status === 'DEGRADED' && sourceValue.command_results.every(r => readFileSync(path.join(sourceRun, r.stdout_path), 'utf8').length > 12000 && readFileSync(path.join(sourceRun, r.stderr_path), 'utf8').includes('actual diagnostic')));
  fx.check('full source outcomes preserve nonretryable errors', parse(path.join(sourceRun, 'source-run.json')).outcomes.find(s => s.adapter === 'jobright').errors === 7);
  measurements.source_coordinator_stdout_chars = [...sourceResult.stdout].length;
  measurements.source_captured_stdout_chars = sourceValue.command_results.reduce((n, r) => n + [...readFileSync(path.join(sourceRun, r.stdout_path), 'utf8')].length, 0);
  fx.write(path.join(fx.root, 'measurements.json'), measurements);
  fx.check('failed run was not committed', !existsSync(path.join(run, 'receipt.json')));
  const result = fx.finish({ receipt: path.join(successRun, 'receipt.json'), measurements, limitations: 'Mechanical fixtures and prompt contract checks; no live agent wait behavior, real page applicability, model judgments or token savings measured.' });
  console.log(JSON.stringify({ root: result.root, passed: result.passed, assertions: result.assertions.length, commands: result.commands, measurements }));
} catch (error) { fx.write(path.join(fx.root, 'failure.json'), { error: error.stack }); console.error(error.stack); process.exitCode = 1; }
