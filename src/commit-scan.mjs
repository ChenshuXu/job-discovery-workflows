#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildCanonicalFingerprintAudit } from './canonical-url-fingerprint.mjs';
import {
  loadCareerTrackerParser,
  parseTracker,
  readReportIdentity,
  trackerNoteHasPostingKey,
} from './daily-scan-state.mjs';
import { evaluatePersistence, jobIssue, normalizeJobIssues } from './job-issue-policy.mjs';
import { validateRun } from './run-contract.mjs';
import { loadScanResults } from './scan-results.mjs';
import { renderScanReports } from './render-scan-reports.mjs';
import { collectHistoricalSemanticContexts } from './posting-history.mjs';
import {
  auditScanReceipt,
  writeReceiptCreateOnly,
} from './verify-scan-receipt.mjs';

const atomicJson = (file, value) => {
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staged, file);
};

class JobScopedCommitError extends Error {
  constructor(postingKey, code, message, evidence = null) {
    super(message);
    this.postingKey = postingKey;
    this.code = code;
    this.evidence = evidence;
  }
}

function firstReportReference(matches) {
  return matches.flatMap(item => item.prior_artifacts ?? []).find(item => /^career-ops\/reports\/.+\.md$/i.test(item)) ?? null;
}

function assertBaselinePipeline(runRoot) {
  const baselineFile = path.join(runRoot, 'baseline.json');
  if (!existsSync(baselineFile)) throw new Error(`run baseline missing: ${baselineFile}`);
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const pipeline = baseline.pipeline ?? {};
  if (pipeline.exit_code !== 0) throw new Error(`baseline Career-Ops pipeline verifier exited ${pipeline.exit_code}`);
  if (Number(pipeline.errors ?? 0) !== 0) throw new Error(`baseline Career-Ops pipeline has ${pipeline.errors} error(s)`);
}

function initialJobIssues(run, results, careerRoot, scopedContractErrors = []) {
  const issues = results.failed.map(item => jobIssue({
    posting_key: item.posting_key,
    stage: 'SCORING',
    code: 'WORKER_FAILED',
    reason: item.error,
    evidence: { attempts: Number(item.attempts) },
  }));
  const evaluated = new Set(results.evaluated.map(item => item.posting_key));
  const records = run.records.filter(record => evaluated.has(record.primary_key));
  const audit = buildCanonicalFingerprintAudit({ records, careerRoot, runId: path.basename(run.root) });
  for (const item of audit.results.filter(value => value.duplicate)) {
    issues.push(jobIssue({
      posting_key: item.primary_key,
      stage: 'PRECOMMIT_IDENTITY',
      code: 'HISTORY_DUPLICATE',
      reason: `Exact historical identity matched: ${item.matched_keys.join(', ')}`,
      evidence: { matched_keys: item.matched_keys, matches: item.matches },
      existing_report: firstReportReference(item.matches),
    }));
  }
  if (results.plan.runtime.semantic_dedup_mode === 'enforce') {
    const exactIssueKeys = new Set(issues.filter(item => item.code === 'HISTORY_DUPLICATE').map(item => item.posting_key));
    const semanticHistory = collectHistoricalSemanticContexts({ careerRoot, locationPolicy: results.plan.location_policy });
    for (const item of results.evaluated) {
      if (exactIssueKeys.has(item.posting_key)) continue;
      const matches = semanticHistory.get(`${item.semantic_job_key}\0${item.posting_context_key}`) ?? [];
      if (!matches.length) continue;
      issues.push(jobIssue({
        posting_key: item.posting_key,
        stage: 'PRECOMMIT_IDENTITY',
        code: 'SEMANTIC_HISTORY_COLLISION',
        reason: 'Same semantic job and posting context was committed while scoring was in progress',
        evidence: { matches },
        existing_report: firstReportReference(matches.map(match => ({ prior_artifacts: [match.prior_artifact] }))),
      }));
    }
  }
  for (const item of scopedContractErrors) {
    if (issues.some(issue => issue.posting_key === item.posting_key)) continue;
    issues.push(jobIssue({
      posting_key: item.posting_key,
      stage: item.stage,
      code: item.code,
      reason: item.error,
      evidence: { contract_error: item.error },
    }));
  }
  return normalizeJobIssues(issues);
}

