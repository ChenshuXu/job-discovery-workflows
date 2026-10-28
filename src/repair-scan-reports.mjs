#!/usr/bin/env node
import { resolveCareerPaths } from './career-ops-paths.mjs';
// An explicit, hash-bound repair of reports from one already completed scan.
// Raw parts and the original run's receipt/mapping/results are never rewritten.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkerParts } from './merge-worker-results.mjs';
import { applyScoringSafety, deriveReportWorkAuthorization } from './scoring-safety.mjs';
import { resolveCompactReport } from './expand-scan-report.mjs';
import { renderCompactReport, validateStructuredReport, splitPermHistoryReference, appendPermHistoryReference } from './scan-report-contract.mjs';
import { renderScanReports, renderScanReportDocument, reserveScanReportNumbers, releaseScanReportNumbers, scanReportStem, trackerIdentityNote } from './render-scan-reports.mjs';
import { appendCandidateTracker, loadCareerInterfaces, removeOwnedTrackerRows, runCareerCommand } from './commit-scan.mjs';
import { parseTracker, readReportIdentity, trackerNoteHasPostingKey } from './daily-scan-state.mjs';
import { runPipelineCheck } from './verify-scan-receipt.mjs';
import { auditPermHistory, renderPermHistoryReference } from './perm-history.mjs';


const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const fileContent = file => String(readFileSync(file));
const reportDate = header => header.match(/^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
const exact = (values, label) => { if (values.length !== 1) throw new Error(`${label}: expected exactly one match, found ${values.length}`); return values[0]; };
const manifestContent = manifest => String(JSON.stringify(manifest));
const repairFile = (careerRoot, runId) => path.join(resolveCareerPaths(careerRoot).dataRoot, 'data/daily-scan-repairs', `${runId}-reports.json`);

function validateManifest(manifest, runRoot) {
  if (!manifest || manifest.run_id !== path.basename(runRoot) || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > 20) throw new Error('explicit bounded manifest must name this run and 1-20 exact keys');
  const keys = manifest.entries.map(entry => entry.posting_key);
  if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) throw new Error('repair allowlist has missing or duplicate posting keys');
  for (const entry of manifest.entries) {
    if (!['Apply', 'Consider', 'Research first', 'Skip'].includes(entry.decision)
        || !(entry.report_number === null || Number.isSafeInteger(entry.report_number) && entry.report_number > 0)) throw new Error(`${entry.posting_key}: invalid desired effect`);
    for (const gap of [entry.remove_gap, entry.replace_gap?.original].filter(Boolean)) {
      if (typeof gap !== 'object' || Object.keys(gap).sort().join(',') !== 'explanation,locator,quote'
          || Object.values(gap).some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('gap correction requires the exact nonempty quote, locator and explanation');
      }
    }
    if (entry.replace_gap && (Object.keys(entry.replace_gap).sort().join(',') !== 'explanation,original'
        || typeof entry.replace_gap.explanation !== 'string' || !entry.replace_gap.explanation.trim())) throw new Error('replace_gap requires original and explanation');
    for (const edit of [entry.replace_reason].filter(Boolean)) {
      if (Object.keys(edit).sort().join(',') !== 'original,replacement'
          || Object.values(edit).some(value => typeof value !== 'string' || !value.trim())) throw new Error('wording correction requires original and replacement');
    }
    if (entry.corrected_result && (!path.isAbsolute(entry.corrected_result.path ?? '')
        || typeof entry.corrected_result.content !== 'string')) throw new Error('corrected_result requires an absolute path and content snapshot');
  }
}

function nextNumbers(careerRoot, rows, count) {
  const occupied = readdirSync(path.join(resolveCareerPaths(careerRoot).dataRoot, 'reports')).filter(name => !/^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => Number(name.match(/^(\d+)-/)?.[1])).filter(Number.isFinite);
  for (const row of rows) occupied.push(row.number, ...[...String(row.parsed.report).matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])));
  const first = Math.max(0, ...occupied) + 1;
  return Array.from({ length: count }, (_, index) => first + index);
}

