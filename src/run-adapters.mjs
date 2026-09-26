#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunProfile } from './adapter-registry.mjs';
import { observeScanUsage, recordScanSourceAttempt } from './scan-usage.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digestFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function commandFor(discoveryRoot, runRoot, definition) {
  if (!Array.isArray(definition.command) || !definition.command.length || !definition.config) throw new Error('enabled adapter lacks its frozen command/config');
  return [
    ...definition.command,
    '--discovery-root', discoveryRoot,
    '--run-id', path.basename(runRoot),
    '--config', path.resolve(discoveryRoot, definition.config),
  ];
}

export function previewAdapterCommands({ runRoot, discoveryRoot = PROJECT_ROOT, registryFile } = {}) {
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

function runOne({ adapterId, definition, discoveryRoot, runRoot }) {
  const argv = commandFor(discoveryRoot, runRoot, definition);
  const startedAt = new Date();
  const started = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: discoveryRoot, env: process.env, stdio: 'inherit' });
  const exitCode = result.status ?? 1;
  observeScanUsage(() => recordScanSourceAttempt(runRoot, { adapter_id: adapterId, started_at: startedAt.toISOString(), completed_at: new Date().toISOString(), wall_ms: Math.round(performance.now() - started), exit_code: exitCode }));
  let summary;
  try { summary = summaryFor(runRoot, adapterId); } catch {}
  return {
    adapter_id: adapterId,
    argv,
    exit_code: exitCode,
    status: summary?.status ?? 'MISSING',
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

export function runAdapters({ runRoot, discoveryRoot = PROJECT_ROOT, retry } = {}) {
  const root = path.resolve(runRoot);
  const discovery = path.resolve(discoveryRoot);
  if (path.dirname(root) !== path.join(discovery, 'runs')) throw new Error(`run must be directly under ${path.join(discovery, 'runs')}`);
  const profile = requireBaselineProfile(root);
  if (retry && !profile.adapters.includes(retry)) throw new Error(`retry adapter is not enabled in this run: ${retry}`);

  for (const adapterId of profile.adapters) {
    const definition = profile.adapter_definitions[adapterId];
    if (!definition.command || !definition.config || !definition.config_sha256) throw new Error(`${adapterId}: baseline lacks frozen command/config`);
    const configFile = path.resolve(discovery, definition.config);
    if (!existsSync(configFile) || digestFile(configFile) !== definition.config_sha256) throw new Error(`${adapterId}: source config changed after baseline capture`);
  }

  let archivedAttempt = null;
  if (retry) {
    let priorSummary;
    try { priorSummary = summaryFor(root, retry); } catch {}
    if (priorSummary?.status === 'SUCCESS') throw new Error(`${retry}: successful source is not retryable`);
    if (priorSummary?.status === 'FAILED' && priorSummary.retryable === false) throw new Error(`${retry}: source failure is explicitly non-retryable`);
    archivedAttempt = archiveAttempt(root, retry);
  }

  const attempted = retry ? [retry] : profile.adapters;
  const commandResults = [];
  const systemErrors = [];
  for (const adapterId of attempted) {
    const sourceRoot = path.join(root, 'sources', adapterId);
    if (!retry && existsSync(sourceRoot)) {
      systemErrors.push(`${adapterId}: source artifacts already exist; use --retry for an eligible failure`);
      continue;
    }
    const result = runOne({ adapterId, definition: profile.adapter_definitions[adapterId], discoveryRoot: discovery, runRoot: root });
    commandResults.push(result);
    if (result.exit_code !== 0 && result.status === 'SUCCESS') systemErrors.push(`${adapterId}: command exited ${result.exit_code} but summary reports SUCCESS`);
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
  if (systemErrors.length) throw new Error([...new Set(systemErrors)].join('\n'));
  return {
    status: successful.length === profile.adapters.length ? 'SUCCESS' : 'DEGRADED',
    profile_id: profile.profile_id,
    adapters: profile.adapters,
    successful_adapters: successful,
    minimum_successful_adapters: profile.minimum_successful_adapters,
    ...(retry ? { retried_adapter: retry, archived_attempt: archivedAttempt } : {}),
    command_results: commandResults,
  };
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
    if (!run) throw new Error('Usage: node src/run-adapters.mjs --run runs/<run-id> [--dry-run | --retry <adapter-id>]');
    const dryRun = process.argv.includes('--dry-run');
    const retry = option('--retry');
    if (dryRun && retry) throw new Error('--dry-run and --retry cannot be combined');
    const result = dryRun
      ? previewAdapterCommands({ runRoot: run })
      : runAdapters({ runRoot: run, retry });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
