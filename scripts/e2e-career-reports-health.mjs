#!/usr/bin/env node
// Failure inventory: test/career-ops-integration-e2e.plan.json, recorded before
// implementation. These scenarios exercise complete CLIs and the real installed
// upstream verifier/lock; no test doubles replace Career-Ops interfaces.
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCareerFixture, DISCOVERY_ROOT, EMPTY_TRACKER, sha256 } from './e2e-career-fixture.mjs';
import { renderCompactReport, readMachineSummary } from '../src/scan-report-contract.mjs';

function manifest(root) {
  if (!existsSync(root)) return [];
  const visit = file => {
    const stat = lstatSync(file);
    const entry = { path: path.relative(root, file), mtime: stat.mtimeMs, mode: stat.mode };
    if (stat.isSymbolicLink()) return [{ ...entry, kind: 'symlink', target: readlinkSync(file) }];
    if (stat.isDirectory()) return [{ ...entry, kind: 'directory' }, ...readdirSync(file).sort().flatMap(name => visit(path.join(file, name)))];
    return [{ ...entry, kind: 'file', sha256: sha256(readFileSync(file)) }];
  };
  return visit(root);
}

function compact(legacy = false, fixedTerm = null) {
  const report = {
    archetype: 'Backend Engineer', reason: 'Backend scope matches the supplied candidate experience.',
    evidence: [{ source: 'jd', quote: 'Build backend services.', explanation: 'Backend service ownership is relevant.' }],
    gaps: [{ quote: 'Public-cloud operations.', locator: 'cv.md/Experience', explanation: 'Confirm production cloud scope.' }],
    risk_level: 'Low', confidence: legacy === true ? 'High' : 'Low', advertised_comp: null, company_confidential_evidence: null,
    risk_summary: { classification: 'clear', culture: 'not_evaluated', interview_redflags: 'not_evaluated', ai_infra: 'consistent' },
  };
  if (legacy !== true) {
    report.score_evidence = Object.fromEntries(['cv_match', 'north_star', 'compensation', 'culture', 'red_flags'].map(key => [key,
      ['compensation', 'culture'].includes(key)
        ? { status: 'unknown', source: null, observation: `${key} is not specified.`, question: `Confirm ${key}.` }
        : { status: 'supported', source: 'JD: Build backend services.', observation: 'Relevant backend scope.', question: null }]));
    report.confidence_gaps = ['Confirm compensation and culture.'];
  }
  if (legacy === false) Object.assign(report, { discard_reasons: [], fixed_term_evidence: fixedTerm });
  return renderCompactReport({ runId: 'fixture-run',
    record: { primary_key: 'greenhouse:acme:100', primary_url: 'https://boards.greenhouse.io/acme/jobs/100', company: 'Acme', title: 'Backend Engineer', sources: ['jobspy'] },
    result: { posting_key: 'greenhouse:acme:100', score: 4.2, report_decision: 'Apply', legitimacy_tier: 'High Confidence',
      work_authorization: { value: 'unstated', label: '⚠️ Unstated', quote: null }, report } });
}

function full(body, preserveFixedTerm = true) {
  const machine = body.slice(0, body.indexOf('\n\n## Verdict'));
  const term = preserveFixedTerm ? body.split('\n').find(line => line.startsWith('Fixed-term contract: ') || line === 'No fixed term disclosed in the supplied JD.') : null;
  return [machine, '## A) Role Summary\nBuild backend services.', '## B) Match with CV\nRelevant backend scope.',
    '## C) Level and Strategy\nConfirm production cloud scope.', '## D) Comp and Demand\nCompensation is not specified.',
    '## E) Customization Plan\nUse only supplied candidate facts.', '## F) Interview Plan\nDiscuss service ownership.',
    '## G) Posting Legitimacy\nHigh Confidence.', '## Risk Summary\nLow risk; compensation and culture remain open.' + (term ? '\n' + term : ''),
    '## Keywords extracted\nbackend, services'].join('\n\n');
}

