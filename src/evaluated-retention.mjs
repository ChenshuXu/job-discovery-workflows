import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDailyScanRuntime } from './daily-scan-runtime.mjs';
import { loadCareerTrackerParser, parseTracker, readReportIdentity, trackerNoteHasPostingKey } from './daily-scan-state.mjs';
import { postingKey } from './posting-identity.mjs';
import { trackerIdentityNote } from './render-scan-reports.mjs';
import { runPipelineCheck } from './verify-scan-receipt.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_NAME = '.daily-scan-retention-recovery';
const RETENTION_STATUSES = new Set(['evaluated', 'skip', 'discarded']);
const retentionStatus = value => String(value ?? '').trim().toLowerCase().replace(/^skipped$/, 'skip');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readOptional = file => existsSync(file) ? readFileSync(file, 'utf8') : '';
const safeKey = key => key.replace(/[^A-Za-z0-9._-]/g, '-');

function createJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { linkSync(staged, file); }
  finally { try { unlinkSync(staged); } catch {} }
}

function dateOrdinal(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

function ordinalDate(ordinal) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

export function localCalendarDate(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function field(text, name) {
  return String(text).match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s{0,2}$`, 'mi'))?.[1]?.trim() ?? '';
}

function machineField(text, name) {
  const match = String(text).match(new RegExp(`^${name}:\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))\\s*$`, 'mi'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function notePostingKey(note) {
  return String(note).match(/(?:^|;\s*)posting key ([^;]+)(?:;|$)/)?.[1]?.trim() ?? '';
}

function canonicalKey(url) {
  try { return postingKey(url); } catch { return null; }
}

function filesBelow(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}

function isRegularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function containedFile(root, relative) {
  const file = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), file);
  return rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel) ? file : null;
}

function referencesNumber(text, number) {
  if (new RegExp(`(?:^|\\D)#${number}(?!\\d)`, 'm').test(text)) return true;
  return String(text).split(/\r?\n/).some(line => {
    if (!line.trimStart().startsWith('|')) return false;
    const cells = line.split('|').map(value => value.trim());
    return Number(cells[2]) === number;
  });
}