function correctedDocument(resolved, result) {
  const header = resolved.header
    .replace(/^(\*\*Score:\*\*\s*)[^\r\n]*/m, `$1${Number(result.score).toFixed(1)}/5  `)
    .replace(/^(\*\*Work Auth:\*\*\s*)[^\r\n]*/m, `$1${result.work_authorization.label}  `);
  const markdown = renderCompactReport({ result, record: result._record, runId: resolved.runId });
  return `${header}${appendPermHistoryReference(markdown, splitPermHistoryReference(resolved.body).reference)}\n`;
}

function assertRowIdentity(row, record, reportPath) {
  if (row.report_path !== reportPath || !trackerNoteHasPostingKey(row.notes, record.primary_key)
      || row.url && row.url !== record.primary_url) throw new Error(`${record.primary_key}: tracker exact identity mismatch`);
}

// Only selected successful RAW entries are eligible. The shared validator also
// verifies candidate-source hashes and ordered part/assignment identity.
async function buildPlan({ runRoot, careerRoot, manifest, interfaces }) {
  validateManifest(manifest, runRoot);
  const assignmentsFile = path.join(runRoot, 'assignments.json');
  const plan = json(assignmentsFile);
  if (path.resolve(plan.career_ops_root) !== careerRoot || plan.run_id !== manifest.run_id) throw new Error('assignment run/Career-Ops identity mismatch');
  const receipt = json(path.join(runRoot, 'receipt.json'));
  if (receipt.status !== 'COMPLETE' || receipt.run_id !== manifest.run_id || receipt.terminal_equation?.valid !== true) throw new Error('report repair requires a completed, reconciled original run');
  const acquisition = json(path.join(runRoot, 'acquisition.json'));
  const mappings = json(path.join(runRoot, 'rendered-reports.json')).reports;
  const trackerFile = resolveCareerPaths(careerRoot).trackerFile;
  if (!path.isAbsolute(trackerFile)) throw new Error('canonical tracker path must be absolute');
  const trackerText = read(trackerFile);
  const rows = parseTracker(trackerText, interfaces.trackerParser);
  const sources = new Set([assignmentsFile, path.join(runRoot, 'receipt.json'), path.join(runRoot, 'acquisition.json'), path.join(runRoot, 'rendered-reports.json'), ...plan.candidate_sources.map(source => source.path)]);
  let permHistory = null;
  const baselineFile = path.join(runRoot, 'baseline.json');
  if (existsSync(baselineFile) && json(baselineFile).perm_history) {
    const scored = new Set(receipt.scored_keys);
    auditPermHistory({ runRoot, run: { records: acquisition.acquired },
      results: { byKey: new Map(acquisition.acquired.map(record => [record.primary_key, { status: scored.has(record.primary_key) ? 'EVALUATED' : 'FAILED' }])) },
      reports: [], requirePersistence: false });
    permHistory = json(path.join(runRoot, 'perm-history.json'));
    for (const file of [baselineFile, path.join(runRoot, 'perm-history.json'), path.join(runRoot, 'perm-history.md'), path.join(moduleRoot, 'perm-history.mjs'), path.join(moduleRoot, 'perm-history.py')]) sources.add(file);
  }
  for (const name of ['repair-scan-reports.mjs', 'merge-worker-results.mjs', 'scoring-safety.mjs', 'scan-report-contract.mjs', 'render-scan-reports.mjs', 'commit-scan.mjs', 'verify-scan-receipt.mjs', 'scoring-inputs.mjs', 'scoring-research.mjs', 'perm-employers.mjs']) sources.add(path.join(moduleRoot, name));
  const byWorker = new Map();
  const reserveNumbers = nextNumbers(careerRoot, rows, manifest.entries.filter(entry => entry.report_number === null).length);
  const selected = [];
  const candidateText = plan.candidate_sources.map(source => `\n--- ${source.label} ---\n${read(source.path)}`).join('');
  const reportFiles = readdirSync(path.join(resolveCareerPaths(careerRoot).dataRoot, 'reports')).filter(name => name.endsWith('.md') && !name.endsWith('-RESERVED.md'));
  for (const entry of manifest.entries) {
    const key = entry.posting_key;
    if (!receipt.committed_evaluated_keys?.includes(key)) throw new Error(`${key}: original run did not persist a successful evaluation`);
    const record = exact(acquisition.acquired.filter(record => record.primary_key === key), `${key}: acquisition`);
    const worker = exact(Object.keys(plan.assignments).filter(worker => plan.assignments[worker].includes(key)), `${key}: assignment`);
    if (!byWorker.has(worker)) byWorker.set(worker, validateWorkerParts(runRoot, worker, { collectItemErrors: true, checkPermLive: false }));
    const replay = byWorker.get(worker);
    const errors = replay.itemErrors.filter(error => error.startsWith(`${key}:`));
    if (errors.length) throw new Error(errors.join('; '));
    const part = exact(replay.parts.filter(part => part.artifact.results.some(item => item.posting_key === key)), `${key}: raw part`);
    let raw = exact(part.artifact.results.filter(item => item.posting_key === key), `${key}: raw result`);
    if (String(raw.status ?? 'EVALUATED').toUpperCase() !== 'EVALUATED') throw new Error(`${key}: failed raw entry cannot be report-repaired`);
    let result = structuredClone(exact(replay.results.filter(item => item.posting_key === key), `${key}: replay`));
    if (entry.corrected_result) {
      const file = entry.corrected_result.path;
      if (fileContent(file) !== entry.corrected_result.content) throw new Error(`${key}: corrected result hash changed`);
      const corrected = json(file);
      const allowed = new Set(['eligibility_status', 'eligibility_category', 'eligibility_evidence', 'rationale', 'report']);
      for (const field of new Set([...Object.keys(raw), ...Object.keys(corrected)])) {
        const addedUnstatedAuth = field === 'work_authorization' && raw[field] === undefined && !raw.report && corrected.report
          && JSON.stringify(corrected[field]) === JSON.stringify({ value: 'unstated', quote: null });
        if (!allowed.has(field) && !addedUnstatedAuth && JSON.stringify(raw[field]) !== JSON.stringify(corrected[field])) throw new Error(`${key}: correction cannot change ${field}`);
      }
      if (raw.report && JSON.stringify(raw.report) !== JSON.stringify(corrected.report)) throw new Error(`${key}: existing report edits require explicit wording corrections`);
      result = { ...applyScoringSafety({ item: corrected, jdText: read(path.join(runRoot, record.jd_path)), threshold: plan.runtime.reporting.full_report_threshold }),
        semantic_job_key: record.semantic_job_key, posting_context_key: record.posting_context_key };
      raw = corrected;
      sources.add(file);
    }
    if (result.report_decision !== entry.decision) throw new Error(`${key}: replay decision ${result.report_decision} does not match approved ${entry.decision}`);
    const jdFile = path.resolve(runRoot, record.jd_path);
    if (!jdFile.startsWith(`${runRoot}${path.sep}`)) throw new Error(`${key}: source JD escapes run`);
    const jdText = read(jdFile);
    sources.add(jdFile); sources.add(part.file); sources.add(path.join(runRoot, 'results', `${worker}.json`));
    const persistedJd = path.join(resolveCareerPaths(careerRoot).dataRoot, 'jds', `discovery-${manifest.run_id}-${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`);
    if (!existsSync(persistedJd) || read(persistedJd) !== jdText) throw new Error(`${key}: persisted source JD differs from the original run`);
    sources.add(persistedJd);
    const originalResult = exact(json(path.join(runRoot, 'results', `${worker}.json`)).results.filter(item => item.posting_key === key), `${key}: original final result`);
    if (result.report_decision === 'Skip' && entry.report_number !== null) {
      if (entry.report_number === null || !result.hard_exclusion || !originalResult.report) throw new Error(`${key}: only an existing evidenced hard-stop report may be retired`);
      result.report = { ...structuredClone(originalResult.report), reason: result.rationale, discard_reasons: [result.rationale] };
    }
    if (!result.report && entry.corrected_result && entry.report_number === null && !originalResult.report) {
      if (entry.remove_gap || entry.replace_gap || entry.replace_reason) throw new Error(`${key}: absent report cannot have report wording edits`);
      result.work_authorization = null;
      selected.push({ entry, record, result, effect: { posting_key: key, operation: 'evaluation-only', report_number: null, report_path: null,
        old_score: originalResult.score, new_score: result.score, old_decision: originalResult.report_decision, new_decision: result.report_decision,
        report_allowed: false, hard_exclusion: result.hard_exclusion, corrected_evaluation: result,
        tracker: { changed: false, note: null } } });
      continue;
    }
    if (!result.report) throw new Error(`${key}: source-locked report payload is required; repair never rescores or invents one`);
    if (entry.remove_gap) {
      const index = result.report.gaps.findIndex(gap => JSON.stringify(gap) === JSON.stringify(entry.remove_gap));
      if (index < 0 || result.report.gaps.filter(gap => JSON.stringify(gap) === JSON.stringify(entry.remove_gap)).length !== 1) throw new Error(`${key}: approved raw gap no longer matches exactly`);
      result.report.gaps.splice(index, 1);
    }
    if (entry.replace_gap) {
      const matches = result.report.gaps.filter(gap => JSON.stringify(gap) === JSON.stringify(entry.replace_gap.original));
      if (matches.length !== 1) throw new Error(`${key}: approved raw gap no longer matches exactly`);
      matches[0].explanation = entry.replace_gap.explanation;
    }
    if (entry.replace_reason) {
      if (result.report.reason !== entry.replace_reason.original) throw new Error(`${key}: approved report reason no longer matches exactly`);
      result.report.reason = entry.replace_reason.replacement;
    }
    validateStructuredReport(result.report, { jdText, resumeText: plan.candidate_sources.find(source => source.label === 'cv.md')?.content,
      requireHiringManagerReview: plan.hiring_manager_review_version === 1,
      research: result.research, eligibilityStatus: result.eligibility_status, schemaVersion: plan.result_schema_version, decision: result.report_decision, label: `${key}: repaired report` });
    result.work_authorization = deriveReportWorkAuthorization({ item: raw, jdText, candidateText });
    const existingMatches = reportFiles.filter(name => {
      const identity = readReportIdentity(read(path.join(resolveCareerPaths(careerRoot).dataRoot, 'reports', name)));
      return identity.posting_key === key || identity.posting_url === record.primary_url;
    });
    let number = entry.report_number;
    let reportPath, oldText = null, newText, oldRow = null;
    if (number !== null) {
      const mapping = exact(mappings.filter(mapping => mapping.posting_key === key && mapping.report_number === number), `${key}: original report mapping`);
      const resolved = resolveCompactReport(number, careerRoot, path.dirname(path.dirname(runRoot)));
      if (resolved.postingKey !== key || resolved.postingUrl !== record.primary_url || resolved.runId !== manifest.run_id
          || path.relative(resolveCareerPaths(careerRoot).dataRoot, resolved.reportFile) !== mapping.report_path || existingMatches.length !== 1) throw new Error(`${key}: report exact identity mismatch`);
      reportPath = mapping.report_path;
      if (existsSync(path.join(resolveCareerPaths(careerRoot).dataRoot, 'data/daily-scan-repairs', manifest.run_id, 'report-backups', path.basename(reportPath)))) throw new Error(`${key}: preexisting repair backup requires review`);
      oldText = resolved.original;
      const date = reportDate(resolved.header);
      const permReference = renderPermHistoryReference(permHistory, record, path.join(resolveCareerPaths(careerRoot).dataRoot, reportPath), runRoot);
      if (!date || oldText !== renderScanReportDocument({ result: originalResult, record, number: String(number).padStart(3, '0'), date, runId: manifest.run_id, permReference, permReportLayout: permHistory?.report_layout })) throw new Error(`${key}: existing report changed from original rendered evidence`);
      oldRow = exact(rows.filter(row => row.report_path === reportPath), `${key}: tracker report binding`);
      assertRowIdentity(oldRow, record, reportPath);
      if (oldRow.status !== 'Evaluated' || oldRow.parsed.pdf !== '❌' || oldRow.notes !== trackerIdentityNote(record)
          || oldRow.parsed.score !== `${Number(originalResult.score).toFixed(1)}/5` || oldRow.parsed.date !== date
          || oldRow.parsed.company !== String(record.company).replace(/\s+/g, ' ').trim()
          || oldRow.parsed.role !== String(record.title).replace(/\s+/g, ' ').trim()) throw new Error(`${key}: protected user-interacted tracker row`);
      newText = correctedDocument(resolved, { ...result, _record: record });
    } else {
      if (existingMatches.length || mappings.some(mapping => mapping.posting_key === key)
          || rows.some(row => trackerNoteHasPostingKey(row.notes, key) || row.url === record.primary_url)) throw new Error(`${key}: restore target already has a report or tracker row`);
      if (result.report_allowed !== true || result.hard_exclusion || result.score < plan.runtime.reporting.full_report_threshold) throw new Error(`${key}: restore target is not a candidate`);
      number = reserveNumbers.shift();
      const dateParts = manifest.run_id.match(/^(?:perm-)?(\d{4})(\d{2})(\d{2})-/);
      if (!dateParts) throw new Error(`${key}: restore requires a dated scan run id`);
      const date = dateParts.slice(1).join('-');
      reportPath = `reports/${scanReportStem(record, number)}-${date}.md`;
      const permReference = renderPermHistoryReference(permHistory, record, path.join(resolveCareerPaths(careerRoot).dataRoot, reportPath), runRoot);
      newText = renderScanReportDocument({ result, record, number: String(number).padStart(3, '0'), date, runId: manifest.run_id, permReference, permReportLayout: permHistory?.report_layout });
    }
    const status = result.report_decision === 'Skip' ? 'SKIP' : 'Evaluated';
    const trackerChanged = oldRow !== null && (Number(oldRow.parsed.score.replace('/5', '')) !== result.score || oldRow.status !== status);
    // Routine repair provenance belongs in this manifest, not a manual tracker
    // note: evaluated-only retention must continue to recognize untouched rows.
    const note = trackerChanged ? `Daily Scan ${manifest.run_id} report audit correction: ${result.rationale || result.report_decision} (original run preserved).` : null;
    selected.push({ entry, record, result, oldText, newText, oldRow, effect: {
      posting_key: key, operation: entry.report_number === null ? 'restore' : 'correct', report_number: number, report_path: reportPath,
      old_report_content: oldText === null ? null : String(oldText), new_report_content: String(newText),
      original_raw_fit_score: raw.fit_score, old_score: originalResult.score, new_score: result.score,
      old_decision: originalResult.report_decision, new_decision: result.report_decision,
      report_allowed: result.report_allowed, hard_exclusion: result.hard_exclusion,
      gap_removal: entry.remove_gap ?? null,
      gap_correction: entry.replace_gap ?? null,
      corrected_evaluation: entry.corrected_result ? result : null,
      tracker: { old_row_content: oldRow ? String(oldRow.raw) : null, status, changed: trackerChanged, note },
    } });
  }
  const sourceSnapshots = [...sources].sort().map(file => ({ path: file, content: fileContent(file) }));
  const output = {
    schema_version: 1, run_id: manifest.run_id, run_root: runRoot, career_ops_root: careerRoot,
    manifest_content: manifestContent(manifest), tracker_path: trackerFile, tracker_content: String(trackerText),
    reports_catalog_content: String(JSON.stringify(readdirSync(path.join(resolveCareerPaths(careerRoot).dataRoot, 'reports')).sort())),
    source_snapshots: sourceSnapshots, effects: selected.map(item => item.effect), original_run_untouched: true,
  };
  return { output, selected, trackerFile, plan, permHistory, run: { root: runRoot, records: selected.map(item => item.record), errors: [] } };
}

