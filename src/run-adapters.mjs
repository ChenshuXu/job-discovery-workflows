#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunProfile } from './adapter-registry.mjs';
import { observeScanUsage, recordScanSourceAttempt } from './scan-usage.mjs';
import { compactSummary } from './scan-summary.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPERVISOR = path.join(PROJECT_ROOT, 'src/adapter-supervisor.mjs');
const readConfigContent = file => readFileSync(file, 'utf8');

function commandFor(discoveryRoot, runRoot, definition) {
  if (!Array.isArray(definition.command) || !definition.command.length || !definition.config) throw new Error('enabled adapter lacks its frozen command/config');
  return [
    ...definition.command,
    '--discovery-root', discoveryRoot,
    '--run-id', path.basename(runRoot),
    '--config', path.resolve(discoveryRoot, definition.config),
  ];
}

function previewAdapterCommands({ runRoot, discoveryRoot = PROJECT_ROOT, registryFile } = {}) {
  const root = path.resolve(runRoot);
  const profile = loadRunProfile(null, { registryFile });
  return {
    dry_run: true,
    profile_id: profile.profile_id,
    minimum_successful_adapters: profile.minimum_successful_adapters,
    adapters: profile.adapters.map(adapterId => ({
      adapter_id: adapterId,
      argv: commandFor(path.resolve(discoveryRoot), root, profile.adapter_definitions[adapterId]),
    })),
  };
}

