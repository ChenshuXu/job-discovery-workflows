#!/usr/bin/env node

// Transaction coordinator for the scheduled Gmail job-reply review.
//
// Gmail reads still happen through the approved connector/browser surfaces.
// This helper owns only the local run lease, classification ledger, verification
// delta, and recoverable state commit. It never reads or writes Gmail content.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  ActiveInterviewsLockError,
  assertInterviewProcessesPreserved,
  readInterviewProcessSummary,
  validateActiveInterviews,
  withActiveInterviewsLock,
} from './active-interviews.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const JOB_DISCOVERY_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');
let CAREER_OPS_ROOT;
let STATE_ROOT;
let RUNS_DIR;
let ACTIVE_PATH;
let COMPLETED_DIR;
let FAILED_DIR;
let PRIMARY_STATE_PATH;
let SECONDARY_STATE_PATH;
let ACTIVE_INTERVIEWS_PATH;
let APPLICATIONS_PATH;
let STATUS_LOG_PATH;
let withPipelineLock;
let renameSyncWithRetry = renameSync;
const LEASE_MS = 45 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_IDENTIFIERS = 1000;

const MAILBOXES = new Set(['primary', 'secondary']);
const CATEGORIES = new Set([
  'action_required',
  'explicit_rejection',
  'ambiguous',
  'application_confirmation',
  'superseded',
  'not_application',
]);
const DISPOSITIONS = new Set([
  'register_updated',
  'tracker_rejected',
  'needs_confirmation',
  'no_action',
  'deferred_mailbox_failure',
]);
const RECEIPT_TARGETS = new Set(['register', 'tracker']);
const ALLOWED_DISPOSITIONS = new Map([
  ['action_required', new Set(['register_updated', 'needs_confirmation'])],
  ['explicit_rejection', new Set(['tracker_rejected', 'no_action'])],
  ['ambiguous', new Set(['needs_confirmation', 'deferred_mailbox_failure'])],
  ['application_confirmation', new Set(['no_action'])],
  ['superseded', new Set(['register_updated', 'no_action'])],
  ['not_application', new Set(['no_action'])],
]);

function requiredReceiptTargets(classification) {
  if (classification.disposition === 'tracker_rejected') {
    return [
      ...(classification.tracker_identity_key ? ['tracker'] : []),
      ...(classification.interview_process_identity ? ['register'] : []),
    ];
  }
  if (['register_updated', 'needs_confirmation'].includes(classification.disposition)) {
    return ['register'];
  }
  return [];
}

function allowedReceiptTargets(classification) {
  return requiredReceiptTargets(classification);
}

function registerIdentity(classification) {
  return classification.interview_process_identity ?? classification.identity_key;
}

function trackerReceiptIdentity(classification) {
  return classification.tracker_identity_key ?? classification.identity_key;
}

class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

async function configure(options) {
  CAREER_OPS_ROOT = canonicalPath(requiredOption(options, 'career-ops-root'));
  ACTIVE_INTERVIEWS_PATH = canonicalPath(requiredOption(options, 'interviews-file'));
  const stateRoot = options.has('state-root')
    ? requiredOption(options, 'state-root')
    : join(JOB_DISCOVERY_ROOT, '.local', 'gmail-job-reply-review');
  STATE_ROOT = canonicalPath(stateRoot);
  RUNS_DIR = join(STATE_ROOT, 'runs');
  ACTIVE_PATH = join(RUNS_DIR, 'active.json');
  COMPLETED_DIR = join(RUNS_DIR, 'completed');
  FAILED_DIR = join(RUNS_DIR, 'failed');
  PRIMARY_STATE_PATH = join(STATE_ROOT, 'gmail-job-reply-state.json');
  SECONDARY_STATE_PATH = join(STATE_ROOT, 'gmail-job-reply-secondary-state.json');
  APPLICATIONS_PATH = join(CAREER_OPS_ROOT, 'data', 'applications.md');
  STATUS_LOG_PATH = join(CAREER_OPS_ROOT, 'data', 'status-log.tsv');

  try {
    ({ withPipelineLock } = await import(pathToFileURL(
      join(CAREER_OPS_ROOT, 'pipeline-lock.mjs'),
    ).href));
    ({ renameSyncWithRetry } = await import(pathToFileURL(
      join(CAREER_OPS_ROOT, 'tracker-utils.mjs'),
    ).href));
  } catch (error) {
    throw new CliError('INVALID_CONFIGURATION', 'Cannot load required workflow modules', {
      cause: error.message,
    });
  }
}

function parseArgs(argv) {
  const options = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals !== -1) {
      options.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(key, true);
    } else {
      options.set(key, next);
      i++;
    }
  }
  return { options, positionals };
}

function requiredOption(options, key) {
  const value = options.get(key);
  if (typeof value !== 'string' || !value) {
    throw new CliError('INVALID_ARGUMENT', `Missing --${key}`);
  }
  return value;
}

function validateMailbox(value) {
  if (!MAILBOXES.has(value)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid mailbox: ${value}`);
  }
  return value;
}

function validateOpaqueId(value) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid opaque identifier: ${value}`);
  }
  return value;
}

function validateIdentityKey(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string'
      || !/^(?:tracker:#\d+|action:[A-Za-z0-9._-]+|ambiguous:[A-Za-z0-9._-]+)$/.test(value)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid --identity-key');
  }
  return value;
}

function validateTrackerIdentityOption(value) {
  if (value === undefined) return null;
  const identity = trackerIdentity(value);
  if (!identity) throw new CliError('INVALID_ARGUMENT', 'Invalid --tracker-identity-key');
  return identity;
}

function requiredIntegerOption(options, key) {
  const value = requiredOption(options, key);
  if (!/^\d+$/.test(value)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid --${key}: ${value}`);
  }
  return Number(value);
}

function validateEventDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new CliError('INVALID_ARGUMENT', `Invalid --event-date: ${value}`);
  }
  return value;
}

function parseIso(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid ${label}: ${value}`);
  }
  return new Date(timestamp).toISOString();
}

function parseCandidateDescriptor(descriptor) {
  const separator = descriptor.lastIndexOf('@');
  if (separator <= 0 || separator === descriptor.length - 1) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Candidate must be OPAQUE_ID@RECEIVED_AT: ${descriptor}`,
    );
  }
  const opaqueId = validateOpaqueId(descriptor.slice(0, separator));
  const receivedAt = parseIso(descriptor.slice(separator + 1), 'received_at');
  return {
    key: `${opaqueId}@${receivedAt}`,
    opaque_id: opaqueId,
    received_at: receivedAt,
  };
}

function ensureDirectories() {
  for (const path of [RUNS_DIR, COMPLETED_DIR, FAILED_DIR]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError('INVALID_STATE', `Cannot read valid JSON: ${path}`, {
      cause: error.message,
    });
  }
}

function readFileSnapshot(path, optional = false) {
  if (!existsSync(path)) {
    if (optional) return { exists: false, raw: null, text: null, sha256: null };
    throw new CliError('INVALID_STATE', `Required file is missing: ${path}`);
  }
  try {
    const raw = readFileSync(path);
    return {
      exists: true,
      raw,
      text: raw.toString('utf8'),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
  } catch (error) {
    throw new CliError('INVALID_STATE', `Cannot snapshot file: ${path}`, {
      cause: error.message,
    });
  }
}

function readJsonSnapshot(path) {
  const snapshot = readFileSnapshot(path);
  try {
    return { ...snapshot, value: JSON.parse(snapshot.text) };
  } catch (error) {
    throw new CliError('INVALID_STATE', `Cannot read valid JSON: ${path}`, {
      cause: error.message,
    });
  }
}

function atomicWritePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSyncWithRetry(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function validateInterviewDocument(text, resolveSummaries = true) {
  try {
    const document = validateActiveInterviews(text);
    if (resolveSummaries) {
      for (const row of interviewRows(document)) row.summary = readInterviewProcessSummary(row, ACTIVE_INTERVIEWS_PATH);
    }
    return document;
  } catch (error) {
    throw new CliError('ACTIVE_INTERVIEWS_INVALID', error.message, {
      errors: Array.isArray(error.errors) ? error.errors : [],
    });
  }
}

function interviewProcessSnapshot(document) {
  return [
    ...document.active.map(row => ({
      identity: row.identity,
      kind: 'active',
      status: row.status,
      dateOrDeadline: row.dateOrDeadline,
      lastUpdated: row.lastUpdated,
    })),
    ...document.archived.map(row => ({
      identity: row.identity,
      kind: 'archived',
      status: row.status,
      dateOrDeadline: row.dateOrDeadline,
      lastUpdated: row.lastUpdated,
    })),
  ];
}

function validateInterviewContinuity(previousProcesses, text) {
  try {
    assertInterviewProcessesPreserved(previousProcesses, text, { registerPath: ACTIVE_INTERVIEWS_PATH });
  } catch (error) {
    throw new CliError('ACTIVE_INTERVIEWS_INVALID', error.message, {
      errors: Array.isArray(error.errors) ? error.errors : [],
    });
  }
}

function trackerIdentity(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^tracker:#\d+$/.test(trimmed)) return trimmed;
  if (/^#\d+$/.test(trimmed)) return `tracker:${trimmed}`;
  return null;
}

function interviewRows(document) {
  return [...document.active, ...document.archived];
}

function rejectionBinding(identityKey, document, requestedTrackerIdentity = null) {
  const rows = interviewRows(document);
  const inputTracker = trackerIdentity(identityKey);
  if (inputTracker && requestedTrackerIdentity && inputTracker !== requestedTrackerIdentity) {
    throw new CliError('INTERVIEW_TRACKER_MISMATCH', 'Classification contains two different tracker identities', {
      identity_key: identityKey,
      tracker_identity_key: requestedTrackerIdentity,
    });
  }
  const exactTracker = requestedTrackerIdentity ?? inputTracker;
  const matches = rows.filter((row) => (
    row.identity === identityKey
      || (inputTracker !== null && trackerIdentity(row.tracker) === inputTracker)
  ));
  if (matches.length > 1) {
    throw new CliError('AMBIGUOUS_INTERVIEW_IDENTITY', 'Tracker matches multiple interview processes', {
      identity_key: identityKey,
      lines: matches.map((row) => row.line),
    });
  }
  const process = matches[0] ?? null;
  if (requestedTrackerIdentity && !inputTracker && !process) {
    throw new CliError(
      'INVALID_IDENTITY',
      'A separate tracker identity requires one exact interview process identity',
      { identity_key: identityKey },
    );
  }
  const processTracker = trackerIdentity(process?.tracker);
  const linkedTracker = exactTracker ?? processTracker;
  if (!process && !linkedTracker) {
    throw new CliError('INVALID_IDENTITY', 'tracker_rejected requires an exact tracker or interview process identity', {
      identity_key: identityKey,
    });
  }
  if (exactTracker && processTracker && exactTracker !== processTracker) {
    throw new CliError('INTERVIEW_TRACKER_MISMATCH', 'Interview process Tracker conflicts with classification', {
      identity_key: identityKey,
      tracker_identity_key: exactTracker,
      process_line: process.line,
    });
  }
  const linkedRows = linkedTracker
    ? rows.filter((row) => trackerIdentity(row.tracker) === linkedTracker)
    : [];
  if (linkedRows.length > 1
      || (process && linkedRows.some(row => row.identity !== process.identity))) {
    throw new CliError('AMBIGUOUS_INTERVIEW_IDENTITY', 'Tracker is linked to multiple interview processes', {
      tracker_identity_key: linkedTracker,
      lines: linkedRows.map((row) => row.line),
    });
  }
  return {
    processIdentity: process?.identity ?? null,
    trackerIdentity: linkedTracker,
  };
}

function assertArchivedRejection(document, classification) {
  if (!classification.interview_process_identity) return;
  const row = document.archived.find(
    (item) => item.identity === classification.interview_process_identity,
  );
  if (!row || row.status !== 'Rejected') {
    throw new CliError('INTERVIEW_ARCHIVE_MISSING', 'Interview process is not archived as Rejected', {
      identity_key: classification.interview_process_identity,
      line: row?.line ?? null,
    });
  }
  if (classification.tracker_identity_key
      && trackerIdentity(row.tracker) !== classification.tracker_identity_key) {
    throw new CliError('INTERVIEW_TRACKER_MISMATCH', 'Archived process does not retain the resolved Tracker', {
      identity_key: classification.interview_process_identity,
      tracker_identity_key: classification.tracker_identity_key,
      line: row.line,
    });
  }
}

function assertRegisterMarker(document, classification, marker) {
  const identity = registerIdentity(classification);
  const linkedTracker = trackerIdentity(identity);
  const matches = interviewRows(document).filter((row) => (
    row.identity === identity
      || (linkedTracker !== null && trackerIdentity(row.tracker) === linkedTracker)
  ));
  if (matches.length !== 1 || !(matches[0].summary?.text ?? matches[0].notes).includes(marker)) {
    throw new CliError('REGISTER_RECEIPT_MISSING', 'Exact process marker is absent', {
      identity_key: identity,
      required_marker: marker,
      lines: matches.map((row) => row.line),
    });
  }
}

function replaceInterviewDocument(expectedHash, text) {
  const current = readFileSnapshot(ACTIVE_INTERVIEWS_PATH);
  if (current.sha256 !== expectedHash) {
    throw new CliError('STATE_CONFLICT', 'Interview document changed during update', {
      path: ACTIVE_INTERVIEWS_PATH,
      expected_sha256: expectedHash,
      current_sha256: current.sha256,
    });
  }
  const temporaryPath = join(
    dirname(ACTIVE_INTERVIEWS_PATH),
    `.${basename(ACTIVE_INTERVIEWS_PATH)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, text, 'utf8');
    assertInterviewHash(expectedHash, 'while writing the replacement');
    renameSyncWithRetry(temporaryPath, ACTIVE_INTERVIEWS_PATH);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.signal) {
    throw new CliError('GIT_COMMIT_FAILED', 'Git could not record interview document changes', {
      cause: result.error?.message ?? `signal ${result.signal}`,
    });
  }
  return result;
}

