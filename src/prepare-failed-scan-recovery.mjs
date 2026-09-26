#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotAdapterProfile } from './adapter-registry.mjs';
import { sourceRecord, writeAcquisition } from './combine.mjs';
import { validateDailyScanRuntime } from './daily-scan-runtime.mjs';
import { planEvaluations } from './plan-scan-evaluations.mjs';
import { semanticIdentity } from './semantic-jd-identity.mjs';
import { captureBaseline } from './verify-scan-receipt.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalSet = (a, b) => a.length === new Set(a).size && b.length === new Set(b).size
  && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const save = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};

/** Prepare a new evaluation of failed captured inputs; never acquire, retain or commit. */
export function prepareFailedScanRecovery({ sourceRun, runRoot, careerRoot, sourceRevision }) {
  const source = realpathSync(sourceRun);
  const root = path.resolve(runRoot);
  const career = path.resolve(careerRoot);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.basename(root)) || existsSync(root)) throw new Error('recovery destination must be a new named run');
  const inside = (parent, file) => file === parent || file.startsWith(`${parent}${path.sep}`);
  if (inside(source, root)) throw new Error('recovery destination must not be inside the source run');
  if (!/^[a-f0-9]{7,40}$/i.test(sourceRevision ?? '')) throw new Error('source-revision must be an explicit Git commit');
  const revision = execFileSync('git', ['rev-parse', '--verify', `${sourceRevision}^{commit}`], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  const inputs = new Map();
  const readOrigin = relative => {
    const file = path.resolve(source, relative);
    if (!inside(source, file) || !inside(source, realpathSync(file))) throw new Error(`source artifact escapes run: ${relative}`);
    const bytes = readFileSync(file);
    if (inputs.has(relative) && inputs.get(relative).sha256 !== digest(bytes)) throw new Error(`source artifact changed during recovery preparation: ${relative}`);
    inputs.set(relative, { path: relative, sha256: digest(bytes) });
    return bytes;
  };
  const json = relative => JSON.parse(readOrigin(relative).toString('utf8'));
  const receipt = json('receipt.json');
  const baseline = json('baseline.json');
  const original = json('assignments.json');
  const acquisition = json('acquisition.json');
  const resolutions = json('triage/canonical-url-resolutions.json');
  const sourceId = path.basename(source);
  if ([receipt, baseline, original, acquisition, resolutions].some(item => item.run_id !== sourceId)
      || receipt.schema_version !== 4 || receipt.status !== 'COMPLETE' || original.result_schema_version !== 3
      || acquisition.identity_parser_version !== 2 || path.resolve(original.career_ops_root ?? '') !== career) {
    throw new Error('source run identities, schema or Career-Ops root do not agree');
  }
  const runtime = validateDailyScanRuntime(original.runtime);
  if (!equalSet(acquisition.keys, acquisition.acquired.map(item => item.primary_key))
      || !equalSet(acquisition.keys, Object.values(original.assignments).flat())
      || !equalSet(acquisition.keys, receipt.acquired_keys)
      || !equalSet(acquisition.keys, [...receipt.committed_evaluated_keys, ...receipt.job_issue_keys])) {
    throw new Error('source acquisition, assignments and terminal sets do not conserve keys');
  }
  const issues = receipt.job_issues.filter(item => item.code === 'WORKER_FAILED');
  const keys = issues.map(item => item.posting_key);
  if (!keys.length || !equalSet(keys, receipt.failed.map(item => item.posting_key))) throw new Error('source receipt must identify exactly its failed worker keys');
  const selected = new Set(keys);
  const records = acquisition.acquired.filter(item => selected.has(item.primary_key));
  if (!equalSet(keys, records.map(item => item.primary_key))) throw new Error('failed keys do not resolve to unique acquired records');
  for (const issue of issues) {
    const owners = Object.entries(original.assignments).filter(([, assigned]) => assigned.includes(issue.posting_key));
    if (owners.length !== 1) throw new Error(`${issue.posting_key}: failed key ownership is not unique`);
    const [worker, assigned] = owners[0];
    const index = assigned.indexOf(issue.posting_key);
    const partNumber = Math.floor(index / runtime.scheduler.batch_size) + 1;
    const part = json(`results/${worker}.part-${partNumber}.json`);
    const final = json(`results/${worker}.json`);
    const item = part.results?.[index % runtime.scheduler.batch_size];
    const matches = final.results?.filter(value => value.posting_key === issue.posting_key) ?? [];
    if (part.result_schema_version !== 3 || final.result_schema_version !== 3 || part.worker !== worker || final.worker !== worker
        || part.part !== partNumber || item?.posting_key !== issue.posting_key || item.status !== 'FAILED'
        || item.attempts !== runtime.failure.per_job_retry_limit + 1 || item.error !== issue.reason || item.report !== null
        || JSON.stringify(part.results.map(value => value.posting_key)) !== JSON.stringify(assigned.slice((partNumber - 1) * runtime.scheduler.batch_size, partNumber * runtime.scheduler.batch_size))
        || JSON.stringify(final.results.map(value => value.posting_key)) !== JSON.stringify(assigned)
        || matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(item)) {
      throw new Error(`${issue.posting_key}: original terminal failure changed or is invalid`);
    }
  }
  const candidateLabels = ['cv.md', 'config/profile.yml', 'modes/_profile.md'];
  if (JSON.stringify(original.candidate_sources?.map(item => item.label)) !== JSON.stringify(candidateLabels)) throw new Error('source candidate hash set is invalid');
  for (const item of original.candidate_sources) {
    if (item.path !== path.join(career, item.label) || digest(readFileSync(item.path)) !== item.sha256) throw new Error(`approved candidate source hash changed: ${item.label}`);
  }

  const currentProfile = snapshotAdapterProfile();
  const oldProfile = baseline.adapter_profile;
  if (JSON.stringify(oldProfile?.adapters) !== JSON.stringify(currentProfile.adapters)
      || oldProfile.minimum_successful_adapters !== currentProfile.minimum_successful_adapters) throw new Error('adapter selection changed since source run');
  const oldFiles = new Map();
  const oldFile = relative => {
    if (!oldFiles.has(relative)) oldFiles.set(relative, execFileSync('git', ['show', `${revision}:${relative}`], { cwd: PROJECT_ROOT }));
    return oldFiles.get(relative);
  };
  if (digest(oldFile('config/discovery-adapters.v1.json')) !== oldProfile.registry_sha256) throw new Error('source registry/revision provenance mismatch');
  for (const adapter of oldProfile.adapters) {
    const before = oldProfile.adapter_definitions[adapter], after = currentProfile.adapter_definitions[adapter];
    if (before.config !== after.config || before.employer_exclusions !== after.employer_exclusions
        || JSON.stringify(before.command) !== JSON.stringify(after.command)
        || digest(oldFile(before.config)) !== before.config_sha256) throw new Error(`${adapter}: source config/revision provenance mismatch`);
  }
  for (const relative of ['config/daily-scan-runtime.json', 'config/worker-prompt.md', 'config/report-contract.md', 'src/scoring-safety.mjs', 'src/scan-report-contract.mjs']) oldFile(relative);
  if (JSON.stringify(JSON.parse(oldFile('config/daily-scan-runtime.json'))) !== JSON.stringify(runtime)) throw new Error('source revision runtime differs from original assignment snapshot');
  const resolutionByKey = new Map(resolutions.results.map(item => [item.posting_key, item]));
  if (resolutionByKey.size !== resolutions.results.length) throw new Error('source canonical resolutions contain duplicate keys');
  const files = [];
  const outcomes = [];
  for (const adapter of oldProfile.adapters) {
    const summary = json(`sources/${adapter}/summary.json`);
    json(`sources/${adapter}/excluded-employers.json`);
    if (summary.run_id !== sourceId || summary.adapter !== adapter || summary.status !== 'SUCCESS' || summary.errors !== 0
        || JSON.stringify(summary) !== JSON.stringify(acquisition.sources.find(item => item.adapter === adapter))) throw new Error(`${adapter}: source capture was not successful or changed`);
    const names = readdirSync(path.join(source, 'sources', adapter, 'jobs')).filter(name => name.endsWith('.md'));
    if (summary.markdown_jobs !== names.length || summary.unique_jobs !== names.length) throw new Error(`${adapter}: source JD counts changed`);
    for (const name of names) {
      const relative = `sources/${adapter}/jobs/${name}`;
      const file = path.join(source, relative);
      if (!inside(source, realpathSync(file))) throw new Error(`source artifact escapes run: ${relative}`);
      const record = sourceRecord(source, adapter, file);
      const resolved = resolutionByKey.get(record.primary_key);
      const owners = records.filter(item => item.posting_keys.includes(record.primary_key)
        || (resolved?.status === 'RESOLVED' && item.posting_keys.includes(resolved.official_key)));
      if (!owners.length) continue;
      if (owners.length !== 1 || !owners[0].sources.includes(adapter)) throw new Error(`${relative}: source subset ownership is ambiguous`);
      files.push({ path: relative, posting_key: owners[0].primary_key, bytes: readOrigin(relative) });
    }
    const count = files.filter(item => item.path.startsWith(`sources/${adapter}/`)).length;
    outcomes.push({ schema_version: 1, run_id: path.basename(root), adapter, status: count ? 'SUCCESS' : 'EMPTY', raw_rows: count,
      unique_jobs: count, markdown_jobs: count, errors: 0, acquisition_mode: 'frozen_subset_recovery', live_acquisition: false,
      origin_run_id: sourceId, origin_summary_sha256: inputs.get(`sources/${adapter}/summary.json`).sha256 });
  }
  if (outcomes.filter(item => item.status === 'SUCCESS').length < currentProfile.minimum_successful_adapters) throw new Error('recovered source subset cannot satisfy frozen minimum_successful_adapters');
  const hydrated = records.map(record => {
    for (const adapter of record.sources) if (!files.some(item => item.posting_key === record.primary_key && item.path.startsWith(`sources/${adapter}/`))) throw new Error(`${record.primary_key}: original source lineage is missing ${adapter}`);
    const bytes = readOrigin(record.jd_path);
    const parsed = sourceRecord(source, record.sources[0], path.join(source, record.jd_path));
    if (parsed.primary_key !== record.primary_key || parsed.primary_url !== record.primary_url) throw new Error(`${record.primary_key}: frozen JD identity changed`);
    const identity = semanticIdentity({ record, markdown: bytes.toString('utf8') });
    if (JSON.stringify(original.semantic_identities[record.primary_key]) !== JSON.stringify({ semantic_job_key: identity.semantic_job_key, posting_context_key: identity.posting_context_key })
        || record.semantic_job_key !== identity.semantic_job_key || record.posting_context_key !== identity.posting_context_key) throw new Error(`${record.primary_key}: frozen JD or semantic identity changed`);
    return { ...record, jd_origin: { run_id: sourceId, path: record.jd_path, sha256: digest(bytes) }, _text: bytes.toString('utf8'), _size: bytes.length };
  });

  // The caller chooses a new destination; this path never resumes or resets the source run.
  let ancestor = path.dirname(root);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (inside(source, realpathSync(ancestor))) throw new Error('recovery destination parent resolves inside the source run');
  mkdirSync(path.dirname(root), { recursive: true });
  mkdirSync(root);
  const fresh = captureBaseline({ runRoot: root, careerRoot: career });
  if (fresh.baseline.pipeline.exit_code !== 0 || fresh.baseline.pipeline.errors) throw new Error('Career-Ops pipeline is not healthy for recovery preparation');
  for (const file of files) save(path.join(root, file.path), file.bytes);
  for (const outcome of outcomes) {
    mkdirSync(path.join(root, 'sources', outcome.adapter, 'jobs'), { recursive: true });
    save(path.join(root, 'sources', outcome.adapter, 'summary.json'), outcome);
    save(path.join(root, 'sources', outcome.adapter, 'excluded-employers.json'), { schema_version: 1, run_id: path.basename(root), excluded_count: 0, results: [] });
  }
  for (const [relative, bytes] of oldFiles) save(path.join(root, 'provenance', 'original', relative), bytes);
  writeAcquisition(root, fresh.baseline.adapter_profile, outcomes, hydrated, { rawSourceJobs: files.length, identityParserVersion: 2 });
  const resolutionSubset = resolutions.results.filter(item => records.some(record => record.posting_keys.includes(item.posting_key) || record.posting_keys.includes(item.official_key)));
  save(path.join(root, 'triage/canonical-url-resolutions.json'), { schema_version: 1, run_id: path.basename(root), origin_run_id: sourceId, results: resolutionSubset });
  const { output: plan } = planEvaluations(root, path.join(root, 'provenance/original/config/daily-scan-runtime.json'), career);
  if (Object.values(plan.assignments).flat().some(key => !selected.has(key))) throw new Error('recovery planner introduced an unselected key');
  if (JSON.stringify(plan.candidate_sources) !== JSON.stringify(original.candidate_sources)) throw new Error('approved candidate source hashes changed during recovery preparation');
  for (const input of inputs.values()) if (digest(readFileSync(path.join(source, input.path))) !== input.sha256) throw new Error(`source artifact changed during recovery preparation: ${input.path}`);
  const origin = { schema_version: 1, kind: 'failed_evaluation_recovery', source_run_id: sourceId, source_run_path: source,
    source_revision: revision, live_acquisition: false, retention_performed: false, selected_keys: [...keys].sort(),
    assigned_keys: Object.values(plan.assignments).flat().sort(), inputs: [...inputs.values()],
    source_files: files.map(({ path: file, posting_key, bytes }) => ({ path: file, posting_key, sha256: digest(bytes) })),
    original_code: [...oldFiles].map(([file, bytes]) => ({ path: file, snapshot: `provenance/original/${file}`, sha256: digest(bytes) })) };
  save(path.join(root, 'provenance/origin.json'), origin);
  mkdirSync(path.join(root, 'results'));
  return { runRoot: root, selected_count: keys.length, assigned_count: origin.assigned_keys.length, assignments: path.join(root, 'assignments.json'), origin: path.join(root, 'provenance/origin.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };
    if (['--source-run', '--run', '--career-ops', '--source-revision'].some(flag => !arg(flag))) throw new Error('Usage: node src/prepare-failed-scan-recovery.mjs --source-run runs/<completed> --run runs/<new> --career-ops ../career-ops --source-revision <commit>');
    console.log(JSON.stringify(prepareFailedScanRecovery({ sourceRun: arg('--source-run'), runRoot: arg('--run'), careerRoot: arg('--career-ops'), sourceRevision: arg('--source-revision') }), null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
