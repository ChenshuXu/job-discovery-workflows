import { renderCompactReport, readCompactReportSummary } from '../src/scan-report-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadDailyScanRuntime, workerIdsForRuntime } from '../src/daily-scan-runtime.mjs';
import { failWorkerResult, mergeWorkerResults, validateWorkerParts } from '../src/merge-worker-results.mjs';
import { loadScanResults } from '../src/scan-results.mjs';

function fixture() {
  const run = mkdtempSync(path.join(os.tmpdir(), 'worker-parts-'));
  mkdirSync(path.join(run, 'results'));
  const runtime = loadDailyScanRuntime();
  runtime.scheduler = { ...runtime.scheduler, batch_size: 2, max_active_workers: 2 };
  const assignments = {
    schema_version: 1,
    result_schema_version: 4,
    run_id: 'test-run',
    runtime,
    location_policy: { local_metros: ['Seattle', 'Bellevue', 'Redmond', 'Kirkland', 'Bothell', 'Renton', 'Issaquah', 'SeaTac', 'Tacoma', 'Everett'] },
    assignments: Object.fromEntries(workerIdsForRuntime(runtime).map(worker => [worker, worker === 'worker-1' ? ['a:1', 'b:2', 'c:3'] : []])),
    primary_urls: { 'a:1': 'https://jobs.example/a', 'b:2': 'https://jobs.example/b', 'c:3': 'https://jobs.example/c' },
  };
  const candidateRoot = path.join(run, 'candidate');
  const candidates = {
    'cv.md': '# CV\nMaster of Science in Computer Science\n',
    'config/profile.yml': 'visa_status: "H-1B"\nneeds_sponsorship: true\n',
    'modes/_profile.md': '# Profile\n',
  };
  assignments.candidate_sources = Object.entries(candidates).map(([label, content]) => {
    const file = path.join(candidateRoot, label);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return { label, path: file, sha256: createHash('sha256').update(content).digest('hex') };
  });
  assignments.career_ops_root = candidateRoot;
  assignments.semantic_identities = Object.fromEntries(['a:1', 'b:2', 'c:3'].map(key => [key, {
    semantic_job_key: `semantic:${key}`, posting_context_key: `context:${key}`,
  }]));
  const acquired = ['a:1', 'b:2', 'c:3'].map(key => ({
    primary_key: key, company: 'Example', title: 'Backend Engineer', sources: ['jobspy'],
    primary_url: assignments.primary_urls[key],
    jd_path: `jobs/${key.replace(':', '-')}.md`,
    location_scope: { allowed: true, decision: 'ALLOW_LOCAL' },
    ...assignments.semantic_identities[key],
  }));
  mkdirSync(path.join(run, 'jobs'));
  for (const record of acquired) writeFileSync(path.join(run, record.jd_path), '**Role:** Senior Backend Engineer\n**Employment Type:** Full-time\n\n## Job Description\n\nBuild backend systems.');
  writeFileSync(path.join(run, 'acquisition.json'), JSON.stringify({ acquired }));
  const result = posting_key => rawResult(posting_key);
  writeFileSync(path.join(run, 'assignments.json'), JSON.stringify(assignments));
  writeFileSync(path.join(run, 'results/worker-1.part-1.json'), JSON.stringify({ result_schema_version: 4, worker: 'worker-1', part: 1, results: [result('a:1'), result('b:2')] }));
  writeFileSync(path.join(run, 'results/worker-1.part-2.json'), JSON.stringify({ result_schema_version: 4, worker: 'worker-1', part: 2, results: [result('c:3')] }));
  return run;
}

function rawResult(posting_key, overrides = {}) {
  return {
    posting_key, work_authorization: { value: 'unstated', quote: null }, fit_score: 3.5, level_signal: 'target', level_evidence: 'JD: "**Role:** Senior Backend Engineer"',
    eligibility_status: 'eligible', eligibility_category: null, eligibility_evidence: null,
    legitimacy_tier: 'High Confidence', rationale: 'Material baseline gap keeps this below the report threshold.', report: null,
    ...overrides,
  };
}

function structuredReport(overrides = {}) {
  return {
    archetype: 'Backend platform', reason: 'Direct backend alignment.',
    evidence: [{ source: 'jd', quote: 'Build backend systems', explanation: 'Relevant backend scope.' }],
    gaps: [], risk_level: 'Low', confidence: 'High',
    risk_summary: { classification: 'clear', culture: 'not_evaluated', interview_redflags: 'not_evaluated', ai_infra: 'consistent' },
    advertised_comp: null, company_confidential_evidence: null,
    ...overrides,
  };
}

