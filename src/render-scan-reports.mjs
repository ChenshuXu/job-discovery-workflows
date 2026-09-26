import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { postingRequisition } from './posting-identity.mjs';
import { renderCompactReport } from './scan-report-contract.mjs';
export { discoveryVia } from './scan-report-contract.mjs';

const MAX_BATCH = 50;
const atomicWrite = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); const staged = `${file}.tmp-${process.pid}`; writeFileSync(staged, text); renameSync(staged, file); };
const slug = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'role';
const oneLine = value => String(value).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export function trackerIdentityNote(record) {
  const requisition = postingRequisition(record.primary_key);
  // Career-Ops' duplicate guard recognizes letters, digits, and hyphens in a
  // tagged requisition. Preserve the authoritative value as a second tagged
  // identity while leading with a lossless comparison alias for IDs that use
  // underscores or other separators. This keeps fuzzy title matching from
  // rebinding a distinct posting without changing Career-Ops code.
  const comparisonRequisition = requisition.replace(/[^A-Za-z0-9-]/g, '-');
  const identity = comparisonRequisition === requisition
    ? `job id ${requisition}`
    : `job id ${comparisonRequisition}; source job id ${requisition}`;
  return `Daily Scan evaluation; ${identity}; posting key ${record.primary_key}; live-role/Apply verification is deferred.`;
}

