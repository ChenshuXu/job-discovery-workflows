#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDailyScanRuntime, workerIdsForRuntime } from './daily-scan-runtime.mjs';
import { isAllowedLocationDecision } from './location-scope.mjs';
import { validateStructuredReport, renderCompactReport } from './scan-report-contract.mjs';
import { applyScoringSafety, deriveReportWorkAuthorization, RESULT_SCHEMA_VERSION } from './scoring-safety.mjs';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON ${file}: ${error.message}`); }
}

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const evaluationHash = item => digest(JSON.stringify(canonical(item)));
const evidenceFile = (root, worker) => path.join(root, 'results', `${worker}.validation-evidence.json`);

function validationContext(root, worker, plan) {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  return {
    schema_version: 1, run_id: plan.run_id, worker,
    assignments_sha256: digest(readFileSync(path.join(root, 'assignments.json'))),
    acquisition_sha256: digest(readFileSync(path.join(root, 'acquisition.json'))),
    validator_sha256: digest(Buffer.concat(['merge-worker-results.mjs', 'scoring-safety.mjs', 'scan-report-contract.mjs']
      .map(name => readFileSync(path.join(moduleRoot, name))))),
  };
}

function validateRejectedAttempts(key, evidence) {
  const attempts = evidence?.attempts;
  if (!Array.isArray(attempts) || !attempts.length || !(evidence.jd_sha256 === null || /^[a-f0-9]{64}$/.test(evidence.jd_sha256 ?? ''))
      || attempts.some(attempt => !attempt?.rejected_result || Array.isArray(attempt.rejected_result)
        || attempt.rejected_result.posting_key !== key
        || String(attempt.rejected_result.status ?? 'EVALUATED').toUpperCase() !== 'EVALUATED'
        || attempt.evaluation_sha256 !== evaluationHash(attempt.rejected_result)
        || typeof attempt.error !== 'string' || !attempt.error.startsWith(`${key}:`))
      || new Set(attempts.map(attempt => attempt.evaluation_sha256)).size !== attempts.length) {
    throw new Error(`${key}: invalid validation evidence`);
  }
  return attempts;
}

function readValidationEvidence(root, worker, plan) {
  const context = validationContext(root, worker, plan);
  const file = evidenceFile(root, worker);
  const evidence = readJson(file);
  if (Object.entries(context).some(([key, value]) => evidence[key] !== value)
      || !evidence.failures || typeof evidence.failures !== 'object' || Array.isArray(evidence.failures)) {
    throw new Error(`${worker}: validation evidence context changed`);
  }
  for (const [key, failure] of Object.entries(evidence.failures)) {
    if (!plan.assignments[worker].includes(key)) throw new Error(`${key}: foreign validation evidence`);
    validateRejectedAttempts(key, failure);
  }
  return evidence;
}

// Only the CLI records rejected evaluations. Library readers and finalized runs
// remain read-only; this is evidence, not a scheduler or a retry queue.
function validateForCli(runDir, worker, options = {}) {
  const value = validateWorkerParts(runDir, worker, { ...options, collectItemErrors: true });
  const { root, plan, itemFailures } = value;
  if (itemFailures.length && !existsSync(path.join(root, 'receipt.json'))
      && !existsSync(path.join(root, 'results', `${worker}.json`))) {
    const file = evidenceFile(root, worker);
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const evidence = before === null ? { ...validationContext(root, worker, plan), failures: {} }
      : readValidationEvidence(root, worker, plan);
    let changed = false;
    for (const failure of itemFailures) {
      const key = failure.posting_key;
      const entry = evidence.failures[key] ??= { jd_sha256: failure.jd_sha256, attempts: [] };
      if (entry.jd_sha256 !== failure.jd_sha256) throw new Error(`${key}: validation JD evidence changed`);
      const hash = evaluationHash(failure.rejected_result);
      if (!entry.attempts.some(attempt => attempt.evaluation_sha256 === hash)) {
        entry.attempts.push({ evaluation_sha256: hash, error: failure.error, rejected_result: failure.rejected_result });
        changed = true;
      }
    }
    if (changed) {
      for (const part of value.parts) {
        if (evaluationHash(readJson(part.file)) !== evaluationHash(part.artifact)) throw new Error(`${worker}: part changed during validation`);
      }
      if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== before) throw new Error(`${worker}: validation evidence changed concurrently`);
      const staged = `${file}.tmp-${process.pid}`;
      writeFileSync(staged, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      renameSync(staged, file);
    }
  }
  if (value.itemErrors.length) throw new Error(value.itemErrors.join('\n'));
  return value;
}

function validateCandidateSources(plan) {
  const expected = ['cv.md', 'config/profile.yml', 'modes/_profile.md'];
  if (!path.isAbsolute(plan.career_ops_root ?? '')) throw new Error('assignments career_ops_root must be absolute');
  if (!Array.isArray(plan.candidate_sources) || JSON.stringify(plan.candidate_sources.map(item => item.label)) !== JSON.stringify(expected)) {
    throw new Error('assignments candidate_sources must contain the three approved sources in order');
  }
  return plan.candidate_sources.map(source => {
    if (source.path !== path.join(plan.career_ops_root, source.label) || !existsSync(source.path)) throw new Error(`approved candidate source missing or outside Career-Ops: ${source.path}`);
    const content = readFileSync(source.path);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== source.sha256) throw new Error(`approved candidate source hash changed: ${source.label}`);
    return `\n--- ${source.label} ---\n${content.toString('utf8')}`;
  }).join('');
}

export function validateWorkerParts(runDir, worker, options = {}) {
  const root = path.resolve(runDir);
  const planFile = path.join(root, 'assignments.json');
  const plan = readJson(planFile);
  plan.runtime = validateDailyScanRuntime(plan.runtime, `${planFile} runtime`);
  if (plan.result_schema_version !== RESULT_SCHEMA_VERSION) throw new Error(`${planFile}: result_schema_version must be ${RESULT_SCHEMA_VERSION}`);
  const candidateText = validateCandidateSources(plan);
  if (!workerIdsForRuntime(plan.runtime).includes(worker)) throw new Error(`invalid worker id: ${worker}`);
  const assigned = (plan.assignments?.[worker] ?? []).map(String);
  const acquisition = readJson(path.join(root, 'acquisition.json'));
  const records = new Map((acquisition.acquired ?? []).map(record => [String(record.primary_key), record]));
  const recorded = existsSync(evidenceFile(root, worker)) ? readJson(evidenceFile(root, worker)) : null;
  const batchSize = plan.runtime.scheduler.batch_size;
  const parts = [];
  const results = [];
  const rawResultKeys = [];
  const itemErrors = [];
  const itemFailures = [];
  const expectedParts = Math.ceil(assigned.length / batchSize);
  const throughPart = options.throughPart == null ? expectedParts : Number(options.throughPart);
  const minimumParts = expectedParts === 0 && options.throughPart == null ? 0 : 1;
  if (!Number.isInteger(throughPart) || throughPart < minimumParts || throughPart > expectedParts) throw new Error(`${worker}: validate-through-part must be between 1 and ${expectedParts}`);
  for (let index = 0; index < throughPart; index += 1) {
    const file = path.join(root, 'results', `${worker}.part-${index + 1}.json`);
    if (!existsSync(file)) throw new Error(`${worker}: missing part ${index + 1}`);
    const artifact = readJson(file);
    if (artifact.result_schema_version !== RESULT_SCHEMA_VERSION || artifact.worker !== worker || artifact.part !== index + 1 || !Array.isArray(artifact.results)) throw new Error(`${worker}: invalid part ${index + 1} schema`);
    const expectedKeys = assigned.slice(index * batchSize, (index + 1) * batchSize);
    const returnedKeys = artifact.results.map(item => String(item.posting_key ?? ''));
    rawResultKeys.push(...returnedKeys);
    if (JSON.stringify(returnedKeys) !== JSON.stringify(expectedKeys)) throw new Error(`${worker}: part ${index + 1} keys do not match assigned batch`);
    for (const item of artifact.results) {
      let canRecordFailure = false;
      let jdHash = null;
      try {
        const key = String(item.posting_key ?? '');
        const record = records.get(key);
        const primaryUrl = plan.primary_urls?.[key];
        if (!record || typeof primaryUrl !== 'string' || primaryUrl !== record.primary_url) throw new Error(`${key}: assignment primary_url must equal acquisition primary_url`);
        if (!isAllowedLocationDecision(record.location_scope?.decision) || record.location_scope?.allowed !== true) throw new Error(`${key}: assignment lacks an allowed location-scope decision`);
        const status = String(item.status ?? 'EVALUATED').toUpperCase();
        if (status === 'FAILED') {
          const noRepair = item.no_repair_reason !== undefined;
          if (noRepair && (typeof item.no_repair_reason !== 'string' || !item.no_repair_reason.trim()
              || /[\r\n]/.test(item.no_repair_reason) || !item.validation_evidence)) throw new Error(`${key}: invalid no-repair failure`);
          if (!Number.isInteger(item.attempts) || (noRepair
            ? item.attempts < 1 || item.attempts > plan.runtime.failure.per_job_retry_limit + 1
            : item.attempts !== plan.runtime.failure.per_job_retry_limit + 1) || typeof item.error !== 'string' || !item.error.trim() || item.report != null) throw new Error(`${key}: invalid FAILED result`);
          if (item.rejected_result != null && (typeof item.rejected_result !== 'object'
              || Array.isArray(item.rejected_result) || item.rejected_result.posting_key !== key
              || String(item.rejected_result.status ?? 'EVALUATED').toUpperCase() === 'FAILED'
              || Object.hasOwn(item.rejected_result, 'rejected_result'))) throw new Error(`${key}: invalid rejected_result provenance`);
          const priorEvaluation = recorded?.failures?.[key];
          if (priorEvaluation && item.validation_evidence == null) throw new Error(`${key}: FAILED requires observed validation evidence`);
          if (item.validation_evidence != null) {
            if (!item.rejected_result) throw new Error(`${key}: invalid terminal validation evidence`);
            const attempts = validateRejectedAttempts(key, item.validation_evidence);
            const last = attempts.at(-1);
            if (item.validation_evidence.run_id !== plan.run_id || item.validation_evidence.worker !== worker
                || attempts.length !== item.attempts || last.evaluation_sha256 !== evaluationHash(item.rejected_result)
                || last.error !== item.error) throw new Error(`${key}: invalid terminal validation evidence`);
            if (!priorEvaluation
                || evaluationHash(priorEvaluation) !== evaluationHash({ jd_sha256: item.validation_evidence.jd_sha256, attempts })) {
              throw new Error(`${key}: terminal validation evidence does not match recorded failures`);
            }
            {
              const contextFields = ['schema_version', 'run_id', 'worker', 'assignments_sha256', 'acquisition_sha256', 'validator_sha256'];
              const jdFile = path.join(root, record.jd_path);
              const currentJdHash = existsSync(jdFile) ? digest(readFileSync(jdFile)) : null;
              if (contextFields.some(field => recorded?.[field] !== item.validation_evidence[field])
                  || recorded.schema_version !== 1 || recorded.run_id !== plan.run_id || recorded.worker !== worker
                  || recorded.assignments_sha256 !== digest(readFileSync(planFile))
                  || recorded.acquisition_sha256 !== digest(readFileSync(path.join(root, 'acquisition.json')))
                  || !/^[a-f0-9]{64}$/.test(recorded.validator_sha256 ?? '')
                  || currentJdHash !== item.validation_evidence.jd_sha256) {
                throw new Error(`${key}: terminal validation evidence context or JD changed`);
              }
            }
          }
          results.push(item);
          continue;
        }
        if (status !== 'EVALUATED') throw new Error(`${key}: invalid evaluated result`);
        const identity = plan.semantic_identities?.[key];
        if (!identity?.semantic_job_key || !identity?.posting_context_key
            || record.semantic_job_key !== identity.semantic_job_key || record.posting_context_key !== identity.posting_context_key) {
          throw new Error(`${key}: assignment semantic identity must equal acquisition`);
        }
        const jdFile = path.join(root, record.jd_path);
        canRecordFailure = true;
        if (!existsSync(jdFile)) throw new Error(`${key}: JD file missing`);
        const threshold = plan.runtime.reporting.full_report_threshold;
        const jdText = readFileSync(jdFile, 'utf8');
        jdHash = digest(jdText);
        const derived = applyScoringSafety({ item, jdText, threshold });
        const result = { ...derived, semantic_job_key: identity.semantic_job_key, posting_context_key: identity.posting_context_key };
        if (result.report_allowed !== Boolean(result.report)) throw new Error(`${key}: report payload must exist exactly for report candidates`);
        if (result.report_allowed) {
          validateStructuredReport(result.report, { jdText, label: `${key}: report` });
          result.work_authorization = deriveReportWorkAuthorization({ item, jdText, candidateText });
          renderCompactReport({ result, record, runId: plan.run_id });
        }
        if (!result.report_allowed && item.work_authorization !== undefined) result.work_authorization = deriveReportWorkAuthorization({ item, jdText, candidateText });
        results.push(result);
      } catch (error) {
        if (!options.collectItemErrors) throw error;
        itemErrors.push(error.message);
        if (canRecordFailure) itemFailures.push({ posting_key: item.posting_key, jd_sha256: jdHash, error: error.message, rejected_result: item });
      }
    }
    parts.push({ file, artifact });
  }
  const unique = new Set(rawResultKeys);
  const validatedAssigned = assigned.slice(0, Math.min(throughPart * batchSize, assigned.length));
  if (unique.size !== rawResultKeys.length || JSON.stringify(rawResultKeys) !== JSON.stringify(validatedAssigned)) throw new Error(`${worker}: part union has duplicate, omitted, or out-of-order keys`);
  return { root, plan, assigned, parts, results, itemErrors, itemFailures };
}

function writeWorkerResults(value, worker) {
  const output = {
    result_schema_version: RESULT_SCHEMA_VERSION,
    worker,
    model: value.plan.runtime.worker.model,
    reasoning_effort: value.plan.runtime.worker.reasoning_effort,
    results: value.results,
  };
  const file = path.join(value.root, 'results', `${worker}.json`);
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(output, null, 2)}\n`);
  renameSync(staged, file);
  return { file, output, part_count: value.parts.length, result_count: value.results.length };
}