function verifySources(plan) {
  for (const source of plan.source_snapshots) if (!existsSync(source.path) || fileContent(source.path) !== source.content) throw new Error(`source changed since repair plan: ${source.path}`);
}

async function replaceRow({ trackerFile, expected, replacement, interfaces, ledger = '', onReplaced = () => {} }) {
  const transaction = await interfaces.trackerUtils.openTrackerTransaction(trackerFile);
  try {
    const text = transaction.read();
    const lines = text.split('\n');
    const index = exact(lines.flatMap((line, index) => line === expected ? [index] : []), 'tracker concurrent row precondition');
    lines[index] = replacement;
    transaction.replace(lines.join('\n'));
    onReplaced();
    const ledgerFile = path.join(path.dirname(trackerFile), 'status-log.tsv');
    const beforeLedger = existsSync(ledgerFile) ? read(ledgerFile) : '';
    if (ledger) {
      appendFileSync(ledgerFile, ledger);
      if (read(ledgerFile) !== beforeLedger + ledger) throw new Error('canonical status ledger append postcondition failed');
    }
    return { before_content: String(beforeLedger), after_content: String(beforeLedger + ledger), appended_content: String(ledger), appended_lines: ledger.split('\n').filter(Boolean).length, appended: ledger };
  } finally { transaction.close(); }
}