function assertInterviewHash(expectedHash, stage) {
  const current = readFileSnapshot(ACTIVE_INTERVIEWS_PATH);
  if (current.sha256 !== expectedHash) {
    throw new CliError('STATE_CONFLICT', `Interview document changed ${stage}`, {
      path: ACTIVE_INTERVIEWS_PATH,
      expected_sha256: expectedHash,
      current_sha256: current.sha256,
    });
  }
}

function interviewSummaryGuards(document) {
  return [...new Map(interviewRows(document).filter(row => row.summary).map(row => [
    row.summary.path, { path: row.summary.path, expected_sha256: row.summary.sha256 },
  ])).values()].sort((a, b) => a.path.localeCompare(b.path));
}

function interviewEvidenceHash(snapshot, document) {
  const summaries = interviewSummaryGuards(document);
  return summaries.length ? warningFingerprint(JSON.stringify([snapshot.sha256, summaries])) : snapshot.sha256;
}

function assertWorkspaceGuards(guards, stage) {
  for (const guard of guards) {
    if (readFileSnapshot(guard.path, true).sha256 !== guard.expected_sha256) {
      throw new CliError('STATE_CONFLICT', `Interview evidence changed ${stage}`, { path: guard.path });
    }
  }
}

function interviewGitRoot() {
  const result = runGit(['-C', dirname(ACTIVE_INTERVIEWS_PATH), 'rev-parse', '--show-toplevel']);
  if (result.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Interview document is not inside a Git repository');
  return canonicalPath(result.stdout.trim());
}

function summaryBaseline(document) {
  const gitRoot = interviewGitRoot();
  const linked = new Map(interviewSummaryGuards(document).map(guard => [guard.path, guard]));
  const files = runGit(['-C', gitRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `${relative(gitRoot, dirname(ACTIVE_INTERVIEWS_PATH))}/*/process-summary.md`]);
  if (files.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Cannot inspect existing process summaries');
  const paths = new Set([...linked.keys(), ...files.stdout.split('\0').filter(Boolean).map(file => join(gitRoot, file))]);
  return [...paths].map(path => {
    const status = runGit(['-C', gitRoot, 'status', '--porcelain=v1', '--', relative(gitRoot, path)]);
    if (status.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Cannot inspect process-summary Git state');
    return { path, expected_sha256: readFileSnapshot(path, true).sha256, linked: linked.has(path), dirty: Boolean(status.stdout.trim()) };
  });
}

function commitInterviewDocument(guards, baselineSummaries = []) {
  assertWorkspaceGuards(guards, 'before Git commit');
  const gitRoot = interviewGitRoot();
  const baseline = new Map(baselineSummaries.map(item => [item.path, item]));
  const targets = guards.filter(guard => {
    if (guard.path === ACTIVE_INTERVIEWS_PATH) return true;
    const previous = baseline.get(guard.path);
    if (previous?.expected_sha256 === guard.expected_sha256 && previous.linked) return false;
    if (previous?.dirty) throw new CliError('GIT_COMMIT_CONFLICT', 'Changed process summary already had local edits at begin', { path: guard.path });
    return true;
  });
  const files = targets.map(guard => relative(gitRoot, guard.path));
  if (files.some(file => !file || file.startsWith('..'))) throw new CliError('GIT_COMMIT_FAILED', 'Interview evidence is outside its Git repository');
  const tracked = runGit(['-C', gitRoot, 'ls-files', '--error-unmatch', '--', relative(gitRoot, ACTIVE_INTERVIEWS_PATH)]);
  if (tracked.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Interview document must be Git-tracked before the run');
  const status = runGit(['-C', gitRoot, 'status', '--porcelain=v1', '--', ...files]);
  if (status.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Cannot inspect interview evidence Git state');
  if (!status.stdout.trim()) return null;
  for (const file of files) {
    const known = runGit(['-C', gitRoot, 'ls-files', '--error-unmatch', '--', file]);
    if (known.status !== 0) {
      const added = runGit(['-C', gitRoot, 'add', '--intent-to-add', '--', file]);
      if (added.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Cannot include new process summary', { path: file });
    }
  }
  assertWorkspaceGuards(guards, 'before Git commit');
  const commit = runGit(['-C', gitRoot, 'commit', '--only', '-m', 'docs(interview): sync active interview register', '--', ...files]);
  if (commit.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Git commit for interview evidence failed', { stderr: commit.stderr.trim(), stdout: commit.stdout.trim() });
  assertWorkspaceGuards(guards, 'during Git commit');
  const head = runGit(['-C', gitRoot, 'rev-parse', 'HEAD']);
  if (head.status !== 0) throw new CliError('GIT_COMMIT_FAILED', 'Cannot resolve interview document commit');
  return head.stdout.trim();
}

function headInterviewDocument() {
  const rootResult = runGit(['-C', dirname(ACTIVE_INTERVIEWS_PATH), 'rev-parse', '--show-toplevel']);
  if (rootResult.status !== 0) {
    throw new CliError('GIT_COMMIT_FAILED', 'Interview document is not inside a Git repository');
  }
  const gitRoot = canonicalPath(rootResult.stdout.trim());
  const file = relative(gitRoot, ACTIVE_INTERVIEWS_PATH);
  if (!file || file.startsWith('..')) {
    throw new CliError('GIT_COMMIT_FAILED', 'Interview document is outside its Git repository');
  }
  const result = runGit(['-C', gitRoot, 'show', `HEAD:${file}`]);
  if (result.status !== 0) {
    throw new CliError('GIT_COMMIT_FAILED', 'Cannot read the committed interview document', {
      stderr: result.stderr.trim(),
    });
  }
  return result.stdout;
}

function checkedInterviewSnapshot() {
  const snapshot = readFileSnapshot(ACTIVE_INTERVIEWS_PATH);
  const committed = validateInterviewDocument(headInterviewDocument(), false);
  validateInterviewContinuity(interviewProcessSnapshot(committed), snapshot.text);
  const document = validateInterviewDocument(snapshot.text);
  return { snapshot, document, evidence_sha256: interviewEvidenceHash(snapshot, document) };
}

function interviewDocumentSummary(command, document, baselineSha256 = null) {
  return {
    command,
    ...(baselineSha256 ? { baseline_sha256: baselineSha256 } : {}),
    active: document.active.length,
    todos: document.todos.length,
    archived: document.archived.length,
  };
}

function interviewRegisterCommand(command, args) {
  const requiredArguments = { check: 1, prepare: 2, apply: 3 }[command];
  if (args.length !== requiredArguments) {
    throw new CliError(
      'INVALID_ARGUMENT',
      'Usage: gmail-job-reply-run.mjs check FILE | prepare FILE CANDIDATE | apply FILE CANDIDATE BASELINE_SHA256',
    );
  }

  const [filePath, candidatePath, expectedSha256] = args;
  ACTIVE_INTERVIEWS_PATH = canonicalPath(filePath);
  if (command === 'check') {
    return interviewDocumentSummary(command, checkedInterviewSnapshot().document);
  }

  const candidate = canonicalPath(candidatePath);
  if (candidate === ACTIVE_INTERVIEWS_PATH) {
    throw new CliError('INVALID_ARGUMENT', 'Candidate must be a separate file');
  }
  if (command === 'prepare') {
    return withActiveInterviewsLock(ACTIVE_INTERVIEWS_PATH, () => {
      const current = checkedInterviewSnapshot();
      writeFileSync(candidate, current.snapshot.text, { flag: 'wx', mode: 0o600 });
      return interviewDocumentSummary(command, current.document, current.evidence_sha256);
    });
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new CliError('INVALID_ARGUMENT', 'Expected baseline SHA-256 is required');
  }

  const candidateSnapshot = readFileSnapshot(candidate);
  const candidateDocument = validateInterviewDocument(candidateSnapshot.text);
  return withActiveInterviewsLock(ACTIVE_INTERVIEWS_PATH, () => {
    const current = checkedInterviewSnapshot();
    if (current.evidence_sha256 !== expectedSha256) {
      throw new CliError('STATE_CONFLICT', 'active-interviews.md changed since candidate preparation', {
        expected_sha256: expectedSha256,
        current_sha256: current.evidence_sha256,
      });
    }
    validateInterviewContinuity(
      interviewProcessSnapshot(current.document),
      candidateSnapshot.text,
    );
    assertWorkspaceGuards(interviewSummaryGuards(candidateDocument), 'before register replacement');
    replaceInterviewDocument(current.snapshot.sha256, candidateSnapshot.text);
    const result = interviewDocumentSummary(command, candidateDocument);
    try {
      rmSync(candidate, { force: true });
      return { ...result, candidate_removed: true };
    } catch (error) {
      return {
        ...result,
        candidate_removed: false,
        cleanup_warning: `Canonical update succeeded but candidate cleanup failed: ${error.message}`,
      };
    }
  });
}

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonFingerprint(value) {
  return warningFingerprint(serializedJson(value));
}

function warningFingerprint(text) {
  return createHash('sha256').update(text).digest('hex');
}

function fileFingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function compactWarningCapture(capture) {
  if (!capture) return null;
  return {
    errors: capture.errors,
    warnings: capture.warnings,
    exit_status: capture.exit_status,
    fingerprints: (capture.fingerprints ?? []).map((item) => ({ hash: item.hash })),
  };
}

function compactWarningDelta(delta) {
  if (!delta) return null;
  const compactItems = (items) => items.map(({ hash, count }) => ({ hash, count }));
  return {
    existing_count: delta.existing_count,
    added: compactItems(delta.added),
    resolved: compactItems(delta.resolved),
  };
}

function compactSyncCheck(syncCheck) {
  if (!syncCheck) return null;
  return {
    ok: syncCheck.ok,
    status: syncCheck.status,
    signal: syncCheck.signal,
  };
}

function safeCommandError(error) {
  const diagnostics = {};
  for (const [key, value] of Object.entries(error instanceof CliError ? error.details : {})) {
    if (typeof value === 'string') {
      diagnostics[key] = {
        byte_count: Buffer.byteLength(value),
        sha256: warningFingerprint(value),
      };
    } else if (value === null || ['number', 'boolean'].includes(typeof value)) {
      diagnostics[key] = value;
    }
  }
  return {
    code: error instanceof CliError ? error.code : 'INTERNAL_ERROR',
    message: error.message ?? String(error),
    diagnostics,
    recorded_at: nowIso(),
  };
}

function runWorkspaceCommand(script) {
  const result = spawnSync(process.execPath, [join(CAREER_OPS_ROOT, script)], {
    cwd: CAREER_OPS_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
    env: {
      ...process.env,
      CAREER_OPS_ROOT,
    },
  });
  if (result.error) {
    throw new CliError('COMMAND_FAILED', `${script} could not run`, {
      cause: result.error.message,
    });
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function captureVerify() {
  const result = runWorkspaceCommand('verify-pipeline.mjs');
  if (result.signal) {
    throw new CliError('VERIFY_FAILED', 'verify-pipeline.mjs failed to execute', {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr.trim(),
    });
  }
  const match = result.stdout.match(/Pipeline Health:\s*(\d+)\s+errors,\s*(\d+)\s+warnings/);
  if (!match) {
    throw new CliError('VERIFY_UNPARSEABLE', 'Could not parse verify summary');
  }
  const warningTexts = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('⚠️'));
  const errors = Number(match[1]);
  const warnings = Number(match[2]);
  if (warningTexts.length !== warnings) {
    throw new CliError('VERIFY_UNPARSEABLE', 'Warning total does not match warning lines', {
      summary_warnings: warnings,
      parsed_warning_lines: warningTexts.length,
    });
  }
  return {
    errors,
    warnings,
    exit_status: result.status,
    fingerprints: warningTexts.map((text) => ({
      hash: warningFingerprint(text),
      text,
    })),
  };
}

function captureSyncCheck() {
  const result = runWorkspaceCommand('cv-sync-check.mjs');
  return {
    ok: result.status === 0 && !result.signal,
    status: result.status,
    signal: result.signal,
    stderr: result.stderr.trim(),
  };
}

function warningDelta(before, after) {
  const countFingerprints = (items) => {
    const counts = new Map();
    for (const item of items) {
      const current = counts.get(item.hash) ?? { text: item.text, count: 0 };
      current.count++;
      counts.set(item.hash, current);
    }
    return counts;
  };
  const beforeMap = countFingerprints(before.fingerprints);
  const afterMap = countFingerprints(after.fingerprints);
  const hashes = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const added = [];
  const resolved = [];
  let existingCount = 0;
  for (const hash of hashes) {
    const beforeItem = beforeMap.get(hash);
    const afterItem = afterMap.get(hash);
    const beforeCount = beforeItem?.count ?? 0;
    const afterCount = afterItem?.count ?? 0;
    existingCount += Math.min(beforeCount, afterCount);
    if (afterCount > beforeCount) {
      added.push({ hash, text: afterItem.text, count: afterCount - beforeCount });
    }
    if (beforeCount > afterCount) {
      resolved.push({ hash, text: beforeItem.text, count: beforeCount - afterCount });
    }
  }
  return {
    existing_count: existingCount,
    added,
    resolved,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function leaseExpired(run) {
  const expiresAt = Date.parse(run.lease_expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function refreshLease(run) {
  const heartbeatAt = nowIso();
  run.heartbeat_at = heartbeatAt;
  run.lease_expires_at = new Date(Date.parse(heartbeatAt) + LEASE_MS).toISOString();
}

function validateCredentials(run, options) {
  validateRunConfiguration(run);
  const runId = requiredOption(options, 'run-id');
  const token = requiredOption(options, 'token');
  if (run.run_id !== runId || run.token !== token) {
    throw new CliError('FOREIGN_RUN', 'Run ID or token does not own the active lease');
  }
  if (leaseExpired(run)) {
    throw new CliError('LEASE_EXPIRED', 'The logical lease expired and cannot be revived', {
      run_id: run.run_id,
      phase: run.phase,
      lease_expires_at: run.lease_expires_at,
    });
  }
}

function validateRunConfiguration(run) {
  const expected = {
    career_ops_root: CAREER_OPS_ROOT,
    interviews_file: ACTIVE_INTERVIEWS_PATH,
    state_root: STATE_ROOT,
  };
  if (!run.configuration
      || Object.entries(expected).some(([key, value]) => run.configuration[key] !== value)) {
    throw new CliError('CONFIGURATION_CONFLICT', 'Run paths do not match the active ledger', {
      expected,
      actual: run.configuration ?? null,
    });
  }
}

function archivePath(directory, runId) {
  return join(directory, `${runId}.json`);
}

function archiveFailed(run, reasonCode, status = 'aborted') {
  const record = structuredClone(run);
  record.status = status;
  record.abort_reason_code = reasonCode;
  record.aborted_at = nowIso();
  delete record.token;
  if (record.verification) {
    record.verification.before = compactWarningCapture(record.verification.before);
    record.verification.after = compactWarningCapture(record.verification.after);
    record.verification.delta = compactWarningDelta(record.verification.delta);
  }
  if (record.workspace_baseline?.application_row_hashes) {
    record.workspace_baseline.application_row_count = Object.keys(
      record.workspace_baseline.application_row_hashes,
    ).length;
    delete record.workspace_baseline.application_row_hashes;
    delete record.workspace_baseline.application_row_statuses;
  }
  if (record.workspace_baseline?.status_log_line_counts) {
    record.workspace_baseline.status_log_distinct_line_count = Object.keys(
      record.workspace_baseline.status_log_line_counts,
    ).length;
    delete record.workspace_baseline.status_log_line_counts;
  }
  atomicWritePrivateJson(archivePath(FAILED_DIR, run.run_id), record);
}

function stateCursor(state, path) {
  if (!state || state.version !== 1 || typeof state.last_successful_run_at !== 'string') {
    throw new CliError('INVALID_STATE', `Unsupported mailbox state: ${path}`);
  }
  return parseIso(state.last_successful_run_at, `${basename(path)} cursor`);
}

function mailboxTemplate(statePath, state, cutoffAt) {
  const priorCursor = stateCursor(state, statePath);
  const searchAfterAt = new Date(Date.parse(priorCursor) - OVERLAP_MS).toISOString();
  const afterEpoch = Math.floor(Date.parse(searchAfterAt) / 1000);
  const beforeEpoch = Math.floor(Date.parse(cutoffAt) / 1000) + 1;
  return {
    state_path: statePath,
    prior_cursor_at: priorCursor,
    search_after_at: searchAfterAt,
    scan_cutoff_at: cutoffAt,
    required_query: `in:anywhere after:${afterEpoch} before:${beforeEpoch} -in:spam -in:trash`,
    status: 'pending',
    candidates: {},
    pages: [],
    pagination_complete: false,
    expected_page_token_hash: warningFingerprint('START'),
  };
}

function frozenCutoffIso() {
  // Gmail's numeric before: operator is second-granular. Freeze at the end of
  // the previous whole second so before:<next-second> exactly covers the
  // declared cutoff instead of silently including a future fraction.
  return new Date(Math.floor(Date.now() / 1000) * 1000 - 1).toISOString();
}

function publicRunSummary(run) {
  const summarizeMailbox = (mailbox) => ({
    prior_cursor_at: mailbox.prior_cursor_at,
    search_after_at: mailbox.search_after_at,
    scan_cutoff_at: mailbox.scan_cutoff_at,
    required_query: mailbox.required_query,
    status: mailbox.status,
    page_count: mailbox.pages.length,
    pagination_complete: mailbox.pagination_complete,
    next_page_expected: mailbox.expected_page_token_hash !== null,
    candidate_count: Object.keys(mailbox.candidates).length,
    classified_count: Object.values(mailbox.candidates)
      .filter((candidate) => candidate.classification !== null).length,
  });
  return {
    run_id: run.run_id,
    phase: run.phase,
    started_at: run.started_at,
    lease_expires_at: run.lease_expires_at,
    verification_baseline: {
      errors: run.verification.before.errors,
      warnings: run.verification.before.warnings,
    },
    interview_preflight: run.interview_preflight ?? null,
    mailboxes: {
      primary: summarizeMailbox(run.mailboxes.primary),
      secondary: summarizeMailbox(run.mailboxes.secondary),
    },
  };
}

function secondaryActualVersionMap(state) {
  const versions = new Map();
  if (Array.isArray(state.processed_thread_versions)) {
    for (const item of state.processed_thread_versions) {
      if (!item || typeof item.thread_token !== 'string') continue;
      const parsed = Date.parse(item.latest_received_at);
      if (!Number.isFinite(parsed)) continue;
      const current = versions.get(item.thread_token);
      if (!current || parsed > Date.parse(current)) {
        versions.set(item.thread_token, new Date(parsed).toISOString());
      }
    }
  }
  return versions;
}

function secondaryLegacyTokens(state) {
  const explicit = state.legacy_thread_tokens;
  if (Array.isArray(explicit)) {
    return new Set(explicit.filter((token) => typeof token === 'string'));
  }
  // Backward-compatible migration: pre-hardening state had only token-level
  // dedupe. Those tokens are known only through the old successful cursor, not
  // at a fabricated per-thread received timestamp.
  return new Set((state.processed_thread_tokens ?? [])
    .filter((token) => typeof token === 'string'));
}

function secondaryLegacyFloor(state) {
  if (typeof state.legacy_thread_token_floor_at === 'string') {
    return parseIso(state.legacy_thread_token_floor_at, 'legacy_thread_token_floor_at');
  }
  return stateCursor(state, SECONDARY_STATE_PATH);
}

function candidateAlreadyProcessed(mailbox, candidate, state) {
  if (mailbox === 'primary') {
    return new Set(state.processed_message_ids ?? []).has(candidate.opaque_id);
  }
  const priorVersion = secondaryActualVersionMap(state).get(candidate.opaque_id);
  if (priorVersion !== undefined) {
    return Date.parse(priorVersion) >= Date.parse(candidate.received_at);
  }
  return secondaryLegacyTokens(state).has(candidate.opaque_id)
    && Date.parse(secondaryLegacyFloor(state)) >= Date.parse(candidate.received_at);
}

function applicationRows(text) {
  if (typeof text !== 'string') {
    throw new CliError('INVALID_STATE', 'Application rows require one file snapshot');
  }
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (match) {
      const key = `tracker:#${match[1]}`;
      if (rows.has(key)) {
        throw new CliError('DUPLICATE_TRACKER_ID', `Tracker identity is not unique: ${key}`);
      }
      rows.set(key, line);
    }
  }
  return rows;
}

function applicationRowHashes(rows) {
  return Object.fromEntries([...rows].map(([key, line]) => [
    key,
    warningFingerprint(line),
  ]));
}

function applicationRowStatuses(rows) {
  return Object.fromEntries([...rows.keys()].map((key) => [
    key,
    parseApplicationRow(key, rows).status,
  ]));
}

function statusLogLineCounts(lines) {
  const counts = {};
  if (!Array.isArray(lines)) {
    throw new CliError('INVALID_STATE', 'Status-log counts require one file snapshot');
  }
  for (const line of lines) {
    if (!line) continue;
    const hash = warningFingerprint(line);
    counts[hash] = (counts[hash] ?? 0) + 1;
  }
  return counts;
}

function parseApplicationRow(identityKey, rows) {
  if (!(rows instanceof Map)) {
    throw new CliError('INVALID_STATE', 'Tracker lookup requires one application snapshot');
  }
  const line = rows.get(identityKey);
  if (!line) {
    throw new CliError('TRACKER_ROW_MISSING', `Tracker row does not exist: ${identityKey}`);
  }
  const fields = line.slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((value) => value.trim());
  return {
    line,
    status: fields[5],
    notes: fields.slice(8).join('|'),
  };
}

function assertTrackerRegisterSync(document, rows) {
  const archivedStatuses = {
    Rejected: 'Rejected',
    Withdrawn: 'Discarded',
    Cancelled: 'Discarded',
    Hired: 'Hired',
  };
  for (const [kind, processes] of [['active', document.active], ['archived', document.archived]]) {
    for (const process of processes) {
      const identity = trackerIdentity(process.tracker);
      if (!identity) continue;
      const expected = kind === 'active' ? ['Interview', 'Offer'] : [archivedStatuses[process.status]];
      const application = rows.has(identity) ? parseApplicationRow(identity, rows) : null;
      if (!expected.includes(application?.status)) {
        throw new CliError('TRACKER_REGISTER_MISMATCH', 'Interview process Tracker is missing or has a different status', {
          identity_key: process.identity,
          tracker_identity_key: identity,
          process_line: process.line,
          tracker_status: application?.status ?? null,
          expected_status: expected.join(' or '),
        });
      }
    }
  }
}

function captureWorkspaceBaseline() {
  const registerSnapshot = readFileSnapshot(ACTIVE_INTERVIEWS_PATH);
  const registerDocument = validateInterviewDocument(registerSnapshot.text);
  const applicationsSnapshot = readFileSnapshot(APPLICATIONS_PATH);
  const statusLogSnapshot = readFileSnapshot(STATUS_LOG_PATH, true);
  const rows = applicationRows(applicationsSnapshot.text);
  assertTrackerRegisterSync(registerDocument, rows);
  const statusLogLines = statusLogSnapshot.exists
    ? statusLogSnapshot.text.split(/\r?\n/)
    : [];
  return {
    active_interviews_sha256: interviewEvidenceHash(registerSnapshot, registerDocument),
    interview_summaries: summaryBaseline(registerDocument),
    applications_sha256: applicationsSnapshot.sha256,
    status_log_sha256: statusLogSnapshot.sha256,
    interview_processes: interviewProcessSnapshot(registerDocument),
    application_row_hashes: applicationRowHashes(rows),
    application_row_statuses: applicationRowStatuses(rows),
    status_log_line_counts: statusLogLineCounts(statusLogLines),
  };
}

function registerAuditMarker(identityKey, mailboxName, candidateKey) {
  const evidenceId = warningFingerprint(`${mailboxName}\0${candidateKey}`).slice(0, 16);
  return `Gmail evidence: ${identityKey} / ${evidenceId}`;
}

function buildPrimaryState(run, state) {
  const mailbox = run.mailboxes.primary;
  const newIds = Object.values(mailbox.candidates)
    .sort((left, right) => Date.parse(right.received_at) - Date.parse(left.received_at))
    .map((candidate) => candidate.opaque_id);
  const unique = [...new Set([...newIds, ...(state.processed_message_ids ?? [])])]
    .slice(0, MAX_IDENTIFIERS);
  return {
    ...state,
    version: 1,
    last_successful_run_at: mailbox.scan_cutoff_at,
    processed_message_ids: unique,
  };
}

function buildSecondaryState(run, state) {
  const mailbox = run.mailboxes.secondary;
  const versions = secondaryActualVersionMap(state);
  const legacyTokens = secondaryLegacyTokens(state);
  for (const candidate of Object.values(mailbox.candidates)) {
    const current = versions.get(candidate.opaque_id);
    if (!current || Date.parse(candidate.received_at) > Date.parse(current)) {
      versions.set(candidate.opaque_id, candidate.received_at);
    }
    legacyTokens.delete(candidate.opaque_id);
  }
  const processedThreadVersions = [...versions]
    .map(([thread_token, latest_received_at]) => ({ thread_token, latest_received_at }))
    .sort((left, right) => Date.parse(right.latest_received_at) - Date.parse(left.latest_received_at))
    .slice(0, MAX_IDENTIFIERS);
  const retainedLegacyTokens = [...legacyTokens]
    .slice(0, Math.max(0, MAX_IDENTIFIERS - processedThreadVersions.length));
  return {
    ...state,
    version: 1,
    last_successful_run_at: mailbox.scan_cutoff_at,
    processed_thread_tokens: [...new Set([
      ...processedThreadVersions.map((item) => item.thread_token),
      ...retainedLegacyTokens,
    ])],
    legacy_thread_token_floor_at: secondaryLegacyFloor(state),
    legacy_thread_tokens: retainedLegacyTokens,
    processed_thread_versions: processedThreadVersions,
  };
}

function assertMailboxStateUnchanged(run, mailboxName, state) {
  const mailbox = run.mailboxes[mailboxName];
  const currentCursor = stateCursor(state, mailbox.state_path);
  if (currentCursor !== mailbox.prior_cursor_at) {
    throw new CliError('STATE_CONFLICT', `${mailboxName} cursor changed during the run`, {
      expected_cursor_at: mailbox.prior_cursor_at,
      current_cursor_at: currentCursor,
    });
  }
}

function validateCommitGate(run) {
  const registerSnapshot = readFileSnapshot(ACTIVE_INTERVIEWS_PATH);
  const registerDocument = validateInterviewDocument(registerSnapshot.text);
  if (!Array.isArray(run.workspace_baseline.interview_processes)) {
    throw new CliError('INVALID_STATE', 'Interview-process baseline is unavailable');
  }
  validateInterviewContinuity(run.workspace_baseline.interview_processes, registerSnapshot.text);
  const checked = registerDocument.todos.filter(todo => todo.checked);
  if (checked.length) throw new CliError('INTERVIEW_RECONCILIATION_REQUIRED', 'Reconcile checked TODOs with Stage, Date / Deadline, Status and process-summary evidence before commit', { identities: [...new Set(checked.map(todo => todo.identity))] });
  const applicationsSnapshot = readFileSnapshot(APPLICATIONS_PATH);
  const statusLogSnapshot = readFileSnapshot(STATUS_LOG_PATH, true);
  const registerHash = interviewEvidenceHash(registerSnapshot, registerDocument);
  const applicationsHash = applicationsSnapshot.sha256;
  const statusLogHash = statusLogSnapshot.sha256;
  const applicationRowsSnapshot = applicationRows(applicationsSnapshot.text);
  assertTrackerRegisterSync(registerDocument, applicationRowsSnapshot);
  const statusLogLines = statusLogSnapshot.exists
    ? statusLogSnapshot.text.split(/\r?\n/)
    : [];
  const currentStatusLogCounts = statusLogLineCounts(statusLogLines);
  for (const [mailboxName, mailbox] of Object.entries(run.mailboxes)) {
    if (!['success', 'unavailable'].includes(mailbox.status)) {
      throw new CliError('MAILBOX_INCOMPLETE', `${mailboxName} mailbox is ${mailbox.status}`);
    }
    const unclassified = Object.values(mailbox.candidates)
      .filter((candidate) => candidate.classification === null)
      .map((candidate) => candidate.key);
    if (unclassified.length > 0) {
      throw new CliError('UNCLASSIFIED_CANDIDATES', `${mailboxName} has unclassified candidates`, {
        candidates: unclassified,
      });
    }
    if (mailbox.status === 'success') {
      if (mailbox.pages.length === 0 || !mailbox.pagination_complete
          || mailbox.expected_page_token_hash !== null) {
        throw new CliError('PAGINATION_INCOMPLETE', `${mailboxName} page chain is incomplete`);
      }
      const deferred = Object.values(mailbox.candidates)
        .filter((candidate) => candidate.classification.disposition === 'deferred_mailbox_failure');
      if (deferred.length > 0) {
        throw new CliError(
          'INVALID_CLASSIFICATION',
          `${mailboxName} cannot succeed with deferred candidates`,
        );
      }
    }
    for (const candidate of Object.values(mailbox.candidates)) {
      const classification = candidate.classification;
      const requiredTargets = requiredReceiptTargets(classification);
      const allowedTargets = allowedReceiptTargets(classification);
      if (classification.disposition === 'tracker_rejected') {
        assertArchivedRejection(registerDocument, classification);
      }
      const receipts = classification.receipts ?? [];
      for (const target of requiredTargets) {
        if (!receipts.some((item) => item.target === target)) {
          throw new CliError('WRITE_RECEIPT_MISSING', `${candidate.key} lacks ${target} receipt`);
        }
      }
      const unexpected = receipts.filter((item) => !allowedTargets.includes(item.target));
      if (unexpected.length > 0) {
        throw new CliError('UNEXPECTED_RECEIPT', `${candidate.key} has an unexpected receipt`);
      }
      for (const receipt of receipts) {
        const { target } = receipt;
        const expectedReceiptIdentity = target === 'tracker'
          ? trackerReceiptIdentity(classification)
          : registerIdentity(classification);
        if (receipt.identity_key !== expectedReceiptIdentity
            || receipt.process_identity_key !== registerIdentity(classification)) {
          throw new CliError('WRITE_RECEIPT_MISMATCH', `${candidate.key} receipt identity changed`);
        }
        if (target === 'register') {
          const marker = registerAuditMarker(
            registerIdentity(classification),
            mailboxName,
            candidate.key,
          );
          try {
            assertRegisterMarker(registerDocument, classification, marker);
          } catch (error) {
            throw new CliError(
              'REGISTER_RECEIPT_STALE',
              `${candidate.key} register marker is absent`,
              error instanceof CliError ? error.details : {},
            );
          }
          if (receipt.file_sha256 !== registerHash) {
            throw new CliError('REGISTER_RECEIPT_STALE', `${candidate.key} register marker is absent`);
          }
        } else {
          const trackerKey = trackerReceiptIdentity(classification);
          const row = parseApplicationRow(trackerKey, applicationRowsSnapshot);
          const baselineRowHash = run.workspace_baseline.application_row_hashes[
            trackerKey
          ] ?? null;
          const baselineRejected = run.workspace_baseline.application_row_statuses?.[
            trackerKey
          ] === 'Rejected';
          const expectedNote = `Gmail rejection received ${receipt.event_date}`;
          if ((!baselineRejected && warningFingerprint(row.line) === baselineRowHash)
              || warningFingerprint(row.line) !== receipt.tracker_row_sha256
              || row.status !== 'Rejected'
              || !hasTrackerRejectionNote(row.notes, expectedNote)
              || receipt.applications_sha256 !== applicationsHash
              || receipt.status_log_sha256 !== statusLogHash) {
            throw new CliError('TRACKER_RECEIPT_STALE', `${candidate.key} tracker state is absent`);
          }
          const exactLines = exactStatusLogLines(
            statusLogLines,
            trackerKey,
            receipt.event_date,
          );
          const exactHashPresent = exactLines.some(
            (line) => warningFingerprint(line) === receipt.status_log_line_sha256,
          );
          if (!exactHashPresent
              || (currentStatusLogCounts[receipt.status_log_line_sha256] ?? 0)
                !== receipt.status_log_line_count
              || (!baselineRejected
                && (currentStatusLogCounts[receipt.status_log_line_sha256] ?? 0)
                  <= (run.workspace_baseline.status_log_line_counts[
                    receipt.status_log_line_sha256
                  ] ?? 0))) {
            throw new CliError('TRACKER_RECEIPT_STALE', `${candidate.key} status log entry is absent`);
          }
        }
      }
    }
  }
  return {
    interview_evidence_sha256: registerHash,
    workspace_guards: [
      { path: ACTIVE_INTERVIEWS_PATH, expected_sha256: registerSnapshot.sha256 },
      { path: APPLICATIONS_PATH, expected_sha256: applicationsSnapshot.sha256 },
      { path: STATUS_LOG_PATH, expected_sha256: statusLogSnapshot.sha256 },
      ...interviewSummaryGuards(registerDocument),
    ],
  };
}

function completedRecord(run, completedAt, syncCheck, after, delta, finalGate) {
  const record = structuredClone(run);
  delete record.token;
  record.status = 'committed';
  record.phase = 'committed';
  record.completed_at = completedAt;
  record.authoritative = true;
  record.verification.before = compactWarningCapture(run.verification.before);
  record.verification.after = compactWarningCapture(after);
  record.verification.delta = compactWarningDelta(delta);
  delete record.verification.command_error;
  record.sync_check = compactSyncCheck(syncCheck);
  delete record.transaction;
  if (record.workspace_baseline?.application_row_hashes) {
    record.workspace_baseline.application_row_count = Object.keys(
      record.workspace_baseline.application_row_hashes,
    ).length;
    delete record.workspace_baseline.application_row_hashes;
    delete record.workspace_baseline.application_row_statuses;
  }
  if (record.workspace_baseline?.status_log_line_counts) {
    record.workspace_baseline.status_log_distinct_line_count = Object.keys(
      record.workspace_baseline.status_log_line_counts,
    ).length;
    delete record.workspace_baseline.status_log_line_counts;
  }
  const receipts = [];
  for (const [mailboxName, mailbox] of Object.entries(record.mailboxes)) {
    const candidates = Object.values(mailbox.candidates);
    mailbox.ledger_terminal = candidates.every((candidate) => candidate.classification !== null);
    mailbox.deferred_count = candidates.filter((candidate) => (
      candidate.classification?.disposition === 'deferred_mailbox_failure'
    )).length;
    mailbox.content_classification_complete = mailbox.status === 'success'
      && mailbox.pagination_complete
      && mailbox.ledger_terminal
      && mailbox.deferred_count === 0;
    mailbox.page_result_count = mailbox.pages
      .reduce((total, pageRecord) => total + pageRecord.result_count, 0);
    for (const candidate of candidates) {
      for (const item of candidate.classification?.receipts ?? []) {
        receipts.push({
          mailbox: mailboxName,
          candidate_key: candidate.key,
          identity_key: item.identity_key,
          process_identity_key: registerIdentity(candidate.classification),
          target: item.target,
          event_date: item.event_date ?? null,
        });
      }
    }
  }
  record.ledger_terminal = Object.values(record.mailboxes)
    .every((mailbox) => mailbox.ledger_terminal);
  record.content_classification_complete = Object.values(record.mailboxes)
    .every((mailbox) => mailbox.content_classification_complete);
  record.audit_status = record.content_classification_complete
    ? 'page_and_write_receipts_verified'
    : 'partial_mailbox_commit_with_terminal_deferral';
  // Backward-compatible name now means content was actually inspected, not
  // merely assigned a terminal deferred classification.
  record.classification_complete = record.content_classification_complete;
  record.writes = {
    interview_evidence_changed: run.workspace_baseline.active_interviews_sha256 !== finalGate.interview_evidence_sha256,
    receipt_count: receipts.length,
    register_receipt_count: receipts.filter((item) => item.target === 'register').length,
    tracker_receipt_count: receipts.filter((item) => item.target === 'tracker').length,
    receipts,
  };
  return record;
}

function commitSummary(completed, recoveredTransaction) {
  return {
    run_id: completed.run_id,
    status: completed.status,
    recovered_transaction: recoveredTransaction,
    ledger_terminal: completed.ledger_terminal,
    content_classification_complete: completed.content_classification_complete,
    classification_complete: completed.classification_complete,
    mailboxes: Object.fromEntries(Object.entries(completed.mailboxes).map(([name, mailbox]) => [
      name,
      {
        status: mailbox.status,
        page_count: mailbox.pages.length,
        pagination_complete: mailbox.pagination_complete,
        candidate_count: Object.keys(mailbox.candidates).length,
        ledger_terminal: mailbox.ledger_terminal,
        content_classification_complete: mailbox.content_classification_complete,
      },
    ])),
    verification: completed.verification,
    writes: completed.writes,
  };
}

function applyTransaction(run) {
  if (run.phase !== 'committing' || !run.transaction) {
    throw new CliError('INVALID_PHASE', 'No recoverable commit transaction exists');
  }
  if (!Array.isArray(run.transaction.workspace_guards)
      || run.transaction.workspace_guards.length < 3) {
    throw new CliError('INVALID_TRANSACTION', 'Workspace guards are absent');
  }
  for (const guard of run.transaction.workspace_guards) {
    const snapshot = readFileSnapshot(guard.path, true);
    if (snapshot.sha256 !== guard.expected_sha256) {
      throw new CliError('STATE_CONFLICT', 'Receipt source changed before cursor commit', {
        path: guard.path,
        expected_sha256: guard.expected_sha256,
        current_sha256: snapshot.sha256,
      });
    }
  }
  for (const target of run.transaction.state_targets) {
    if (!target.expected_before_sha256 || !target.target_sha256 || !existsSync(target.path)) {
      throw new CliError('INVALID_TRANSACTION', `State target is not safely replayable: ${target.path}`);
    }
    const currentHash = fileFingerprint(target.path);
    if (currentHash === target.target_sha256) continue;
    if (currentHash !== target.expected_before_sha256) {
      throw new CliError('STATE_CONFLICT', 'Prepared state target changed before recovery', {
        path: target.path,
        expected_before_sha256: target.expected_before_sha256,
        current_sha256: currentHash,
        target_sha256: target.target_sha256,
      });
    }
    atomicWritePrivateJson(target.path, target.value);
    if (fileFingerprint(target.path) !== target.target_sha256) {
      throw new CliError('STATE_WRITE_MISMATCH', `State target hash mismatch: ${target.path}`);
    }
  }
  const completedPath = archivePath(COMPLETED_DIR, run.run_id);
  const completedHash = run.transaction.completed_record_sha256;
  if (!completedHash) throw new CliError('INVALID_TRANSACTION', 'Completed-record hash is absent');
  if (existsSync(completedPath)) {
    if (fileFingerprint(completedPath) !== completedHash) {
      throw new CliError('STATE_CONFLICT', 'Completed ledger conflicts with prepared transaction');
    }
  } else {
    atomicWritePrivateJson(completedPath, run.transaction.completed_record);
    if (fileFingerprint(completedPath) !== completedHash) {
      throw new CliError('STATE_WRITE_MISMATCH', 'Completed ledger hash mismatch');
    }
  }
  rmSync(ACTIVE_PATH, { force: true });
  return run.transaction.completed_record;
}

async function begin() {
  ensureDirectories();
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (existsSync(ACTIVE_PATH)) {
      const active = readJson(ACTIVE_PATH);
      validateRunConfiguration(active);
      if (!leaseExpired(active)) {
        throw new CliError('LOCK_BUSY', 'Another Gmail review run owns the lease', {
          run_id: active.run_id,
          phase: active.phase,
          lease_expires_at: active.lease_expires_at,
        });
      }
      if (active.phase === 'committing' && active.transaction) {
        applyTransaction(active);
      } else {
        archiveFailed(active, 'stale_lease_reclaimed', 'abandoned');
        rmSync(ACTIVE_PATH, { force: true });
      }
    }

    const interviewPreflight = checkedInterviewSnapshot().document.todos.filter(todo => todo.checked);
    const startedAt = nowIso();
    const baseline = captureVerify();
    if (baseline.exit_status !== 0 || baseline.errors !== 0) {
      throw new CliError('PREFLIGHT_ERRORS', 'Preflight verify contains errors', {
        errors: baseline.errors,
        warnings: baseline.warnings,
        exit_status: baseline.exit_status,
      });
    }
    const cutoffAt = frozenCutoffIso();
    const heartbeatAt = nowIso();
    const primaryState = readJson(PRIMARY_STATE_PATH);
    const secondaryState = readJson(SECONDARY_STATE_PATH);
    const run = {
      schema_version: 2,
      run_id: randomUUID(),
      token: randomUUID(),
      status: 'active',
      phase: 'classifying',
      started_at: startedAt,
      heartbeat_at: heartbeatAt,
      lease_expires_at: new Date(Date.parse(heartbeatAt) + LEASE_MS).toISOString(),
      overlap_seconds: OVERLAP_MS / 1000,
      configuration: {
        career_ops_root: CAREER_OPS_ROOT,
        interviews_file: ACTIVE_INTERVIEWS_PATH,
        state_root: STATE_ROOT,
      },
      interview_preflight: {
        reconciliation_required: interviewPreflight.length > 0,
        checked_todo_count: interviewPreflight.length,
        checked_todos: interviewPreflight.map(({ identity, action, line }) => ({
          identity,
          line,
          action_sha256: warningFingerprint(action),
        })),
      },
      mailboxes: {
        primary: mailboxTemplate(PRIMARY_STATE_PATH, primaryState, cutoffAt),
        secondary: mailboxTemplate(SECONDARY_STATE_PATH, secondaryState, cutoffAt),
      },
      verification: {
        before: compactWarningCapture(baseline),
        after: null,
        delta: null,
        command_error: null,
      },
      sync_check: null,
      workspace_baseline: captureWorkspaceBaseline(),
    };
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return { ...publicRunSummary(run), token: run.token };
  });
}

function validatePageToken(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || /[\r\n]/.test(value)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid --${label}`);
  }
  return value;
}

function stagePageCandidates(run, mailboxName, candidates) {
  const mailbox = run.mailboxes[mailboxName];
  const state = readJson(mailbox.state_path);
  const results = [];
  for (const candidate of candidates) {
    const received = Date.parse(candidate.received_at);
    if (received <= Date.parse(mailbox.search_after_at)
        || received > Date.parse(mailbox.scan_cutoff_at)) {
      results.push({ key: candidate.key, status: 'outside_frozen_window' });
      continue;
    }
    if (candidateAlreadyProcessed(mailboxName, candidate, state)) {
      results.push({ key: candidate.key, status: 'previously_committed' });
      continue;
    }
    const sameOpaqueId = Object.values(mailbox.candidates)
      .find((existing) => existing.opaque_id === candidate.opaque_id);
    if (sameOpaqueId && mailboxName === 'primary' && sameOpaqueId.key !== candidate.key) {
      throw new CliError(
        'RESULT_VERSION_CONFLICT',
        `Primary message ID appeared with conflicting received times: ${candidate.opaque_id}`,
      );
    }
    if (mailbox.candidates[candidate.key]) {
      results.push({ key: candidate.key, status: 'duplicate_page_result' });
      continue;
    }
    mailbox.candidates[candidate.key] = {
      ...candidate,
      staged_at: nowIso(),
      classification: null,
    };
    results.push({ key: candidate.key, status: 'staged' });
  }
  return results;
}

async function page(options, descriptors) {
  const mailboxName = validateMailbox(requiredOption(options, 'mailbox'));
  const query = requiredOption(options, 'query');
  const pageToken = validatePageToken(requiredOption(options, 'page-token'), 'page-token');
  const nextPageToken = validatePageToken(
    requiredOption(options, 'next-page-token'),
    'next-page-token',
  );
  const resultCount = requiredIntegerOption(options, 'result-count');
  if (resultCount !== descriptors.length) {
    throw new CliError('PAGE_COUNT_MISMATCH', 'Descriptor count does not match --result-count', {
      result_count: resultCount,
      descriptor_count: descriptors.length,
    });
  }
  const candidates = descriptors.map(parseCandidateDescriptor);
  if (new Set(candidates.map((candidate) => candidate.key)).size !== candidates.length) {
    throw new CliError('DUPLICATE_PAGE_RESULT', 'A page cannot repeat a result descriptor');
  }
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (run.phase !== 'classifying') {
      throw new CliError('INVALID_PHASE', `Cannot record a page during ${run.phase}`);
    }
    const mailbox = run.mailboxes[mailboxName];
    if (mailbox.status !== 'pending') {
      throw new CliError('INVALID_PHASE', `${mailboxName} mailbox is already ${mailbox.status}`);
    }
    if (query !== mailbox.required_query) {
      throw new CliError('QUERY_MISMATCH', 'Page query does not match the frozen mailbox query', {
        required_query: mailbox.required_query,
      });
    }
    const pageTokenHash = warningFingerprint(pageToken);
    const nextPageTokenHash = nextPageToken === 'END'
      ? null
      : warningFingerprint(nextPageToken);
    const priorPage = mailbox.pages.find((item) => item.page_token_hash === pageTokenHash);
    if (priorPage) {
      const same = priorPage.next_page_token_hash === nextPageTokenHash
        && priorPage.result_count === resultCount
        && JSON.stringify(priorPage.results.map((item) => item.key))
          === JSON.stringify(candidates.map((candidate) => candidate.key));
      if (!same) {
        throw new CliError('PAGE_CONFLICT', 'Page token was already recorded with different evidence');
      }
      refreshLease(run);
      atomicWritePrivateJson(ACTIVE_PATH, run);
      return {
        run_id: run.run_id,
        mailbox: mailboxName,
        page_index: priorPage.page_index,
        idempotent: true,
        results: priorPage.results,
        pagination_complete: mailbox.pagination_complete,
        total_candidates: Object.keys(mailbox.candidates).length,
      };
    }
    if (pageTokenHash !== mailbox.expected_page_token_hash) {
      throw new CliError('PAGE_CHAIN_MISMATCH', 'Page token does not continue the recorded chain');
    }
    if (nextPageTokenHash !== null && nextPageTokenHash === pageTokenHash) {
      throw new CliError('PAGE_CHAIN_LOOP', 'A page cannot point to itself');
    }
    if (nextPageTokenHash !== null
        && mailbox.pages.some((item) => item.page_token_hash === nextPageTokenHash)) {
      throw new CliError('PAGE_CHAIN_LOOP', 'A page cannot point to an earlier page token');
    }
    const results = stagePageCandidates(run, mailboxName, candidates);
    const pageRecord = {
      page_index: mailbox.pages.length + 1,
      page_token_hash: pageTokenHash,
      next_page_token_hash: nextPageTokenHash,
      result_count: resultCount,
      results,
      recorded_at: nowIso(),
    };
    mailbox.pages.push(pageRecord);
    mailbox.expected_page_token_hash = nextPageTokenHash;
    mailbox.pagination_complete = nextPageTokenHash === null;
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return {
      run_id: run.run_id,
      mailbox: mailboxName,
      page_index: pageRecord.page_index,
      idempotent: false,
      results,
      pagination_complete: mailbox.pagination_complete,
      result_counts: Object.fromEntries([...new Set(results.map((item) => item.status))]
        .map((status) => [status, results.filter((item) => item.status === status).length])),
      total_candidates: Object.keys(mailbox.candidates).length,
    };
  });
}

async function classify(options, descriptors) {
  const mailboxName = validateMailbox(requiredOption(options, 'mailbox'));
  const category = requiredOption(options, 'category');
  const disposition = requiredOption(options, 'disposition');
  const identityKey = validateIdentityKey(options.get('identity-key'));
  const trackerIdentityKey = validateTrackerIdentityOption(options.get('tracker-identity-key'));
  if (!CATEGORIES.has(category)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid category: ${category}`);
  }
  if (!DISPOSITIONS.has(disposition)
      || !ALLOWED_DISPOSITIONS.get(category).has(disposition)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid disposition for ${category}: ${disposition}`);
  }
  if (['register_updated', 'tracker_rejected', 'needs_confirmation'].includes(disposition)
      && !identityKey) {
    throw new CliError('INVALID_ARGUMENT', `${disposition} requires --identity-key`);
  }
  if (trackerIdentityKey && disposition !== 'tracker_rejected') {
    throw new CliError('INVALID_ARGUMENT', '--tracker-identity-key is only valid for tracker_rejected');
  }
  if (disposition === 'needs_confirmation'
      && !/^(?:action|ambiguous):/.test(identityKey)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      'needs_confirmation requires action: or ambiguous: identity',
    );
  }
  if (descriptors.length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'classify requires at least one candidate descriptor');
  }
  const keys = descriptors.map((descriptor) => parseCandidateDescriptor(descriptor).key);
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (run.phase !== 'classifying') {
      throw new CliError('INVALID_PHASE', `Cannot classify during ${run.phase}`);
    }
    const mailbox = run.mailboxes[mailboxName];
    if (mailbox.status !== 'pending') {
      throw new CliError('INVALID_PHASE', `${mailboxName} mailbox is already ${mailbox.status}`);
    }
    const binding = disposition === 'tracker_rejected'
      ? rejectionBinding(
        identityKey,
        validateInterviewDocument(readFileSnapshot(ACTIVE_INTERVIEWS_PATH).text),
        trackerIdentityKey,
      )
      : null;
    let classified = 0;
    let idempotent = 0;
    for (const key of keys) {
      const candidate = mailbox.candidates[key];
      if (!candidate) throw new CliError('UNKNOWN_CANDIDATE', `Candidate was not staged: ${key}`);
      const next = {
        category,
        disposition,
        identity_key: identityKey,
        interview_process_identity: binding?.processIdentity ?? null,
        tracker_identity_key: binding?.trackerIdentity ?? null,
        classified_at: nowIso(),
        receipts: [],
      };
      if (candidate.classification !== null) {
        const same = candidate.classification.category === category
          && candidate.classification.disposition === disposition
          && candidate.classification.identity_key === identityKey
          && candidate.classification.interview_process_identity
            === (binding?.processIdentity ?? null)
          && candidate.classification.tracker_identity_key
            === (binding?.trackerIdentity ?? null);
        if (!same) {
          throw new CliError('CLASSIFICATION_CONFLICT', `Candidate already classified: ${key}`);
        }
        idempotent++;
        continue;
      }
      candidate.classification = next;
      classified++;
    }
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return {
      run_id: run.run_id,
      mailbox: mailboxName,
      classified_count: classified,
      idempotent_count: idempotent,
      register_markers: allowedReceiptTargets({
        disposition,
        interview_process_identity: binding?.processIdentity ?? null,
      }).includes('register')
        ? keys.map((key) => registerAuditMarker(
          binding?.processIdentity ?? identityKey,
          mailboxName,
          key,
        ))
        : [],
    };
  });
}

function hasTrackerRejectionNote(notes, note) {
  return notes.split(';').some((item) => {
    const entry = item.trim();
    const detailedPrefix = `${note} for `;
    return entry === note
      || (entry.startsWith(detailedPrefix) && entry.length > detailedPrefix.length);
  });
}

function exactStatusLogLines(lines, identityKey, eventDate) {
  const trackerId = identityKey.slice('tracker:#'.length);
  return lines.filter((line) => {
    const fields = line.split('\t');
    return fields[0] === trackerId
      && fields[1] === eventDate
      && fields[3] === 'Rejected'
      && fields[4] === 'set-status';
  });
}

function everyCandidate(run) {
  return Object.entries(run.mailboxes).flatMap(([mailboxName, mailbox]) => (
    Object.values(mailbox.candidates).map((candidate) => ({ mailboxName, candidate }))
  ));
}

function refreshRegisterReceiptSnapshots(run, registerText, registerHash) {
  const document = validateInterviewDocument(registerText);
  for (const { mailboxName, candidate } of everyCandidate(run)) {
    const classification = candidate.classification;
    const item = classification?.receipts?.find((receiptItem) => receiptItem.target === 'register');
    if (!item) continue;
    const marker = registerAuditMarker(item.identity_key, mailboxName, candidate.key);
    assertRegisterMarker(document, classification, marker);
    item.file_sha256 = registerHash;
    item.marker_sha256 = warningFingerprint(marker);
    item.snapshot_refreshed_at = nowIso();
  }
}

function refreshTrackerReceiptSnapshots(
  run,
  applicationsHash,
  statusLogHash,
  statusLogLines,
  applicationRowsSnapshot,
  currentCounts,
) {
  for (const { candidate } of everyCandidate(run)) {
    const classification = candidate.classification;
    const item = classification?.receipts?.find((receiptItem) => receiptItem.target === 'tracker');
    if (!item) continue;
    const row = parseApplicationRow(item.identity_key, applicationRowsSnapshot);
    const rowHash = warningFingerprint(row.line);
    const baselineRowHash = run.workspace_baseline.application_row_hashes[item.identity_key] ?? null;
    const baselineRejected = run.workspace_baseline.application_row_statuses?.[
      item.identity_key
    ] === 'Rejected';
    const expectedNote = `Gmail rejection received ${item.event_date}`;
    const currentLineCount = currentCounts[item.status_log_line_sha256] ?? 0;
    const baselineLineCount = run.workspace_baseline.status_log_line_counts[
      item.status_log_line_sha256
    ] ?? 0;
    if ((!baselineRejected && rowHash === baselineRowHash) || row.status !== 'Rejected'
        || !hasTrackerRejectionNote(row.notes, expectedNote)
        || (!baselineRejected && currentLineCount <= baselineLineCount)) {
      throw new CliError('TRACKER_RECEIPT_STALE', `${candidate.key} tracker receipt is stale`);
    }
    item.applications_sha256 = applicationsHash;
    item.tracker_row_sha256 = rowHash;
    item.status_log_sha256 = statusLogHash;
    item.status_log_line_count = currentLineCount;
    item.snapshot_refreshed_at = nowIso();
  }
}

async function receipt(options, descriptors) {
  const mailboxName = validateMailbox(requiredOption(options, 'mailbox'));
  const target = requiredOption(options, 'target');
  if (!RECEIPT_TARGETS.has(target)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid receipt target: ${target}`);
  }
  if (descriptors.length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'receipt requires at least one candidate descriptor');
  }
  const keys = descriptors.map((descriptor) => parseCandidateDescriptor(descriptor).key);
  const eventDate = target === 'tracker'
    ? validateEventDate(requiredOption(options, 'event-date'))
    : null;
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (!['classifying', 'verification_failed'].includes(run.phase)) {
      throw new CliError('INVALID_PHASE', `Cannot record a receipt during ${run.phase}`);
    }
    const mailbox = run.mailboxes[mailboxName];

    const registerSnapshot = target === 'register'
      ? readFileSnapshot(ACTIVE_INTERVIEWS_PATH)
      : null;
    const applicationsSnapshot = target === 'tracker'
      ? readFileSnapshot(APPLICATIONS_PATH)
      : null;
    const statusLogSnapshot = target === 'tracker'
      ? readFileSnapshot(STATUS_LOG_PATH, true)
      : null;
    const registerText = registerSnapshot?.text ?? null;
    const applicationsHash = applicationsSnapshot?.sha256 ?? null;
    const statusLogHash = statusLogSnapshot?.sha256 ?? null;
    const applicationRowsSnapshot = applicationsSnapshot
      ? applicationRows(applicationsSnapshot.text)
      : null;
    const statusLogLines = statusLogSnapshot?.exists
      ? statusLogSnapshot.text.split(/\r?\n/)
      : [];
    const currentStatusLogCounts = statusLogLineCounts(statusLogLines);
    const registerDocument = registerText !== null
      ? validateInterviewDocument(registerText)
      : null;
    const registerHash = registerSnapshot ? interviewEvidenceHash(registerSnapshot, registerDocument) : null;

    let recorded = 0;
    let idempotent = 0;
    for (const key of keys) {
      const candidate = mailbox.candidates[key];
      if (!candidate) throw new CliError('UNKNOWN_CANDIDATE', `Candidate was not staged: ${key}`);
      const classification = candidate.classification;
      if (!classification) {
        throw new CliError('UNCLASSIFIED_CANDIDATE', `Candidate is not classified: ${key}`);
      }
      const identityKey = target === 'tracker'
        ? trackerReceiptIdentity(classification)
        : registerIdentity(classification);
      if (!allowedReceiptTargets(classification).includes(target)) {
        throw new CliError(
          'UNEXPECTED_RECEIPT',
          `${classification.disposition} does not accept a ${target} receipt`,
        );
      }
      classification.receipts ??= [];
      const priorReceipt = classification.receipts.find((item) => item.target === target);

      let nextReceipt;
      if (target === 'register') {
        if (classification.disposition === 'tracker_rejected') {
          assertArchivedRejection(registerDocument, classification);
        }
        const marker = registerAuditMarker(identityKey, mailboxName, candidate.key);
        assertRegisterMarker(registerDocument, classification, marker);
        nextReceipt = {
          target,
          identity_key: identityKey,
          process_identity_key: registerIdentity(classification),
          file_sha256: registerHash,
          marker_sha256: warningFingerprint(marker),
          verified_at: nowIso(),
        };
      } else {
        if (!/^tracker:#\d+$/.test(identityKey)) {
          throw new CliError('INVALID_IDENTITY', 'Tracker receipt requires tracker:#N identity');
        }
        const row = parseApplicationRow(identityKey, applicationRowsSnapshot);
        const rowHash = warningFingerprint(row.line);
        const baselineRowHash = run.workspace_baseline.application_row_hashes[identityKey] ?? null;
        const baselineRejected = run.workspace_baseline.application_row_statuses?.[
          identityKey
        ] === 'Rejected';
        if (!baselineRejected && rowHash === baselineRowHash) {
          throw new CliError('TRACKER_ROW_UNCHANGED', `Exact tracker row did not change: ${identityKey}`);
        }
        const expectedNote = `Gmail rejection received ${eventDate}`;
        if (row.status !== 'Rejected' || !hasTrackerRejectionNote(row.notes, expectedNote)) {
          throw new CliError('TRACKER_STATE_MISMATCH', 'Exact tracker rejection state is absent', {
            identity_key: identityKey,
            expected_status: 'Rejected',
            expected_note_date: eventDate,
          });
        }
        if (!run.workspace_baseline.status_log_line_counts) {
          throw new CliError('INVALID_STATE', 'Status-log line baseline is unavailable');
        }
        const exactLogLines = exactStatusLogLines(statusLogLines, identityKey, eventDate)
          .map((line) => ({ line, hash: warningFingerprint(line) }));
        const exactLogLine = baselineRejected
          ? exactLogLines[0]
          : exactLogLines.find(({ hash }) => (
            (currentStatusLogCounts[hash] ?? 0)
              > (run.workspace_baseline.status_log_line_counts[hash] ?? 0)
          ));
        if (!exactLogLine
            || (!baselineRejected && statusLogHash === run.workspace_baseline.status_log_sha256)) {
          throw new CliError('STATUS_LOG_RECEIPT_MISSING', 'Exact set-status transition is absent', {
            identity_key: identityKey,
            event_date: eventDate,
          });
        }
        nextReceipt = {
          target,
          identity_key: identityKey,
          process_identity_key: registerIdentity(classification),
          event_date: eventDate,
          applications_sha256: applicationsHash,
          tracker_row_sha256: rowHash,
          status_log_sha256: statusLogHash,
          status_log_line_sha256: exactLogLine.hash,
          status_log_line_count: currentStatusLogCounts[exactLogLine.hash],
          verified_at: nowIso(),
        };
      }

      if (priorReceipt) {
        const same = priorReceipt.identity_key === nextReceipt.identity_key
          && priorReceipt.event_date === nextReceipt.event_date;
        if (!same) {
          throw new CliError('RECEIPT_CONFLICT', `Conflicting ${target} receipt: ${key}`);
        }
        idempotent++;
        continue;
      }
      classification.receipts.push(nextReceipt);
      recorded++;
    }
    if (target === 'register') {
      refreshRegisterReceiptSnapshots(run, registerText, registerHash);
    } else {
      refreshTrackerReceiptSnapshots(
        run,
        applicationsHash,
        statusLogHash,
        statusLogLines,
        applicationRowsSnapshot,
        currentStatusLogCounts,
      );
    }
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return {
      run_id: run.run_id,
      mailbox: mailboxName,
      target,
      recorded_count: recorded,
      idempotent_count: idempotent,
    };
  });
}

async function finishMailbox(options) {
  const mailboxName = validateMailbox(requiredOption(options, 'mailbox'));
  const status = requiredOption(options, 'status');
  if (!['success', 'unavailable'].includes(status)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid mailbox status: ${status}`);
  }
  const failureReasonCode = status === 'unavailable'
    ? requiredOption(options, 'reason-code')
    : null;
  if (failureReasonCode && !/^[a-z0-9_-]{1,64}$/.test(failureReasonCode)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid --reason-code');
  }
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (run.phase !== 'classifying') {
      throw new CliError('INVALID_PHASE', `Cannot finish mailbox during ${run.phase}`);
    }
    const mailbox = run.mailboxes[mailboxName];
    if (mailbox.status !== 'pending' && mailbox.status !== status) {
      throw new CliError('MAILBOX_STATUS_CONFLICT', `${mailboxName} is already ${mailbox.status}`);
    }
    if (mailbox.status === 'unavailable'
        && mailbox.failure_reason_code !== failureReasonCode) {
      throw new CliError('MAILBOX_STATUS_CONFLICT', `${mailboxName} has a different failure reason`);
    }
    if (status === 'unavailable') {
      for (const candidate of Object.values(mailbox.candidates)) {
        if (candidate.classification === null) {
          candidate.classification = {
            category: 'ambiguous',
            disposition: 'deferred_mailbox_failure',
            identity_key: null,
            classified_at: nowIso(),
          };
        }
      }
    } else {
      if (mailbox.pages.length === 0 || !mailbox.pagination_complete
          || mailbox.expected_page_token_hash !== null) {
        throw new CliError(
          'PAGINATION_INCOMPLETE',
          `${mailboxName} has no closed search-page chain`,
        );
      }
      const unclassified = Object.values(mailbox.candidates)
        .filter((candidate) => candidate.classification === null)
        .map((candidate) => candidate.key);
      if (unclassified.length > 0) {
        throw new CliError('UNCLASSIFIED_CANDIDATES', `${mailboxName} has unclassified candidates`, {
          candidates: unclassified,
        });
      }
    }
    mailbox.status = status;
    mailbox.failure_reason_code = failureReasonCode;
    mailbox.finished_at = nowIso();
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return publicRunSummary(run);
  });
}

async function heartbeat(options) {
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (!['classifying', 'verification_failed'].includes(run.phase)) {
      throw new CliError('INVALID_PHASE', `Cannot heartbeat during ${run.phase}`);
    }
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    return {
      run_id: run.run_id,
      phase: run.phase,
      heartbeat_at: run.heartbeat_at,
      lease_expires_at: run.lease_expires_at,
    };
  });
}

async function commit(options) {
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (run.phase === 'committing') {
      const completed = applyTransaction(run);
      return commitSummary(completed, true);
    }
    if (!['classifying', 'verification_failed'].includes(run.phase)) {
      throw new CliError('INVALID_PHASE', `Cannot commit during ${run.phase}`);
    }
    validateCommitGate(run);
    run.verification.attempt = (run.verification.attempt ?? 0) + 1;
    run.verification.after = null;
    run.verification.delta = null;
    run.verification.command_error = null;
    run.sync_check = null;
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    let syncCheck;
    let after;
    let delta;
    try {
      syncCheck = captureSyncCheck();
      after = captureVerify();
      delta = warningDelta(run.verification.before, after);
    } catch (error) {
      run.phase = 'verification_failed';
      run.verification.command_error = safeCommandError(error);
      if (syncCheck) run.sync_check = compactSyncCheck(syncCheck);
      refreshLease(run);
      atomicWritePrivateJson(ACTIVE_PATH, run);
      throw error;
    }
    run.sync_check = compactSyncCheck(syncCheck);
    run.verification.after = compactWarningCapture(after);
    run.verification.delta = compactWarningDelta(delta);
    run.verification.command_error = null;
    if (!syncCheck.ok || after.exit_status !== 0 || after.errors !== 0
        || delta.added.length > 0) {
      run.phase = 'verification_failed';
      refreshLease(run);
      atomicWritePrivateJson(ACTIVE_PATH, run);
      throw new CliError('VERIFICATION_GATE_FAILED', 'State commit blocked by verification delta', {
        sync_check_ok: syncCheck.ok,
        errors: after.errors,
        verify_exit_status: after.exit_status,
        existing_warnings: delta.existing_count,
        added_warnings: delta.added,
        resolved_warnings: delta.resolved,
      });
    }

    let finalGate;
    try {
      finalGate = validateCommitGate(run);
      commitInterviewDocument(
        [finalGate.workspace_guards[0], ...finalGate.workspace_guards.slice(3)],
        run.workspace_baseline.interview_summaries,
      );
    } catch (error) {
      run.phase = 'verification_failed';
      run.verification.command_error = safeCommandError(error);
      refreshLease(run);
      atomicWritePrivateJson(ACTIVE_PATH, run);
      throw error;
    }

    const stateTargets = [];
    if (run.mailboxes.primary.status === 'success') {
      const primarySnapshot = readJsonSnapshot(PRIMARY_STATE_PATH);
      const primaryState = primarySnapshot.value;
      assertMailboxStateUnchanged(run, 'primary', primaryState);
      const value = buildPrimaryState(run, primaryState);
      stateTargets.push({
        path: PRIMARY_STATE_PATH,
        value,
        expected_before_sha256: primarySnapshot.sha256,
        target_sha256: jsonFingerprint(value),
      });
    }
    if (run.mailboxes.secondary.status === 'success') {
      const secondarySnapshot = readJsonSnapshot(SECONDARY_STATE_PATH);
      const secondaryState = secondarySnapshot.value;
      assertMailboxStateUnchanged(run, 'secondary', secondaryState);
      const value = buildSecondaryState(run, secondaryState);
      stateTargets.push({
        path: SECONDARY_STATE_PATH,
        value,
        expected_before_sha256: secondarySnapshot.sha256,
        target_sha256: jsonFingerprint(value),
      });
    }
    const completedAt = nowIso();
    const completed = completedRecord(run, completedAt, syncCheck, after, delta, finalGate);
    run.phase = 'committing';
    run.transaction = {
      prepared_at: completedAt,
      workspace_guards: finalGate.workspace_guards,
      state_targets: stateTargets,
      completed_record: completed,
      completed_record_sha256: jsonFingerprint(completed),
    };
    refreshLease(run);
    atomicWritePrivateJson(ACTIVE_PATH, run);
    applyTransaction(run);
    return commitSummary(completed, false);
  });
}

async function abort(options) {
  const reasonCode = requiredOption(options, 'reason-code');
  if (!/^[a-z0-9_-]{1,64}$/.test(reasonCode)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid --reason-code');
  }
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) throw new CliError('NO_ACTIVE_RUN', 'No active run');
    const run = readJson(ACTIVE_PATH);
    validateCredentials(run, options);
    if (run.phase === 'committing') {
      throw new CliError('COMMIT_RECOVERY_REQUIRED', 'A prepared commit cannot be aborted; run commit again');
    }
    archiveFailed(run, reasonCode);
    rmSync(ACTIVE_PATH, { force: true });
    return { run_id: run.run_id, status: 'aborted', reason_code: reasonCode };
  });
}

async function status(options) {
  ensureDirectories();
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (!existsSync(ACTIVE_PATH)) return { active: false };
    const run = readJson(ACTIVE_PATH);
    validateRunConfiguration(run);
    if (options.has('run-id') || options.has('token')) validateCredentials(run, options);
    return { active: true, ...publicRunSummary(run) };
  });
}

async function supersedeLedger(options) {
  const runId = requiredOption(options, 'run-id');
  const reasonCode = requiredOption(options, 'reason-code');
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^[a-z0-9_-]{1,64}$/.test(reasonCode)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid run ID or reason code');
  }
  ensureDirectories();
  return withPipelineLock(ACTIVE_PATH, async () => {
    if (existsSync(ACTIVE_PATH)) {
      throw new CliError('LOCK_BUSY', 'Cannot migrate a ledger while a run is active');
    }
    const path = archivePath(COMPLETED_DIR, runId);
    if (!existsSync(path)) throw new CliError('LEDGER_NOT_FOUND', `No completed ledger: ${runId}`);
    const record = readJson(path);
    const idempotent = record.authoritative === false
      && record.superseded_reason_code === reasonCode;
    if (record.verification) {
      if (record.verification.before?.fingerprints) {
        record.verification.before = compactWarningCapture(record.verification.before);
      }
      if (record.verification.after?.fingerprints) {
        record.verification.after = compactWarningCapture(record.verification.after);
      }
      if (record.verification.delta) {
        record.verification.delta = compactWarningDelta(record.verification.delta);
      }
    }
    if (idempotent) {
      atomicWritePrivateJson(path, record);
      return { run_id: runId, authoritative: false, idempotent: true };
    }
    record.authoritative = false;
    record.audit_status = 'superseded_pre_page_evidence';
    record.superseded_reason_code = reasonCode;
    record.superseded_at = nowIso();
    record.page_evidence_complete = false;
    record.content_classification_complete = null;
    record.classification_complete = null;
    atomicWritePrivateJson(path, record);
    return { run_id: runId, authoritative: false, idempotent: false };
  });
}

function help() {
  return {
    mailbox_transaction_options: '--career-ops-root PATH --interviews-file PATH [--state-root PATH]',
    usage: [
      'gmail-job-reply-run.mjs begin --career-ops-root PATH --interviews-file PATH [--state-root PATH]',
      'gmail-job-reply-run.mjs heartbeat --run-id ID --token TOKEN',
      'gmail-job-reply-run.mjs page --run-id ID --token TOKEN --mailbox primary|secondary --query QUERY --page-token TOKEN|START --next-page-token TOKEN|END --result-count N [OPAQUE_ID@RECEIVED_AT ...]',
      'gmail-job-reply-run.mjs classify --run-id ID --token TOKEN --mailbox primary|secondary --category CATEGORY --disposition DISPOSITION [--identity-key KEY] [--tracker-identity-key tracker:#N] OPAQUE_ID@RECEIVED_AT ...',
      'gmail-job-reply-run.mjs receipt --run-id ID --token TOKEN --mailbox primary|secondary --target register|tracker [--event-date YYYY-MM-DD] OPAQUE_ID@RECEIVED_AT ...',
      'gmail-job-reply-run.mjs mailbox --run-id ID --token TOKEN --mailbox primary|secondary --status success|unavailable [--reason-code CODE]',
      'gmail-job-reply-run.mjs commit --run-id ID --token TOKEN',
      'gmail-job-reply-run.mjs abort --run-id ID --token TOKEN --reason-code CODE',
      'gmail-job-reply-run.mjs status [--run-id ID --token TOKEN]',
      'gmail-job-reply-run.mjs supersede-ledger --run-id ID --reason-code CODE',
      'gmail-job-reply-run.mjs check FILE',
      'gmail-job-reply-run.mjs prepare FILE CANDIDATE',
      'gmail-job-reply-run.mjs apply FILE CANDIDATE BASELINE_SHA256',
    ],
    categories: [...CATEGORIES],
    dispositions: [...DISPOSITIONS],
    allowed_dispositions: Object.fromEntries(
      [...ALLOWED_DISPOSITIONS].map(([category, dispositions]) => [category, [...dispositions]]),
    ),
  };
}

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const { options, positionals } = parseArgs(argv);
  if (['help', '--help', '-h'].includes(command)) return help();
  if (['check', 'prepare', 'apply'].includes(command)) {
    if (options.size > 0) throw new CliError('INVALID_ARGUMENT', `${command} accepts positional arguments only`);
    return interviewRegisterCommand(command, positionals);
  }
  await configure(options);
  switch (command) {
    case 'begin': return begin();
    case 'heartbeat': return heartbeat(options);
    case 'page': return page(options, positionals);
    case 'classify': return classify(options, positionals);
    case 'receipt': return receipt(options, positionals);
    case 'mailbox': return finishMailbox(options);
    case 'commit': return commit(options);
    case 'abort': return abort(options);
    case 'status': return status(options);
    case 'supersede-ledger': return supersedeLedger(options);
    default: throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  const cliError = error instanceof CliError
    ? error
    : error instanceof ActiveInterviewsLockError
      ? new CliError(error.code, error.message)
      : new CliError('INTERNAL_ERROR', error.message ?? String(error));
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: cliError.code,
      message: cliError.message,
      ...cliError.details,
    },
  })}\n`);
  process.exitCode = 1;
}
