import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateDailyScanRuntime, workerIdsForRuntime } from './daily-scan-runtime.mjs';
import { validateWorkerParts } from './merge-worker-results.mjs';
import { RESULT_SCHEMA_VERSION } from './scoring-safety.mjs';

export function loadScanResults(runDir) {
  const root = path.resolve(runDir);
  const plan = JSON.parse(readFileSync(path.join(root, 'assignments.json'), 'utf8'));
  plan.runtime = validateDailyScanRuntime(plan.runtime, `${path.join(root, 'assignments.json')} runtime`);
  if (plan.result_schema_version !== RESULT_SCHEMA_VERSION) throw new Error(`assignments result_schema_version must be ${RESULT_SCHEMA_VERSION}`);
  const workers = workerIdsForRuntime(plan.runtime);
  const byKey = new Map();
  const validatedKeys = new Set();
  const errors = [];
  for (const worker of workers) {
    const file = path.join(root, 'results', `${worker}.json`);
    if (!existsSync(file)) { errors.push(`missing results/${worker}.json`); continue; }
    const artifact = JSON.parse(readFileSync(file, 'utf8'));
    const results = Array.isArray(artifact.results) ? artifact.results : [];
    if (artifact.result_schema_version !== RESULT_SCHEMA_VERSION || artifact.worker !== worker || !Array.isArray(artifact.results)) errors.push(`${worker}: invalid result schema`);
    try {
      const parts = validateWorkerParts(root, worker, { collectItemErrors: true });
      errors.push(...parts.itemErrors);
      if (!parts.itemErrors.length) {
        if (JSON.stringify(parts.results) === JSON.stringify(results)) {
          for (const item of parts.results) validatedKeys.add(String(item.posting_key));
        } else {
          errors.push(`${worker}: merged result does not equal ordered part union`);
        }
      } else {
        const finalByKey = new Map(results.map(item => [String(item.posting_key ?? ''), item]));
        for (const item of parts.results) {
          const key = String(item.posting_key);
          if (JSON.stringify(item) === JSON.stringify(finalByKey.get(key))) validatedKeys.add(key);
          else errors.push(`${key}: merged result does not equal validated part result`);
        }
      }
    } catch (error) { errors.push(error.message); }
    for (const item of results) {
      const key = String(item.posting_key ?? '');
      if (!key || byKey.has(key)) { errors.push(`${worker}: duplicate or missing posting_key ${key || '<missing>'}`); continue; }
      const status = String(item.status ?? 'EVALUATED').toUpperCase();
      byKey.set(key, { ...item, posting_key: key, status, worker });
    }
  }
  if (JSON.stringify(Object.keys(plan.assignments ?? {}).sort()) !== JSON.stringify([...workers].sort())) errors.push('assignment worker ids do not match runtime');
  const assignedKeys = Object.values(plan.assignments ?? {}).flat().map(String).sort();
  if (JSON.stringify(assignedKeys) !== JSON.stringify([...byKey.keys()].sort())) errors.push('assignment/result union mismatch');
  const evaluated = [...byKey.values()].filter(item => item.status === 'EVALUATED');
  const failed = [...byKey.values()].filter(item => item.status === 'FAILED');
  const candidates = evaluated.filter(item => validatedKeys.has(item.posting_key)
    && Number(item.score) >= plan.runtime.reporting.full_report_threshold && item.hard_exclusion === false);
  if (candidates.some(item => item.report_allowed !== true || !item.report)) errors.push('candidate set contains a result blocked by scoring safety');
  return { root, plan, byKey, evaluated, failed, candidates, errors };
}