function candidate(run, report = structuredReport(), overrides = {}) {
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0] = rawResult('a:1', { fit_score: 4.1, rationale: null, report, ...overrides });
  writeFileSync(file, JSON.stringify(part));
}

function rendered(run) {
  const result = mergeWorkerResults(run, 'worker-1').output.results[0];
  const record = JSON.parse(readFileSync(path.join(run, 'acquisition.json'))).acquired[0];
  const markdown = renderCompactReport({ result, record, runId: 'test-run' });
  return { result, markdown, summary: readCompactReportSummary(markdown) };
}

function validatePartFromCli(run, part = 1) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../src/merge-worker-results.mjs', import.meta.url)),
    '--run', run, '--worker', 'worker-1', '--validate-through-part', String(part)], { encoding: 'utf8' });
}

const validationEvidenceFile = run => path.join(run, 'results/worker-1.validation-evidence.json');

test('terminalization preserves the exact rejected payload and changes only the failed key', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const artifact = JSON.parse(readFileSync(file));
  artifact.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(artifact));
  assert.equal(validatePartFromCli(run).status, 1);
  const firstRejected = structuredClone(artifact.results[0]);
  artifact.results[0].level_evidence = 'JD: "Missing second evidence."';
  writeFileSync(file, JSON.stringify(artifact));
  assert.equal(validatePartFromCli(run).status, 1);
  const attempts = loadDailyScanRuntime().failure.per_job_retry_limit + 1;
  const failed = failWorkerResult(run, 'worker-1', 'a:1', attempts);
  assert.equal(failed.changed, true);
  assert.deepEqual(failed.result.rejected_result, artifact.results[0]);
  assert.deepEqual(failed.result.validation_evidence.attempts[0].rejected_result, firstRejected);
  assert.equal(failed.result.validation_evidence.attempts.length, attempts);
  assert.match(failed.result.error, /level_evidence is not an exact JD substring/);
  assert.deepEqual(JSON.parse(readFileSync(file)).results[1], artifact.results[1]);
  assert.equal(failWorkerResult(run, 'worker-1', 'a:1', attempts).changed, false);
  const merged = mergeWorkerResults(run, 'worker-1');
  assert.deepEqual(merged.output.results[0], failed.result);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'b:2', attempts), /already finalized/);
});

test('terminalization requires an observed changed rejected evaluation, not an asserted attempts count', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  const before = readFileSync(file, 'utf8');
  const attempts = loadDailyScanRuntime().failure.per_job_retry_limit + 1;
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts), /validation evidence|observed rejected/);
  assert.equal(existsSync(validationEvidenceFile(run)), false);
  assert.equal(validatePartFromCli(run).status, 1);
  const firstEvidence = readFileSync(validationEvidenceFile(run), 'utf8');
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts), /observed rejected/);
  assert.equal(validatePartFromCli(run).status, 1);
  assert.equal(readFileSync(validationEvidenceFile(run), 'utf8'), firstEvidence);
  part.results[0] = Object.fromEntries(Object.entries(part.results[0]).reverse());
  writeFileSync(file, JSON.stringify(part, null, 2));
  assert.equal(validatePartFromCli(run).status, 1);
  assert.equal(readFileSync(validationEvidenceFile(run), 'utf8'), firstEvidence);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts), /observed rejected/);
  assert.deepEqual(JSON.parse(readFileSync(file)), JSON.parse(before));
});

test('CLI records all affected keys independently while sibling writes do not consume another key retry', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  part.results[1].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  let evidence = JSON.parse(readFileSync(validationEvidenceFile(run)));
  assert.equal(evidence.failures['a:1'].attempts.length, 1);
  assert.equal(evidence.failures['b:2'].attempts.length, 1);
  part.results[1].level_evidence = 'JD: "Missing second evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  evidence = JSON.parse(readFileSync(validationEvidenceFile(run)));
  assert.equal(evidence.failures['a:1'].attempts.length, 1);
  assert.equal(evidence.failures['b:2'].attempts.length, 2);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 2), /observed rejected/);
  assert.equal(failWorkerResult(run, 'worker-1', 'b:2', 2).changed, true);
});

test('a successful repair is validated and merged without waiting for a second rejected payload', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  const evidenceBefore = readFileSync(validationEvidenceFile(run), 'utf8');
  part.results[0].level_evidence = 'JD: "**Role:** Senior Backend Engineer"';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 0);
  assert.equal(readFileSync(validationEvidenceFile(run), 'utf8'), evidenceBefore);
  assert.equal(mergeWorkerResults(run, 'worker-1').output.results[0].level_signal, 'target');
});