function canonicalKeysInText(text) {
  return new Set([...String(text).matchAll(/https?:\/\/[^\s<>'"`|)]+/gi)]
    .map(match => canonicalKey(match[0].replace(/[),.;]+$/, ''))).filter(Boolean));
}

function textHasIdentity(text, key, url, currentKey, currentKeys) {
  if (String(text).includes(key) || String(text).includes(url)) return true;
  return Boolean(currentKey && currentKeys.has(currentKey));
}

function reportArtifacts(careerRoot) {
  // ponytail: one full report scan per preflight; add an index only if this becomes a measured bottleneck.
  return filesBelow(path.join(path.resolve(careerRoot), 'reports')).filter(file => file.endsWith('.md')).map(file => {
    const text = readFileSync(file, 'utf8');
    const identity = readReportIdentity(text);
    return { file, text, ...identity, current_key: canonicalKey(identity.posting_url) };
  });
}

function protectedItem(row, reason) {
  return { tracker_number: row.number, reason };
}

export function buildEvaluatedRetentionPlan({
  trackerText, scanHistoryText, careerRoot, parser, asOfDate, ttlDays,
  statusLogText = '', followupsText = '', pdfIndexText = '', activeInterviewsText = '', pipelineText = '',
}) {
  const asOf = dateOrdinal(asOfDate);
  if (asOf == null) throw new Error(`invalid retention as-of date: ${asOfDate}`);
  if (!Number.isInteger(ttlDays) || ttlDays < 1) throw new Error('evaluated retention TTL must be a positive integer');

  const rows = parseTracker(trackerText, parser);
  const candidates = rows.filter(row => RETENTION_STATUSES.has(retentionStatus(row.status)));
  const historyLines = String(scanHistoryText).split(/\r?\n/);
  const historyCanonicalCounts = new Map();
  for (const line of historyLines) {
    const key = canonicalKey(line.split('\t')[0]);
    if (key) historyCanonicalCounts.set(key, (historyCanonicalCounts.get(key) ?? 0) + 1);
  }
  const pipelineCanonicalKeys = canonicalKeysInText(pipelineText);
  const reports = reportArtifacts(careerRoot);
  const protectedRows = [];
  const cleaned = [];
  let expiredCount = 0;

  for (const row of candidates) {
    const evaluated = dateOrdinal(row.parsed.date);
    if (evaluated == null || evaluated > asOf) {
      protectedRows.push(protectedItem(row, 'INVALID_OR_FUTURE_EVALUATED_DATE'));
      continue;
    }
    if (asOf - evaluated < ttlDays) continue;
    expiredCount += 1;

    const key = notePostingKey(row.notes);
    if (!key || !row.notes.startsWith('Daily Scan evaluation;')) {
      protectedRows.push(protectedItem(row, 'NOT_DAILY_SCAN_OWNED'));
      continue;
    }
    let expectedNote;
    try { expectedNote = trackerIdentityNote({ primary_key: key }); }
    catch {
      protectedRows.push(protectedItem(row, 'INVALID_POSTING_KEY'));
      continue;
    }
    if (row.notes !== expectedNote) {
      protectedRows.push(protectedItem(row, 'MANUAL_NOTE'));
      continue;
    }
    const history = String(statusLogText).split(/\r?\n/).map(line => line.split('\t'))
      .filter(cells => cells[0] === String(row.number));
    // Skipping/discarding an unsubmitted evaluation is now eligible. Any
    // application-stage, unknown, or inconsistent history still protects it.
    const terminalOnly = retentionStatus(row.status) !== 'evaluated' && history.every(cells =>
      cells.length >= 5 && dateOrdinal(cells[1]) != null && dateOrdinal(cells[1]) <= asOf
      && RETENTION_STATUSES.has(retentionStatus(cells[2])) && RETENTION_STATUSES.has(retentionStatus(cells[3])))
      && (!history.length || retentionStatus(history.at(-1)[3]) === retentionStatus(row.status));
    if (history.length && !terminalOnly) {
      protectedRows.push(protectedItem(row, 'STATUS_HISTORY'));
      continue;
    }
    if (row.parsed.pdf !== '❌' || String(pdfIndexText).split(/\r?\n/).some(line => Number(line.split('\t')[0]) === row.number)) {
      protectedRows.push(protectedItem(row, 'PDF_OR_OUTPUT'));
      continue;
    }
    if (referencesNumber(followupsText, row.number)) {
      protectedRows.push(protectedItem(row, 'FOLLOW_UP'));
      continue;
    }
    if (referencesNumber(activeInterviewsText, row.number)) {
      protectedRows.push(protectedItem(row, 'ACTIVE_INTERVIEW'));
      continue;
    }
    if (!row.report_path || rows.filter(item => item.report_path === row.report_path).length !== 1) {
      protectedRows.push(protectedItem(row, 'TRACKER_REPORT_NOT_UNIQUE'));
      continue;
    }

    const reportFile = containedFile(careerRoot, row.report_path);
    if (!reportFile || !isRegularFile(reportFile)) {
      protectedRows.push(protectedItem(row, 'REPORT_MISSING_OR_UNSAFE'));
      continue;
    }
    const reportText = readFileSync(reportFile, 'utf8');
    const reportIdentity = readReportIdentity(reportText);
    const runId = machineField(reportText, 'run_id');
    const machineKey = machineField(reportText, 'posting_key');
    const machineUrl = machineField(reportText, 'posting_url');
    const reportNumber = Number(field(reportText, 'Report Number'));
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || reportIdentity.posting_key !== key || machineKey !== key
        || !reportIdentity.posting_url || machineUrl !== reportIdentity.posting_url || reportNumber !== row.number) {
      protectedRows.push(protectedItem(row, 'REPORT_IDENTITY_MISMATCH'));
      continue;
    }
    const url = reportIdentity.posting_url;
    const currentKey = canonicalKey(url);
    const owners = reports.filter(item => item.file === reportFile || item.posting_key === key
      || item.posting_url === url || (currentKey && item.current_key === currentKey));
    if (owners.length !== 1 || owners[0].file !== reportFile) {
      protectedRows.push(protectedItem(row, 'REPORT_IDENTITY_NOT_UNIQUE'));
      continue;
    }
    if (rows.filter(item => trackerNoteHasPostingKey(item.notes, key)).length !== 1) {
      protectedRows.push(protectedItem(row, 'TRACKER_IDENTITY_NOT_UNIQUE'));
      continue;
    }
    if (textHasIdentity(pipelineText, key, url, currentKey, pipelineCanonicalKeys)) {
      protectedRows.push(protectedItem(row, 'PIPELINE_REFERENCE'));
      continue;
    }

    const expansionBackup = path.join(careerRoot, 'reports', '.expansion-backups', `${path.basename(reportFile)}.compact.md`);
    if (existsSync(expansionBackup)) {
      protectedRows.push(protectedItem(row, 'EXPANDED_REPORT'));
      continue;
    }
    const jdRelative = `jds/discovery-${runId}-${safeKey(key)}.md`;
    const jdFile = containedFile(careerRoot, jdRelative);
    if (!jdFile || !isRegularFile(jdFile)) {
      protectedRows.push(protectedItem(row, 'JD_MISSING_OR_UNSAFE'));
      continue;
    }
    const jdText = readFileSync(jdFile, 'utf8');
    const jdUrls = [field(jdText, 'URL'), field(jdText, 'Direct Job URL')].filter(Boolean);
    if (!jdUrls.includes(url) || field(jdText, 'Discovery Run') !== runId) {
      protectedRows.push(protectedItem(row, 'JD_IDENTITY_MISMATCH'));
      continue;
    }

    const exactHistory = historyLines.flatMap((line, index) => {
      const cells = line.split('\t');
      return cells[0] === url && cells[5] === `daily-scan:${runId}` ? [{ line, index }] : [];
    });
    const canonicalHistoryCount = currentKey ? historyCanonicalCounts.get(currentKey) ?? 0 : exactHistory.length;
    if (exactHistory.length !== 1 || canonicalHistoryCount !== 1) {
      protectedRows.push(protectedItem(row, 'SCAN_HISTORY_NOT_UNIQUE'));
      continue;
    }

    cleaned.push({
      tracker_number: row.number,
      status: row.status,
      tracker_raw: row.raw,
      report_path: row.report_path,
      report_file: reportFile,
      report_sha256: sha256(reportText),
      jd_path: jdRelative,
      jd_file: jdFile,
      jd_sha256: sha256(jdText),
      posting_key: key,
      posting_url: url,
      run_id: runId,
      scan_history_raw: exactHistory[0].line,
    });
  }

  const reasonCounts = Object.fromEntries([...Map.groupBy(protectedRows, item => item.reason)]
    .sort(([left], [right]) => left.localeCompare(right)).map(([reason, items]) => [reason, items.length]));
  return {
    as_of_date: asOfDate,
    ttl_days: ttlDays,
    cutoff_date: ordinalDate(asOf - ttlDays),
    evaluated_count: rows.filter(item => item.status === 'Evaluated').length,
    candidate_status_counts: Object.fromEntries([...RETENTION_STATUSES].map(status =>
      [status, candidates.filter(row => retentionStatus(row.status) === status).length])),
    expired_count: expiredCount,
    cleaned,
    protected: protectedRows,
    protected_reason_counts: reasonCounts,
  };
}

function removeExactRows(text, rawRows, label) {
  const rows = [...new Set(rawRows)];
  const lines = String(text).split(/\r?\n/);
  for (const raw of rows) {
    if (lines.filter(line => line === raw).length !== 1) throw new Error(`${label} row changed or is not unique`);
  }
  const remove = new Set(rows);
  const trailing = String(text).endsWith('\n');
  let next = lines.filter(line => !remove.has(line)).join('\n');
  if (trailing && !next.endsWith('\n')) next += '\n';
  return next;
}

function runTrackerSync(careerRoot, trackerFile) {
  const result = spawnSync(process.execPath, ['tracker.mjs', 'sync'], {
    cwd: careerRoot,
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_TRACKER: trackerFile },
  });
  if (result.status !== 0) throw new Error(`Career-Ops tracker sync failed: ${(result.stderr || result.stdout).trim()}`);
}