export function mergeWorkerResults(runDir, worker) {
  return writeWorkerResults(validateWorkerParts(runDir, worker), worker);
}

export function failWorkerResult(runDir, worker, key, attempts, noRepairReason) {
  const root = path.resolve(runDir);
  if (existsSync(path.join(root, 'receipt.json')) || existsSync(path.join(root, 'results', `${worker}.json`))) {
    throw new Error('cannot terminalize an already finalized worker or completed run');
  }
  const plan = readJson(path.join(root, 'assignments.json'));
  const runtime = validateDailyScanRuntime(plan.runtime, 'assignments runtime');
  if (!workerIdsForRuntime(runtime).includes(worker)) throw new Error(`invalid worker id: ${worker}`);
  const index = plan.assignments?.[worker]?.indexOf(key) ?? -1;
  if (index < 0) throw new Error(`${key}: key is not assigned to ${worker}`);
  const noRepair = noRepairReason !== undefined;
  if (noRepair && (typeof noRepairReason !== 'string' || !noRepairReason.trim() || /[\r\n]/.test(noRepairReason))) throw new Error(`${key}: no-repair reason must be a nonempty single line`);
  if (!Number.isInteger(attempts) || (noRepair ? attempts < 1 || attempts > runtime.failure.per_job_retry_limit + 1
    : attempts !== runtime.failure.per_job_retry_limit + 1)) throw new Error(`${key}: exhausted attempts must equal the frozen retry budget; no-repair attempts must be within it`);
  const partNumber = Math.floor(index / runtime.scheduler.batch_size) + 1;
  const file = path.join(root, 'results', `${worker}.part-${partNumber}.json`);
  const before = readFileSync(file, 'utf8');
  const artifact = readJson(file);
  const validation = validateWorkerParts(root, worker, { throughPart: partNumber, collectItemErrors: true });
  const errors = validation.itemErrors.filter(error => error.startsWith(`${key}:`));
  const slot = index % runtime.scheduler.batch_size;
  const rejected = artifact.results[slot];
  if (String(rejected.status ?? '').toUpperCase() === 'FAILED') {
    if (errors.length) throw new Error(`${key}: cannot replace an invalid terminal failure`);
    return { file, result: rejected, changed: false };
  }
  if (!errors.length) throw new Error(`${key}: a valid result cannot be marked FAILED`);
  if (!existsSync(evidenceFile(root, worker))) throw new Error(`${key}: validation evidence is required before terminalization`);
  const evidence = readValidationEvidence(root, worker, validation.plan);
  const history = evidence.failures[key];
  const observed = history ? validateRejectedAttempts(key, history) : [];
  if (observed.length !== attempts) throw new Error(`${key}: observed rejected evaluations (${observed.length}) do not match requested attempts (${attempts})`);
  const failure = validation.itemFailures.find(item => item.posting_key === key);
  const last = observed.at(-1);
  if (!failure || failure.jd_sha256 !== history.jd_sha256 || last.evaluation_sha256 !== evaluationHash(rejected)
      || last.error !== errors.join('; ')) throw new Error(`${key}: current rejected evaluation does not match validation evidence`);
  const { failures, ...context } = evidence;
  const result = { posting_key: key, status: 'FAILED', attempts: observed.length, error: last.error, report: null,
    ...(noRepair ? { no_repair_reason: noRepairReason.trim() } : {}),
    rejected_result: rejected, validation_evidence: { ...context, ...history } };
  artifact.results[slot] = result;
  if (readFileSync(file, 'utf8') !== before) throw new Error(`${key}: part changed during validation`);
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  renameSync(staged, file);
  return { file, result, changed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runAt = process.argv.indexOf('--run');
    const workerAt = process.argv.indexOf('--worker');
    const throughAt = process.argv.indexOf('--validate-through-part');
    const failAt = process.argv.indexOf('--fail-key');
    const attemptsAt = process.argv.indexOf('--attempts');
    const noRepairAt = process.argv.indexOf('--no-repair-reason');
    if (noRepairAt >= 0 && (failAt < 0 || !process.argv[noRepairAt + 1] || process.argv[noRepairAt + 1].startsWith('--'))) throw new Error('--no-repair-reason requires --fail-key and a reason');
    const run = runAt >= 0 ? process.argv[runAt + 1] : null;
    const worker = workerAt >= 0 ? process.argv[workerAt + 1] : null;
    if (!run || !worker) throw new Error('Usage: node src/merge-worker-results.mjs --run runs/<run-id> --worker worker-N');
    if (failAt >= 0) {
      if (throughAt >= 0 || attemptsAt < 0) throw new Error('--fail-key requires --attempts and cannot be combined with --validate-through-part');
      console.log(JSON.stringify(failWorkerResult(run, worker, process.argv[failAt + 1], Number(process.argv[attemptsAt + 1]), noRepairAt >= 0 ? process.argv[noRepairAt + 1] : undefined), null, 2));
    } else if (throughAt >= 0) {
      const value = validateForCli(run, worker, { throughPart: process.argv[throughAt + 1] });
      console.log(JSON.stringify({ worker, validated_parts: value.parts.length, result_count: value.results.length }, null, 2));
    } else {
      console.log(JSON.stringify(writeWorkerResults(validateForCli(run, worker), worker), null, 2));
    }
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