test('library and finalized-run validation stay read-only and legacy FAILED artifacts remain valid', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validateWorkerParts(run, 'worker-1', { collectItemErrors: true }).itemErrors.length, 1);
  assert.equal(existsSync(validationEvidenceFile(run)), false);
  writeFileSync(path.join(run, 'receipt.json'), JSON.stringify({ status: 'COMPLETE' }));
  assert.equal(validatePartFromCli(run).status, 1);
  assert.equal(existsSync(validationEvidenceFile(run)), false);
  part.results[0] = { posting_key: 'a:1', status: 'FAILED', attempts: 2, error: 'historical failure', report: null };
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 0);
  assert.equal(existsSync(validationEvidenceFile(run)), false);
});

test('candidate-source and part-schema errors do not fabricate per-posting validation attempts', () => {
  const run = fixture();
  writeFileSync(path.join(run, 'candidate/cv.md'), 'changed candidate facts');
  assert.equal(validatePartFromCli(run).status, 1);
  assert.equal(existsSync(validationEvidenceFile(run)), false);
  const other = fixture();
  writeFileSync(path.join(other, 'results/worker-1.part-1.json'), '{}');
  assert.equal(validatePartFromCli(other).status, 1);
  assert.equal(existsSync(validationEvidenceFile(other)), false);
});

test('terminal evidence honors the frozen repair budget and requires the current rejected payload', () => {
  const run = fixture();
  const assignmentFile = path.join(run, 'assignments.json');
  const assignments = JSON.parse(readFileSync(assignmentFile));
  assignments.runtime.failure.per_job_retry_limit = 2;
  writeFileSync(assignmentFile, JSON.stringify(assignments));
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  part.results[0].level_evidence = 'JD: "Missing second evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 3), /observed rejected evaluations \(2\)/);
  part.results[0].level_evidence = 'JD: "Missing third evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  part.results[0].level_evidence = 'JD: "Missing second evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 3), /does not match validation evidence/);
  part.results[0].level_evidence = 'JD: "Missing third evidence."';
  writeFileSync(file, JSON.stringify(part));
  const failed = failWorkerResult(run, 'worker-1', 'a:1', 3);
  assert.equal(failed.result.validation_evidence.attempts.length, 3);
  assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1'));
});

test('tampered payload evidence and JD drift cannot establish retry exhaustion', () => {
  for (const tamper of ['payload', 'jd']) {
    const run = fixture();
    const file = path.join(run, 'results/worker-1.part-1.json');
    const part = JSON.parse(readFileSync(file));
    part.results[0].level_evidence = 'JD: "Missing initial evidence."';
    writeFileSync(file, JSON.stringify(part));
    assert.equal(validatePartFromCli(run).status, 1);
    part.results[0].level_evidence = 'JD: "Missing second evidence."';
    writeFileSync(file, JSON.stringify(part));
    assert.equal(validatePartFromCli(run).status, 1);
    if (tamper === 'payload') {
      const evidence = JSON.parse(readFileSync(validationEvidenceFile(run)));
      evidence.failures['a:1'].attempts[0].rejected_result.fit_score = 1;
      writeFileSync(validationEvidenceFile(run), JSON.stringify(evidence));
    } else {
      const jd = path.join(run, 'jobs/a-1.md');
      writeFileSync(jd, `${readFileSync(jd, 'utf8')}\nChanged source.`);
    }
    const before = readFileSync(file, 'utf8');
    assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 2), /validation evidence/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('terminal evidence must match canonical recorded failures, context, and JD', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0] = rawResult('a:1', { level_evidence: 'JD: "Missing initial evidence."' });
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  part.results[0].level_evidence = 'JD: "Missing second evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  const failed = failWorkerResult(run, 'worker-1', 'a:1', 2);
  assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1'));
  const finalizedPart = JSON.parse(readFileSync(file));
  finalizedPart.results[0].validation_evidence.validator_sha256 = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(finalizedPart));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /context or JD changed/);
  finalizedPart.results[0] = failed.result;
  writeFileSync(file, JSON.stringify(finalizedPart));
  const jd = path.join(run, 'jobs/a-1.md');
  const originalJd = readFileSync(jd);
  writeFileSync(jd, `${originalJd}\nChanged source.`);
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /context or JD changed/);
  writeFileSync(jd, originalJd);
  const evidence = JSON.parse(readFileSync(validationEvidenceFile(run)));
  evidence.failures['a:1'].attempts = evidence.failures['a:1'].attempts.slice(0, 1);
  writeFileSync(validationEvidenceFile(run), JSON.stringify(evidence));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /does not match recorded failures/);
  assert.deepEqual(JSON.parse(readFileSync(file)).results[0], failed.result);
});

