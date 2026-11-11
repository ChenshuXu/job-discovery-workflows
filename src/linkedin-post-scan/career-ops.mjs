import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workerIdsForRuntime } from '../daily-scan-runtime.mjs';
import { matchExcludedEmployer } from '../employer-exclusions.mjs';
import { localCalendarDate } from '../evaluated-retention.mjs';
import { DEFAULT_CONFIG, POST_SCAN_ROOT, PROJECT_ROOT } from './config.mjs';
import { safePostingKey } from '../posting-identity.mjs';

const atomicJson = (file, value) => { const staged = `${file}.tmp-${process.pid}`; writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`); renameSync(staged, file); };

function runNode(script, args, env) {
  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'src', script), ...args], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${script} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

export function prepareHandoffRun(db, config, postingKey, runId = null) {
  const prior = db.prepare('SELECT * FROM career_ops_handoffs WHERE posting_key=?').get(postingKey);
  if (prior && prior.status !== 'PREPARED') return { existing: true, handoff: prior };
  const row = db.prepare("SELECT * FROM opportunities WHERE posting_key=? AND kind='EXACT_JOB'").get(postingKey);
  if (!row) throw new Error(`exact opportunity not found: ${postingKey}`);
  if (row.status === 'EMPLOYER_EXCLUDED') return { existing: true, status: 'EMPLOYER_EXCLUDED', reason_code: row.reason_code };
  const evidence = JSON.parse(row.evidence_json);
  const exclusionsConfig = JSON.parse(readFileSync(config.paths.employer_exclusions, 'utf8'));
  const excluded = matchExcludedEmployer({ company: row.employer, description: evidence.jd_text }, exclusionsConfig.employer_exclusions);
  if (excluded) {
    // An excluded employer is a final outcome for this opportunity, not a failed handoff to retry.
    db.prepare("UPDATE opportunities SET status='EMPLOYER_EXCLUDED', reason_code=?, updated_at=? WHERE opportunity_id=?")
      .run(excluded.id, new Date().toISOString(), row.opportunity_id);
    return { existing: false, status: 'EMPLOYER_EXCLUDED', reason_code: excluded.id, exclusion: excluded };
  }
  // A PREPARED row means planning never finished; that run is left as evidence and a new one starts.
  if (prior) db.prepare('DELETE FROM career_ops_handoffs WHERE posting_key=?').run(postingKey);
  runId ??= `postscan-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runRoot = path.join(POST_SCAN_ROOT, 'runs', runId);
  const sourceRoot = path.join(runRoot, 'sources/linkedin-post-scan');
  const jobsRoot = path.join(sourceRoot, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  atomicJson(path.join(sourceRoot, 'excluded-employers.json'), { schema_version: 1, run_id: runId, excluded_count: 0, results: [] });
  const jobFile = path.join(jobsRoot, `${safePostingKey(postingKey)}.md`);
  const markdown = `# ${row.employer} - ${row.title}\n\n**URL:** ${row.official_url}\n**Company:** ${row.employer}\n**Role:** ${row.title}\n**Location:** ${row.location}\n**Employment Type:** ${evidence.employment_type ?? 'unknown'}\n**Employment Type Source:** ${evidence.employment_type_source ?? 'linkedin-post-deep-check'}\n**Workplace Type:** ${evidence.workplace_type ?? 'unknown'}\n**Workplace Type Source:** ${evidence.workplace_type_source ?? 'linkedin-post-deep-check'}\n**Structured Remote Signal:** ${evidence.structured_remote_signal === true}\n**Posted:** ${evidence.published_at ?? ''}\n**Source:** LinkedIn Post Scan\n**Discovery Run:** ${runId}\n**Posting Key:** ${postingKey}\n\n## Job Description\n\n${evidence.jd_text.trim()}\n`;
  writeFileSync(jobFile, markdown);
  atomicJson(path.join(sourceRoot, 'summary.json'), { schema_version: 1, run_id: runId, adapter: 'linkedin-post-scan', status: 'SUCCESS',
    raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0, excluded_employers: 0 });
  db.prepare(`INSERT INTO career_ops_handoffs (posting_key, opportunity_id, run_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'PREPARED', ?, ?)`)
    .run(postingKey, row.opportunity_id, runId, new Date().toISOString(), new Date().toISOString());
  return { existing: false, runId, runRoot, jobFile };
}

export function runHandoffPlanning(db, config, postingKey) {
  const prepared = prepareHandoffRun(db, config, postingKey);
  if (prepared.status === 'EMPLOYER_EXCLUDED') return prepared;
  if (prepared.existing) {
    const runRoot = path.join(POST_SCAN_ROOT, 'runs', prepared.handoff.run_id);
    const acquisitionFile = path.join(runRoot, 'acquisition.json');
    if (prepared.handoff.status === 'PLANNED_EMPTY' && existsSync(acquisitionFile)) {
      const acquisition = JSON.parse(readFileSync(acquisitionFile, 'utf8'));
      if (!acquisition.keys?.length && acquisition.historical_duplicates?.some(item => item.primary_key === postingKey)) {
        const timestamp = new Date().toISOString();
        db.prepare("UPDATE career_ops_handoffs SET status='ALREADY_TRACKED', reason_code='HISTORICAL_EXACT_DUPLICATE', updated_at=? WHERE posting_key=?").run(timestamp, postingKey);
        db.prepare("UPDATE opportunities SET status='ALREADY_TRACKED', reason_code='HISTORICAL_EXACT_DUPLICATE', updated_at=? WHERE posting_key=?").run(timestamp, postingKey);
        return { existing: true, status: 'ALREADY_TRACKED', runRoot, historical_duplicates: acquisition.historical_duplicates };
      }
    }
    return prepared;
  }
  const env = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: path.resolve(config.file ?? DEFAULT_CONFIG) };
  const career = config.paths.career_ops_root;
  const run = prepared.runRoot;
  const stages = {};
  stages.baseline = runNode('verify-scan-receipt.mjs', ['--run', run, '--career-ops', career, '--capture-baseline'], env);
  stages.combine = runNode('combine.mjs', ['--run', run], env);
  stages.contract = runNode('run-contract.mjs', ['--run', run], env);
  stages.urls = runNode('resolve-canonical-urls.mjs', ['--run', run], env);
  stages.plan = runNode('plan-scan-evaluations.mjs', ['--run', run, '--career-ops', career, '--full'], env);
  mkdirSync(path.join(run, 'results'), { recursive: true });
  const nonEmpty = [];
  for (const worker of workerIdsForRuntime(stages.plan.runtime)) {
    const assigned = stages.plan.assignments?.[worker] ?? [];
    if (assigned.length) nonEmpty.push({ worker, assigned });
    else stages[worker] = runNode('merge-worker-results.mjs', ['--run', run, '--worker', worker], env);
  }
  db.prepare("UPDATE career_ops_handoffs SET status=?, receipt_json=?, updated_at=? WHERE posting_key=?")
    .run(nonEmpty.length ? 'SCORING_REQUIRED' : 'PLANNED_EMPTY', JSON.stringify(stages), new Date().toISOString(), postingKey);
  return { ...prepared, stages, non_empty_assignments: nonEmpty,
    runtime: stages.plan.runtime, worker_prompt: path.join(PROJECT_ROOT, 'config/worker-prompt.md') };
}