export function runReportsHealthE2E({ outRoot, sourceRoot } = {}) {
  const fx = createCareerFixture({ name: 'reports-health', outRoot, sourceRoot });
  const expansion = path.join(DISCOVERY_ROOT, 'src/expand-scan-report.mjs');
  const health = path.join(DISCOVERY_ROOT, 'src/career-ops-health.mjs');
  const discovery = path.join(fx.root, 'discovery');
  const reports = path.join(fx.dataRoot, 'reports');
  const reportFile = path.join(reports, '007-acme-2026-10-03.md');
  const draft = path.join(fx.root, 'expanded-draft.md');
  const body = compact();
  const original = `# Evaluation: Acme — Backend Engineer\n\n**Report Number:** 007  \n**Score:** 4.2/5  \n**URL:** https://boards.greenhouse.io/acme/jobs/100  \n**Posting Key:** greenhouse:acme:100  \n\n---\n\n${body}\n`;
  fx.write(reportFile, original);
  fx.write(path.join(discovery, 'runs/fixture-run/jobs/greenhouse-acme-100.md'), '# Acme — Backend Engineer\nBuild backend services.\nPublic-cloud operations.\n18-month contract\n');
  const prepareArgs = ['prepare', '7', '--career-ops', fx.codeRoot, '--discovery', discovery];
  const prepared = JSON.parse(fx.run('expansion-prepare', expansion, prepareArgs).stdout);
  fx.check('prepare digest binds source bytes', prepared.source_sha256 === sha256(original));
  fx.check('prepare uses private candidate data', prepared.candidate_sources.every(file => file.startsWith(fx.dataRoot + path.sep)));
  const commitArgs = ['commit', '7', draft, '--career-ops', fx.codeRoot, '--discovery', discovery, '--source-sha256', prepared.source_sha256];
  const mutations = [
    ['wrong-score', value => value.replace('score: 4.2', 'score: 1.1')],
    ...['run_id', 'posting_key', 'posting_url', 'company', 'role', 'work_auth', 'via'].map(field => [field, value => value.replace(new RegExp(`^${field}: .+$`, 'm'), `${field}: "wrong"`)]),
    ['lost-gaps', value => value.replace(/^soft_gaps: .+$/m, 'soft_gaps: []')],
    ['lost-evidence', value => value.replace(/^top_strengths: .+$/m, 'top_strengths: []')],
    ['wrong-confidence', value => value.replace('confidence: "Low"', 'confidence: "High"')],
    ['missing-field', value => value.replace(/^work_auth: .+\n/m, '')],
    ['duplicate-field', value => value.replace('score: 4.2', 'score: 4.2\nscore: 4.2')],
    ['malformed-yaml', value => value.replace('score: 4.2', 'score: nope')],
    ['duplicate-summary', value => `${value}\n\n## Machine Summary\n\n\`\`\`yaml\nscore: 1.1\n\`\`\``],
    ['unsupported-field', value => value.replace('score: 4.2', 'score: 4.2\nother: true')],
    ['embedded-report-header', value => `# Evaluation: Another Company — Different Role\n\n${value}`],
  ];
  for (const [name, mutate] of mutations) {
    fx.write(draft, mutate(full(body)));
    const before = manifest(reports);
    fx.run(`expansion-reject-${name}`, expansion, commitArgs, { expect: 1 });
    fx.check(`${name}: rejected before report-tree writes`, JSON.stringify(manifest(reports)) === JSON.stringify(before));
  }
  fx.write(draft, full(body));
  fx.run('expansion-reject-no-digest', expansion, commitArgs.slice(0, -2), { expect: 1 });
  fx.write(reportFile, original + '\n');
  let before = manifest(reports);
  fx.run('expansion-reject-source-drift', expansion, commitArgs, { expect: 1 });
  fx.check('stale prepare leaves edited report untouched', JSON.stringify(manifest(reports)) === JSON.stringify(before));
  fx.write(reportFile, original.replace('run_id: "fixture-run"', 'run_id: "../outside"'));
  before = manifest(reports);
  fx.run('expansion-reject-run-traversal', expansion, prepareArgs, { expect: 1 });
  fx.check('run traversal leaves report untouched', JSON.stringify(manifest(reports)) === JSON.stringify(before));
  fx.write(reportFile, original);
  const outsideReport = fx.write(path.join(fx.root, 'outside-report.md'), original);
  rmSync(reportFile); symlinkSync(outsideReport, reportFile);
  const escapedBefore = { reports: manifest(reports), outside: manifest(outsideReport) };
  fx.run('expansion-reject-report-symlink-traversal', expansion, prepareArgs, { expect: 1 });
  fx.run('expansion-reject-symlink-commit', expansion, commitArgs, { expect: 1 });
  fx.check('report symlink traversal preserves both trees', JSON.stringify({ reports: manifest(reports), outside: manifest(outsideReport) }) === JSON.stringify(escapedBefore));
  rmSync(reportFile); fx.write(reportFile, original);
  for (const [name, malformed] of [
    ['header-company', original.replace('# Evaluation: Acme', '# Evaluation: Other')],
    ['header-score', original.replace('**Score:** 4.2/5', '**Score:** 1.1/5')],
    ['header-authorization', original.replace('**Score:**', '**Work Auth:** ✅ Sponsors  \n**Score:**')],
  ]) {
    fx.write(reportFile, malformed);
    const baseline = manifest(reports);
    fx.run(`expansion-reject-${name}`, expansion, prepareArgs, { expect: 1 });
    fx.check(`${name}: original report unchanged`, JSON.stringify(manifest(reports)) === JSON.stringify(baseline));
  }
  fx.write(reportFile, original);
  const backup = path.join(reports, '.expansion-backups/007-acme-2026-10-03.md.compact.md');
  fx.write(backup, 'Existing backup must survive.\n');
  before = manifest(reports);
  fx.run('expansion-reject-existing-backup', expansion, commitArgs, { expect: 1 });
  fx.check('existing backup preserved', JSON.stringify(manifest(reports)) === JSON.stringify(before));
  rmSync(path.dirname(backup), { recursive: true });
  const committed = JSON.parse(fx.run('expansion-commit', expansion, commitArgs).stdout);
  fx.check('compact backup is byte-identical', readFileSync(committed.compact_backup, 'utf8') === original);
  const expanded = readFileSync(reportFile, 'utf8');
  fx.check('expanded report retains the full summary', JSON.stringify(readMachineSummary(expanded)) === JSON.stringify(prepared.machine_summary));
  fx.check('expanded report preserves source authorization and gaps', expanded.includes('### Work Authorization\n\n⚠️ Unstated') && expanded.includes('Confirm production cloud scope.'));
  fx.check('expanded output digest reproducible', committed.expanded_sha256 === sha256(expanded));

  // Historical v4 contracts remain expandable, without fabricating evidence fields.
  const legacyBody = compact(true), legacyFile = path.join(reports, '008-acme-2026-10-03.md');
  const legacyOriginal = original.replace('**Report Number:** 007', '**Report Number:** 008').replace(body, legacyBody);
  fx.write(legacyFile, legacyOriginal); fx.write(draft, full(legacyBody));
  const legacy = JSON.parse(fx.run('legacy-prepare', expansion, ['prepare', '8', '--career-ops', fx.codeRoot, '--discovery', discovery]).stdout);
  const legacyCommit = JSON.parse(fx.run('legacy-commit', expansion, ['commit', '8', draft, '--career-ops', fx.codeRoot, '--discovery', discovery, '--source-sha256', legacy.source_sha256]).stdout);
  fx.check('legacy backup exact and no fabricated score evidence', readFileSync(legacyCommit.compact_backup, 'utf8') === legacyOriginal && !readMachineSummary(readFileSync(legacyFile, 'utf8')).score_evidence);

  const v5Body = compact(5), v5File = path.join(reports, '010-acme-2026-10-03.md');
  const v5Original = original.replace('**Report Number:** 007', '**Report Number:** 010').replace(body, v5Body);
  fx.write(v5File, v5Original); fx.write(draft, full(v5Body));
  const v5Prepare = JSON.parse(fx.run('v5-prepare', expansion, ['prepare', '10', '--career-ops', fx.codeRoot, '--discovery', discovery]).stdout);
  const v5Commit = JSON.parse(fx.run('v5-commit', expansion, ['commit', '10', draft, '--career-ops', fx.codeRoot, '--discovery', discovery, '--source-sha256', v5Prepare.source_sha256]).stdout);
  fx.check('v5 expansion preserves original summary without backfilling v6', readFileSync(v5Commit.compact_backup, 'utf8') === v5Original && !readMachineSummary(readFileSync(v5File, 'utf8')).result_schema_version);
  const finiteBody = compact(false, '18-month contract'), finiteFile = path.join(reports, '011-acme-2026-10-03.md');
  const finiteOriginal = original.replace('**Report Number:** 007', '**Report Number:** 011').replace(body, finiteBody);
  fx.write(finiteFile, finiteOriginal);
  const finitePrepare = JSON.parse(fx.run('finite-prepare', expansion, ['prepare', '11', '--career-ops', fx.codeRoot, '--discovery', discovery]).stdout);
  const finiteArgs = ['commit', '11', draft, '--career-ops', fx.codeRoot, '--discovery', discovery, '--source-sha256', finitePrepare.source_sha256];
  for (const [label, line] of [['missing', ''], ['changed', 'Fixed-term contract: "12-month contract"'], ['added', 'Fixed-term contract: "18-month contract"\nFixed-term contract: "12-month contract"']]) {
    fx.write(draft, full(finiteBody, false) + '\n' + line + '\n');
    const beforeFinite = manifest(reports);
    fx.run(`finite-reject-${label}-quote`, expansion, finiteArgs, { expect: 1 });
    fx.check(`${label} finite-term draft leaves report tree unchanged`, JSON.stringify(manifest(reports)) === JSON.stringify(beforeFinite));
  }
  fx.write(draft, full(finiteBody));
  fx.run('finite-expansion-preserves-quote', expansion, finiteArgs);
  fx.check('finite-term original quote survives expansion', readFileSync(finiteFile, 'utf8').includes('Fixed-term contract: "18-month contract"'));

  const linkedData = path.join(fx.root, 'linked-reports-data');
  fx.write(path.join(linkedData, 'cv.md'), 'Fictional candidate.\n');
  symlinkSync(reports, path.join(linkedData, 'reports'));
  const linkedOriginal = original.replace('**Report Number:** 007', '**Report Number:** 009');
  fx.write(path.join(reports, '009-acme-2026-10-03.md'), linkedOriginal); fx.write(draft, full(body));
  const linkedEnv = { CAREER_OPS_ROOT: linkedData };
  const linkedPrepare = JSON.parse(fx.run('expansion-symlinked-reports-root-prepare', expansion, ['prepare', '9', '--career-ops', fx.codeRoot, '--discovery', discovery], { env: linkedEnv }).stdout);
  const linkedCommit = JSON.parse(fx.run('expansion-symlinked-reports-root-commit', expansion,
    ['commit', linkedPrepare.report, draft, '--career-ops', fx.codeRoot, '--discovery', discovery, '--source-sha256', linkedPrepare.source_sha256], { env: linkedEnv }).stdout);
  fx.check('configured reports directory symlink remains supported', readFileSync(linkedCommit.compact_backup, 'utf8') === linkedOriginal);

  // Read-only health exercises real stale-reservation GC, alternate roots,
  // exact identity resolution, and linked interview state in one complete call.
  const external = path.join(fx.root, 'external');
  const healthReports = path.join(external, 'reports');
  const tracker = path.join(external, 'ledger/applications.md');
  const rows = [100, 200].map((id, index) => {
    const name = `${index + 1}-acme-2026-10-03.md`;
    fx.write(path.join(healthReports, name), `# Evaluation: Acme — Engineer\n**URL:** https://boards.greenhouse.io/acme/jobs/${id}\n**Posting Key:** greenhouse:acme:${id}\n\n## Job Description\n\nThis fictional permanent full-time role builds reliable backend services, tests distributed APIs, monitors deployments and documents production operations. The engineer works with peers to improve service reliability and delivery.\n`);
    return `| ${index + 1} | Acme | Engineer | Remote | N/A | 4.2/5 | Applied | 2026-10-03 | ❌ | [${index + 1}](../reports/${name}) | LinkedIn | — | — |`;
  });
  fx.write(tracker, EMPTY_TRACKER + rows.join('\n') + '\n');
  const stale = fx.write(path.join(healthReports, '099-RESERVED.md'), 'reserved\n');
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000); utimesSync(stale, old, old);
  const interviews = fx.write(path.join(external, 'interviews.md'), '# Active Interviews\n\n| Company | Role | Round | Date/Time | Interviewer | Status | Notes |\n|---|---|---|---|---|---|---|\n| Acme | Engineer | Call | 2026-10-03 | Recruiter | Rejected | #1 in tracker |\n');
  symlinkSync(interviews, path.join(fx.dataRoot, 'data/active-interviews.md'));
  const healthEnv = { CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: healthReports };
  const protectedBefore = { code: manifest(fx.codeRoot), data: manifest(fx.dataRoot), external: manifest(external) };
  fx.write(path.join(fx.root, 'health-source-before.json'), protectedBefore);
  const check = JSON.parse(fx.run('health-isolated-audit', health, ['--career-ops', fx.codeRoot], { env: healthEnv, expect: 1 }).stdout);
  fx.check('stale reservation warning remains visible', check.unresolved?.some(message => message.includes('stale reservation sentinel')));
  fx.check('linked interview mismatch remains visible', check.unresolved?.some(message => message.includes('Sync drift')));
  fx.check('exact distinct posting warning is resolved with evidence', check.resolved?.some(item => item.reason === 'distinct_recorded_posting_identities' && item.members.length === 2));
  const protectedAfter = { code: manifest(fx.codeRoot), data: manifest(fx.dataRoot), external: manifest(external) };
  fx.write(path.join(fx.root, 'health-source-after.json'), protectedAfter);
  fx.check('health preserves bytes mtimes tree and symlink targets', JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore));
  fx.check('health preserves original stale reservation', existsSync(stale));
  fx.check('audit explicitly identifies snapshot-only cleanup', check.isolation?.reservation_cleanup.includes('snapshot_only'));
  // Clear only fictional blocking conditions and prove a genuine healthy result.
  rmSync(stale); fx.write(interviews, '# Active Interviews\n');
  const clean = JSON.parse(fx.run('health-clean-distinct-postings', health, ['--career-ops', fx.codeRoot], { env: healthEnv }).stdout);
  fx.check('healthy only after blocking fixture findings resolved', clean.errors === 0 && clean.warnings === 0 && clean.raw_warnings === 1);
  const relativeHealthEnv = { CAREER_OPS_TRACKER: path.relative(fx.codeRoot, tracker), CAREER_OPS_REPORTS: path.relative(fx.dataRoot, healthReports) };
  const relative = JSON.parse(fx.run('health-relative-overrides', health, ['--career-ops', fx.codeRoot], { env: relativeHealthEnv }).stdout);
  fx.check('relative tracker and reports overrides use canonical roots', relative.errors === 0 && relative.warnings === 0 && relative.raw_warnings === 1);
  fx.write(path.join(healthReports, '2-acme-2026-10-03.md'), readFileSync(path.join(healthReports, '1-acme-2026-10-03.md'), 'utf8'));
  const archivedFile = path.join(healthReports, '1-acme-2026-10-03.md');
  const archivedText = readFileSync(archivedFile, 'utf8');
  fx.write(archivedFile, archivedText.split('\n\n## Job Description')[0]);
  const missingArchive = JSON.parse(fx.run('health-missing-archive-stays-blocked', health, ['--career-ops', fx.codeRoot], { env: healthEnv, expect: 1 }).stdout);
  fx.check('missing JD archive warning remains blocking', missingArchive.unresolved.some(message => message.includes('no jds/ capture')));
  fx.write(archivedFile, archivedText);
  const duplicate = JSON.parse(fx.run('health-same-posting-stays-blocked', health, ['--career-ops', fx.codeRoot], { env: healthEnv, expect: 1 }).stdout);
  fx.check('same posting warnings remain unresolved', duplicate.unresolved?.some(message => message.startsWith('Possible duplicates:'))
    && duplicate.unresolved?.some(message => message.startsWith('Duplicate reports for same company+role:')));
  const absentData = path.join(fx.root, 'fresh-data-root');
  const fresh = JSON.parse(fx.run('health-fresh-setup-no-source-directories', health, ['--career-ops', fx.codeRoot],
    { env: { CAREER_OPS_ROOT: absentData }, expect: 1 }).stdout);
  fx.check('fresh setup cannot create original data or reports directories', !existsSync(absentData) && fresh.errors > 0);
  const missing = path.join(fx.root, 'missing-code'); fx.write(path.join(missing, '.career-ops-data'), fx.dataRoot);
  const missingResult = JSON.parse(fx.run('health-missing-interface', health, ['--career-ops', missing], { expect: 1 }).stdout);
  fx.check('missing official interface fails closed', missingResult.errors > 0 && /interface missing/.test(missingResult.error));
  return fx.finish({ rerun: 'node scripts/e2e-career-reports-health.mjs', failure_plan: 'test/career-ops-integration-e2e.plan.json' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--out');
  console.log(JSON.stringify(runReportsHealthE2E({ outRoot: index >= 0 ? process.argv[index + 1] : undefined }), null, 2));
}
