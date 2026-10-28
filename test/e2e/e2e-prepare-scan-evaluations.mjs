#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { EVIDENCE_TEXT, SCAN_DATE, seedCandidate, seedScan } from './e2e-scan-inputs.mjs';
import { postingKey } from '../../src/posting-identity.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'prepare-scan-evaluations', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const manifest = root => JSON.stringify(treeManifest(root));
const key = id => `linkedin:linkedin.com:${id}`;
const ledgerFile = run => path.join(run, 'triage/canonical-url-resolutions.json');
const prepare = (label, run, args = [], expect = 0) => fx.run(label, script('prepare-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot, ...args], { expect });
const plan = (label, run, args = [], expect = 0) => fx.run(label, script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot, ...args], { expect });
const failure = (label, result, pattern) => fx.check(`${label}: diagnostic retained`, pattern.test(`${result.stdout}\n${result.stderr}`), { stdout: result.stdout, stderr: result.stderr });
const absent = (label, run, files) => fx.check(label, files.every(file => !existsSync(path.join(run, file))), { files });
const fresh = (name, jobs) => {
  const run = seedScan(fx, { name, ...(jobs ? { jobs } : {}) });
  // seedScan also serves older planner E2Es; remove only its test-created derived files.
  rmSync(path.join(run, 'acquisition.json'));
  rmSync(path.join(run, 'jobs'), { recursive: true });
  return run;
};
const oldChain = (label, run, args = []) => {
  fx.run(`${label}-combine`, script('combine.mjs'), ['--run', run]);
  fx.run(`${label}-contract-before-resolution`, script('run-contract.mjs'), ['--run', run]);
  fx.run(`${label}-resolve`, script('resolve-canonical-urls.mjs'), ['--run', run]);
  plan(`${label}-plan`, run, args);
  fx.run(`${label}-contract-after-plan`, script('run-contract.mjs'), ['--run', run]);
};
const projection = run => {
  const acquisition = parse(path.join(run, 'acquisition.json'));
  const assignments = parse(path.join(run, 'assignments.json'));
  const location = parse(path.join(run, 'triage/location-scope.json'));
  const resolution = parse(ledgerFile(run));
  return {
    assignment_keys: Object.values(assignments.assignments).flat().sort(),
    assignments: assignments.assignments,
    primary_urls: assignments.primary_urls,
    runtime: assignments.runtime,
    research_version: assignments.research_version,
    location_policy: assignments.location_policy,
    location: location.results.map(({ posting_key, allowed, decision }) => ({ posting_key, allowed, decision })),
    exact: resolution.history_deduplication.results.map(({ primary_key, duplicate, matched_keys }) => ({ primary_key, duplicate, matched_keys })),
    semantic: resolution.semantic_deduplication.results.map(({ primary_key, disposition, matched_run_primary_key }) => ({ primary_key, disposition, matched_run_primary_key })),
    resolution: resolution.results,
    counts: { raw_source_jobs: acquisition.raw_source_jobs, source_unique_count: acquisition.source_unique_count,
      assigned: acquisition.acquired.length, location_excluded: acquisition.location_exclusion_count,
      location_ambiguous: acquisition.location_ambiguous_count, history_duplicates: acquisition.historical_duplicate_count,
      semantic_aliases: resolution.semantic_deduplication.enforced_semantic_alias_count },
    artifacts: ['acquisition.json', 'assignments.json', 'triage/location-scope.json', 'triage/blacklist.json', 'triage/canonical-url-resolutions.json']
      .filter(file => existsSync(path.join(run, file))),
    source_jobs: readdirSync(path.join(run, 'sources/jobspy/jobs')).sort(),
    prepared_jobs: acquisition.acquired.map(({ primary_key, primary_url, posting_keys, location_scope }) => ({ primary_key, primary_url, posting_keys, location_scope })),
  };
};

try {
  fx.write(path.join(fx.root, 'failure-plan.json'), parse(path.join(DISCOVERY_ROOT, 'test/prepare-scan-evaluations-e2e.plan.json')));
  const implementationFiles = ['test/e2e/e2e-prepare-scan-evaluations.mjs', 'test/prepare-scan-evaluations-e2e.plan.json',
    'test/e2e/e2e-career-fixture.mjs', 'test/e2e/e2e-scan-inputs.mjs',
    'src/prepare-scan-evaluations.mjs', 'src/combine.mjs', 'src/run-contract.mjs', 'src/resolve-canonical-urls.mjs',
    'src/plan-scan-evaluations.mjs', 'src/scan-summary.mjs', 'config/daily-scan-runtime.json', 'config/discovery-adapters.v1.json'];
  fx.write(path.join(fx.root, 'implementation.json'), {
    discovery_revision: execFileSync('git', ['-C', DISCOVERY_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    invocation: [process.execPath, ...process.argv.slice(1)], fixture_date: SCAN_DATE,
    files: Object.fromEntries(implementationFiles.map(file => [file, existsSync(path.join(DISCOVERY_ROOT, file))
      ? createHash('sha256').update(readFileSync(path.join(DISCOVERY_ROOT, file))).digest('hex') : null])),
  });
  seedCandidate(fx);
  const historyFile = path.join(fx.dataRoot, 'data/scan-history.tsv');
  fx.write(historyFile, readFileSync(historyFile, 'utf8') + `https://www.linkedin.com/jobs/view/92000003\t${SCAN_DATE}\tfictional\tSenior Backend Engineer\tHistorical Co\tdaily-scan:evaluated\tSeattle, WA\n`);
  const careerBefore = manifest(fx.dataRoot);
  const body = `${EVIDENCE_TEXT.scope}\n${EVIDENCE_TEXT.compensation}\n${EVIDENCE_TEXT.culture}\n${EVIDENCE_TEXT.sponsorship}\nThe engineer owns platform reliability, design, delivery, operations, testing and incident response for permanent backend services.`;
  const officialUrl = 'https://boards.greenhouse.io/fictionalprepare/jobs/1001';
  const jobs = [
    { id: '92000001', company: 'Canonical Co', body: `${body}\nApply at ${officialUrl}` },
    { id: '92000002', company: 'Canonical Co', url: officialUrl, key: postingKey(officialUrl), body: `${body}\nApply at ${officialUrl}` },
    { id: '92000003', company: 'Historical Co' },
    { id: '92000004', company: 'Nonlocal Co' },
    { id: '92000005', company: 'Ambiguous Co' },
    { id: '92000006', company: 'Semantic Co', body },
    { id: '92000007', company: 'Semantic Co', body },
    { id: '92000008', company: 'Unique Local Co' },
    { id: '92000009', company: 'Structured Remote Co' },
  ];
  const seedBusinessRun = name => {
    const run = fresh(name, jobs);
    for (const [id, location, remote] of [['92000004', 'New York, NY', false], ['92000005', 'United States', false], ['92000009', 'United States', true]]) {
      const file = path.join(run, 'sources/jobspy/jobs', `${id}.md`);
      fx.write(file, readFileSync(file, 'utf8').replace('**Location:** Seattle, WA', `**Location:** ${location}`)
        .replace('**Workplace Type:** hybrid', `**Workplace Type:** ${remote ? 'remote' : 'hybrid'}`)
        .replace('**Structured Remote Signal:** false', `**Structured Remote Signal:** ${remote}`));
    }
    return run;
  };
  const runtime = parse(path.join(DISCOVERY_ROOT, 'config/daily-scan-runtime.json'));
  runtime.scheduler = { ...runtime.scheduler, max_active_workers: 2, batch_size: 3 };
  const runtimeFile = fx.write(path.join(fx.root, 'runtime.json'), runtime);
  const runtimeArgs = ['--runtime-config', runtimeFile];
  const legacy = seedBusinessRun('legacy-sequence');
  oldChain('legacy', legacy, runtimeArgs);
  const combined = seedBusinessRun('combined-command');
  const ready = prepare('combined-command', combined, runtimeArgs);
  const summary = JSON.parse(ready.stdout);
  fx.check('prepare emits bounded READY assignment metadata', summary.stage === 'prepare' && summary.status === 'READY'
    && summary.artifact === path.join(combined, 'assignments.json') && summary.counts.assigned === 4 && [...ready.stdout].length <= 2001
    && !ready.stdout.includes('Fictional Candidate') && !ready.stdout.includes('candidate_sources') && !ready.stdout.includes('rule_sources'), summary);
  const expected = projection(legacy), actual = projection(combined);
  fx.write(path.join(fx.root, 'equivalence.json'), { expected, actual });
  fx.check('new command preserves complete business projection of old sequence', JSON.stringify(actual) === JSON.stringify(expected));
  fx.check('fixture traverses canonical, location, exact and semantic gates', actual.counts.raw_source_jobs === 9
    && actual.counts.source_unique_count === 8 && actual.location.length === 8 && actual.location.filter(item => item.allowed).length === 6
    && actual.exact.filter(item => !item.duplicate).length === 5 && actual.assignment_keys.length === 4
    && actual.counts.location_excluded === 2 && actual.counts.location_ambiguous === 1 && actual.counts.history_duplicates === 1
    && actual.counts.semantic_aliases === 1 && actual.primary_urls[postingKey(officialUrl)] === officialUrl, actual.counts);
  fx.check('runtime reaches planner unchanged and JD-only/PERM-off contract remains', JSON.stringify(actual.runtime) === JSON.stringify(runtime)
    && actual.research_version === 0 && !parse(path.join(combined, 'baseline.json')).perm_history);
  absent('prepare performs no cleanup, usage, scoring or commit', combined,
    ['maintenance', 'usage-context.json', 'results', 'scores.json', 'rendered-reports.json', 'receipt.json']);
  fx.run('combined-final-contract', script('run-contract.mjs'), ['--run', combined]);

  const malformed = fresh('malformed-cli');
  for (const [label, args] of [
    ['missing-required', []], ['missing-career', ['--run', malformed]],
    ['missing-run-value', ['--run', '--career-ops', fx.codeRoot]],
    ['unknown', ['--run', malformed, '--career-ops', fx.codeRoot, '--unknown']],
    ['full-is-not-supported', ['--run', malformed, '--career-ops', fx.codeRoot, '--full']],
    ['duplicate', ['--run', malformed, '--career-ops', fx.codeRoot, '--run', malformed]],
    ['runtime-value-missing', ['--run', malformed, '--career-ops', fx.codeRoot, '--runtime-config']],
    ['override-value-missing', ['--run', malformed, '--career-ops', fx.codeRoot, '--allow-blacklisted']],
    ['empty-override', ['--run', malformed, '--career-ops', fx.codeRoot, '--allow-blacklisted', '']],
  ]) {
    const before = manifest(malformed);
    fx.run(`cli-${label}`, script('prepare-scan-evaluations.mjs'), args, { expect: 1 });
    fx.check(`cli-${label}: no mutation`, manifest(malformed) === before);
  }

  const badCombine = fresh('combine-count-failure');
  const badSummaryFile = path.join(badCombine, 'sources/jobspy/summary.json');
  const badSummary = parse(badSummaryFile); badSummary.markdown_jobs += 1; fx.write(badSummaryFile, badSummary);
  failure('combine failure', prepare('combine-count-failure', badCombine, [], 1), /counts do not reconcile/);
  absent('combine failure stops downstream stages', badCombine, ['acquisition.json', 'jobs', 'triage', 'assignments.json']);
  fx.check('combine failure preserves captured source evidence', existsSync(path.join(badCombine, 'sources/jobspy/jobs/88000001.md')));
  badSummary.markdown_jobs -= 1; fx.write(badSummaryFile, badSummary);
  prepare('combine-repair-rerun', badCombine);

  const badContract = fresh('contract-missing-audit');
  rmSync(path.join(badContract, 'sources/jobspy/excluded-employers.json'));
  failure('contract failure', prepare('contract-missing-audit', badContract, [], 1), /excluded-employers\.json is required/);
  fx.check('post-combine contract failure retains acquisition', existsSync(path.join(badContract, 'acquisition.json')));
  absent('post-combine contract failure stops resolution and planner', badContract, ['triage/canonical-url-resolutions.json', 'triage/location-scope.json', 'assignments.json']);

  const configDrift = fresh('frozen-config-drift');
  const baselineFile = path.join(configDrift, 'baseline.json');
  const baseline = parse(baselineFile);
  const definition = Object.values(baseline.adapter_profile.adapter_definitions).find(item => item.config);
  definition.config_content += '\n'; fx.write(baselineFile, baseline);
  const beforeConfigDrift = manifest(configDrift);
  failure('frozen source config drift', prepare('frozen-config-drift', configDrift, [], 1), /config changed after baseline capture/);
  fx.check('frozen config rejection preserves whole run', manifest(configDrift) === beforeConfigDrift);

  const resolverFailure = fresh('resolver-late-failure', jobs.slice(0, 2));
  fx.write(path.join(resolverFailure, 'triage'), 'Fictional regular file blocking the resolver ledger directory.\n');
  failure('resolver failure', prepare('resolver-late-failure', resolverFailure, [], 1), /EEXIST|ENOTDIR/);
  fx.check('resolver failure retains canonical-enriched acquisition and original sources', parse(path.join(resolverFailure, 'acquisition.json')).acquired.length === 1
    && parse(path.join(resolverFailure, 'acquisition.json')).keys[0] === postingKey(officialUrl)
    && readdirSync(path.join(resolverFailure, 'sources/jobspy/jobs')).length === 2);
  absent('resolver failure stops planner', resolverFailure, ['assignments.json']);
  rmSync(path.join(resolverFailure, 'triage'));
  prepare('resolver-repaired-rerun', resolverFailure);

  const cvFile = path.join(fx.dataRoot, 'cv.md');
  const cv = readFileSync(cvFile, 'utf8');
  const missingCandidate = fresh('planner-missing-candidate');
  rmSync(cvFile);
  try { failure('missing candidate', prepare('planner-missing-candidate', missingCandidate, [], 1), /approved candidate source missing/); }
  finally { fx.write(cvFile, cv); }
  fx.check('planner failure preserves resolution evidence', existsSync(ledgerFile(missingCandidate)));
  absent('missing candidate never creates assignments', missingCandidate, ['assignments.json']);
  const beforeLedgerGuard = manifest(missingCandidate);
  failure('whole command cannot silently replay resolver', prepare('planner-retry-needs-diagnostic-command', missingCandidate, [], 1), /resolution ledger exists/);
  fx.check('ledger preflight preserves all existing work', manifest(missingCandidate) === beforeLedgerGuard);
  plan('standalone-planner-recovers-missing-candidate', missingCandidate);

  const invalidRuntime = fresh('planner-invalid-runtime');
  const invalidRuntimeFile = fx.write(path.join(fx.root, 'runtime-invalid.json'), { ...runtime, scheduler: { ...runtime.scheduler, max_active_workers: 0 } });
  failure('invalid runtime', prepare('planner-invalid-runtime', invalidRuntime, ['--runtime-config', invalidRuntimeFile], 1), /max_active_workers must be a positive integer/);
  fx.check('invalid-runtime planner failure retains resolution', existsSync(ledgerFile(invalidRuntime)));
  absent('invalid runtime never creates assignments', invalidRuntime, ['assignments.json']);
  plan('standalone-planner-recovers-runtime', invalidRuntime, runtimeArgs);

  const locationDrift = fresh('planner-location-drift');
  const profileFile = path.join(fx.dataRoot, 'config/profile.yml');
  const profile = readFileSync(profileFile, 'utf8');
  fx.write(profileFile, profile.replace('"local_metros":["Seattle"]', '"local_metros":["Bellevue"]'));
  try { failure('location policy drift', prepare('planner-location-drift', locationDrift, [], 1), /location policy changed after baseline capture/); }
  finally { fx.write(profileFile, profile); }
  fx.check('location drift preserves canonical resolution', existsSync(ledgerFile(locationDrift)));
  absent('location drift prevents assignments', locationDrift, ['assignments.json']);
  plan('standalone-planner-recovers-location-policy', locationDrift);

  const forceRun = fresh('force-ledger-recovery', jobs.slice(0, 2));
  fx.run('force-fixture-combine', script('combine.mjs'), ['--run', forceRun]);
  fx.run('force-fixture-resolve', script('resolve-canonical-urls.mjs'), ['--run', forceRun]);
  const originalLedger = readFileSync(ledgerFile(forceRun), 'utf8');
  const beforeForce = manifest(forceRun);
  failure('ledger guard', prepare('existing-ledger-without-force', forceRun, [], 1), /resolution ledger exists/);
  fx.check('existing ledger guard runs before destructive combine', manifest(forceRun) === beforeForce);
  prepare('explicit-force-recovery', forceRun, ['--force']);
  const archives = readdirSync(path.join(forceRun, 'triage')).filter(name => name.startsWith('canonical-url-resolutions.json.superseded-'));
  fx.check('force preserves old resolution ledger as exact archive', archives.length === 1
    && readFileSync(path.join(forceRun, 'triage', archives[0]), 'utf8') === originalLedger && existsSync(path.join(forceRun, 'assignments.json')));

  for (const [artifact, prepared] of [['assignments.json', true], ['rendered-reports.json', false], ['receipt.json', false]]) {
    const protectedRun = prepared ? combined : fresh(`guard-${artifact.replace('.json', '')}`);
    if (!prepared) fx.write(path.join(protectedRun, artifact), { synthetic: true });
    for (const force of [false, true]) {
      const before = manifest(protectedRun);
      prepare(`guard-${artifact}-${force ? 'force' : 'normal'}`, protectedRun, force ? ['--force'] : [], 1);
      fx.check(`${artifact}: ${force ? 'force' : 'normal'} preserves whole run`, manifest(protectedRun) === before);
    }
  }

  const lockedRunBefore = manifest(combined);
  for (const [label, file] of [['candidate', cvFile], ['rule', path.join(fx.dataRoot, 'modes/_custom.md')]]) {
    const original = readFileSync(file, 'utf8');
    fx.write(file, `${original}\nFictional drift after assignment lock.\n`);
    try { failure(`${label} drift`, plan(`standalone-reject-${label}-drift`, combined, runtimeArgs, 1), new RegExp(`approved ${label} source content changed`)); }
    finally { fx.write(file, original); }
    fx.check(`${label} drift leaves locked run unchanged`, manifest(combined) === lockedRunBefore);
  }
  const changedRuntimeFile = fx.write(path.join(fx.root, 'runtime-changed.json'), { ...runtime, scheduler: { ...runtime.scheduler, batch_size: 4 } });
  failure('runtime drift', plan('standalone-reject-runtime-drift', combined, ['--runtime-config', changedRuntimeFile], 1), /runtime does not match/);
  fx.check('runtime drift leaves locked run unchanged', manifest(combined) === lockedRunBefore);
  const assignmentBytes = readFileSync(path.join(combined, 'assignments.json'), 'utf8');
  plan('standalone-planner-valid-resume', combined, runtimeArgs);
  fx.check('standalone valid resume preserves assignments byte-for-byte', readFileSync(path.join(combined, 'assignments.json'), 'utf8') === assignmentBytes);

  const blacklistFile = path.join(fx.dataRoot, 'data/blacklist.md');
  const blacklistBefore = existsSync(blacklistFile) ? readFileSync(blacklistFile, 'utf8') : null;
  fx.write(blacklistFile, '# Blacklist\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Blocked Prepare Co | 2026-10-03 | company | Fictional hold |\n');
  try {
    const override = fresh('legal-exact-override', [{ id: '92000020', company: 'Blocked Prepare Co' }, { id: '92000021', company: 'Blocked Prepare Co' }]);
    prepare('forward-exact-blacklist-exception', override, [...runtimeArgs, '--allow-blacklisted', key('92000020')]);
    const output = parse(path.join(override, 'assignments.json'));
    const audit = parse(path.join(override, 'triage/blacklist.json'));
    fx.check('exact blacklist override cannot release another posting', JSON.stringify(Object.values(output.assignments).flat()) === JSON.stringify([key('92000020')])
      && JSON.stringify(output.blacklist_overrides) === JSON.stringify([key('92000020')])
      && audit.results.find(item => item.posting_key === key('92000021')).disposition === 'BLACKLIST_HOLD');
    const badOverride = fresh('illegal-unmatched-override');
    failure('unmatched override', prepare('reject-unmatched-blacklist-exception', badOverride, ['--allow-blacklisted', key('92000999')], 1), /override|allow-blacklisted/i);
    absent('unmatched override creates no assignments', badOverride, ['assignments.json']);
  } finally { if (blacklistBefore === null) rmSync(blacklistFile); else fx.write(blacklistFile, blacklistBefore); }
  fx.check('preparation and rejected requests leave Career-Ops candidate/tracker/report state unchanged', manifest(fx.dataRoot) === careerBefore);
  console.log(JSON.stringify(fx.finish({ scope: 'Real prepare and diagnostic CLI workflows; all run and candidate data synthetic and isolated. No source collection, retention, model call or commit.', equivalent_assignment_keys: actual.assignment_keys }), null, 2));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