async function loadCareerInterfaces(careerRoot) {
  const trackerUtilsFile = path.join(careerRoot, 'tracker-utils.mjs');
  const pipelineLockFile = path.join(careerRoot, 'pipeline-lock.mjs');
  if (!existsSync(trackerUtilsFile) || !existsSync(pipelineLockFile)) throw new Error('Career-Ops tracker/lock interfaces are missing');
  const [trackerUtils, pipelineLock, parser] = await Promise.all([
    import(pathToFileURL(trackerUtilsFile).href),
    import(pathToFileURL(pipelineLockFile).href),
    loadCareerTrackerParser(careerRoot),
  ]);
  const previous = process.cwd();
  process.chdir(careerRoot);
  let trackerFile;
  try { trackerFile = trackerUtils.resolveTrackerPath(careerRoot); }
  finally { process.chdir(previous); }
  return {
    parser,
    trackerFile,
    resolvePdfIndexPath: trackerUtils.resolvePdfIndexPath,
    openTrackerTransaction: trackerUtils.openTrackerTransaction,
    writeFileAtomic: trackerUtils.writeFileAtomic,
    acquireCommitLock: () => pipelineLock.acquirePipelineLock(path.join(careerRoot, '.daily-scan-commit'), { timeoutMs: 60_000, staleMs: 10 * 60_000 }),
    withHistoryLock: (file, fn) => pipelineLock.withPipelineLock(file, fn),
    syncTracker: () => runTrackerSync(careerRoot, trackerFile),
    pipelineCheck: () => runPipelineCheck(careerRoot, trackerFile),
  };
}