function previewRow({ careerRoot, trackerFile, row, score, status, note, interfaces }) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'daily-scan-report-status-'));
  try {
    const preview = path.join(temporary, 'applications.md');
    writeFileSync(preview, read(trackerFile));
    runCareerCommand(careerRoot, 'set-status.mjs', ['--report', String(row.report_path.match(/^reports\/(\d+)-/)[1]), status, '--note', note, '--json'], { CAREER_OPS_TRACKER: preview });
    const text = read(preview);
    const next = exact(parseTracker(text, interfaces.trackerParser).filter(item => item.number === row.number && item.report_path === row.report_path), 'canonical status preview row');
    const columns = interfaces.trackerParser.resolveColumns(text.split('\n'));
    const cells = next.raw.split('|').map(value => value.trim());
    cells[columns.score] = `${Number(score).toFixed(1)}/5`;
    const replacement = interfaces.trackerUtils.rebuildRow(cells);
    const ledgerFile = path.join(temporary, 'status-log.tsv');
    return { replacement, ledger: existsSync(ledgerFile) ? read(ledgerFile) : '' };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function applyPlan(value, interfaces, receiptFile) {
  const { output: plan, selected, trackerFile } = value;
  const careerRoot = plan.career_ops_root;
  const backupRoot = path.join(resolveCareerPaths(careerRoot).dataRoot, 'data/daily-scan-repairs', plan.run_id, 'report-backups');
  const pipelineBefore = runPipelineCheck(careerRoot, trackerFile);
  if (pipelineBefore.exit_code !== 0 || pipelineBefore.errors !== 0 || pipelineBefore.warnings !== 0) throw new Error(`report repair preflight pipeline failed: exit=${pipelineBefore.exit_code}, errors=${pipelineBefore.errors}, warnings=${pipelineBefore.warnings}`);
  const journal = { schema_version: 1, status: 'APPLYING', plan, pipeline_before: pipelineBefore, completed: [], rollback_errors: [] };
  mkdirSync(path.dirname(receiptFile), { recursive: true });
  writeFileSync(receiptFile, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
  const save = () => interfaces.trackerUtils.writeFileAtomic(receiptFile, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    for (const item of selected) {
      verifySources(plan);
      const { effect, record, result } = item;
      const completed = { ...effect, report_written: false, row_written: false, backup: null, row_after: null };
      journal.completed.push(completed); save();
      if (effect.operation === 'evaluation-only') continue;
      const target = path.join(resolveCareerPaths(careerRoot).dataRoot, effect.report_path);
      if (effect.operation === 'correct') {
        if (fileContent(target) !== effect.old_report_content) throw new Error(`${effect.posting_key}: report changed before correction`);
        mkdirSync(backupRoot, { recursive: true });
        completed.backup = path.join(backupRoot, path.basename(target));
        writeFileSync(completed.backup, item.oldText, { flag: 'wx' });
        save();
        const preview = effect.tracker.changed ? previewRow({ careerRoot, trackerFile, row: item.oldRow, score: effect.new_score, status: effect.tracker.status, note: effect.tracker.note, interfaces }) : null;
        interfaces.trackerUtils.writeFileAtomic(target, item.newText);
        completed.report_written = true; save();
        completed.row_after = item.oldRow.raw;
        if (preview) completed.ledger = await replaceRow({ trackerFile, expected: item.oldRow.raw, ...preview, interfaces,
          onReplaced: () => { completed.row_written = true; completed.row_after = preview.replacement; save(); } });
        save();
      } else {
        const temporary = mkdtempSync(path.join(os.tmpdir(), 'daily-scan-report-restore-'));
        try {
          const additionsDir = path.join(temporary, 'additions');
          const restoreResults = { plan: value.plan, errors: [], evaluated: [result], candidates: [result] };
          // Allocation stays canonical. A changed report-number landscape fails
          // before the renderer creates a report, even if the dry-run is stale.
          const reserveBatch = (root, count) => {
            const reserved = reserveScanReportNumbers(root, count);
            if (JSON.stringify(reserved) !== JSON.stringify([effect.report_number])) {
              releaseScanReportNumbers(root, reserved);
              throw new Error(`${effect.posting_key}: reserved report number changed; review a new dry run`);
            }
            return reserved;
          };
          const rendered = renderScanReports({ runRoot: plan.run_root, careerRoot, date: reportDate(item.newText),
            includeKeys: [effect.posting_key], writeOutput: false, additionsDir, validated: { run: value.run, results: restoreResults, permHistory: value.permHistory }, reserveBatch });
          const report = rendered.reports[0];
          completed.report_written = true; save();
          if (report.report_path !== effect.report_path || fileContent(target) !== effect.new_report_content) throw new Error(`${effect.posting_key}: restored report does not match approved plan`);
          const addition = exact(readdirSync(additionsDir).filter(name => name.endsWith('.tsv')), 'restore tracker addition');
          const row = await appendCandidateTracker({ careerRoot, trackerFile, trackerParser: interfaces.trackerParser,
            openTrackerTransaction: interfaces.trackerUtils.openTrackerTransaction, postingKey: effect.posting_key, record, report, additionFile: path.join(additionsDir, addition) });
          completed.row_written = true; completed.row_after = row.raw; save();
        } finally { rmSync(temporary, { recursive: true, force: true }); }
      }
    }
    runCareerCommand(careerRoot, 'tracker.mjs', ['sync'], { CAREER_OPS_TRACKER: trackerFile });
    journal.tracker_synced = true;
    journal.pipeline_after = runPipelineCheck(careerRoot, trackerFile);
    save();
    if (journal.pipeline_after.exit_code !== 0 || journal.pipeline_after.errors !== 0 || journal.pipeline_after.warnings !== 0) throw new Error(`report repair post-write pipeline failed: exit=${journal.pipeline_after.exit_code}, errors=${journal.pipeline_after.errors}, warnings=${journal.pipeline_after.warnings}`);
    verifySources(plan);
    const finalRows = parseTracker(read(trackerFile), interfaces.trackerParser);
    for (const item of journal.completed) {
      if (item.operation === 'evaluation-only') continue;
      if (fileContent(path.join(resolveCareerPaths(careerRoot).dataRoot, item.report_path)) !== item.new_report_content
          || finalRows.filter(row => row.raw === item.row_after).length !== 1) throw new Error(`${item.posting_key}: final report/row hash mismatch`);
    }
    journal.status = 'COMPLETE'; save();
    return journal;
  } catch (error) {
    for (const completed of [...journal.completed].reverse()) {
      try {
        const item = selected.find(item => item.effect.posting_key === completed.posting_key);
        if (completed.operation === 'evaluation-only') continue;
        const target = path.join(resolveCareerPaths(careerRoot).dataRoot, completed.report_path);
        // Check the whole owned savepoint before compensating either surface.
        // A user edit to its report must not silently roll its row back first.
        if (completed.report_written && fileContent(target) !== completed.new_report_content) throw new Error('report changed after repair; refusing rollback overwrite');
        if (completed.report_written && completed.operation === 'correct' && fileContent(completed.backup) !== completed.old_report_content) throw new Error('report backup hash mismatch');
        if (completed.row_written) {
          if (completed.operation === 'restore') await removeOwnedTrackerRows(trackerFile, [completed.row_after], interfaces.trackerUtils.openTrackerTransaction);
          else {
            const current = exact(parseTracker(read(trackerFile), interfaces.trackerParser).filter(row => row.raw === completed.row_after), 'rollback target row hash');
            const preview = previewRow({ careerRoot, trackerFile, row: current, score: item.effect.old_score, status: item.oldRow.status,
              note: `Daily Scan ${plan.run_id} report repair rolled back after failure; original report restored.`, interfaces });
            completed.rollback_ledger = await replaceRow({ trackerFile, expected: completed.row_after, ...preview, interfaces });
            completed.rollback_row_content = String(preview.replacement);
          }
        }
        if (completed.report_written) {
          if (completed.operation === 'restore') rmSync(target);
          else {
            interfaces.trackerUtils.writeFileAtomic(target, read(completed.backup));
          }
        }
      } catch (rollbackError) { journal.rollback_errors.push(`${completed.posting_key}: ${rollbackError.message}`); }
    }
    if (journal.completed.some(item => item.report_written || item.row_written)) {
      try {
        runCareerCommand(careerRoot, 'tracker.mjs', ['sync'], { CAREER_OPS_TRACKER: trackerFile });
        journal.rollback_tracker_synced = true;
        journal.rollback_pipeline = runPipelineCheck(careerRoot, trackerFile);
        if (journal.rollback_pipeline.exit_code !== 0 || journal.rollback_pipeline.errors !== 0 || journal.rollback_pipeline.warnings !== 0) throw new Error(`pipeline exit=${journal.rollback_pipeline.exit_code}, errors=${journal.rollback_pipeline.errors}, warnings=${journal.rollback_pipeline.warnings}`);
      } catch (syncError) { journal.rollback_errors.push(`compensated tracker synchronization/health failed: ${syncError.message}`); }
    }
    journal.status = 'FAILED'; journal.error = error.message; save();
    throw new Error(`report repair failed: ${error.message}; audit: ${receiptFile}${journal.rollback_errors.length ? '; rollback needs attention: ' + journal.rollback_errors.join('; ') : '; owned changes compensated (audit notes/backups retained)'}`);
  }
}

export async function repairScanReports({ runRoot, careerRoot, manifest, apply = false, expectedPlan = null }) {
  runRoot = path.resolve(runRoot); careerRoot = path.resolve(careerRoot);
  validateManifest(manifest, runRoot);
  const interfaces = await loadCareerInterfaces(careerRoot);
  if (typeof interfaces.trackerUtils.rebuildRow !== 'function') throw new Error('Career-Ops canonical row builder is required');
  const receiptFile = repairFile(careerRoot, manifest.run_id);
  if (existsSync(receiptFile)) {
    const prior = json(receiptFile);
    if (prior.status !== 'COMPLETE' || prior.plan.manifest_content !== manifestContent(manifest)) throw new Error(`existing report repair journal needs review: ${receiptFile}`);
    const rows = parseTracker(read(prior.plan.tracker_path), interfaces.trackerParser);
    for (const item of prior.completed) {
      if (item.operation === 'evaluation-only') continue;
      if (fileContent(path.join(resolveCareerPaths(careerRoot).dataRoot, item.report_path)) !== item.new_report_content || !rows.some(row => row.raw === item.row_after)) throw new Error('completed report repair state changed; refusing automatic reapply');
    }
    return { status: 'ALREADY_APPLIED', receipt_file: receiptFile, plan: prior.plan };
  }
  if (!apply) return { status: 'DRY_RUN', plan: (await buildPlan({ runRoot, careerRoot, manifest, interfaces })).output };
  if (!expectedPlan) throw new Error('--apply requires the reviewed --plan-file from a dry run');
  const lock = await interfaces.pipelineLock.acquirePipelineLock(path.join(resolveCareerPaths(careerRoot).dataRoot, '.daily-scan-commit'), { timeoutMs: 60_000, staleMs: 10 * 60_000 });
  try {
    const value = await buildPlan({ runRoot, careerRoot, manifest, interfaces });
    if (JSON.stringify(value.output) !== JSON.stringify(expectedPlan)) throw new Error('repair plan changed; dry-run and review again');
    return await applyPlan(value, interfaces, receiptFile);
  } finally { lock.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  try {
    if (!arg('--run') || !arg('--career-ops') || !arg('--manifest')) throw new Error('Usage: repair-scan-reports.mjs --run runs/<completed-run> --career-ops <root> --manifest <json> [--apply --plan-file <reviewed JSON file>]');
    console.log(JSON.stringify(await repairScanReports({ runRoot: arg('--run'), careerRoot: arg('--career-ops'), manifest: json(arg('--manifest')),
      apply: process.argv.includes('--apply'), expectedPlan: arg('--plan-file') ? (json(arg('--plan-file')).plan ?? json(arg('--plan-file'))) : null }), null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