function validateTrackerAppend({ postingKey, record, report, beforeText, afterText, trackerParser }) {
  const before = parseTracker(beforeText, trackerParser);
  const after = parseTracker(afterText, trackerParser);
  const beforeByNumber = new Map(before.map(row => [row.number, row]));
  for (const row of before) {
    const next = after.find(value => value.number === row.number);
    if (!next || JSON.stringify(next.cells) !== JSON.stringify(row.cells)) {
      throw new JobScopedCommitError(postingKey, 'TRACKER_EXISTING_ROW_CHANGED', 'tracker merge rewrote or removed an existing row', {
        report_path: report.report_path,
        row_number: row.number,
      });
    }
  }
  const added = after.filter(row => !beforeByNumber.has(row.number));
  if (after.length !== before.length + 1 || added.length !== 1) {
    throw new JobScopedCommitError(postingKey, 'TRACKER_APPEND_COUNT_INVALID', `tracker merge must add exactly one row; added ${added.length}`, {
      before_rows: before.length,
      after_rows: after.length,
      report_path: report.report_path,
    });
  }
  const row = added[0];
  if (row.report_path !== report.report_path) {
    throw new JobScopedCommitError(postingKey, 'TRACKER_REPORT_MISMATCH', 'new tracker row does not point to the rendered report', {
      expected: report.report_path,
      actual: row.report_path,
    });
  }
  if (!trackerNoteHasPostingKey(row.notes, record.primary_key)) {
    throw new JobScopedCommitError(postingKey, 'TRACKER_IDENTITY_MISMATCH', 'new tracker row lacks the exact posting key', {
      expected_posting_key: record.primary_key,
      notes: row.notes ?? null,
    });
  }
  if (row.url !== null && row.url !== record.primary_url) {
    throw new JobScopedCommitError(postingKey, 'TRACKER_URL_MISMATCH', 'new tracker row URL does not equal the authoritative posting URL', {
      expected_posting_url: record.primary_url,
      actual_posting_url: row.url,
    });
  }
  return row;
}