function supportPaths(careerRoot, trackerFile, resolvePdfIndexPath, overrides = {}) {
  const workspace = path.dirname(careerRoot);
  const configured = (value, fallback) => path.isAbsolute(value || fallback)
    ? path.normalize(value || fallback)
    : path.resolve(careerRoot, value || fallback);
  return {
    scanHistory: configured(process.env.CAREER_OPS_SCAN_HISTORY, 'data/scan-history.tsv'),
    statusLog: path.join(path.dirname(trackerFile), 'status-log.tsv'),
    followups: configured(process.env.CAREER_OPS_FOLLOWUPS, 'data/follow-ups.md'),
    pdfIndex: resolvePdfIndexPath(trackerFile),
    activeInterviews: process.env.CAREER_OPS_ACTIVE_INTERVIEWS
      ? configured(process.env.CAREER_OPS_ACTIVE_INTERVIEWS, '')
      : path.join(workspace, 'career-docs/context/Interview/active-interviews.md'),
    pipeline: configured(process.env.CAREER_OPS_PIPELINE, 'data/pipeline.md'),
    ...overrides,
  };
}

function auditValue(runRoot, plan) {
  return {
    schema_version: 1,
    run_id: path.basename(runRoot),
    created_at: new Date().toISOString(),
    as_of_date: plan.as_of_date,
    ttl_days: plan.ttl_days,
    cutoff_date: plan.cutoff_date,
    evaluated_count: plan.evaluated_count,
    candidate_status_counts: plan.candidate_status_counts,
    expired_count: plan.expired_count,
    cleaned_count: plan.cleaned.length,
    protected_count: plan.protected.length,
    protected_reason_counts: plan.protected_reason_counts,
    cleaned: plan.cleaned.map(item => ({
      tracker_number: item.tracker_number,
      status: item.status,
      posting_key: item.posting_key,
      posting_url: item.posting_url,
      run_id: item.run_id,
      report_path: item.report_path,
      report_sha256: item.report_sha256,
      jd_path: item.jd_path,
      jd_sha256: item.jd_sha256,
    })),
    protected: plan.protected,
  };
}