export function reserveScanReportNumbers(careerRoot, count) {
  const result = spawnSync(process.execPath, ['reserve-report-num.mjs', '--count', String(count)], { cwd: careerRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`report-number reservation failed: ${(result.stderr || result.stdout).trim()}`);
  const match = result.stdout.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`unexpected reservation output: ${result.stdout.trim()}`);
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function releaseScanReportNumbers(careerRoot, numbers) {
  if (!numbers.length) return;
  const ordered = [...numbers].sort((a, b) => a - b);
  for (let index = 0; index < ordered.length; index += MAX_BATCH) {
    const batch = ordered.slice(index, index + MAX_BATCH);
    const value = batch.length === 1 ? String(batch[0]) : `${batch[0]}-${batch.at(-1)}`;
    const result = spawnSync(process.execPath, ['reserve-report-num.mjs', '--release', value], { cwd: careerRoot, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`report-number release failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function reserveAll(careerRoot, count, reserveBatch, releaseBatch) {
  const numbers = [];
  try {
    for (let index = 0; index < count; index += MAX_BATCH) numbers.push(...reserveBatch(careerRoot, Math.min(MAX_BATCH, count - index)));
    if (numbers.length !== count || new Set(numbers).size !== count) throw new Error('invalid report-number reservation set');
    return numbers;
  } catch (error) {
    if (numbers.length) releaseBatch(careerRoot, numbers);
    throw error;
  }
}

export function scanReportStem(record, number) {
  return `${String(number).padStart(3, '0')}-${slug(record.company)}-${slug(record.title)}`;
}

export function renderScanReportDocument({ result, record, number, date, runId }) {
  const report = { company: record.company, role: record.title, archetype: result.report.archetype,
    work_auth: result.work_authorization.label, markdown: renderCompactReport({ result, record, runId }) };
  const linkedin = record.linkedin_id ? `**LinkedIn Job ID:** ${record.linkedin_id}  \n` : '';
  return `# Evaluation: ${report.company} — ${report.role}\n\n`
    + `**Report Number:** ${number}  \n**Date:** ${date}  \n`
    + `**Archetype:** ${report.archetype || 'Unstated'}  \n`
    + `**Score:** ${Number(result.score).toFixed(1)}/5  \n`
    + `**Legitimacy:** ${result.legitimacy_tier}  \n**Work Auth:** ${report.work_auth}  \n`
    + `**Location:** ${oneLine(record.location) || 'Unstated'}  \n**Workplace Type:** ${oneLine(record.workplace_type) || 'unknown'}  \n**Structured Remote Signal:** ${record.structured_remote_signal === true ? 'yes' : 'no'}  \n**Location Scope:** ${oneLine(record.location_scope?.decision) || 'unknown'}  \n`
    + `**URL:** ${record.primary_url}  \n**Posting Key:** ${record.primary_key}  \n${linkedin}`
    + `**PDF:** not generated — Daily Scan does not create PDFs\n\n---\n\n${report.markdown.trim()}\n`;
}

export function renderScanReports({
  runRoot, careerRoot, date, reserveBatch = reserveScanReportNumbers, releaseBatch = releaseScanReportNumbers,
  includeKeys = null, writeOutput = true, ignoredJobIssueKeys = [], additionsDir = null,
  validated = null,
}) {
  if (!validated?.run || !validated?.results) throw new Error('report rendering is owned by the serialized commit path');
  careerRoot = path.resolve(careerRoot);
  const run = validated.run;
  if (path.resolve(run.root) !== path.resolve(runRoot)) throw new Error('validated run does not match runRoot');
  const ignored = new Set(ignoredJobIssueKeys.map(String));
  const activeRunErrors = run.errors.filter(error => ![...ignored].some(key => error.startsWith(`${key}:`)));
  if (activeRunErrors.length) throw new Error(`run contract failed: ${activeRunErrors.join('; ')}`);
  const results = validated.results;
  if (!results.plan.career_ops_root || path.resolve(results.plan.career_ops_root) !== careerRoot) throw new Error('assignments Career-Ops root does not match report target');
  const activeResultErrors = results.errors.filter(error => ![...ignored].some(key => error.startsWith(`${key}:`)));
  if (activeResultErrors.length) throw new Error(`result contract failed: ${activeResultErrors.join('; ')}`);
  if (!results.evaluated.length) throw new Error('all evaluations failed; refusing Career-Ops writes');
  const records = new Map(run.records.map(record => [record.primary_key, record]));
  const requested = includeKeys == null ? null : new Set(includeKeys.map(String));
  const candidateKeys = new Set(results.candidates.map(item => item.posting_key));
  if (requested) for (const key of requested) if (!candidateKeys.has(key)) throw new Error(`${key}: requested report is not a candidate`);
  const candidates = results.candidates.filter(result => !requested || requested.has(result.posting_key)).map(result => ({ result, record: records.get(result.posting_key) }));
  for (const item of candidates) {
    if (!item.record) throw new Error(`${item.result.posting_key}: acquisition record missing`);
    item.report = {
      company: item.record.company, role: item.record.title,
      archetype: item.result.report.archetype, work_auth: item.result.work_authorization.label,
      markdown: renderCompactReport({ result: item.result, record: item.record, runId: results.plan.run_id }),
    };
  }
  const numbers = reserveAll(careerRoot, candidates.length, reserveBatch, releaseBatch);
  const assignments = candidates.map((item, index) => ({ posting_key: item.result.posting_key, report_number: numbers[index] }));
  const reports = [];
  const created = [];
  const trackerAdditionsRoot = additionsDir ? path.resolve(additionsDir) : path.join(careerRoot, 'batch/tracker-additions');
  try {
    for (const assignment of assignments) {
      const item = candidates.find(candidate => candidate.result.posting_key === assignment.posting_key);
      const number = String(assignment.report_number).padStart(3, '0');
      const stem = scanReportStem(item.record, number);
      const reportPath = `reports/${stem}-${date}.md`;
      const tsvPath = path.join(trackerAdditionsRoot, `${stem}.tsv`);
      const reportText = renderScanReportDocument({ ...item, number, date, runId: results.plan.run_id });
      const note = trackerIdentityNote(item.record);
      const tsv = 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\n'
        + `${[Number(number), date, oneLine(item.report.company), oneLine(item.report.role), 'Evaluated', `${Number(item.result.score).toFixed(1)}/5`, '❌', `[${Number(number)}](${reportPath})`, note].join('\t')}\n`;
      const reportFile = path.join(careerRoot, reportPath);
      const tsvFile = tsvPath;
      const sentinel = path.join(careerRoot, 'reports', `${number}-RESERVED.md`);
      if (existsSync(reportFile) || existsSync(tsvFile)) throw new Error(`${assignment.posting_key}: report or tracker addition already exists`);
      if (!existsSync(sentinel)) throw new Error(`${assignment.posting_key}: reservation sentinel missing`);
      atomicWrite(reportFile, reportText);
      created.push(reportFile);
      atomicWrite(tsvFile, tsv);
      created.push(tsvFile);
      unlinkSync(sentinel);
      reports.push({ posting_key: assignment.posting_key, report_number: assignment.report_number, report_path: reportPath });
    }
  } catch (error) {
    for (const file of created) rmSync(file, { force: true });
    try { releaseBatch(careerRoot, numbers); } catch (releaseError) { error.message += `; reservation cleanup failed: ${releaseError.message}`; }
    throw error;
  }
  const output = { schema_version: 1, run_id: path.basename(run.root), reports };
  const outputFile = path.join(run.root, 'rendered-reports.json');
  if (writeOutput) atomicWrite(outputFile, `${JSON.stringify(output, null, 2)}\n`);
  return { outputFile: writeOutput ? outputFile : null, reports };
}
