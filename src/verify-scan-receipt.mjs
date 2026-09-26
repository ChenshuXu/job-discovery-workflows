#!/usr/bin/env node
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotAdapterProfile } from './adapter-registry.mjs';
import {
  loadCareerTrackerParser,
  parseTracker,
  readReportIdentity,
  trackerNoteHasPostingKey,
} from './daily-scan-state.mjs';
import { evaluatePersistence, jobIssue, normalizeJobIssues } from './job-issue-policy.mjs';
import { loadLocationPolicy } from './location-scope.mjs';
import { postingKey } from './posting-identity.mjs';
import { validateRun } from './run-contract.mjs';
import { loadScanResults } from './scan-results.mjs';
import { finishScanUsage, observeScanUsage } from './scan-usage.mjs';

const unique = values => [...new Set((values ?? []).map(String))].sort();
const same = (left, right) => JSON.stringify(unique(left)) === JSON.stringify(unique(right));
const createJson = (file, value) => {
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { linkSync(staged, file); }
  finally { unlinkSync(staged); }
};

export function runPipelineCheck(careerRoot, trackerFile = null) {
  const env = trackerFile ? { ...process.env, CAREER_OPS_TRACKER: trackerFile } : process.env;
  const result = spawnSync(process.execPath, ['verify-pipeline.mjs'], { cwd: careerRoot, encoding: 'utf8', env });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/Pipeline Health:\s*(\d+) errors?/i);
  return { errors: match ? Number(match[1]) : result.status === 0 ? 0 : 1, exit_code: result.status };
}

export function captureBaseline({ runRoot, careerRoot, maintenance = null }) {
  const root = path.resolve(runRoot);
  const career = path.resolve(careerRoot);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'baseline.json');
  if (existsSync(file)) throw new Error(`baseline already exists: ${file}`);
  const baseline = {
    schema_version: 3,
    run_id: path.basename(root),
    captured_at: new Date().toISOString(),
    adapter_profile: snapshotAdapterProfile(),
    location_policy: loadLocationPolicy(path.join(career, 'config/profile.yml')),
    pipeline: runPipelineCheck(career),
    ...(maintenance ? { maintenance } : {}),
  };
  createJson(file, baseline);
  return { baseline, file };
}

function historyKeys(file, runId) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).flatMap(line => {
    const cells = line.split('\t');
    return cells[5] === `daily-scan:${runId}` ? [postingKey(cells[0])].filter(Boolean) : [];
  });
}

function resolveConfiguredCareerPath(careerRoot, configured, fallback) {
  const value = configured || fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(careerRoot, value);
}

async function resolveOfficialTrackerPath(careerRoot, requested) {
  if (requested) return path.resolve(requested);
  const trackerUtilsFile = path.join(careerRoot, 'tracker-utils.mjs');
  if (!existsSync(trackerUtilsFile)) throw new Error(`Career-Ops tracker interface missing: ${trackerUtilsFile}`);
  const trackerUtils = await import(pathToFileURL(trackerUtilsFile).href);
  if (typeof trackerUtils.resolveTrackerPath !== 'function') throw new Error(`Career-Ops tracker path interface is incompatible: ${trackerUtilsFile}`);
  const previous = process.cwd();
  process.chdir(careerRoot);
  try {
    return trackerUtils.resolveTrackerPath(careerRoot);
  } finally {
    process.chdir(previous);
  }
}

function workerIssues(results) {
  return results.failed.map(item => jobIssue({
    posting_key: item.posting_key,
    stage: 'SCORING',
    code: 'WORKER_FAILED',
    reason: item.error,
    evidence: { attempts: Number(item.attempts) },
  }));
}