function createRecovery(recoveryRoot, auditFile, careerRoot, trackerFile, scanHistoryFile, trackerText, historyText, cleaned) {
  mkdirSync(recoveryRoot);
  mkdirSync(path.join(recoveryRoot, 'files'));
  writeFileSync(path.join(recoveryRoot, 'tracker.before'), trackerText, { flag: 'wx' });
  writeFileSync(path.join(recoveryRoot, 'scan-history.before'), historyText, { flag: 'wx' });
  const files = cleaned.flatMap((item, index) => [
    { target: item.report_file, backup: path.join(recoveryRoot, 'files', `${index}-report.md`), sha256: item.report_sha256 },
    { target: item.jd_file, backup: path.join(recoveryRoot, 'files', `${index}-jd.md`), sha256: item.jd_sha256 },
  ]);
  const manifest = { schema_version: 1, audit_file: auditFile, career_root: careerRoot, tracker_file: trackerFile, scan_history_file: scanHistoryFile, files };
  createJson(path.join(recoveryRoot, 'manifest.json'), manifest);
  return manifest;
}

function assertRecoveryManifest(manifest, recoveryRoot, careerRoot, trackerFile, scanHistoryFile) {
  if (manifest?.schema_version !== 1 || path.resolve(manifest.career_root) !== careerRoot
      || path.resolve(manifest.tracker_file) !== trackerFile || path.resolve(manifest.scan_history_file) !== scanHistoryFile
      || !Array.isArray(manifest.files)) throw new Error('invalid evaluated-retention recovery manifest');
  for (const item of manifest.files) {
    if (!containedFile(careerRoot, path.relative(careerRoot, item.target))
        || !containedFile(recoveryRoot, path.relative(recoveryRoot, item.backup))) throw new Error('recovery manifest path escapes its owner');
  }
}

function restoreFiles(manifest) {
  for (const item of manifest.files) {
    const targetExists = existsSync(item.target);
    const backupExists = existsSync(item.backup);
    if (targetExists && sha256(readFileSync(item.target)) !== item.sha256) throw new Error(`recovery target changed: ${item.target}`);
    if (!targetExists && !backupExists) throw new Error(`recovery file missing from both locations: ${item.target}`);
    if (!targetExists) {
      mkdirSync(path.dirname(item.target), { recursive: true });
      renameSync(item.backup, item.target);
    }
  }
}