export function runCareerCommand(careerRoot, script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: careerRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${script} failed: ${(result.stderr || result.stdout).trim()}`);
}

export async function loadCareerInterfaces(careerRoot) {
  const trackerUtilsFile = path.join(careerRoot, 'tracker-utils.mjs');
  const pipelineLockFile = path.join(careerRoot, 'pipeline-lock.mjs');
  for (const file of [trackerUtilsFile, pipelineLockFile]) if (!existsSync(file)) throw new Error(`Career-Ops canonical interface missing: ${file}`);
  const [trackerUtils, pipelineLock, trackerParser] = await Promise.all([
    import(pathToFileURL(trackerUtilsFile).href),
    import(pathToFileURL(pipelineLockFile).href),
    loadCareerTrackerParser(careerRoot),
  ]);
  if (typeof trackerUtils.openTrackerTransaction !== 'function'
      || typeof trackerUtils.resolveTrackerPath !== 'function'
      || typeof trackerUtils.writeFileAtomic !== 'function') {
    throw new Error(`Career-Ops tracker transaction interface is incompatible: ${trackerUtilsFile}`);
  }
  if (typeof pipelineLock.acquirePipelineLock !== 'function' || typeof pipelineLock.withPipelineLock !== 'function') {
    throw new Error(`Career-Ops pipeline lock interface is incompatible: ${pipelineLockFile}`);
  }
  return { trackerUtils, pipelineLock, trackerParser };
}

async function loadScanWriter(careerRoot) {
  const scanModule = path.join(careerRoot, 'scan.mjs');
  if (!existsSync(scanModule)) throw new Error(`Career-Ops canonical writer missing: ${scanModule}`);
  const previous = process.cwd();
  process.chdir(careerRoot);
  try {
    const writer = await import(`${pathToFileURL(scanModule).href}?daily=${Date.now()}-${Math.random()}`);
    if (typeof writer.appendToScanHistory !== 'function' || typeof writer.appendScanRunSummary !== 'function') {
      throw new Error(`Career-Ops scan writer is incompatible: ${scanModule}`);
    }
    return writer;
  } finally {
    process.chdir(previous);
  }
}

function resolveConfiguredCareerPath(careerRoot, configured, fallback) {
  const value = configured || fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(careerRoot, value);
}

function resolveOfficialTrackerPath(careerRoot, trackerUtils) {
  const previous = process.cwd();
  process.chdir(careerRoot);
  try {
    return trackerUtils.resolveTrackerPath(careerRoot);
  } finally {
    process.chdir(previous);
  }
}

function copyCandidateWorkspace({ careerRoot, trackerText, report, additionFile, workspace }) {
  const trackerFile = path.join(workspace, 'data/applications.md');
  const additionsDir = path.join(workspace, 'tracker-additions');
  const reportFile = path.resolve(workspace, report.report_path);
  if (!reportFile.startsWith(`${path.resolve(workspace)}${path.sep}`)) throw new Error('rendered report path escapes temporary workspace');
  mkdirSync(path.dirname(trackerFile), { recursive: true });
  mkdirSync(additionsDir, { recursive: true });
  mkdirSync(path.dirname(reportFile), { recursive: true });
  writeFileSync(trackerFile, trackerText);
  copyFileSync(path.join(careerRoot, report.report_path), reportFile);
  copyFileSync(additionFile, path.join(additionsDir, path.basename(additionFile)));
  return { trackerFile, additionsDir };
}

export async function appendCandidateTracker({
  careerRoot, trackerFile, trackerParser, openTrackerTransaction,
  postingKey, record, report, additionFile,
}) {
  const beforeText = readFileSync(trackerFile, 'utf8');
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'daily-scan-merge-preview-'));
  try {
    const preview = copyCandidateWorkspace({ careerRoot, trackerText: beforeText, report, additionFile, workspace });
    try {
      runCareerCommand(careerRoot, 'merge-tracker.mjs', [], {
        CAREER_OPS_TRACKER: preview.trackerFile,
        CAREER_OPS_ADDITIONS: preview.additionsDir,
        CAREER_OPS_PDF_INDEX: path.join(workspace, 'data/disabled-pdf-index.tsv'),
        CAREER_OPS_BATCH_STATE: path.join(workspace, 'data/disabled-batch-state.tsv'),
      });
    } catch (error) {
      throw new JobScopedCommitError(postingKey, 'TRACKER_MERGE_FAILED', error.message, { report_path: report.report_path });
    }
    const afterText = readFileSync(preview.trackerFile, 'utf8');
    const addedRow = validateTrackerAppend({ postingKey, record, report, beforeText, afterText, trackerParser });
    const transaction = await openTrackerTransaction(trackerFile);
    try {
      if (transaction.read() !== beforeText) {
        const error = new Error('Career-Ops tracker changed while this candidate was prepared; rerun the scan commit');
        error.code = 'TRACKER_CONCURRENT_UPDATE';
        throw error;
      }
      transaction.replace(afterText);
    } finally {
      transaction.close();
    }
    return addedRow;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function removeOwnedTrackerRows(trackerFile, rawRows, openTrackerTransaction) {
  const rows = [...new Set(rawRows)];
  if (!rows.length) return;
  const transaction = await openTrackerTransaction(trackerFile);
  try {
    const lines = transaction.read().split('\n');
    for (const raw of rows) {
      const matches = lines.flatMap((line, index) => line === raw ? [index] : []);
      if (matches.length !== 1) throw new Error(`owned tracker row changed or disappeared before compensation: ${raw}`);
      lines.splice(matches[0], 1);
    }
    transaction.replace(lines.join('\n'));
  } finally {
    transaction.close();
  }
}

async function compensateHistory(file, runId, pipelineLock, writeFileAtomic) {
  if (!existsSync(file)) return;
  const status = `daily-scan:${runId}`;
  await pipelineLock.withPipelineLock(file, () => {
    const text = readFileSync(file, 'utf8');
    const hadTrailingNewline = text.endsWith('\n');
    const lines = text.split(/\r?\n/);
    const kept = lines.filter(line => !line || line.split('\t')[5] !== status);
    let next = kept.join('\n');
    if (hadTrailingNewline && !next.endsWith('\n')) next += '\n';
    if (next !== text) writeFileAtomic(file, next);
  });
}

function buildScanRunSummary(run, offers) {
  return {
    timestamp: new Date().toISOString(),
    status: `complete:${path.basename(run.root)}`,
    companies: new Set(offers.map(offer => offer.company.toLowerCase())).size,
    boards: run.acquisition.sources.filter(item => item.status === 'SUCCESS').length,
    found: Number(run.acquisition.source_unique_count ?? run.records.length),
    filteredTitle: 0,
    filteredTier: 0,
    filteredLocation: Number(run.acquisition.location_exclusion_count ?? 0),
    filteredPostingAge: 0,
    filteredSalary: 0,
    filteredContent: 0,
    filteredCooldown: 0,
    dupes: Number(run.acquisition.duplicates_removed ?? 0),
    newAdded: offers.length,
    errors: 0,
  };
}

async function persistEvaluatedJobs({
  run, results, careerRoot, includeKeys, scanWriter, scanHistoryFile,
  pipelineLock, writeFileAtomic,
}) {
  const records = new Map(run.records.map(record => [record.primary_key, record]));
  const included = new Set(includeKeys);
  const accepted = results.evaluated.filter(result => included.has(result.posting_key));
  const jdRoot = path.join(careerRoot, 'jds');
  mkdirSync(jdRoot, { recursive: true });
  const touched = [];
  const offers = [];
  try {
    for (const result of accepted) {
      const record = records.get(result.posting_key);
      if (!record) throw new JobScopedCommitError(result.posting_key, 'JD_PERSIST_FAILED', 'acquisition record missing during JD persistence');
      const filename = `discovery-${path.basename(run.root)}-${record.primary_key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`;
      const destination = path.join(jdRoot, filename);
      try {
        if (existsSync(destination)) throw new Error('destination JD already exists');
        const staged = `${destination}.tmp-${process.pid}`;
        copyFileSync(path.join(run.root, record.jd_path), staged);
        renameSync(staged, destination);
        touched.push(destination);
        offers.push({
          url: record.primary_url,
          company: record.company,
          title: record.title,
          location: record.location,
          source: `job-discovery:${record.sources.join('+')}`,
          description: readFileSync(destination, 'utf8'),
          postedAt: record.posted_at ? Date.parse(record.posted_at) : undefined,
          note: `daily-scan=${path.basename(run.root)} posting_key=${record.primary_key} jd=jds/${filename}`,
        });
      } catch (error) {
        throw new JobScopedCommitError(result.posting_key, 'JD_PERSIST_FAILED', error.message, {
          jd_path: record.jd_path,
          destination: `jds/${filename}`,
        });
      }
    }
    const previous = process.cwd();
    process.chdir(careerRoot);
    try {
      await scanWriter.appendToScanHistory(offers, new Date().toISOString().slice(0, 10), `daily-scan:${path.basename(run.root)}`);
    } finally {
      process.chdir(previous);
    }
    return {
      evaluated_keys: accepted.map(item => item.posting_key).sort(),
      jd_files: touched.map(item => path.relative(careerRoot, item)),
      scan_run_summary: buildScanRunSummary(run, offers),
    };
  } catch (error) {
    try {
      await compensateHistory(scanHistoryFile, path.basename(run.root), pipelineLock, writeFileAtomic);
    } catch (compensationError) {
      error.message += `; scan-history compensation failed: ${compensationError.message}`;
    }
    for (const file of touched) rmSync(file, { force: true });
    throw error;
  }
}

async function commitScanLocked({ runRoot, careerRoot, date, interfaces }) {
  const receiptFile = path.join(runRoot, 'receipt.json');
  if (existsSync(receiptFile)) throw new Error(`receipt already exists: ${receiptFile}`);
  const mappingFile = path.join(runRoot, 'rendered-reports.json');
  if (existsSync(mappingFile)) throw new Error(`rendered report mapping already exists without a receipt: ${mappingFile}`);

  const { trackerUtils, pipelineLock, trackerParser } = interfaces;
  const trackerFile = resolveOfficialTrackerPath(careerRoot, trackerUtils);
  const scanHistoryFile = resolveConfiguredCareerPath(
    careerRoot,
    process.env.CAREER_OPS_SCAN_HISTORY,
    'data/scan-history.tsv',
  );
  const scanWriter = await loadScanWriter(careerRoot);
  const createdPaths = new Set();
  const ownedTrackerRows = [];
  let historyWritten = false;
  let mappingWritten = false;
  let finalizationStarted = false;
  let run;
  let results;
  let issues = [];
  let eligible = [];

  const restoreTransaction = async () => {
    try {
      await removeOwnedTrackerRows(trackerFile, ownedTrackerRows, trackerUtils.openTrackerTransaction);
    } catch (error) {
      throw new Error(`tracker compensation failed: ${error.message}`);
    }
    ownedTrackerRows.length = 0;
    if (historyWritten) {
      try {
        await compensateHistory(scanHistoryFile, path.basename(runRoot), pipelineLock, trackerUtils.writeFileAtomic);
      } catch (error) {
        throw new Error(`scan-history compensation failed: ${error.message}`);
      }
    }
    historyWritten = false;
    for (const file of createdPaths) rmSync(file, { recursive: true, force: true });
    createdPaths.clear();
    if (mappingWritten) rmSync(mappingFile, { force: true });
    mappingWritten = false;
  };

  const emergencyFailedReceipt = systemErrors => {
    const acquired = [...new Set((run?.acquisition?.keys ?? []).map(String))].sort();
    const receipt = {
      schema_version: 4,
      run_id: path.basename(runRoot),
      status: 'FAILED',
      acquired_keys: acquired,
      scored_keys: [],
      eligible_evaluated_keys: [],
      committed_evaluated_keys: [],
      evaluated_keys: [],
      job_issues: issues,
      job_issue_keys: issues.map(item => item.posting_key).sort(),
      job_issue_ratio: acquired.length ? issues.length / acquired.length : 1,
      persistence_decision: { allowed: false, has_successful_posting: false, reason: 'system-level failure prevented verified persistence' },
      terminal_equation: { committed_evaluated_count: 0, job_issue_count: issues.length, acquired_count: acquired.length, disjoint: true, valid: false },
      reports: [],
      tracker_keys: [],
      scan_history_keys: [],
      system_errors: systemErrors.map(String),
      errors: systemErrors.map(String),
    };
    return writeReceiptCreateOnly(receiptFile, receipt);
  };

  const failedReceipt = async (systemErrors = []) => {
    const errors = [...systemErrors];
    try { await restoreTransaction(); }
    catch (error) { errors.push(error.message); }
    try {
      const audited = await auditScanReceipt({
        runRoot,
        careerRoot,
        trackerFile,
        scanHistoryFile,
        jobIssues: issues,
        committedEvaluatedKeys: [],
        eligibleEvaluatedKeys: eligible,
        systemErrors: errors,
        requirePersistence: false,
      });
      return writeReceiptCreateOnly(audited.receiptFile, audited.receipt);
    } catch (error) {
      if (existsSync(receiptFile)) throw error;
      return emergencyFailedReceipt([...errors, `receipt verification failed: ${error.message}`]);
    }
  };

  try {
    run = validateRun(runRoot);
    results = loadScanResults(runRoot);
    assertBaselinePipeline(runRoot);
    const acquiredKeys = run.acquisition.keys.map(String);
    const scopedContractErrors = [];
    const systemRunErrors = run.errors.filter(error => {
      const key = acquiredKeys.find(value => error.startsWith(`${value}: JD `));
      if (key) scopedContractErrors.push({ posting_key: key, stage: 'COMMIT_PRECHECK', code: 'JD_CONTRACT_ERROR', error });
      return !key;
    });
    const systemResultErrors = results.errors.filter(error => {
      const key = acquiredKeys.find(value => error.startsWith(`${value}:`));
      if (key) scopedContractErrors.push({ posting_key: key, stage: 'RESULT_VALIDATION', code: 'REPORT_CONTRACT_ERROR', error });
      return !key;
    });
    if (systemRunErrors.length) throw new Error(`run contract failed: ${systemRunErrors.join('; ')}`);
    if (systemResultErrors.length) throw new Error(`result contract failed: ${systemResultErrors.join('; ')}`);
    issues = initialJobIssues(run, results, careerRoot, scopedContractErrors);
    const acquired = run.acquisition.keys.map(String);
    const recomputeEligible = () => {
      const issueKeys = new Set(issues.map(item => item.posting_key));
      eligible = results.evaluated.map(item => item.posting_key).filter(key => !issueKeys.has(key)).sort();
      return evaluatePersistence({ acquiredKeys: acquired, committedKeys: eligible, jobIssues: issues });
    };
    let persistence = recomputeEligible();
    if (!persistence.allowed) return await failedReceipt();

    const records = new Map(run.records.map(record => [record.primary_key, record]));
    const maxAttempts = results.candidates.length + 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const rendered = [];
      for (const candidate of results.candidates.filter(item => eligible.includes(item.posting_key))) {
        const itemRoot = mkdtempSync(path.join(os.tmpdir(), 'daily-scan-savepoint-'));
        const additionsDir = path.join(itemRoot, 'tracker-additions');
        mkdirSync(additionsDir, { recursive: true });
        let report = null;
        try {
          let reportResult;
          try {
            reportResult = renderScanReports({
              runRoot,
              careerRoot,
              date,
              includeKeys: [candidate.posting_key],
              writeOutput: false,
              ignoredJobIssueKeys: issues.map(item => item.posting_key),
              additionsDir,
              validated: { run, results },
            });
          } catch (error) {
            throw new JobScopedCommitError(candidate.posting_key, 'REPORT_RENDER_FAILED', error.message);
          }
          report = reportResult.reports[0];
          const reportFile = path.join(careerRoot, report.report_path);
          createdPaths.add(reportFile);
          const additions = readdirSync(additionsDir).filter(name => name.endsWith('.tsv'));
          if (additions.length !== 1) throw new JobScopedCommitError(candidate.posting_key, 'TRACKER_APPEND_COUNT_INVALID', `renderer must create exactly one tracker addition; found ${additions.length}`);
          const record = records.get(candidate.posting_key);
          const reportIdentity = readReportIdentity(readFileSync(reportFile, 'utf8'));
          if (reportIdentity.posting_url !== record.primary_url || reportIdentity.posting_key !== record.primary_key) {
            throw new JobScopedCommitError(candidate.posting_key, 'REPORT_IDENTITY_MISMATCH', 'rendered report lacks exact authoritative URL or posting key', { report_path: report.report_path });
          }
          const row = await appendCandidateTracker({
            careerRoot,
            trackerFile,
            trackerParser,
            openTrackerTransaction: trackerUtils.openTrackerTransaction,
            postingKey: candidate.posting_key,
            record,
            report,
            additionFile: path.join(additionsDir, additions[0]),
          });
          ownedTrackerRows.push(row.raw);
          rendered.push(report);
        } catch (error) {
          if (!(error instanceof JobScopedCommitError)) throw error;
          if (report) {
            const reportFile = path.join(careerRoot, report.report_path);
            rmSync(reportFile, { force: true });
            createdPaths.delete(reportFile);
          }
          issues = normalizeJobIssues([...issues, jobIssue({
            posting_key: error.postingKey,
            stage: 'CANDIDATE_SAVEPOINT',
            code: error.code,
            reason: error.message,
            evidence: error.evidence,
          })]);
        } finally {
          rmSync(itemRoot, { recursive: true, force: true });
        }
      }

      persistence = recomputeEligible();
      if (!persistence.allowed) return await failedReceipt();
      let persisted;
      try {
        persisted = await persistEvaluatedJobs({
          run,
          results,
          careerRoot,
          includeKeys: eligible,
          scanWriter,
          scanHistoryFile,
          pipelineLock,
          writeFileAtomic: trackerUtils.writeFileAtomic,
        });
        historyWritten = true;
        for (const relative of persisted.jd_files) createdPaths.add(path.join(careerRoot, relative));
      } catch (error) {
        if (error instanceof JobScopedCommitError) {
          await restoreTransaction();
          issues = normalizeJobIssues([...issues, jobIssue({
            posting_key: error.postingKey,
            stage: 'JD_PERSISTENCE',
            code: error.code,
            reason: error.message,
            evidence: error.evidence,
          })]);
          persistence = recomputeEligible();
          if (!persistence.allowed) return await failedReceipt();
          continue;
        }
        throw error;
      }
      runCareerCommand(careerRoot, 'tracker.mjs', ['sync'], { CAREER_OPS_TRACKER: trackerFile });
      atomicJson(mappingFile, { schema_version: 1, run_id: path.basename(runRoot), reports: rendered });
      mappingWritten = true;
      const audited = await auditScanReceipt({
        runRoot,
        careerRoot,
        trackerFile,
        scanHistoryFile,
        jobIssues: issues,
        committedEvaluatedKeys: eligible,
        eligibleEvaluatedKeys: eligible,
      });
      if (audited.receipt.status === 'COMPLETE') {
        finalizationStarted = true;
        scanWriter.appendScanRunSummary(persisted.scan_run_summary, path.join(careerRoot, 'data/scan-runs.tsv'));
        return writeReceiptCreateOnly(audited.receiptFile, audited.receipt);
      }
      throw new Error(`closeout verification failed: ${audited.receipt.errors.join('; ')}`);
    }
    throw new Error('candidate isolation retry bound exceeded');
  } catch (error) {
    if (finalizationStarted) throw error;
    if (!run || !results) return emergencyFailedReceipt([error.message]);
    return await failedReceipt([error.message]);
  }
}

/** Serialized owner of the only Career-Ops write phase. */
export async function commitScan(runDir, careerDir, date) {
  const runRoot = path.resolve(runDir);
  const careerRoot = path.resolve(careerDir);
  const plan = JSON.parse(readFileSync(path.join(runRoot, 'assignments.json'), 'utf8'));
  if (!plan.career_ops_root || path.resolve(plan.career_ops_root) !== careerRoot) {
    throw new Error('assignments Career-Ops root does not match commit target');
  }
  const interfaces = await loadCareerInterfaces(careerRoot);
  const lock = await interfaces.pipelineLock.acquirePipelineLock(path.join(careerRoot, '.daily-scan-commit'), {
    timeoutMs: 60_000,
    staleMs: 10 * 60_000,
  });
  try {
    return await commitScanLocked({ runRoot, careerRoot, date, interfaces });
  } finally {
    lock.release();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const at = process.argv.indexOf('--run');
    const careerAt = process.argv.indexOf('--career-ops');
    const run = at >= 0 ? process.argv[at + 1] : null;
    const career = careerAt >= 0 ? process.argv[careerAt + 1] : null;
    if (!run || !career) throw new Error('Usage: node src/commit-scan.mjs --run runs/<run-id> --career-ops ../career-ops [--date YYYY-MM-DD]');
    const dateAt = process.argv.indexOf('--date');
    const value = await commitScan(run, career, dateAt >= 0 ? process.argv[dateAt + 1] : new Date().toISOString().slice(0, 10));
    console.log(JSON.stringify(value, null, 2));
    if (value.receipt?.status === 'FAILED') process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
