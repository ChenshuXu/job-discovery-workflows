#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyScanRuntime, workerIdsForRuntime } from './daily-scan-runtime.mjs';
import { buildCanonicalFingerprintAudit } from './canonical-url-fingerprint.mjs';
import { evaluateLocationScope, isAllowedLocationDecision, loadLocationPolicy } from './location-scope.mjs';
import { validateRun } from './run-contract.mjs';
import { collectHistoricalSemanticContexts } from './posting-history.mjs';
import { RESULT_SCHEMA_VERSION } from './scoring-safety.mjs';
import { semanticIdentity } from './semantic-jd-identity.mjs';

function atomicJson(file, value) {
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staged, file);
}

function locationScopeForRun(run, policy) {
  const file = path.join(run.root, 'triage/location-scope.json');
  let audit;
  if (existsSync(file)) {
    audit = JSON.parse(readFileSync(file, 'utf8'));
    if (audit.schema_version !== 1 || audit.run_id !== path.basename(run.root) || !Array.isArray(audit.results)) throw new Error('invalid triage/location-scope.json');
    if (JSON.stringify(audit.policy) !== JSON.stringify(policy)) throw new Error('location policy does not match the existing run audit');
  } else {
    const results = run.records.map(record => ({
      posting_key: record.primary_key,
      company: record.company,
      title: record.title,
      sources: record.sources,
      ...evaluateLocationScope(record, policy),
    }));
    audit = {
      schema_version: 1,
      run_id: path.basename(run.root),
      policy,
      pre_scope_count: results.length,
      accepted_count: results.filter(item => item.allowed).length,
      excluded_count: results.filter(item => !item.allowed).length,
      ambiguous_count: results.filter(item => item.decision.startsWith('AMBIGUOUS_')).length,
      results,
    };
    mkdirSync(path.dirname(file), { recursive: true });
    atomicJson(file, audit);
  }
  if (audit.pre_scope_count !== audit.results.length
      || audit.accepted_count !== audit.results.filter(item => item.allowed).length
      || audit.excluded_count !== audit.results.filter(item => !item.allowed).length
      || audit.ambiguous_count !== audit.results.filter(item => String(item.decision).startsWith('AMBIGUOUS_')).length
      || audit.pre_scope_count !== audit.accepted_count + audit.excluded_count) {
    throw new Error('location-scope audit counts do not reconcile');
  }
  const decisions = new Map(audit.results.map(item => [String(item.posting_key), item]));
  if (decisions.size !== audit.results.length) throw new Error('location-scope audit contains duplicate posting keys');
  for (const item of audit.results) {
    if (item.allowed !== isAllowedLocationDecision(item.decision)) throw new Error(`${item.posting_key}: location-scope allowed flag contradicts decision`);
  }
  const currentKeys = new Set(run.records.map(record => record.primary_key));
  const alreadyScoped = JSON.stringify(run.acquisition.location_scope_policy) === JSON.stringify(policy);
  if (!alreadyScoped) {
    if (currentKeys.size !== decisions.size || [...currentKeys].some(key => !decisions.has(key))) throw new Error('pre-scope acquisition keys do not match location-scope audit');
  } else {
    const historicalDuplicates = new Set((run.acquisition.historical_duplicates ?? []).map(item => String(item.primary_key)));
    const missingAccepted = audit.results.filter(item => isAllowedLocationDecision(item.decision) && !currentKeys.has(String(item.posting_key)));
    if (missingAccepted.some(item => !historicalDuplicates.has(String(item.posting_key)))) throw new Error('scoped acquisition is missing an allowed key without historical-duplicate evidence');
  }
  const records = run.records.map(record => {
    const scope = decisions.get(record.primary_key);
    if (!scope) throw new Error(`${record.primary_key}: missing location-scope decision`);
    return { ...record, location_scope: scope };
  });
  return { file, audit, records, accepted: records.filter(record => isAllowedLocationDecision(record.location_scope.decision)) };
}

export function interleaveBySource(keys) {
  const buckets = new Map();
  for (const key of keys) {
    const source = String(key).split(':', 1)[0];
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(String(key));
  }
  const sources = [...buckets.keys()].sort();
  const output = [];
  for (let index = 0; output.length < keys.length; index += 1) {
    for (const source of sources) if (buckets.get(source)[index] != null) output.push(buckets.get(source)[index]);
  }
  return output;
}

export function assignKeys(keys, workerCount) {
  const workers = workerIdsForRuntime({ scheduler: { max_active_workers: workerCount } });
  const assignments = Object.fromEntries(workers.map(worker => [worker, []]));
  keys.forEach((key, index) => assignments[workers[index % workers.length]].push(key));
  for (const worker of workers) assignments[worker] = interleaveBySource(assignments[worker]);
  return assignments;
}

const semanticPair = identity => `${identity.semantic_job_key}\0${identity.posting_context_key}`;