test('unrecorded model failures remain compatible while a missing file cannot erase recorded evaluation evidence', () => {
  for (const observed of [false, true]) {
    const run = fixture();
    const file = path.join(run, 'results/worker-1.part-1.json');
    const part = JSON.parse(readFileSync(file));
    if (observed) {
      part.results[0].level_evidence = 'JD: "Missing initial evidence."';
      writeFileSync(file, JSON.stringify(part));
      assert.equal(validatePartFromCli(run).status, 1);
    }
    const jd = path.join(run, 'jobs/a-1.md');
    part.results[0] = { posting_key: 'a:1', status: 'FAILED', attempts: 2, error: 'model failed without an evaluation payload', report: null };
    writeFileSync(file, JSON.stringify(part));
    if (observed) assert.throws(() => validateWorkerParts(run, 'worker-1'), /FAILED requires observed validation evidence/);
    else assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1'));
    unlinkSync(jd);
    if (observed) assert.throws(() => validateWorkerParts(run, 'worker-1'), /FAILED requires observed validation evidence/);
    else assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1'));
  }
});

test('existing validation evidence prevents a hand-built legacy-shape bypass', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  part.results[0].level_evidence = 'JD: "Missing initial evidence."';
  writeFileSync(file, JSON.stringify(part));
  assert.equal(validatePartFromCli(run).status, 1);
  part.results[0] = { posting_key: 'a:1', status: 'FAILED', attempts: 2, error: 'unsupported attempts', report: null };
  writeFileSync(file, JSON.stringify(part));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /FAILED requires observed validation evidence/);
});

test('terminalization refuses valid, foreign, unexhausted, and system-level failures without writes', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const before = readFileSync(file, 'utf8');
  const attempts = loadDailyScanRuntime().failure.per_job_retry_limit + 1;
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts), /valid result cannot/);
  assert.throws(() => failWorkerResult(run, 'worker-2', 'a:1', attempts), /not assigned/);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts - 1), /retry budget/);
  writeFileSync(path.join(run, 'candidate/cv.md'), 'changed candidate facts');
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', attempts), /candidate source hash changed/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('FAILED provenance cannot refer to a different posting or nest another failure', () => {
  for (const rejected_result of [{ posting_key: 'b:2' }, { posting_key: 'a:1', status: 'FAILED' }, { posting_key: 'a:1', rejected_result: {} }]) {
    const run = fixture();
    const file = path.join(run, 'results/worker-1.part-1.json');
    const part = JSON.parse(readFileSync(file));
    part.results[0] = { posting_key: 'a:1', status: 'FAILED', attempts: loadDailyScanRuntime().failure.per_job_retry_limit + 1, error: 'validation failure', report: null, rejected_result };
    writeFileSync(file, JSON.stringify(part));
    assert.throws(() => validateWorkerParts(run, 'worker-1'), /invalid rejected_result provenance/);
    const before = readFileSync(file, 'utf8');
    assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', part.results[0].attempts), /cannot replace an invalid terminal failure/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('deterministic merger proves the ordered part union and writes one final file', () => {
  const run = fixture();
  const merged = mergeWorkerResults(run, 'worker-1');
  assert.equal(merged.part_count, 2);
  assert.deepEqual(merged.output.results.map(item => item.posting_key), ['a:1', 'b:2', 'c:3']);
  assert.deepEqual(JSON.parse(readFileSync(merged.file, 'utf8')), merged.output);
});

test('deterministic merger writes an empty final file for an empty assignment', () => {
  const run = fixture();
  const merged = mergeWorkerResults(run, 'worker-2');
  assert.equal(merged.part_count, 0);
  assert.deepEqual(merged.output.results, []);
});

test('result loader reads exactly the worker IDs snapshotted in assignment runtime', () => {
  const run = fixture();
  mergeWorkerResults(run, 'worker-1');
  mergeWorkerResults(run, 'worker-2');
  const loaded = loadScanResults(run);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual([...loaded.byKey.keys()], ['a:1', 'b:2', 'c:3']);
  assert.throws(() => mergeWorkerResults(run, 'worker-3'), /invalid worker id/);
});