export function finalizeHandoff(db, config, postingKey) {
  const handoff = db.prepare('SELECT * FROM career_ops_handoffs WHERE posting_key=?').get(postingKey);
  if (!handoff) throw new Error(`handoff not prepared: ${postingKey}`);
  if (handoff.status === 'ALREADY_TRACKED') return { status: handoff.status, existing: true };
  if (handoff.status === 'PREPARED') throw new Error(`handoff planning has not finished for ${postingKey}; run handoff-plan again`);
  const run = path.join(POST_SCAN_ROOT, 'runs', handoff.run_id);
  const env = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: path.resolve(config.file ?? DEFAULT_CONFIG) };
  try {
    const commit = runNode('commit-scan.mjs', ['--run', run, '--career-ops', config.paths.career_ops_root, '--date', localCalendarDate()], env);
    const receipt = JSON.parse(readFileSync(path.join(run, 'receipt.json'), 'utf8'));
    const report = (receipt.reports ?? []).find(item => item.posting_key === postingKey) ?? null;
    const has = field => Array.isArray(receipt[field]) && receipt[field].includes(postingKey);
    let status;
    if (report && has('tracker_keys') && has('scan_history_keys')) status = 'HANDED_OFF';
    else if (has('below_threshold_keys')) status = 'BELOW_THRESHOLD';
    else if (has('hard_exclusion_keys')) status = 'HARD_EXCLUDED';
    else {
      const locationFile = path.join(run, 'triage/location-scope.json');
      const location = existsSync(locationFile) ? JSON.parse(readFileSync(locationFile, 'utf8')) : null;
      if (location?.results?.some(item => item.posting_key === postingKey && item.allowed === false)) status = 'LOCATION_GATE_EXCLUDED';
      else if (has('job_issue_keys') || receipt.status !== 'COMPLETE') status = 'HANDOFF_FAILED';
      else status = 'HANDOFF_RESULT_UNRESOLVED';
    }
    const timestamp = new Date().toISOString();
    const reason = status === 'HANDED_OFF' ? null : status;
    const classification = { posting_key: postingKey, status, report, tracker_closed: has('tracker_keys'), scan_history_closed: has('scan_history_keys') };
    db.prepare("UPDATE career_ops_handoffs SET status=?, reason_code=?, report_identity=?, tracker_identity=?, receipt_json=?, updated_at=? WHERE posting_key=?")
      .run(status, reason, report ? JSON.stringify(report) : null, status === 'HANDED_OFF' ? postingKey : null,
        JSON.stringify({ commit, receipt, classification }), timestamp, postingKey);
    db.prepare('UPDATE opportunities SET status=?, reason_code=?, updated_at=? WHERE posting_key=?')
      .run(status, reason, timestamp, postingKey);
    return { commit, receipt, ...classification };
  } catch (error) {
    const timestamp = new Date().toISOString();
    const failure = { posting_key: postingKey, status: 'HANDOFF_FAILED', error: error.message };
    db.prepare("UPDATE career_ops_handoffs SET status='HANDOFF_FAILED', reason_code='HANDOFF_FAILED', receipt_json=?, updated_at=? WHERE posting_key=?")
      .run(JSON.stringify(failure), timestamp, postingKey);
    db.prepare("UPDATE opportunities SET status='HANDOFF_FAILED', reason_code='HANDOFF_FAILED', updated_at=? WHERE posting_key=?")
      .run(timestamp, postingKey);
    return failure;
  }
}