async function reconcileRecovery({ recoveryRoot, auditFile, careerRoot, paths, interfaces }) {
  if (!existsSync(recoveryRoot)) return;
  const manifestFile = path.join(recoveryRoot, 'manifest.json');
  if (!existsSync(manifestFile)) {
    rmSync(recoveryRoot, { recursive: true, force: true });
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assertRecoveryManifest(manifest, recoveryRoot, careerRoot, interfaces.trackerFile, paths.scanHistory);
  if (existsSync(manifest.audit_file)) {
    rmSync(recoveryRoot, { recursive: true, force: true });
    return;
  }
  const transaction = await interfaces.openTrackerTransaction(interfaces.trackerFile);
  try {
    await interfaces.withHistoryLock(paths.scanHistory, async () => {
      transaction.replace(readFileSync(path.join(recoveryRoot, 'tracker.before'), 'utf8'));
      interfaces.writeFileAtomic(paths.scanHistory, readFileSync(path.join(recoveryRoot, 'scan-history.before'), 'utf8'));
      restoreFiles(manifest);
      interfaces.syncTracker();
      const check = interfaces.pipelineCheck();
      if (check.exit_code !== 0 || check.errors || check.warnings !== 0) throw new Error('pipeline verification failed after evaluated-retention recovery');
    });
  } finally {
    transaction.close();
  }
  rmSync(recoveryRoot, { recursive: true, force: true });
}

export async function cleanupExpiredEvaluated({
  runRoot, careerRoot, asOfDate = localCalendarDate(), runtime = loadDailyScanRuntime(), interfaces = null, pathOverrides = {},
}) {
  const run = path.resolve(runRoot);
  const career = path.resolve(careerRoot);
  const auditFile = path.join(run, 'maintenance/evaluated-retention.json');
  mkdirSync(run, { recursive: true });
  const api = interfaces ?? await loadCareerInterfaces(career);
  const paths = supportPaths(career, api.trackerFile, api.resolvePdfIndexPath, pathOverrides);
  const recoveryRoot = path.join(career, RECOVERY_NAME);
  const lock = await api.acquireCommitLock();
  try {
    await reconcileRecovery({ recoveryRoot, auditFile, careerRoot: career, paths, interfaces: api });
    if (existsSync(auditFile)) return { audit: JSON.parse(readFileSync(auditFile, 'utf8')), auditFile };

    const transaction = await api.openTrackerTransaction(api.trackerFile);
    try {
      return await api.withHistoryLock(paths.scanHistory, async () => {
        const trackerText = transaction.read();
        const historyText = readOptional(paths.scanHistory);
        const plan = buildEvaluatedRetentionPlan({
          trackerText,
          scanHistoryText: historyText,
          careerRoot: career,
          parser: api.parser,
          asOfDate,
          ttlDays: runtime.retention.evaluated_unapplied_ttl_days,
          statusLogText: readOptional(paths.statusLog),
          followupsText: readOptional(paths.followups),
          pdfIndexText: readOptional(paths.pdfIndex),
          activeInterviewsText: readOptional(paths.activeInterviews),
          pipelineText: readOptional(paths.pipeline),
        });
        const audit = auditValue(run, plan);
        if (!plan.cleaned.length) {
          createJson(auditFile, audit);
          return { audit, auditFile };
        }

        const nextTracker = removeExactRows(trackerText, plan.cleaned.map(item => item.tracker_raw), 'tracker');
        const nextHistory = removeExactRows(historyText, plan.cleaned.map(item => item.scan_history_raw), 'scan-history');
        const manifest = createRecovery(recoveryRoot, auditFile, career, api.trackerFile, paths.scanHistory, trackerText, historyText, plan.cleaned);
        try {
          for (const item of manifest.files) {
            if (!isRegularFile(item.target) || sha256(readFileSync(item.target)) !== item.sha256) throw new Error(`cleanup artifact changed after validation: ${item.target}`);
            renameSync(item.target, item.backup);
          }
          transaction.replace(nextTracker);
          api.writeFileAtomic(paths.scanHistory, nextHistory);
          api.syncTracker();
          const check = api.pipelineCheck();
          if (check.exit_code !== 0 || check.errors || check.warnings !== 0) throw new Error('pipeline verification failed after evaluated-retention cleanup');
          createJson(auditFile, audit);
        } catch (error) {
          try {
            transaction.replace(trackerText);
            api.writeFileAtomic(paths.scanHistory, historyText);
            restoreFiles(manifest);
            api.syncTracker();
            const check = api.pipelineCheck();
            if (check.exit_code !== 0 || check.errors || check.warnings !== 0) throw new Error('pipeline verification failed after cleanup rollback');
            rmSync(recoveryRoot, { recursive: true, force: true });
          } catch (rollbackError) {
            error.message += `; rollback failed: ${rollbackError.message}; recovery retained at ${recoveryRoot}`;
          }
          throw error;
        }
        try { rmSync(recoveryRoot, { recursive: true, force: true }); } catch {}
        return { audit, auditFile };
      });
    } finally {
      transaction.close();
    }
  } finally {
    lock.release();
  }
}