test('result loader reports every item error before checking the final union', () => {
  const run = fixture();
  mergeWorkerResults(run, 'worker-1');
  mergeWorkerResults(run, 'worker-2');
  const partFile = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(partFile, 'utf8'));
  part.results[0].score = 4.5;
  part.results[1].eligibility_evidence = 'unexpected';
  writeFileSync(partFile, JSON.stringify(part));
  const loaded = loadScanResults(run);
  assert.deepEqual(loaded.errors, [
    'a:1: worker must not write derived legacy fields',
    'b:2: eligible result must not carry eligibility category/evidence',
  ]);
});

test('an invalid sibling cannot hide a tampered final candidate', () => {
  const run = fixture();
  mergeWorkerResults(run, 'worker-1');
  mergeWorkerResults(run, 'worker-2');
  const partFile = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(partFile, 'utf8'));
  part.results[0].score = 4.5;
  writeFileSync(partFile, JSON.stringify(part));
  const finalFile = path.join(run, 'results/worker-1.json');
  const final = JSON.parse(readFileSync(finalFile, 'utf8'));
  Object.assign(final.results[2], { fit_score: 4.6, score: 4.6, rationale: null, report_allowed: true, report_decision: 'Apply', report: {} });
  writeFileSync(finalFile, JSON.stringify(final));
  const loaded = loadScanResults(run);
  assert.ok(loaded.errors.includes('c:3: merged result does not equal validated part result'));
  assert.equal(loaded.candidates.some(item => item.posting_key === 'c:3'), false);
});

test('merger uses the report threshold snapshotted in assignment runtime', () => {
  const run = fixture();
  const file = path.join(run, 'assignments.json');
  const assignments = JSON.parse(readFileSync(file, 'utf8'));
  assignments.runtime.reporting.full_report_threshold = 3.5;
  writeFileSync(file, JSON.stringify(assignments));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /report payload must exist exactly for report candidates/);
});

test('merger uses the retry limit snapshotted in assignment runtime', () => {
  const run = fixture();
  const assignmentsFile = path.join(run, 'assignments.json');
  const assignments = JSON.parse(readFileSync(assignmentsFile, 'utf8'));
  assignments.runtime.failure.per_job_retry_limit = 2;
  writeFileSync(assignmentsFile, JSON.stringify(assignments));
  const partFile = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(partFile, 'utf8'));
  part.results[0] = { posting_key: 'a:1', status: 'FAILED', attempts: 3, error: 'timeout', report: null };
  writeFileSync(partFile, JSON.stringify(part));
  assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1'));
  part.results[0].attempts = 2;
  writeFileSync(partFile, JSON.stringify(part));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /invalid FAILED result/);
});

test('merger rejects worker-authored report identity', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  artifact.results[0] = rawResult('a:1', { fit_score: 4.1, rationale: null, report: { posting_key: 'a:1', posting_url: 'https://wrong.example/a' } });
  writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /report has unsupported field posting_key/);
});

test('merger rejects eligibility evidence that is not an exact JD substring', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  artifact.results[0] = rawResult('a:1', { eligibility_status: 'ineligible', eligibility_category: 'citizenship', eligibility_evidence: 'JD: "Citizenship might be needed."', report: null });
  writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /eligibility_evidence is not an exact JD substring/);
});

test('merger preserves model exclusions and prevents reports for them', () => {
  for (const [category, quote] of [['employment_type', 'Full-time / contract, with contract terms controlling this role.'],
    ['no_sponsorship', 'Visa sponsorship cannot be arranged for this vacancy.']]) {
    const run = fixture();
    const jdFile = path.join(run, 'jobs/a-1.md');
    writeFileSync(jdFile, readFileSync(jdFile, 'utf8') + `\n${quote}`);
    const file = path.join(run, 'results/worker-1.part-1.json');
    const part = JSON.parse(readFileSync(file));
    part.results[0] = rawResult('a:1', { fit_score: 4.5, eligibility_status: 'ineligible', eligibility_category: category, eligibility_evidence: `JD: "${quote}"` });
    writeFileSync(file, JSON.stringify(part));
    const result = mergeWorkerResults(run, 'worker-1').output.results[0];
    mergeWorkerResults(run, 'worker-2');
    assert.equal(result.eligibility_category, category);
    assert.equal(result.score, 3.5);
    assert.equal(result.report_allowed, false);
    assert.deepEqual(loadScanResults(run).errors, []);
  }
});

