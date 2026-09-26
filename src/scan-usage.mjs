#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCodexUsageScope, collectCodexUsage } from './codex-usage.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fields = ['input_tokens', 'cached_input_tokens', 'uncached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const unique = values => [...new Set(values)];
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const contextFile = root => path.join(path.resolve(root), 'usage-context.json');
const iso = value => new Date(value ?? Date.now()).toISOString();
const count = value => Array.isArray(value) ? value.length : null;
const duration = (start, end) => start && end && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null;
const sumTokens = values => {
  const measured = values.filter(Boolean);
  return measured.length ? Object.fromEntries(fields.map(key => [key, measured.reduce((sum, item) => sum + (item[key] ?? 0), 0)])) : null;
};

function writeJson(file, value) {
  if (existsSync(file) && !lstatSync(file).isFile()) throw new Error('usage output must be a regular file');
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function readContext(root) {
  const value = readJson(contextFile(root));
  if (value && (value.schema_version !== 1 || value.run_id !== path.basename(path.resolve(root)) || !Array.isArray(value.segments))) {
    throw new Error('invalid usage context');
  }
  return value;
}

function codeSnapshot() {
  const files = ['config/worker-prompt.md', 'config/worker-scoring.md', 'config/report-contract.md', 'src/merge-worker-results.mjs', 'src/scoring-safety.mjs', 'src/scan-report-contract.mjs'];
  const hashes = Object.fromEntries(files.map(file => [file, digest(readFileSync(path.join(projectRoot, file), 'utf8'))]));
  const git = args => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  return { files: hashes, sha256: digest(hashes), git_head: head.status === 0 ? head.stdout.trim() : null, git_dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null };
}

export function startScanUsage({ runRoot, threadId, rootTurnId, sessionsDir, now, capture = captureCodexUsageScope } = {}) {
  const root = path.resolve(runRoot);
  const before = readContext(root);
  const historical = existsSync(path.join(root, 'baseline.json')) && !before;
  if (existsSync(path.join(root, 'receipt.json')) && (!threadId || !rootTurnId)) {
    throw new Error('historical usage requires explicit --coordinator-thread and --root-turn; never bind the current review turn');
  }
  const scope = capture({ ...(threadId ? { threadId } : {}), ...(rootTurnId ? { rootTurnId } : {}), sessionsDir, now });
  const existing = before?.segments.find(item => item.scope.coordinator_thread_id === scope.coordinator_thread_id && item.scope.root_turn_id === scope.root_turn_id);
  if (existing) {
    if (!existing.scope.session_id && scope.session_id) {
      existing.scope = scope;
      writeJson(contextFile(root), before);
    }
    return before;
  }
  const placeholder = threadId && rootTurnId && before?.segments.find(item => !item.scope.root_turn_id && (!item.scope.coordinator_thread_id || item.scope.coordinator_thread_id === threadId));
  if (placeholder && scope.session_id) {
    placeholder.scope = scope;
    writeJson(contextFile(root), before);
    return before;
  }
  const context = before ?? {
    schema_version: 1, run_id: path.basename(root), created_at: iso(now),
    workflow_started_at: historical ? null : iso(now), workflow_completed_at: null,
    implementation: historical ? null : codeSnapshot(), segments: [], source_attempts: [],
  };
  context.segments.push({ scope, workers: {} });
  // ponytail: coordinator-only sidecar writes; add a lock if telemetry gains concurrent writers.
  writeJson(contextFile(root), context);
  return context;
}

export function bindScanWorkers({ runRoot, workers, rootTurnId } = {}) {
  const root = path.resolve(runRoot);
  const context = readContext(root);
  if (!context) throw new Error('usage context missing; run daily-scan:usage start first');
  const segment = rootTurnId ? context.segments.find(item => item.scope.root_turn_id === rootTurnId) : context.segments.at(-1);
  if (!segment?.scope.root_turn_id || !segment.scope.coordinator_thread_id) throw new Error('coordinator scope is unavailable; bind an explicit verified thread/root turn first');
  const plan = readJson(path.join(root, 'assignments.json'));
  for (const binding of workers ?? []) {
    const match = /^(worker-\d+)=([a-f0-9-]{36})$/i.exec(binding);
    if (!match) throw new Error('worker binding must be worker-N=THREAD_ID');
    const [, worker, thread] = match;
    if (!Array.isArray(plan?.assignments?.[worker]) || !plan.assignments[worker].length) throw new Error(`${worker}: nonempty assignment required`);
    if (context.segments.some(item => item.scope.coordinator_thread_id === thread || Object.entries(item.workers).some(([owner, ids]) => owner !== worker && ids.includes(thread)))) {
      throw new Error('thread is already bound to another executor');
    }
    segment.workers[worker] = unique([...(segment.workers[worker] ?? []), thread]);
  }
  writeJson(contextFile(root), context);
  return context;
}

// Optional observation must never invalidate or roll back canonical scan persistence.
export function observeScanUsage(action) {
  try { return action(); }
  catch (error) { console.error(`Daily Scan usage unavailable: ${error.message}`); return null; }
}

export function recordScanSourceAttempt(runRoot, attempt) {
  const context = readContext(runRoot);
  if (!context) return null;
  context.source_attempts.push(attempt);
  writeJson(contextFile(runRoot), context);
  return attempt;
}

function outcomeFor(root, plan) {
  const receipt = readJson(path.join(root, 'receipt.json'));
  const acquisition = readJson(path.join(root, 'acquisition.json'));
  const origin = readJson(path.join(root, 'provenance/origin.json'));
  const keys = plan?.assignments ? Object.values(plan.assignments).flat() : null;
  return {
    kind: origin?.kind ?? 'daily_scan', live_acquisition: origin?.live_acquisition ?? null,
    receipt_status: receipt?.status ?? 'pending', assigned: count(keys), scored: count(receipt?.scored_keys),
    committed: count(receipt?.committed_evaluated_keys), reports: count(receipt?.reports),
    worker_failed: count(receipt?.failed), job_issues: count(receipt?.job_issues),
    below_threshold: count(receipt?.below_threshold_keys), hard_excluded: count(receipt?.hard_exclusion_keys),
    sources: acquisition?.sources?.map(item => ({ adapter: item.adapter, status: item.status, markdown_jobs: item.markdown_jobs ?? null })) ?? null,
    job_issue_codes: receipt?.job_issues ? Object.fromEntries(unique(receipt.job_issues.map(item => item.code)).map(code => [code, receipt.job_issues.filter(item => item.code === code).length])) : null,
    semantic_quality: 'unreviewed',
  };
}

function fingerprints(root, plan, context) {
  const acquisition = readJson(path.join(root, 'acquisition.json'));
  const baseline = readJson(path.join(root, 'baseline.json'));
  const records = new Map((acquisition?.acquired ?? []).map(item => [item.primary_key, item]));
  const keys = plan?.assignments ? unique(Object.values(plan.assignments).flat()).sort() : null;
  const sample = keys?.map(key => {
    const item = records.get(key);
    return item ? [key, item.company, item.title ?? item.role, item.location, item.employment_types ?? item.employment_type, item.workplace_type, plan.semantic_identities?.[key]] : null;
  });
  const { worker, ...policy } = plan?.runtime ?? {};
  return {
    sample: sample?.every(Boolean) ? digest(sample) : null,
    candidate: plan?.candidate_sources ? digest(plan.candidate_sources.map(({ label, sha256 }) => [label, sha256]).sort()) : null,
    execution_policy: plan && context?.implementation ? digest([context.implementation.sha256, policy]) : null,
    scheduling: plan ? digest([plan.assignments, plan.runtime?.scheduler]) : null,
    source_registry: baseline?.adapter_profile?.registry_sha256 ?? null,
  };
}

const settings = threads => unique(threads.flatMap(item => item.observed_settings ?? []).map(item => `${item.model ?? 'unknown'} / ${item.reasoning_effort ?? 'unknown'}`));

export function collectScanUsage({ runRoot, sessionsDir, now, collect = collectCodexUsage } = {}) {
  const root = path.resolve(runRoot);
  const context = readContext(root);
  const plan = readJson(path.join(root, 'assignments.json'));
  const issues = context ? [] : ['usage_context_missing'];
  const coordinators = [], workerThreads = [];
  for (const segment of context?.segments ?? []) {
    const workerEntries = Object.entries(segment.workers).flatMap(([worker, ids]) => ids.map(thread => [thread, worker]));
    const owners = new Map(workerEntries);
    const observation = collect({ scope: segment.scope, threadIds: [segment.scope.coordinator_thread_id, ...owners.keys()].filter(Boolean), sessionsDir, now });
    issues.push(...(observation.issues ?? []));
    for (const thread of observation.threads ?? []) {
      const item = { ...thread, root_turn_id: segment.scope.root_turn_id };
      if (thread.thread_id === segment.scope.coordinator_thread_id) coordinators.push(item);
      else workerThreads.push({ ...item, worker: owners.get(thread.thread_id) });
    }
  }
  if (!plan) issues.push('assignments_missing');
  const expected = Object.entries(plan?.assignments ?? {});
  const workers = expected.map(([worker, keys]) => {
    const threads = workerThreads.filter(item => item.worker === worker);
    const noModel = keys.length === 0;
    const tokens = noModel ? Object.fromEntries(fields.map(key => [key, 0])) : sumTokens(threads.map(item => item.tokens));
    const status = noModel ? 'no_model' : !tokens ? 'unavailable' : threads.every(item => item.status === 'complete') ? 'complete' : 'partial';
    if (!noModel && !threads.length) issues.push(`${worker}: execution_binding_missing`);
    const observed = settings(threads);
    const requested = plan.runtime?.worker ?? null;
    const mismatch = threads.some(item => item.observed_settings?.some(setting => setting.model !== requested?.model || setting.reasoning_effort !== requested?.reasoning_effort));
    return { worker, assigned: keys.length, status, requested, observed_settings: observed, requested_observed_mismatch: mismatch, tokens, threads,
      wall_ms_sum: threads.length && threads.every(item => item.wall_ms != null) ? threads.reduce((sum, item) => sum + item.wall_ms, 0) : noModel ? 0 : null };
  });
  const coordinatorTokens = sumTokens(coordinators.map(item => item.tokens));
  const workerTokens = sumTokens(workers.map(item => item.tokens));
  const tokens = coordinatorTokens || workerThreads.some(item => item.tokens) ? sumTokens([coordinatorTokens, workerTokens]) : null;
  const complete = context?.segments.length && coordinators.length === context.segments.length && coordinators.every(item => item.status === 'complete')
    && plan && workers.every(item => ['complete', 'no_model'].includes(item.status)) && !issues.length;
  const status = !coordinatorTokens && !workerThreads.some(item => item.tokens) ? 'unavailable' : complete ? 'complete' : 'partial';
  const timestamps = [...coordinators, ...workerThreads];
  const start = timestamps.map(item => item.started_at).filter(Boolean).sort()[0];
  const end = timestamps.map(item => item.completed_at).filter(Boolean).sort().at(-1);
  const allDone = timestamps.length && timestamps.every(item => item.completed_at);
  const active = timestamps.some(item => item.started_at && !item.completed_at);
  const taskWall = coordinators.length === 1 && start === coordinators[0].started_at && end === coordinators[0].completed_at
    ? coordinators[0].wall_ms : duration(start, end);
  const outcome = outcomeFor(root, plan);
  return {
    schema_version: 1, run_id: path.basename(root), status, collected_at: iso(now),
    measurement_scope: 'Explicit coordinators and bound scoring workers within frozen Codex root turns; includes their preflight and final replies, excludes later unbound turns. Other work in a bound turn cannot be separated.',
    issues: unique(issues), tokens, coordinator_tokens: coordinatorTokens, worker_tokens: workerTokens,
    coordinator_observed_settings: settings(coordinators), coordinators, workers,
    coverage: { coordinator_segments: context?.segments.length ?? null, measured_coordinator_segments: coordinators.filter(item => item.tokens).length,
      expected_nonempty_workers: plan ? workers.filter(item => item.assigned > 0).length : null,
      measured_nonempty_workers: workers.filter(item => item.assigned > 0 && item.tokens).length },
    timing: { workflow_wall_ms: duration(context?.workflow_started_at, context?.workflow_completed_at),
      task_wall_ms: allDone ? taskWall : null, observed_task_wall_ms: start ? allDone ? taskWall : duration(start, active ? iso(now) : end) : null,
      coordinator_wall_ms_sum: coordinators.length && coordinators.every(item => item.wall_ms != null) ? coordinators.reduce((sum, item) => sum + item.wall_ms, 0) : null,
      worker_wall_ms_sum: workers.length && workers.every(item => item.wall_ms_sum != null) ? workers.reduce((sum, item) => sum + item.wall_ms_sum, 0) : null,
      source_wall_ms_sum: context?.source_attempts.length ? context.source_attempts.reduce((sum, item) => sum + item.wall_ms, 0) : null },
    source_attempts: context?.source_attempts ?? [], implementation: context?.implementation ?? null,
    outcome, fingerprints: fingerprints(root, plan, context),
    efficiency: { tokens_per_assigned_job: status === 'complete' && outcome.assigned > 0 ? tokens.total_tokens / outcome.assigned : null,
      worker_tokens_per_assigned_job: workers.every(item => ['complete', 'no_model'].includes(item.status)) && outcome.assigned > 0 ? workerTokens.total_tokens / outcome.assigned : null,
      worker_failure_rate: outcome.assigned > 0 && outcome.worker_failed !== null ? outcome.worker_failed / outcome.assigned : null },
  };
}

export function refreshScanUsage(options) {
  const value = collectScanUsage(options);
  writeJson(path.join(path.resolve(options.runRoot), 'usage.json'), value);
  return value;
}

export function finishScanUsage(runRoot, now) {
  const context = readContext(runRoot);
  if (!context) return null; // Legacy runs and other workflows do not acquire a current-session binding.
  context.workflow_completed_at ??= iso(now);
  writeJson(contextFile(runRoot), context);
  return refreshScanUsage({ runRoot, now });
}

export function compareScanUsage(values) {
  const warnings = ['Different daily samples are observational comparisons, not controlled model-quality A/B tests. Counts come from original immutable receipts, not later corrections, and do not measure semantic correctness.'];
  for (const field of ['sample', 'candidate', 'execution_policy', 'scheduling', 'source_registry']) {
    const hashes = values.map(value => value.fingerprints[field]);
    if (hashes.some(hash => !hash)) warnings.push(`${field}: fingerprint unavailable for some runs`);
    if (unique(hashes.filter(Boolean)).length > 1) warnings.push(`${field}: differs between runs`);
  }
  const scopeOwners = new Map();
  for (const value of values) for (const item of value.coordinators) {
    const key = `${item.thread_id}:${item.root_turn_id}`;
    if (scopeOwners.has(key) && scopeOwners.get(key) !== value.run_id) warnings.push(`${value.run_id} and ${scopeOwners.get(key)} share a coordinator root turn; totals overlap`);
    scopeOwners.set(key, value.run_id);
  }
  return { schema_version: 1, warnings: unique(warnings), runs: values };
}

function comparisonRows(values) {
  return values.map(value => ({
    run: value.run_id, kind: value.outcome.kind, receipt: value.outcome.receipt_status, usage: value.status,
    coordinator: value.coordinator_observed_settings.join('; ') || 'unknown',
    workers_requested: unique(value.workers.map(item => item.requested ? `${item.requested.model} / ${item.requested.reasoning_effort}` : 'unknown')).join('; '),
    workers_observed: unique(value.workers.flatMap(item => item.observed_settings)).join('; ') || 'unknown',
    worker_coverage: `${value.coverage.measured_nonempty_workers}/${value.coverage.expected_nonempty_workers ?? '?'}`,
    total_tokens: value.tokens?.total_tokens ?? null, input_tokens: value.tokens?.input_tokens ?? null,
    cached_input_tokens: value.tokens?.cached_input_tokens ?? null, uncached_input_tokens: value.tokens?.uncached_input_tokens ?? null,
    output_tokens: value.tokens?.output_tokens ?? null, reasoning_output_tokens: value.tokens?.reasoning_output_tokens ?? null,
    coordinator_tokens: value.coordinator_tokens?.total_tokens ?? null, worker_tokens: value.worker_tokens?.total_tokens ?? null,
    task_seconds: value.timing.task_wall_ms === null ? null : value.timing.task_wall_ms / 1000,
    observed_task_seconds: value.timing.observed_task_wall_ms === null ? null : value.timing.observed_task_wall_ms / 1000,
    workflow_seconds: value.timing.workflow_wall_ms === null ? null : value.timing.workflow_wall_ms / 1000,
    worker_seconds_sum: value.timing.worker_wall_ms_sum === null ? null : value.timing.worker_wall_ms_sum / 1000,
    assigned: value.outcome.assigned, committed: value.outcome.committed, reports: value.outcome.reports,
    worker_failed: value.outcome.worker_failed, job_issues: value.outcome.job_issues,
    tokens_per_job: value.efficiency.tokens_per_assigned_job, semantic_quality: value.outcome.semantic_quality,
  }));
}

export function renderScanUsage(comparison, format = 'markdown') {
  if (format === 'json') return JSON.stringify(comparison, null, 2);
  const rows = comparisonRows(comparison.runs);
  if (!rows.length) return 'No runs with usage context.';
  if (format === 'csv') {
    const cell = value => {
      const text = String(value ?? '');
      return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    return [[...Object.keys(rows[0]), 'comparison_warnings'], ...rows.map(row => [...Object.values(row), comparison.warnings.join('; ')])].map(row => row.map(cell).join(',')).join('\n');
  }
  const columns = ['run', 'usage', 'coordinator', 'workers_observed', 'worker_coverage', 'total_tokens', 'cached_input_tokens', 'uncached_input_tokens', 'output_tokens', 'workflow_seconds', 'observed_task_seconds', 'assigned', 'reports', 'worker_failed', 'job_issues'];
  const cell = value => value === null ? 'unknown' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(key => cell(row[key])).join(' | ')} |`), '',
    ...comparison.warnings.map(warning => `- ${warning}`),
    '- Partial totals are measured subtotals. Cached input is included in input; reasoning is included in output. Tokens are not a cash bill. Final-reply tokens require refresh after the bound turn ends.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), command = args.shift() ?? 'refresh';
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (['--json', '--csv', '--all'].includes(key)) { options[key] = true; continue; }
      if (!['--run', '--worker', '--coordinator-thread', '--root-turn', '--sessions-dir'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`invalid usage option: ${key}`);
      if (!['--run', '--worker'].includes(key) && options[key]) throw new Error(`${key} may be supplied only once`);
      (options[key] ??= []).push(args[++index]);
    }
    if (options['--json'] && options['--csv']) throw new Error('choose --json or --csv');
    const runs = options['--run'] ?? [];
    if (options['--all']) {
      if (command !== 'compare' || runs.length) throw new Error('--all requires compare without --run');
      for (const entry of readdirSync(path.join(projectRoot, 'runs'), { withFileTypes: true })) {
        const root = path.join(projectRoot, 'runs', entry.name);
        if (entry.isDirectory() && existsSync(contextFile(root))) runs.push(root);
      }
    }
    if (!runs.length || (command !== 'compare' && runs.length !== 1)) throw new Error('Usage: daily-scan:usage start|bind|refresh|compare --run runs/RUN_ID [--worker worker-N=THREAD_ID] [--json|--csv]');
    const common = { sessionsDir: options['--sessions-dir']?.[0] };
    if (command === 'start') console.log(JSON.stringify(startScanUsage({ ...common, runRoot: runs[0], threadId: options['--coordinator-thread']?.[0], rootTurnId: options['--root-turn']?.[0] }), null, 2));
    else if (command === 'bind') {
      if (!options['--worker']?.length) throw new Error('bind requires at least one --worker');
      console.log(JSON.stringify(bindScanWorkers({ runRoot: runs[0], workers: options['--worker'], rootTurnId: options['--root-turn']?.[0] }), null, 2));
    }
    else if (['refresh', 'compare'].includes(command)) {
      const values = unique(runs.map(root => path.resolve(root))).map(runRoot => refreshScanUsage({ ...common, runRoot }));
      console.log(renderScanUsage(compareScanUsage(values), options['--json'] ? 'json' : options['--csv'] ? 'csv' : 'markdown'));
    } else throw new Error(`unknown usage command: ${command}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