export async function auditScanReceipt({
  runRoot, careerRoot, jobIssues = null, committedEvaluatedKeys = null,
  eligibleEvaluatedKeys = null, systemErrors = [], requirePersistence = true,
  trackerFile = null, scanHistoryFile = null,
}) {
  const root = path.resolve(runRoot);
  const career = path.resolve(careerRoot);
  const resolvedTrackerFile = await resolveOfficialTrackerPath(career, trackerFile);
  const resolvedScanHistoryFile = scanHistoryFile
    ? resolveConfiguredCareerPath(career, scanHistoryFile, 'data/scan-history.tsv')
    : resolveConfiguredCareerPath(career, process.env.CAREER_OPS_SCAN_HISTORY, 'data/scan-history.tsv');
  const run = validateRun(root);
  const results = loadScanResults(root);
  const baselineFile = path.join(root, 'baseline.json');
  if (!existsSync(baselineFile)) throw new Error(`baseline missing: ${baselineFile}`);
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const acquired = unique(run.acquisition.keys ?? []);
  const issues = normalizeJobIssues(jobIssues ?? workerIssues(results));
  const issueKeys = unique(issues.map(item => item.posting_key));
  const attributable = error => issueKeys.some(key => String(error).startsWith(`${key}:`));
  const errors = [...run.errors.filter(error => !attributable(error)), ...results.errors.filter(error => !attributable(error)), ...systemErrors.map(String)];
  if (!results.plan.career_ops_root || path.resolve(results.plan.career_ops_root) !== career) errors.push('assignments Career-Ops root does not match receipt target');
  const assignments = Object.values(results.plan.assignments ?? {}).flat();
  if (!same(acquired, assignments)) errors.push('acquisition.keys != assignments union');
  const returned = [...results.byKey.keys()];
  if (!same(assignments, returned)) errors.push('assignments union != results union');
  if (!same([...results.evaluated.map(item => item.posting_key), ...results.failed.map(item => item.posting_key)], acquired)) errors.push('evaluated + worker-failed != acquired');
  const identityAuditFile = path.join(root, 'triage/canonical-url-resolutions.json');
  if (!existsSync(identityAuditFile)) errors.push('canonical identity audit missing');
  else {
    const identityAudit = JSON.parse(readFileSync(identityAuditFile, 'utf8'));
    const semantic = identityAudit.semantic_deduplication;
    const locationFile = path.join(root, 'triage/location-scope.json');
    const location = existsSync(locationFile) ? JSON.parse(readFileSync(locationFile, 'utf8')) : null;
    if (!semantic || !Array.isArray(semantic.results) || !location?.results) errors.push('semantic deduplication audit missing or invalid');
    else {
      const accepted = unique(location.results.filter(item => item.allowed === true).map(item => item.posting_key));
      const semanticKeys = unique(semantic.results.map(item => item.primary_key));
      if (!same(accepted, semanticKeys)) errors.push('location accepted keys != semantic audit keys');
      const exact = semantic.results.filter(item => item.disposition === 'EXACT_HISTORY_DUPLICATE').map(item => item.primary_key);
      const aliases = semantic.results.filter(item => item.disposition === 'SAME_CONTEXT_SEMANTIC_ALIAS').map(item => item.primary_key);
      const planned = semantic.results.filter(item => item.disposition === 'ASSIGNMENT').map(item => item.primary_key);
      if (!same(planned, assignments)) errors.push('semantic audit assignment keys != assignments union');
      if (!same([...exact, ...aliases, ...planned], accepted)) errors.push('semantic identity partitions do not conserve location-accepted keys');
      const pairs = assignments.map(key => results.plan.semantic_identities?.[key]).map(item => `${item?.semantic_job_key ?? ''}\0${item?.posting_context_key ?? ''}`);
      if (pairs.some(pair => pair === '\0') || (results.plan.runtime.semantic_dedup_mode === 'enforce' && new Set(pairs).size !== pairs.length)) {
        errors.push('assignments are not unique by semantic/context identity');
      }
      const reportPairs = results.candidates.map(item => `${item.semantic_job_key}\0${item.posting_context_key}`);
      if (results.plan.runtime.semantic_dedup_mode === 'enforce' && new Set(reportPairs).size !== reportPairs.length) errors.push('report candidates are not unique by semantic/context identity');
    }
  }
  const evaluatedKeys = unique(results.evaluated.map(item => item.posting_key));
  const committed = unique(committedEvaluatedKeys ?? evaluatedKeys.filter(key => !issueKeys.includes(key)));
  const eligible = unique(eligibleEvaluatedKeys ?? committed);
  const unknownIssues = issueKeys.filter(key => !acquired.includes(key));
  const unknownCommitted = committed.filter(key => !acquired.includes(key));
  if (unknownIssues.length) errors.push(`job issues contain unknown keys: ${unknownIssues.join(', ')}`);
  if (unknownCommitted.length) errors.push(`committed evaluated contains unknown keys: ${unknownCommitted.join(', ')}`);
  const persistence = evaluatePersistence({
    acquiredKeys: acquired,
    committedKeys: eligible,
    jobIssues: issues,
  });
  if (!persistence.has_successful_posting) errors.push('zero eligible evaluated jobs');
  if (!persistence.terminal_equation_valid) errors.push('eligible evaluated + job issues != acquired');

  const terminalOverlap = committed.filter(key => issueKeys.includes(key));
  const terminalEquation = {
    committed_evaluated_count: committed.length,
    job_issue_count: issueKeys.length,
    acquired_count: acquired.length,
    disjoint: terminalOverlap.length === 0,
    valid: terminalOverlap.length === 0 && same([...committed, ...issueKeys], acquired),
  };
  if (requirePersistence && !terminalEquation.valid) errors.push('committed evaluated + job issues != acquired');

  const records = new Map(run.records.map(record => [record.primary_key, record]));
  const committedSet = new Set(committed);
  const committedResults = results.evaluated.filter(item => committedSet.has(item.posting_key));
  const committedCandidates = results.candidates.filter(item => committedSet.has(item.posting_key));
  const candidateKeys = committedCandidates.map(item => item.posting_key);
  const mappingFile = path.join(root, 'rendered-reports.json');
  const mapping = existsSync(mappingFile) ? JSON.parse(readFileSync(mappingFile, 'utf8')) : { reports: [] };
  const reports = Array.isArray(mapping.reports) ? mapping.reports : [];
  const reportKeys = reports.map(item => item.posting_key);
  const trackerText = existsSync(resolvedTrackerFile) ? readFileSync(resolvedTrackerFile, 'utf8') : '';
  const trackerParser = await loadCareerTrackerParser(career);
  const trackerRows = parseTracker(trackerText, trackerParser);
  const trackerKeys = [];
  const history = historyKeys(resolvedScanHistoryFile, path.basename(root));
  if (requirePersistence) {
    if (!existsSync(mappingFile)) errors.push('rendered-reports.json missing');
    if (!same(reportKeys, candidateKeys)) errors.push('report keys != committed candidate keys');
    for (const report of reports) {
      const record = records.get(report.posting_key);
      const reportFile = path.join(career, report.report_path);
      if (!record || !existsSync(reportFile)) { errors.push(`${report.posting_key}: report missing`); continue; }
      const reportIdentity = readReportIdentity(readFileSync(reportFile, 'utf8'));
      if (reportIdentity.posting_url !== record.primary_url || reportIdentity.posting_key !== record.primary_key) errors.push(`${report.posting_key}: report lacks exact primary identity URL/key`);
      const matching = trackerRows.filter(row => row.report_path === report.report_path);
      if (matching.length !== 1) errors.push(`${report.posting_key}: expected one tracker row, found ${matching.length}`);
      else if (!trackerNoteHasPostingKey(matching[0].notes, record.primary_key)) errors.push(`${report.posting_key}: tracker note lacks exact posting key`);
      else if (matching[0].url !== null && matching[0].url !== record.primary_url) errors.push(`${report.posting_key}: tracker URL does not equal primary URL`);
      else trackerKeys.push(report.posting_key);
    }
    if (!same(trackerKeys, candidateKeys)) errors.push('tracker keys != committed candidate keys');
    if (!same(history, committed)) errors.push('scan-history run rows != committed evaluated keys');
    for (const key of issueKeys) if (history.includes(key)) errors.push(`${key}: job issue key present in scan-history`);
  }

  const afterPipeline = runPipelineCheck(career, resolvedTrackerFile);
  if (afterPipeline.exit_code !== 0) errors.push(`Career-Ops pipeline verifier exited ${afterPipeline.exit_code}`);
  if (afterPipeline.errors) errors.push(`Career-Ops pipeline has ${afterPipeline.errors} error(s)`);

  const reportThreshold = Number(results.plan.runtime.reporting.full_report_threshold);
  const belowThresholdKeys = committedResults.filter(item => !item.hard_exclusion && Number(item.score) < reportThreshold).map(item => item.posting_key);
  const hardExclusion = committedResults.filter(item => item.hard_exclusion).map(item => item.posting_key);
  const locationScopeFile = path.join(root, 'triage/location-scope.json');
  const hasLocationScopeAudit = existsSync(locationScopeFile);

  const receipt = {
    schema_version: 4,
    run_id: path.basename(root),
    status: errors.length ? 'FAILED' : 'COMPLETE',
    acquired_keys: acquired,
    scored_keys: evaluatedKeys,
    eligible_evaluated_keys: eligible,
    committed_evaluated_keys: committed,
    evaluated_keys: committed,
    job_issues: issues,
    job_issue_keys: issueKeys,
    job_issue_ratio: persistence.ratio,
    persistence_decision: persistence,
    terminal_equation: terminalEquation,
    failed: results.failed.map(item => ({ posting_key: item.posting_key, error: item.error })),
    below_threshold_keys: unique(belowThresholdKeys),
    below_threshold_count: belowThresholdKeys.length,
    hard_exclusion_keys: unique(hardExclusion),
    location_exclusion_count: Number(run.acquisition.location_exclusion_count ?? 0),
    location_ambiguous_count: Number(run.acquisition.location_ambiguous_count ?? 0),
    location_scope_audit: hasLocationScopeAudit ? 'triage/location-scope.json' : null,
    candidate_keys: unique(candidateKeys),
    reports,
    tracker_keys: unique(trackerKeys),
    scan_history_keys: unique(history),
    career_ops_pipeline: { before: baseline.pipeline, after: afterPipeline },
    system_errors: systemErrors.map(String),
    errors: unique(errors),
  };
  const receiptFile = path.join(root, 'receipt.json');
  return { receipt, receiptFile };
}

export function writeReceiptCreateOnly(receiptFile, receipt) {
  const target = path.resolve(receiptFile);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  observeScanUsage(() => finishScanUsage(path.dirname(target)));
  return { receipt, receiptFile: target };
}

export async function verifyAndWriteReceipt(options) {
  const audited = await auditScanReceipt(options);
  return writeReceiptCreateOnly(audited.receiptFile, audited.receipt);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const value = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
    const runRoot = value('--run'); const careerRoot = value('--career-ops');
    if (!runRoot || !careerRoot) throw new Error('Usage: node src/verify-scan-receipt.mjs --run runs/<run-id> --career-ops ../career-ops [--capture-baseline]');
    const result = process.argv.includes('--capture-baseline') ? captureBaseline({ runRoot, careerRoot }) : await verifyAndWriteReceipt({ runRoot, careerRoot });
    console.log(JSON.stringify(result, null, 2));
    if (result.receipt?.status === 'FAILED') process.exit(1);
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