test('deterministic merger rejects an omitted or misplaced assigned key', () => {
  const run = fixture();
  writeFileSync(path.join(run, 'results/worker-1.part-2.json'), JSON.stringify({ result_schema_version: 4, worker: 'worker-1', part: 2, results: [{ posting_key: 'b:2' }] }));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /keys do not match assigned batch/);
});

test('merger fails closed when a below-threshold result omits rationale', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  delete artifact.results[0].rationale;
  writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /requires a single-line rationale/);
});

test('merger rejects a rationale longer than 150 characters', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  artifact.results[0].rationale = 'x'.repeat(151);
  writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /at most 150 characters/);
});

test('merger validates a completed prefix before later parts exist', () => {
  const run = fixture();
  unlinkSync(path.join(run, 'results/worker-1.part-2.json'));
  assert.doesNotThrow(() => validateWorkerParts(run, 'worker-1', { throughPart: 1 }));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /missing part 2/);
});

test('new runs reject missing result schema versions and candidate-source drift', () => {
  const run = fixture();
  const partFile = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(partFile, 'utf8'));
  delete part.result_schema_version;
  writeFileSync(partFile, JSON.stringify(part));
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /invalid part 1 schema/);

  part.result_schema_version = 4;
  writeFileSync(partFile, JSON.stringify(part));
  const plan = JSON.parse(readFileSync(path.join(run, 'assignments.json'), 'utf8'));
  writeFileSync(plan.candidate_sources[0].path, 'changed');
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /candidate source hash changed/);

  const missingPlanVersion = fixture();
  const planFile = path.join(missingPlanVersion, 'assignments.json');
  const unversioned = JSON.parse(readFileSync(planFile, 'utf8'));
  delete unversioned.result_schema_version;
  writeFileSync(planFile, JSON.stringify(unversioned));
  assert.throws(() => loadScanResults(missingPlanVersion), /result_schema_version/);
});

test('real failed JDs flow through merger and loader without leaking excluded candidates', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/daily-scan-eligibility-20260904.json', import.meta.url)));
  for (const sample of cases) {
    const run = fixture();
    const file = path.join(run, 'acquisition.json');
    const acquisition = JSON.parse(readFileSync(file));
    acquisition.acquired[0] = { ...sample.record, ...acquisition.acquired[0] };
    writeFileSync(file, JSON.stringify(acquisition));
    writeFileSync(path.join(run, acquisition.acquired[0].jd_path), sample.jdText);
    const role = sample.jdText.split('\n').find(line => line.startsWith('**Role:**'));
    const partFile = path.join(run, 'results/worker-1.part-1.json');
    const part = JSON.parse(readFileSync(partFile));
    const report = sample.status === 'needs_verification'
      ? structuredReport({ evidence: [{ source: 'jd', quote: role, explanation: 'Role scope requires eligibility review.' }] }) : null;
    part.results[0] = rawResult('a:1', { fit_score: 4.1, level_evidence: `JD: "${role}"`, eligibility_status: sample.status, eligibility_category: sample.category, eligibility_evidence: `JD: "${role}"`, report });
    writeFileSync(partFile, JSON.stringify(part));
    const plan = JSON.parse(readFileSync(path.join(run, 'assignments.json')));
    for (const worker of workerIdsForRuntime(plan.runtime)) mergeWorkerResults(run, worker);
    const loaded = loadScanResults(run);
    assert.deepEqual(loaded.errors, [], sample.record.primary_key);
    const result = loaded.byKey.get('a:1');
    assert.equal(result.eligibility_status, sample.status, sample.record.primary_key);
    assert.equal(result.eligibility_category, sample.category, sample.record.primary_key);
    assert.equal(loaded.candidates.length, sample.status === 'needs_verification' ? 1 : 0);
  }
});


test('v4 renders authoritative fields once from structured evidence with zero gaps', () => {
  const run = fixture();
  candidate(run, structuredReport({ evidence: [
    { source: 'jd', quote: 'Build backend systems', explanation: 'Direct backend scope.' },
    { source: 'candidate', locator: 'cv.md/CV', fact: 'Master of Science in Computer Science', explanation: 'Relevant education.' },
  ] }));
  const { result, markdown, summary } = rendered(run);
  assert.equal(result.report.markdown, undefined);
  assert.equal(summary.company, 'Example');
  assert.equal(summary.role, 'Backend Engineer');
  assert.equal(summary.posting_url, 'https://jobs.example/a');
  assert.equal(summary.score, 4.1);
  assert.equal(summary.final_decision, 'Apply');
  assert.deepEqual(summary.top_strengths, result.report.evidence.map(item => item.explanation));
  assert.deepEqual(summary.soft_gaps, []);
  assert.equal(summary.risk_summary.legitimacy, 'high_confidence');
  assert.equal(summary.via, 'LinkedIn');
  assert.match(markdown, /No material gaps identified/);
  mergeWorkerResults(run, 'worker-2');
  assert.deepEqual(loadScanResults(run).errors, []);
});