function candidateSources(careerRoot) {
  return ['cv.md', 'config/profile.yml', 'modes/_profile.md'].map(label => {
    const file = path.join(careerRoot, label);
    if (!existsSync(file)) throw new Error(`approved candidate source missing: ${file}`);
    return { label, path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
}

function buildSemanticDeduplicationAudit({ records, exactAudit, semanticHistory, runRoot, runId, mode }) {
  const exactDuplicates = new Set(exactAudit.results.filter(item => item.duplicate).map(item => item.primary_key));
  const representatives = new Map();
  const enriched = new Map();
  const results = [...records].sort((a, b) => a.primary_key.localeCompare(b.primary_key)).map(record => {
    const markdown = readFileSync(path.join(runRoot, record.jd_path), 'utf8');
    const identity = semanticIdentity({ record, markdown });
    enriched.set(record.primary_key, { ...record, ...identity });
    const pair = semanticPair(identity);
    const historyMatches = semanticHistory.get(pair) ?? [];
    const prior = representatives.get(pair) ?? null;
    const exact = exactDuplicates.has(record.primary_key);
    const semanticAlias = !exact && (historyMatches.length > 0 || prior !== null);
    if (!prior && historyMatches.length === 0) representatives.set(pair, record.primary_key);
    const observed = semanticAlias ? 'SAME_CONTEXT_SEMANTIC_ALIAS' : 'UNIQUE_CONTEXT';
    const disposition = exact
      ? 'EXACT_HISTORY_DUPLICATE'
      : semanticAlias && mode === 'enforce' ? 'SAME_CONTEXT_SEMANTIC_ALIAS' : 'ASSIGNMENT';
    const evidence = Object.values(record.posting_evidence ?? {});
    return {
      primary_key: record.primary_key,
      posting_keys: record.posting_keys,
      semantic_job_key: identity.semantic_job_key,
      posting_context_key: identity.posting_context_key,
      normalizer_version: identity.normalizer_version,
      disposition,
      observed_semantic_disposition: observed,
      matched_run_primary_key: prior,
      matched_committed_evidence: historyMatches,
      posting_evidence: record.posting_evidence ?? {},
      is_reposted: evidence.some(item => /^reposted\b/i.test(String(item?.card_posted_label ?? '').trim())),
    };
  });
  return {
    schema_version: 1,
    run_id: runId,
    mode,
    accepted_count: results.length,
    exact_history_duplicate_count: results.filter(item => item.disposition === 'EXACT_HISTORY_DUPLICATE').length,
    same_context_semantic_alias_count: results.filter(item => item.observed_semantic_disposition === 'SAME_CONTEXT_SEMANTIC_ALIAS').length,
    enforced_semantic_alias_count: results.filter(item => item.disposition === 'SAME_CONTEXT_SEMANTIC_ALIAS').length,
    assignment_count: results.filter(item => item.disposition === 'ASSIGNMENT').length,
    results,
    enriched,
  };
}

export function planEvaluations(runDir, runtimeFile, careerDir) {
  const root = path.resolve(runDir);
  if (!careerDir) throw new Error('Career-Ops path is required for exact historical deduplication');
  const careerRoot = path.resolve(careerDir);
  const run = validateRun(root);
  if (run.errors.length) throw new Error(`run contract failed: ${run.errors.join('; ')}`);
  const file = path.join(root, 'assignments.json');
  if (existsSync(file)) {
    const output = JSON.parse(readFileSync(file, 'utf8'));
    if (path.resolve(output.career_ops_root ?? '') !== careerRoot) throw new Error('existing assignments Career-Ops root does not match planner target');
    if (JSON.stringify(output.runtime) !== JSON.stringify(loadDailyScanRuntime(runtimeFile))) throw new Error('existing assignments runtime does not match requested runtime');
    return { file, output };
  }
  const baselineFile = path.join(root, 'baseline.json');
  if (!existsSync(baselineFile)) throw new Error(`baseline missing: ${baselineFile}`);
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const livePolicy = loadLocationPolicy(path.join(careerRoot, 'config/profile.yml'));
  const policy = baseline.location_policy ?? livePolicy;
  if (JSON.stringify(policy) !== JSON.stringify(livePolicy)) throw new Error('Career-Ops location policy changed after baseline capture; start a new run');
  const lockedCandidateSources = candidateSources(careerRoot);
  const locationScope = locationScopeForRun(run, policy);
  const audit = buildCanonicalFingerprintAudit({ records: locationScope.accepted, careerRoot, runId: path.basename(root) });
  const duplicateKeys = new Set(audit.results.filter(item => item.duplicate).map(item => item.primary_key));
  const runtime = loadDailyScanRuntime(runtimeFile);
  const semanticHistory = collectHistoricalSemanticContexts({ careerRoot, locationPolicy: policy });
  const semanticAudit = buildSemanticDeduplicationAudit({
    records: locationScope.accepted,
    exactAudit: audit,
    semanticHistory,
    runRoot: root,
    runId: path.basename(root),
    mode: runtime.semantic_dedup_mode,
  });
  const semanticAliases = new Set(semanticAudit.results.filter(item => item.disposition === 'SAME_CONTEXT_SEMANTIC_ALIAS').map(item => item.primary_key));
  const priorDuplicates = Array.isArray(run.acquisition.historical_duplicates) ? run.acquisition.historical_duplicates : [];
  const duplicates = audit.results.filter(item => item.duplicate).map(item => ({ primary_key: item.primary_key, matched_keys: item.matched_keys }));
  const allDuplicates = [...new Map([...priorDuplicates, ...duplicates].map(item => [item.primary_key, item])).values()];
  const freshRecords = locationScope.accepted
    .filter(record => !duplicateKeys.has(record.primary_key) && !semanticAliases.has(record.primary_key))
    .map(record => semanticAudit.enriched.get(record.primary_key));
  const acquisition = {
    ...run.acquisition,
    source_unique_count: Math.max(Number(run.acquisition.source_unique_count ?? 0), Number(locationScope.audit.pre_scope_count)),
    location_exclusion_count: Number(locationScope.audit.excluded_count),
    location_ambiguous_count: Number(locationScope.audit.ambiguous_count),
    location_scope_policy: policy,
    historical_duplicate_count: allDuplicates.length,
    historical_duplicates: allDuplicates,
    keys: freshRecords.map(record => record.primary_key),
    acquired: freshRecords,
  };
  const resolutionFile = path.join(root, 'triage/canonical-url-resolutions.json');
  const resolution = existsSync(resolutionFile) ? JSON.parse(readFileSync(resolutionFile, 'utf8')) : { schema_version: 1, run_id: path.basename(root), results: [] };
  const { enriched, ...semanticDeduplication } = semanticAudit;
  const keys = [...acquisition.keys.map(String)].sort();
  if (new Set(keys).size !== keys.length) throw new Error('acquisition keys contain duplicates');
  const records = new Map((acquisition.acquired ?? []).map(record => [String(record.primary_key), record]));
  const primaryUrls = Object.fromEntries(keys.map(key => {
    const url = records.get(key)?.primary_url;
    if (typeof url !== 'string' || !url.trim()) throw new Error(`${key}: acquisition primary_url missing`);
    return [key, url];
  }));
  const assignments = assignKeys(keys, runtime.scheduler.max_active_workers);
  const output = {
    schema_version: 1,
    result_schema_version: RESULT_SCHEMA_VERSION,
    run_id: path.basename(root),
    career_ops_root: careerRoot,
    runtime,
    location_policy: policy,
    location_scope_audit: path.relative(root, locationScope.file),
    location_exclusion_count: Number(locationScope.audit.excluded_count),
    location_ambiguous_count: Number(locationScope.audit.ambiguous_count),
    assignments,
    primary_urls: primaryUrls,
    semantic_identities: Object.fromEntries(keys.map(key => [key, {
      semantic_job_key: records.get(key).semantic_job_key,
      posting_context_key: records.get(key).posting_context_key,
    }])),
    candidate_sources: lockedCandidateSources,
  };
  const removedKeys = new Set([
    ...locationScope.records.filter(record => !isAllowedLocationDecision(record.location_scope.decision)).map(record => record.primary_key),
    ...locationScope.accepted.filter(item => duplicateKeys.has(item.primary_key)).map(record => record.primary_key),
    ...locationScope.accepted.filter(item => semanticAliases.has(item.primary_key)).map(record => record.primary_key),
  ]);
  for (const record of run.records.filter(item => removedKeys.has(item.primary_key))) rmSync(path.join(root, record.jd_path), { force: true });
  atomicJson(path.join(root, 'acquisition.json'), acquisition);
  mkdirSync(path.dirname(resolutionFile), { recursive: true });
  atomicJson(resolutionFile, { ...resolution, history_deduplication: audit, semantic_deduplication: semanticDeduplication });
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(output, null, 2)}\n`);
  renameSync(staged, file);
  return { file, output };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const at = process.argv.indexOf('--run');
    const configAt = process.argv.indexOf('--runtime-config');
    const careerAt = process.argv.indexOf('--career-ops');
    const run = at >= 0 ? process.argv[at + 1] : null;
    const career = careerAt >= 0 ? process.argv[careerAt + 1] : null;
    if (!run || !career) throw new Error('Usage: node src/plan-scan-evaluations.mjs --run runs/<run-id> --career-ops ../career-ops [--runtime-config <file>]');
    console.log(JSON.stringify(planEvaluations(run, configAt >= 0 ? process.argv[configAt + 1] : undefined, career).output, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
