#!/usr/bin/env node
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { seedCandidate, seedScan, scoreReport, writeScoreParts, mergeAll, SCAN_DATE, EVIDENCE_TEXT } from './e2e-scan-inputs.mjs';
import { readCompactReportSummary } from '../../src/scan-report-contract.mjs';
const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'research', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
try {
  fx.write(path.join(fx.root, 'failure-plan.json'), parse(path.join(DISCOVERY_ROOT, 'test/daily-scan-research-e2e.plan.json')));
  seedCandidate(fx);
  const jdOnly = seedScan(fx, { name: 'jd-only', jobs: [
    { id: '88001001', company: 'Fictional JD Only Co' },
    { id: '88001002', company: 'Fictional Below Co' },
    { id: '88001003', company: 'Fictional Restricted Co', body: [EVIDENCE_TEXT.scope, EVIDENCE_TEXT.compensation, EVIDENCE_TEXT.culture, 'We cannot provide visa sponsorship or transfers.', 'Own permanent backend services with testing and debugging.'].join('\n') },
    { id: '88001004', company: 'Fictional Unknown Co', body: [EVIDENCE_TEXT.scope, EVIDENCE_TEXT.sponsorship, 'Own permanent backend services with testing and debugging. Collaborate with engineers on distributed systems, APIs, deployment, data storage and incident response.'].join('\n') },
  ] });
  fx.run('plan-jd-only', script('plan-scan-evaluations.mjs'), ['--run', jdOnly, '--career-ops', fx.codeRoot]);
  const jdPlan = writeScoreParts(fx, jdOnly, key => {
    if (key.endsWith('2')) return { fit_score: 3.5, rationale: 'Fictional below-threshold fit.', report: null, work_authorization: undefined };
    if (key.endsWith('3')) return { fit_score: 4.5, eligibility_status: 'ineligible', eligibility_category: 'no_sponsorship', eligibility_evidence: 'JD: "We cannot provide visa sponsorship or transfers."', rationale: 'The JD excludes required sponsorship.', report: null, work_authorization: undefined };
    if (!key.endsWith('4')) return {};
    const report = scoreReport(); report.advertised_comp = null; report.confidence = 'Low'; report.confidence_gaps = [];
    for (const dimension of ['compensation', 'culture']) {
      const question = `Confirm ${dimension}; the JD does not supply it.`;
      report.score_evidence[dimension] = { status: 'unknown', source: null, observation: 'The supplied JD does not establish this dimension.', question };
      report.confidence_gaps.push(question);
    }
    return { report };
  });
  fx.check('new plans explicitly disable research without a capture-time requirement', jdPlan.research_version === 0 && !Object.hasOwn(jdPlan, 'research_not_before'));
  const jdWorker = Object.keys(jdPlan.assignments).find(id => jdPlan.assignments[id].includes('linkedin:linkedin.com:88001001'));
  const jdPartFile = path.join(jdOnly, 'results', jdWorker + '.part-1.json'), jdPart = parse(jdPartFile);
  const beforeJdData = JSON.stringify(treeManifest(fx.dataRoot));
  for (const [name, mutate, message] of [
    ['external-placeholder', row => { row.research = null; }, 'external research is disabled'],
    ['external-citation', row => { row.report.score_evidence.compensation.source = 'Research: market: Invented external salary benchmark.'; }, 'research source'],
  ]) {
    const invalid = structuredClone(jdPart); mutate(invalid.results[0]); fx.write(jdPartFile, invalid);
    const rejected = fx.run('jd-only-reject-' + name, script('merge-worker-results.mjs'), ['--run', jdOnly, '--worker', jdWorker], { expect: 1 });
    fx.check(name + ': rejects before canonical writes', rejected.stderr.includes(message) && JSON.stringify(treeManifest(fx.dataRoot)) === beforeJdData);
    fx.write(jdPartFile, jdPart);
  }
  mergeAll(fx, jdOnly, jdPlan);
  const jdFinals = Object.keys(jdPlan.assignments).flatMap(id => parse(path.join(jdOnly, 'results', id + '.json')).results);
  fx.check('all JD-only evaluations omit external research, including low-score and hard exclusions', jdFinals.length === 4 && jdFinals.every(row => !Object.hasOwn(row, 'research')));
  const unknown = jdFinals.find(row => row.posting_key.endsWith('4'));
  fx.check('missing facts retain unknown evidence and Low confidence without invented exclusions', unknown.score === 4.2 && unknown.eligibility_status === 'eligible' && unknown.report.confidence === 'Low' && ['compensation', 'culture'].every(d => unknown.report.score_evidence[d].status === 'unknown' && unknown.report.score_evidence[d].source === null) && unknown.report.confidence_gaps.length === 2);
  fx.run('commit-jd-only', script('commit-scan.mjs'), ['--run', jdOnly, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const jdReceipt = parse(path.join(jdOnly, 'receipt.json'));
  fx.check('JD-only persistence keeps threshold and eligibility gates', jdReceipt.status === 'COMPLETE' && jdReceipt.reports.length === 2 && jdReceipt.below_threshold_count === 1 && jdReceipt.hard_exclusion_keys.length === 1);
  fx.check('JD-only reports retain authorization and omit the external research section', jdReceipt.reports.every(entry => { const text = readFileSync(path.join(fx.dataRoot, entry.report_path), 'utf8'); return !text.includes('### External research') && text.includes('✅ Sponsors') && text.includes(EVIDENCE_TEXT.sponsorship); }));
  const run = seedScan(fx, { jobs: [{ id: '88000001', company: 'Fictional Research Co' }, { id: '88000002', company: 'Fictional Unavailable Co' }, { id: '88000003', company: 'Fictional Below Threshold Co' }] });
  fx.run('plan-research', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  // Preserve the old frozen policy only in the historical compatibility fixture.
  const researchedPlan = parse(path.join(run, 'assignments.json'));
  Object.assign(researchedPlan, { research_version: 1, research_not_before: new Date().toISOString() });
  fx.write(path.join(run, 'assignments.json'), researchedPlan);
  const plan = writeScoreParts(fx, run, key => key.endsWith('3') ? { fit_score: 3.5, rationale: 'Fictional below-threshold fit.', report: null } : {});
  fx.check('historical research plan retains its versioned contract', plan.research_version === 1);
  const worker = Object.keys(plan.assignments).find(id => plan.assignments[id].includes('linkedin:linkedin.com:88000001'));
  const file = path.join(run, 'results', worker + '.part-1.json');
  const recovered = parse(file);
  for (const check of Object.values(recovered.results[0].research.checks)) {
    check.queries[0].tool = 'fixture-independent-search';
    check.queries.unshift({ ...check.queries[0], tool: 'fixture-exa', reference: 'fixture:exa-quota-429', outcome: 'blocked' });
  }
  fx.write(file, recovered);
  const original = readFileSync(file, 'utf8');
  const beforeData = JSON.stringify(treeManifest(fx.dataRoot));
  for (const [name, mutate, message] of [
    ['missing', row => delete row.research, 'research'],
    ['foreign-posting', row => { row.research.posting_key = 'foreign:1'; }, 'identity'],
    ['foreign-employer', row => { row.research.company = 'Other Co'; }, 'identity'],
    ['missing-company', row => delete row.research.checks.company, 'company'],
    ['missing-search', row => { row.research.checks.compensation.queries = []; }, 'queries'],
    ['missing-tool-reference', row => { row.research.checks.compensation.queries[0].reference = ''; }, 'reference'],
    ['unsafe-url', row => { row.research.sources[0].url = 'javascript:alert(1)'; }, 'url'],
    ['future-source', row => { row.research.sources[0].retrieved_at = '2099-01-01T00:00:00.000Z'; }, 'time'],
    ['duplicate-source', row => { row.research.sources.push(row.research.sources[0]); }, 'duplicate'],
    ['forged-check-time', row => { row.research.checked_at = '2099-01-01T00:00:00.000Z'; }, 'time'],
    ['unopened', row => { row.research.sources[0].reference = ''; }, 'reference'],
    ['missing-source', row => { row.research.checks.compensation.source_ids = ['absent']; }, 'source'],
    ['no-market', row => { row.research.sources[0].kind = 'official'; }, 'market'],
    ['forged-quote', row => { row.report.score_evidence.compensation.source = 'Research: market: invented quotation'; }, 'substring'],
    ['wrong-dimension', row => { row.report.score_evidence.culture.source = 'Research: market: Published market base range is $170,000 to $200,000.'; }, 'dimension'],
    ['unsupported-success', row => { row.research.checks.compensation.status = 'limited'; row.research.checks.compensation.question = 'Confirm market scope.'; row.report.score_evidence.compensation.status = 'supported'; }, 'supported'],
  ]) {
    const part = JSON.parse(original); mutate(part.results[0]); fx.write(file, part);
    const result = fx.run(`reject-${name}`, script('merge-worker-results.mjs'), ['--run', run, '--worker', worker], { expect: 1 });
    fx.check(`${name}: actionable rejection and no Career-Ops writes`, result.stderr.includes(message) && JSON.stringify(treeManifest(fx.dataRoot)) === beforeData);
    fx.write(file, original);
  }
  const belowWorker = Object.keys(plan.assignments).find(id => plan.assignments[id].some(key => key.endsWith('3')));
  const belowFile = path.join(run, 'results', belowWorker + '.part-1.json');
  const belowOriginal = readFileSync(belowFile, 'utf8'), below = JSON.parse(belowOriginal);
  delete below.results[0].research; fx.write(belowFile, below);
  const missingBelow = fx.run('reject-unresearched-below-threshold', script('merge-worker-results.mjs'), ['--run', run, '--worker', belowWorker], { expect: 1 });
  fx.check('below-threshold result also requires research', missingBelow.stderr.includes('research'));
  fx.write(belowFile, belowOriginal);
  const unavailableWorker = Object.keys(plan.assignments).find(id => plan.assignments[id].some(key => key.endsWith('2')));
  const unavailableFile = path.join(run, 'results', unavailableWorker + '.part-1.json');
  const unavailable = parse(unavailableFile), failedLookup = unavailable.results[0];
  failedLookup.research.sources = [];
  failedLookup.report.confidence_gaps = [];
  for (const [dimension, check] of Object.entries(failedLookup.research.checks)) {
    check.status = 'unavailable'; check.source_ids = [];
    check.queries[0].tool = 'fixture-exa'; check.queries[0].outcome = 'blocked';
    check.queries[0].reference = 'fixture:exa-quota-429';
    check.queries.push({ ...check.queries[0], tool: 'fixture-independent-search', query: check.queries[0].query + ' alternate public source', reference: 'fixture:alternate-' + dimension,
      outcome: dimension === 'culture' ? 'blocked' : dimension === 'company' ? 'error' : 'no_results' });
    check.finding = 'No usable evidence after bounded public lookups; no negative employer conclusion.';
    check.question = `Confirm ${dimension} with a usable current source.`;
    const evidence = failedLookup.report.score_evidence[dimension === 'company' ? 'red_flags' : dimension];
    Object.assign(evidence, { status: 'unknown', source: null, observation: 'External evidence is unavailable.', question: check.question });
    failedLookup.report.confidence_gaps.push(check.question);
  }
  failedLookup.report.confidence = 'Low'; fx.write(unavailableFile, unavailable);
  const part = JSON.parse(original), row = part.results[0];
  row.report.score_evidence.compensation.source = 'Research: market: Published market base range is $170,000 to $200,000.';
  fx.write(file, part);
  mergeAll(fx, run, plan);
  const finalFile = path.join(run, 'results', worker + '.json');
  const originalFinal = readFileSync(finalFile, 'utf8'), tampered = JSON.parse(originalFinal);
  tampered.results[0].research.checks.company.finding = 'Forged merged-only finding'; fx.write(finalFile, tampered);
  const inspect = fx.write(path.join(fx.root, 'inspect-results.mjs'), `import { loadScanResults } from ${JSON.stringify(pathToFileURL(script('scan-results.mjs')).href)};
const value=loadScanResults(process.argv[2]);console.log(JSON.stringify(value.errors));if(value.errors.length)process.exitCode=1;
`);
  const mismatch = fx.run('reject-research-final-tampering', inspect, [run], { expect: 1 });
  fx.check('raw/final research drift is rejected', mismatch.stdout.includes('merged result does not equal'));
  fx.write(finalFile, originalFinal);
  const historical = path.join(fx.root, 'historical/runs', plan.run_id); cpSync(run, historical, { recursive: true });
  const oldPlan = parse(path.join(historical, 'assignments.json')); delete oldPlan.research_version; delete oldPlan.research_not_before;
  fx.write(path.join(historical, 'assignments.json'), oldPlan);
  for (const id of Object.keys(plan.assignments)) for (const suffix of ['.part-1.json', '.json']) {
    const oldFile = path.join(historical, 'results', id + suffix), artifact = parse(oldFile);
    for (const item of artifact.results) { delete item.research; if (item.report?.score_evidence.compensation.source?.startsWith('Research:')) item.report.score_evidence.compensation.source = `JD: ${EVIDENCE_TEXT.compensation}`; }
    fx.write(oldFile, artifact);
  }
  const oldBefore = JSON.stringify(treeManifest(historical)); fx.run('historical-v8-without-research', inspect, [historical]);
  fx.check('historical v8 inspection leaves bytes unchanged', JSON.stringify(treeManifest(historical)) === oldBefore);
  fx.run('commit-researched', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
  const receipt = parse(path.join(run, 'receipt.json'));
  fx.check('complete persistence retains normal scoring and filtering', receipt.status === 'COMPLETE' && receipt.reports.length === 2 && receipt.below_threshold_count === 1);
  const report = receipt.reports.find(item => item.posting_key.endsWith('1'));
  const markdown = readFileSync(path.join(fx.dataRoot, report.report_path), 'utf8');
  fx.check('research links, findings, lookup outcomes and quotes render in existing report', markdown.includes('https://market.example/salary') && markdown.includes('Published market base range') && markdown.includes('External research') && markdown.includes('Fictional Research Co') && readCompactReportSummary(markdown.slice(markdown.indexOf('## Machine Summary'))).score === 4.2);
  fx.check('primary quota failure and independent fallback survive merge and rendering',
    markdown.includes('fixture-exa / blocked') && markdown.includes('fixture-independent-search / found')
    && parse(finalFile).results[0].research.checks.compensation.queries[0].reference === 'fixture:exa-quota-429');
  const unavailableFinal = parse(path.join(run, 'results', unavailableWorker + '.json')).results[0];
  fx.check('exhausted independent fallback retains actual outcomes and no sources',
    unavailableFinal.research.sources.length === 0
    && Object.values(unavailableFinal.research.checks).every(check => check.status === 'unavailable'
      && check.queries[0].tool === 'fixture-exa' && check.queries[0].outcome === 'blocked'
      && check.queries[1].tool === 'fixture-independent-search'));
  fx.check('blocked/empty/error lookups reduce confidence without mechanical score or legitimacy penalties', unavailableFinal.score === 4.2 && unavailableFinal.legitimacy_tier === 'High Confidence' && unavailableFinal.report.confidence === 'Low');
  const prepare = fx.run('prepare-researched-expansion', script('expand-scan-report.mjs'), ['prepare', path.basename(report.report_path), '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  const preparedFile = fx.write(path.join(fx.root, 'prepared-expansion.json'), JSON.parse(prepare.stdout));
  const body = markdown.slice(markdown.indexOf('## Machine Summary'));
  const draft = fx.write(path.join(fx.root, 'expanded-draft.md'), [body.split('\n\n## Verdict')[0],
    '## A) Role Summary\nFictional researched role.', '## B) Match with CV\nDocumented fictional fit.',
    'Fixed-term employment: not detected in supplied JD.',
    '## C) Level and Strategy\nSenior target.', '## D) Comp and Demand\nUse original captured market evidence.',
    '## E) Customization Plan\nPreserve candidate facts.', '## F) Interview Plan\nDiscuss platform ownership.',
    '## G) Posting Legitimacy\nSeparate from fit.', '## Risk Summary\nOriginal gaps remain.',
    '## Keywords extracted\n- distributed systems'].join('\n\n'));
  // The canonical fixed-term line is immutable even in the isolated full draft.
  const fixedLine = body.split('\n').find(line => line.startsWith('Fixed-term') || line === 'No fixed term disclosed in the supplied JD.');
  fx.write(draft, readFileSync(draft, 'utf8').replace('Fixed-term employment: not detected in supplied JD.', fixedLine));
  fx.run('expand-researched-report', script('expand-scan-report.mjs'), ['commit', path.basename(report.report_path), draft, '--prepared', preparedFile, '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  const expanded = readFileSync(path.join(fx.dataRoot, report.report_path), 'utf8');
  const researchText = body.split('\n\n## Score Evidence\n')[1].split('\n\n## Keywords extracted')[0];
  fx.check('expansion preserves complete original research verbatim', expanded.includes(researchText) && expanded.includes('https://market.example/salary'));
  const jdEntry = jdReceipt.reports.find(entry => entry.posting_key.endsWith('4'));
  const jdText = readFileSync(path.join(fx.dataRoot, jdEntry.report_path), 'utf8');
  const jdPrepared = fx.run('prepare-jd-only-expansion', script('expand-scan-report.mjs'), ['prepare', path.basename(jdEntry.report_path), '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  const jdPreparedFile = fx.write(path.join(fx.root, 'jd-only-prepared.json'), JSON.parse(jdPrepared.stdout));
  const jdDraft = fx.write(path.join(fx.root, 'jd-only-expanded-draft.md'), jdText.slice(jdText.indexOf('## Machine Summary')).split('\n\n## Verdict')[0]
    + readFileSync(draft, 'utf8').slice(readFileSync(draft, 'utf8').indexOf('\n\n## A)'))
      .replace('Use original captured market evidence.', 'The JD supplies no salary; external market evidence is unavailable.'));
  fx.run('expand-jd-only-report', script('expand-scan-report.mjs'), ['commit', path.basename(jdEntry.report_path), jdDraft, '--prepared', jdPreparedFile, '--career-ops', fx.codeRoot, '--discovery', fx.root]);
  const jdExpanded = readFileSync(path.join(fx.dataRoot, jdEntry.report_path), 'utf8');
  fx.check('JD-only expansion preserves unknown facts and authorization without external research', !jdExpanded.includes('### External research') && jdExpanded.includes(EVIDENCE_TEXT.sponsorship) && unknown.report.confidence_gaps.every(question => jdExpanded.includes(question)));
  const upgraded = path.join(fx.root, 'upgraded-discovery'), frozen = path.join(upgraded, 'runs', plan.run_id);
  cpSync(path.join(DISCOVERY_ROOT, 'src'), path.join(upgraded, 'src'), { recursive: true });
  cpSync(run, frozen, { recursive: true });
  const frozenFile = path.join(frozen, 'assignments.json'), frozenPlan = parse(frozenFile);
  for (const source of frozenPlan.rule_sources.filter(source => source.label.startsWith('job-discovery/'))) {
    source.path = path.join(upgraded, source.label.slice('job-discovery/'.length));
    fx.write(source.path, source.content + '\n# Later policy: new evaluations use JD-only scoring.\n');
  }
  fx.write(frozenFile, frozenPlan);
  fx.write(path.join(upgraded, 'config/daily-scan-runtime.json'), frozenPlan.runtime);
  for (const definition of Object.values(parse(path.join(frozen, 'baseline.json')).adapter_profile.adapter_definitions)) {
    if (definition.config) fx.write(path.join(upgraded, definition.config), definition.config_content);
  }
  const inspectFrozen = fx.write(path.join(fx.root, 'inspect-frozen-v8.mjs'), `import { loadScanResults } from ${JSON.stringify(pathToFileURL(path.join(upgraded, 'src/scan-results.mjs')).href)};
const result=loadScanResults(process.argv[2],{allowLegacy:process.argv[3]==='historical'});
console.log(JSON.stringify({errors:result.errors,candidates:result.candidates.map(row=>row.posting_key),research:result.evaluated.map(row=>row.research),historical_rule_snapshots_verified:result.historical_rule_snapshots_verified}));
process.exitCode=result.errors.length?1:0;
`);
  const frozenBefore = JSON.stringify(treeManifest(frozen)), dataBeforeInspection = JSON.stringify(treeManifest(fx.dataRoot));
  const strict = fx.run('reject-upgraded-v8-without-readonly-option', inspectFrozen, [frozen], { expect: 1 });
  fx.check('ordinary v8 reads still reject changed rules', strict.stdout.includes('approved rule source content changed'));
  const inspected = JSON.parse(fx.run('read-frozen-v8-after-rule-upgrade', inspectFrozen, [frozen, 'historical']).stdout);
  const originalResearch = Object.keys(plan.assignments).flatMap(id => parse(path.join(run, 'results', id + '.json')).results).map(row => row.research);
  fx.check('read-only v8 inspection retains candidates and research without claiming live rule verification', inspected.candidates.length === receipt.reports.length && JSON.stringify(inspected.research) === JSON.stringify(originalResearch) && inspected.historical_rule_snapshots_verified === false);
  for (const name of ['plan-scan-evaluations.mjs', 'merge-worker-results.mjs']) {
    const rejected = fx.run('reject-upgraded-v8-' + name, path.join(upgraded, 'src', name), ['--run', frozen, '--career-ops', fx.codeRoot, '--worker', worker], { expect: 1 });
    fx.check(name + ': current writes still require matching rules', rejected.stderr.includes('approved rule source content changed'));
  }
  for (const [name, mutate, message] of [
    ['candidate-content', value => { value.candidate_sources[0].content += '\nChanged candidate fact.'; }, 'approved candidate source content changed'],
    ['candidate-path', value => { value.candidate_sources[0].path += '.other'; }, 'outside configured'],
    ['rule-path', value => { value.rule_sources.at(-1).path += '.other'; }, 'outside configured'],
    ['rule-shape', value => { value.rule_sources.at(-1).content = null; }, 'invalid approved rule source content'],
  ]) {
    const invalid = structuredClone(frozenPlan); mutate(invalid); fx.write(frozenFile, invalid);
    const rejected = fx.run('historical-v8-reject-' + name, inspectFrozen, [frozen, 'historical'], { expect: 1 });
    fx.check(name + ': historical validation retains source boundaries', rejected.stdout.includes(message));
    fx.write(frozenFile, frozenPlan);
  }
  const frozenPart = path.join(frozen, 'results', worker + '.part-1.json'), partBeforeInspection = readFileSync(frozenPart, 'utf8');
  const missingResearch = JSON.parse(partBeforeInspection); delete missingResearch.results[0].research; fx.write(frozenPart, missingResearch);
  const rejectedResearch = fx.run('historical-v8-reject-missing-research', inspectFrozen, [frozen, 'historical'], { expect: 1 });
  fx.check('historical v8 research remains required', rejectedResearch.stdout.includes('research'));
  fx.write(frozenPart, partBeforeInspection);
  fx.check('historical v8 inspection preserves all run and Career-Ops bytes', JSON.stringify(treeManifest(frozen)) === frozenBefore && JSON.stringify(treeManifest(fx.dataRoot)) === dataBeforeInspection);
  console.log(JSON.stringify(fx.finish({ receipt: path.join(run, 'receipt.json'), scope: 'Synthetic research tests workflow integrity, not live search availability or model judgment.' })));
} catch (error) { fx.write(path.join(fx.root, 'failure.json'), { error: error.stack }); console.error(error.stack); process.exitCode = 1; }