test('v4 rejects duplicate derived fields and invalid structured evidence before commit', () => {
  const cases = [
    [r => { r.markdown = 'old payload'; }, /unsupported field markdown/],
    [r => { r.company = 'Wrong employer'; }, /unsupported field company/],
    [r => { r.score = 5; }, /unsupported field score/],
    [r => { r.work_auth = 'sponsors'; }, /unsupported field work_auth/],
    [r => { r.risk_summary.legitimacy = 'high_confidence'; }, /unsupported field legitimacy/],
    [r => { r.evidence = []; }, /1-5 items/],
    [r => { r.evidence[0].quote = 'Invented requirement'; }, /exact substring/],
    [r => { r.evidence[0].explanation = ''; }, /explanation/],
    [r => { r.evidence[0].locator = 'cv.md/CV'; }, /unsupported field locator/],
    [r => { r.evidence = [{ source: 'candidate', locator: 'notes.md/Experience', fact: 'Claim', explanation: 'Match' }]; }, /unsupported source locator/],
    [r => { r.gaps = [{ quote: 'Build backend systems', locator: 'cv.md/', explanation: 'Missing evidence' }]; }, /unsupported source locator/],
    [r => { r.gaps = [{ quote: 'Backend Engineer Build backend', locator: 'cv.md/CV', explanation: 'Missing evidence' }]; }, /exact substring/],
    [r => { r.advertised_comp = '200k USD'; }, /exact substring/],
    [r => { r.company_confidential_evidence = 'Confidential client'; }, /exact substring/],
    [r => { r.risk_summary.culture = 'great'; }, /culture is invalid/],
    [r => { r.archetype = ['Backend', 'SRE']; }, /archetype/],
    [r => { r.reason = 'x'.repeat(161); }, /160 characters/],
  ];
  for (const [mutate, expected] of cases) {
    const run = fixture();
    const report = structuredReport();
    mutate(report);
    candidate(run, report);
    assert.throws(() => validateWorkerParts(run, 'worker-1'), expected);
  }
  const run = fixture();
  candidate(run, structuredReport(), { work_authorization: { value: 'sponsors' } });
  assert.throws(() => validateWorkerParts(run, 'worker-1'), /work_authorization requires/);
});