function summaryFor(runRoot, adapterId) {
  const file = path.join(runRoot, 'sources', adapterId, 'summary.json');
  if (!existsSync(file)) throw new Error(`${adapterId}: summary.json missing`);
  let summary;
  try { summary = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${adapterId}: invalid summary.json: ${error.message}`); }
  if (summary.schema_version !== 1 || summary.run_id !== path.basename(runRoot) || summary.adapter !== adapterId) throw new Error(`${adapterId}: summary identity mismatch`);
  if (!['SUCCESS', 'FAILED', 'EMPTY'].includes(summary.status)) throw new Error(`${adapterId}: invalid summary status ${summary.status}`);
  for (const field of ['raw_rows', 'unique_jobs', 'markdown_jobs', 'errors']) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) throw new Error(`${adapterId}: summary ${field} must be a non-negative integer`);
  }
  const jobsRoot = path.join(runRoot, 'sources', adapterId, 'jobs');
  const markdownJobs = existsSync(jobsRoot) ? readdirSync(jobsRoot).filter(name => name.endsWith('.md')).length : 0;
  if (summary.unique_jobs !== summary.markdown_jobs || summary.markdown_jobs !== markdownJobs) throw new Error(`${adapterId}: summary counts do not reconcile`);
  if (summary.status === 'SUCCESS' && (summary.errors !== 0 || markdownJobs < 1)) throw new Error(`${adapterId}: SUCCESS requires jobs and zero errors`);
  if (summary.status === 'FAILED' && summary.errors < 1) throw new Error(`${adapterId}: FAILED requires errors`);
  if (summary.status === 'FAILED' && 'retryable' in summary && typeof summary.retryable !== 'boolean') throw new Error(`${adapterId}: summary retryable must be boolean`);
  if (summary.status === 'EMPTY' && (summary.errors !== 0 || markdownJobs !== 0)) throw new Error(`${adapterId}: EMPTY requires zero jobs and zero errors`);
  return summary;
}

export function archiveAttempt(runRoot, adapterId) {
  const sourceRoot = path.join(runRoot, 'sources', adapterId);
  const attemptsRoot = path.join(runRoot, 'adapter-attempts');
  const archived = path.join(attemptsRoot, `${adapterId}-attempt-1`);
  if (existsSync(archived)) throw new Error(`${adapterId}: retry already used`);
  mkdirSync(attemptsRoot, { recursive: true });
  if (existsSync(sourceRoot)) renameSync(sourceRoot, archived);
  else mkdirSync(archived);
  return path.relative(runRoot, archived);
}

// A killed adapter never writes its summary. Record it as a failed source so the
// remaining sources still decide the run.
function recordAdapterFailure(runRoot, adapterId, fields) {
  const sourceRoot = path.join(runRoot, 'sources', adapterId);
  const jobsRoot = path.join(sourceRoot, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  const markdownJobs = existsSync(jobsRoot) ? readdirSync(jobsRoot).filter(name => name.endsWith('.md')).length : 0;
  const runId = path.basename(runRoot);
  writeFileSync(path.join(sourceRoot, 'summary.json'), JSON.stringify({ schema_version: 1, run_id: runId, adapter: adapterId, status: 'FAILED',
    raw_rows: markdownJobs, unique_jobs: markdownJobs, markdown_jobs: markdownJobs, errors: 1, retryable: false,
    ...fields }, null, 2) + '\n');
  const audit = path.join(sourceRoot, 'excluded-employers.json');
  if (!existsSync(audit)) writeFileSync(audit, JSON.stringify({ schema_version: 1, run_id: runId, excluded_count: 0, results: [] }, null, 2) + '\n');
}

const attemptLog = (adapterId, attempt, stream) => path.join('adapter-attempts', `${adapterId}-attempt-${attempt}.${stream}.log`);
const attemptExitFile = (runRoot, adapterId, attempt) => path.join(runRoot, 'adapter-attempts', `${adapterId}-attempt-${attempt}.exit.json`);
const attemptTimeoutFile = (runRoot, adapterId, attempt) => path.join(runRoot, 'adapter-attempts', `${adapterId}-attempt-${attempt}.timeout.json`);

// A killed process can leave its last JD truncated. A timed-out source keeps the rest.
function dropNewestCapture(runRoot, adapterId) {
  const jobsRoot = path.join(runRoot, 'sources', adapterId, 'jobs');
  if (!existsSync(jobsRoot)) return null;
  const newest = readdirSync(jobsRoot).filter(name => name.endsWith('.md'))
    .map(name => ({ name, mtimeMs: statSync(path.join(jobsRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0];
  if (!newest) return null;
  rmSync(path.join(jobsRoot, newest.name));
  return newest.name;
}

// A process that died with the host records nothing, so a started source with neither a
// summary nor a self-reported exit was interrupted. An adapter that exited on its own
// without a summary crashed: that is a defect, not something a rerun should paper over.
function sourceState(runRoot, adapterId) {
  const sourceRoot = path.join(runRoot, 'sources', adapterId);
  if (existsSync(path.join(sourceRoot, 'summary.json'))) {
    try { summaryFor(runRoot, adapterId); return 'terminal'; } catch { return 'invalid'; }
  }
  const attempt = existsSync(path.join(runRoot, 'adapter-attempts', `${adapterId}-attempt-1`)) ? 2 : 1;
  if (attempt === 1 && !existsSync(sourceRoot) && !existsSync(path.join(runRoot, attemptLog(adapterId, 1, 'stdout')))) return 'not_started';
  const exitFile = attemptExitFile(runRoot, adapterId, attempt);
  if (existsSync(exitFile) && JSON.parse(readFileSync(exitFile, 'utf8')).signal === null) return 'crashed';
  return attempt === 1 ? 'interrupted' : 'abandoned';
}

// Reads the live process table rather than a saved pid, which a reboot would make stale.
// Shell wrappers quote the same arguments but are not acquisition themselves.
export function liveAcquisition(runRoot) {
  const runId = path.basename(runRoot);
  const adapterArgument = new RegExp(`\\s--run-id\\s+${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(line => {
    const [, pid, command] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];
    if (!command || Number(pid) === process.pid || /^\S*\/?-?(sh|bash|zsh)\s/.test(command)) return false;
    return adapterArgument.test(command) || (/^\S*node\s.*run-adapters\.mjs\s/.test(command) && command.includes(runId));
  });
}

function assertNoLiveAcquisition(runRoot) {
  const live = liveAcquisition(runRoot);
  if (live.length) throw new Error(`source acquisition is still running for this run:\n${live.map(line => line.trim()).join('\n')}`);
}

// Counts sleeps the host logged inside the attempt. Log times have one-second resolution.
function hostSleepsDuring(startedAt, endedAt) {
  let log;
  try { log = execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const from = Math.floor(startedAt / 1000) * 1000;
  return log.split('\n').filter(line => {
    const [, day, time, hours, minutes] = line.match(/^(\S+) (\S+) ([+-]\d\d)(\d\d) Sleep\s+Entering Sleep state/) ?? [];
    if (!day) return false;
    const at = Date.parse(`${day}T${time}${hours}:${minutes}`);
    return at >= from && at <= endedAt;
  }).length;
}

// A sleeping host stalls browsers and network calls, so the adapter's own classification
// says nothing about the source. The attempt earns the normal single retry.
function classifyHostSleep(runRoot, adapterId, summary, startedAt) {
  if (summary?.status !== 'FAILED' || summary.retryable === true) return summary;
  const hostSleeps = hostSleepsDuring(startedAt.getTime(), Date.now());
  if (!hostSleeps) return summary;
  const classified = { ...summary, retryable: true, host_sleeps: hostSleeps };
  writeFileSync(path.join(runRoot, 'sources', adapterId, 'summary.json'), JSON.stringify(classified, null, 2) + '\n');
  return classified;
}

// The app's keep-awake belongs to its turn and ends before a long acquisition does. This
// covers idle sleep, and lid-closed sleep on AC; nothing covers a closed lid on battery.
function holdHostAwake() {
  if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
}

// Both attempts were killed. Their captures stay archived but out of acquisition, because
// a killed process can leave its last JD truncated.
function abandonInterrupted(runRoot, adapterId) {
  const sourceRoot = path.join(runRoot, 'sources', adapterId);
  if (existsSync(sourceRoot)) renameSync(sourceRoot, path.join(runRoot, 'adapter-attempts', `${adapterId}-attempt-2`));
  recordAdapterFailure(runRoot, adapterId, { failure_class: 'ADAPTER_INTERRUPTED' });
}

function runOne({ adapterId, definition, discoveryRoot, runRoot, attempt }) {
  const argv = commandFor(discoveryRoot, runRoot, definition);
  const startedAt = new Date();
  const started = performance.now();
  mkdirSync(path.join(runRoot, 'adapter-attempts'), { recursive: true });
  const stdoutPath = attemptLog(adapterId, attempt, 'stdout');
  const stderrPath = attemptLog(adapterId, attempt, 'stderr');
  const handles = [];
  let result;
  try {
    handles.push(openSync(path.join(runRoot, stdoutPath), 'wx', 0o600));
    handles.push(openSync(path.join(runRoot, stderrPath), 'wx', 0o600));
    const timeoutFile = attemptTimeoutFile(runRoot, adapterId, attempt);
    result = spawnSync(process.execPath, [SUPERVISOR, String(definition.timeout_ms ?? 0), timeoutFile, '--', ...argv],
      { cwd: discoveryRoot, env: process.env, stdio: ['ignore', ...handles] });
  } finally { for (const handle of handles) closeSync(handle); }
  const exitCode = result.status ?? 1;
  if (existsSync(attemptTimeoutFile(runRoot, adapterId, attempt))) {
    const dropped = dropNewestCapture(runRoot, adapterId);
    recordAdapterFailure(runRoot, adapterId, { failure_class: 'ADAPTER_TIMEOUT', timeout_ms: definition.timeout_ms, ...(dropped ? { dropped_partial_capture: dropped } : {}) });
  }
  observeScanUsage(() => recordScanSourceAttempt(runRoot, { adapter_id: adapterId, started_at: startedAt.toISOString(), completed_at: new Date().toISOString(), wall_ms: Math.round(performance.now() - started), exit_code: exitCode }));
  let summary;
  try { summary = summaryFor(runRoot, adapterId); } catch {}
  if (attempt === 1) summary = classifyHostSleep(runRoot, adapterId, summary, startedAt);
  if (!summary) writeFileSync(attemptExitFile(runRoot, adapterId, attempt), JSON.stringify({ exit_code: result.status, signal: result.signal }) + '\n');
  return {
    adapter_id: adapterId,
    argv,
    exit_code: exitCode,
    status: summary?.status ?? 'MISSING',
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function requireBaselineProfile(runRoot) {
  const file = path.join(runRoot, 'baseline.json');
  if (!existsSync(file)) throw new Error(`baseline missing: ${file}`);
  let baseline;
  try { baseline = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid baseline: ${file}: ${error.message}`); }
  if (!baseline.adapter_profile) throw new Error(`baseline adapter_profile missing: ${file}`);
  return loadRunProfile(runRoot);
}

export function runAdapters({ runRoot, discoveryRoot = PROJECT_ROOT, retry, retryAuthorization, resume = false } = {}) {
  const root = path.resolve(runRoot);
  const discovery = path.resolve(discoveryRoot);
  if (path.dirname(root) !== path.join(discovery, 'runs')) throw new Error(`run must be directly under ${path.join(discovery, 'runs')}`);
  if (existsSync(path.join(root, 'receipt.json')) || existsSync(path.join(root, 'rendered-reports.json'))) throw new Error('source acquisition is closed for this run');
  const profile = requireBaselineProfile(root);
  if (retry && resume) throw new Error('--resume cannot be combined with --retry');
  if (retry && !profile.adapters.includes(retry)) throw new Error(`retry adapter is not enabled in this run: ${retry}`);

  for (const adapterId of profile.adapters) {
    const definition = profile.adapter_definitions[adapterId];
    if (!definition.command || !definition.config || !definition.config_content) throw new Error(`${adapterId}: baseline lacks frozen command/config`);
    const configFile = path.resolve(discovery, definition.config);
    if (!existsSync(configFile) || readConfigContent(configFile) !== definition.config_content) throw new Error(`${adapterId}: source config changed after baseline capture`);
  }

  let archivedAttempt = null;
  let authorization = null;
  if (retryAuthorization) {
    authorization = JSON.parse(readFileSync(path.resolve(retryAuthorization), 'utf8'));
    if (!retry || authorization.run_id !== path.basename(root) || authorization.adapter !== retry
        || authorization.authorized_by !== 'user' || typeof authorization.instruction !== 'string' || !authorization.instruction.trim()) {
      throw new Error('retry authorization must contain the explicit user instruction for this run and adapter');
    }
  }
  if (retry) {
    let priorSummary;
    try { priorSummary = summaryFor(root, retry); } catch {}
    if (priorSummary?.status === 'SUCCESS') throw new Error(`${retry}: successful source is not retryable`);
    if (priorSummary?.status === 'FAILED' && priorSummary.retryable === false && !authorization) throw new Error(`${retry}: source failure is explicitly non-retryable`);
    const state = sourceState(root, retry);
    const classified = priorSummary ? priorSummary.status !== 'FAILED' || priorSummary.retryable === true : ['not_started', 'interrupted'].includes(state);
    if (!classified && !authorization) throw new Error(`${retry}: source failure is not classified as retryable`);
    if (state !== 'terminal') assertNoLiveAcquisition(root);
    archivedAttempt = archiveAttempt(root, retry);
  }

  const commandResults = [];
  const systemErrors = [];
  const run = (adapterId, attempt) => {
    const result = runOne({ adapterId, definition: profile.adapter_definitions[adapterId], discoveryRoot: discovery, runRoot: root, attempt });
    commandResults.push(result);
    if (result.exit_code !== 0 && result.status === 'SUCCESS') systemErrors.push(`${adapterId}: command exited ${result.exit_code} but summary reports SUCCESS`);
  };
  const resumed = { retried_interrupted: [], started: [], abandoned: [] };
  if (resume) {
    assertNoLiveAcquisition(root);
    for (const adapterId of profile.adapters) {
      const state = sourceState(root, adapterId);
      if (state === 'not_started') {
        resumed.started.push(adapterId);
        run(adapterId, 1);
      } else if (state === 'interrupted') {
        resumed.retried_interrupted.push(adapterId);
        archiveAttempt(root, adapterId);
        run(adapterId, 2);
      } else if (state === 'abandoned') {
        resumed.abandoned.push(adapterId);
        abandonInterrupted(root, adapterId);
      }
    }
  } else {
    for (const adapterId of retry ? [retry] : profile.adapters) {
      if (!retry && existsSync(path.join(root, 'sources', adapterId))) {
        systemErrors.push(`${adapterId}: source artifacts already exist; use --retry for an eligible failure`);
        continue;
      }
      run(adapterId, retry ? 2 : 1);
    }
  }

  const outcomes = [];
  for (const adapterId of profile.adapters) {
    try { outcomes.push(summaryFor(root, adapterId)); }
    catch (error) { systemErrors.push(error.message); }
  }
  const successful = outcomes.filter(summary => summary.status === 'SUCCESS').map(summary => summary.adapter);
  if (successful.length < profile.minimum_successful_adapters) {
    systemErrors.push(`daily profile requires ${profile.minimum_successful_adapters} successful adapter(s), got ${successful.length}`);
  }
  const output = {
    status: systemErrors.length ? 'FAILED' : successful.length === profile.adapters.length ? 'SUCCESS' : 'DEGRADED',
    profile_id: profile.profile_id,
    adapters: profile.adapters,
    successful_adapters: successful,
    minimum_successful_adapters: profile.minimum_successful_adapters,
    ...(retry ? { retried_adapter: retry, archived_attempt: archivedAttempt } : {}),
    ...(authorization ? { retry_authorization: authorization } : {}),
    ...(resume ? { resume: resumed } : {}),
    command_results: commandResults,
    outcomes,
    system_errors: [...new Set(systemErrors)],
  };
  const artifact = path.join(root, 'source-run.json');
  writeFileSync(artifact + '.tmp', JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  renameSync(artifact + '.tmp', artifact);
  if (systemErrors.length) {
    const error = new Error(output.system_errors.join('\n')); error.artifact = artifact; throw error;
  }
  return output;
}

function option(name) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be supplied only once`);
  if (!indexes.length) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const run = option('--run');
    if (!run) throw new Error('Usage: node src/run-adapters.mjs --run runs/<run-id> [--dry-run | --resume | --retry <adapter-id> [--retry-authorization <file>]] [--full]');
    const dryRun = process.argv.includes('--dry-run');
    const retry = option('--retry');
    const retryAuthorization = option('--retry-authorization');
    const resume = process.argv.includes('--resume');
    if (dryRun && retry) throw new Error('--dry-run and --retry cannot be combined');
    if (resume && (dryRun || retry)) throw new Error('--resume cannot be combined with --dry-run or --retry');
    if (retryAuthorization && (!retry || dryRun)) throw new Error('--retry-authorization requires --retry');
    if (!dryRun) holdHostAwake();
    const result = dryRun
      ? previewAdapterCommands({ runRoot: run })
      : runAdapters({ runRoot: run, retry, retryAuthorization, resume });
    console.log(JSON.stringify(dryRun || process.argv.includes('--full') ? result : compactSummary({ stage: 'sources', status: result.status,
      artifact: path.join(path.resolve(run), 'source-run.json'), counts: { successful: result.successful_adapters.length, required: result.minimum_successful_adapters,
        adapters: Object.fromEntries(result.outcomes.map(s => [s.adapter, { status: s.status, jobs: s.markdown_jobs, errors: s.errors }])) },
      errors: result.outcomes.filter(s => s.status === 'FAILED').map(s => `${s.adapter}: ${s.status}; errors=${s.errors}; retryable=${s.retryable ?? 'unclassified'}; see sources/${s.adapter}/summary.json`),
      errorCount: result.outcomes.reduce((n, s) => n + s.errors, 0) })));
  } catch (error) {
    if (error.artifact && !process.argv.includes('--full')) console.error(JSON.stringify(compactSummary({ stage: 'sources', status: 'FAILED', artifact: error.artifact, errors: error.message.split('\n') })));
    else console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