test('v4 escapes quotes, line breaks and Markdown without changing exact source data', () => {
  const run = fixture();
  const quote = 'Build "backend"\nsystems with `tools`.';
  const comp = 'USD 150,000–200,000\nplus "bonus"';
  const confidential = 'The employer is a confidential client.';
  const file = path.join(run, 'jobs/a-1.md');
  writeFileSync(file, readFileSync(file, 'utf8') + `\n${quote}\n${comp}\n${confidential}`);
  candidate(run, structuredReport({
    evidence: [{ source: 'jd', quote, explanation: 'Scope <script> and `code`.' }],
    gaps: [{ quote, locator: 'cv.md/CV', explanation: 'Tool-specific experience is not documented.' }],
    advertised_comp: comp, company_confidential_evidence: confidential,
  }));
  const { result, markdown, summary } = rendered(run);
  assert.equal(result.report.evidence[0].quote, quote);
  assert.equal(summary.advertised_comp, comp);
  assert.equal(summary.company_confidential, true);
  assert.equal((markdown.match(/^## /gm) ?? []).length, 5);
  assert.equal((markdown.match(/^```/gm) ?? []).length, 2);
  assert.doesNotMatch(markdown.split('## Evidence')[1], /<script>/);
  assert.deepEqual(summary.soft_gaps, ['Tool-specific experience is not documented.']);
});

test('v4 renders model sponsorship and uncertain-eligibility actions from supplied evidence', () => {
  for (const [jd, expectedDecision, auth] of [
    ['Visa sponsorship is available.', 'Apply', 'sponsors'],
    ['**Employment Type:** Full-Time / Contract', 'Research first', 'unstated'],
  ]) {
    const run = fixture();
    writeFileSync(path.join(run, 'jobs/a-1.md'), `**Role:** Senior Backend Engineer\n${jd}\nBuild backend systems`);
    if (expectedDecision === 'Research first') {
      const file = path.join(run, 'acquisition.json');
      const acquisition = JSON.parse(readFileSync(file));
      acquisition.acquired[0].employment_type = 'Full-Time / Contract';
      writeFileSync(file, JSON.stringify(acquisition));
    }
    candidate(run, structuredReport(), { work_authorization: { value: auth, quote: auth === 'sponsors' ? jd : null },
      ...(expectedDecision === 'Research first' ? { eligibility_status: 'needs_verification', eligibility_category: 'employment_type', eligibility_evidence: `JD: "${jd}"` } : {}) });
    const { result, summary, markdown } = rendered(run);
    assert.equal(summary.final_decision, expectedDecision);
    assert.equal(summary.work_auth, auth);
    if (expectedDecision === 'Research first') {
      assert.ok(summary.next_action.includes(result.eligibility_evidence));
      assert.equal(result.eligibility_category, 'employment_type');
    } else assert.ok(markdown.includes(jd));
  }
});

test('v4 checks the rendered total budget including immutable acquisition fields', () => {
  const run = fixture();
  const acquisitionFile = path.join(run, 'acquisition.json');
  const acquisition = JSON.parse(readFileSync(acquisitionFile));
  acquisition.acquired[0].company = 'x'.repeat(2500);
  writeFileSync(acquisitionFile, JSON.stringify(acquisition));
  candidate(run);
  assert.throws(() => validateWorkerParts(run, 'worker-1', { throughPart: 1 }), /report exceeds 2500 characters/);
});

test('v4 refuses v2/v3 assignments, parts, and finals without migrating artifacts', () => {
  for (const version of [2, 3]) for (const target of ['assignments.json', 'results/worker-1.part-1.json', 'results/worker-1.json']) {
    const run = fixture();
    mergeWorkerResults(run, 'worker-1');
    mergeWorkerResults(run, 'worker-2');
    const file = path.join(run, target);
    const artifact = JSON.parse(readFileSync(file));
    artifact.result_schema_version = version;
    const original = JSON.stringify(artifact);
    writeFileSync(file, original);
    if (target === 'assignments.json') assert.throws(() => loadScanResults(run), /result_schema_version must be 4/);
    else assert.ok(loadScanResults(run).errors.some(error => /invalid .*schema/.test(error)));
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});


test('no-repair terminalization uses the observed count and survives merger and loader validation', () => {
  const run = fixture();
  const file = path.join(run, 'results/worker-1.part-1.json');
  const part = JSON.parse(readFileSync(file));
  unlinkSync(path.join(run, 'jobs/a-1.md'));
  const reason = 'The captured JD is missing; inventing source text is not a truthful repair.';
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 1, reason), /validation evidence/);
  assert.equal(validatePartFromCli(run).status, 1);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 2, reason), /observed rejected/);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 0, reason), /retry budget/);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'a:1', 1, '  '), /nonempty single line/);
  assert.throws(() => failWorkerResult(run, 'worker-1', 'b:2', 1, reason), /valid result cannot/);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/merge-worker-results.mjs', import.meta.url)),
    '--run', run, '--worker', 'worker-1', '--fail-key', 'a:1', '--attempts', '1', '--no-repair-reason', reason], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const failed = JSON.parse(cli.stdout).result;
  assert.equal(failed.attempts, 1);
  assert.equal(failed.no_repair_reason, reason);
  assert.deepEqual(failed.rejected_result, part.results[0]);
  assert.equal(failed.validation_evidence.attempts.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file)).results[1], part.results[1]);
  assert.equal(validatePartFromCli(run).status, 0);
  assert.equal(failWorkerResult(run, 'worker-1', 'a:1', 1, reason).changed, false);
  const plan = JSON.parse(readFileSync(path.join(run, 'assignments.json')));
  for (const worker of Object.keys(plan.assignments).filter(w => w !== 'worker-1')) mergeWorkerResults(run, worker);
  mergeWorkerResults(run, 'worker-1');
  const loaded = loadScanResults(run);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.failed.length, 1);
  assert.equal(loaded.failed[0].no_repair_reason, reason);
  for (const mutate of [result => delete result.no_repair_reason, result => delete result.validation_evidence,
    result => { result.attempts = 2; }, result => { result.no_repair_reason = ''; }]) {
    const artifact = JSON.parse(readFileSync(file));
    artifact.results[0] = structuredClone(failed);
    mutate(artifact.results[0]);
    writeFileSync(file, JSON.stringify(artifact));
    assert.throws(() => validateWorkerParts(run, 'worker-1'), /invalid .*failure|invalid FAILED|invalid terminal/);
  }
});
