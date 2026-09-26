import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'config/daily-scan-runtime.json');

export function validateDailyScanRuntime(value, label = 'daily-scan runtime') {
  if (value?.schema_version !== 1) throw new Error(`${label}: schema_version must be 1`);
  if (!value.worker?.model || !value.worker?.reasoning_effort) throw new Error(`${label}: worker model and reasoning_effort are required`);
  if (!Number.isInteger(value.scheduler?.max_active_workers) || value.scheduler.max_active_workers < 1) throw new Error(`${label}: max_active_workers must be a positive integer`);
  if (!Number.isInteger(value.scheduler?.batch_size) || value.scheduler.batch_size < 1) throw new Error(`${label}: batch_size must be a positive integer`);
  if (!Number.isFinite(value.reporting?.full_report_threshold) || value.reporting.full_report_threshold < 1 || value.reporting.full_report_threshold > 5) throw new Error(`${label}: full_report_threshold must be between 1 and 5`);
  if (!Number.isInteger(value.failure?.per_job_retry_limit) || value.failure.per_job_retry_limit < 0) throw new Error(`${label}: per_job_retry_limit must be a non-negative integer`);
  if (!Number.isInteger(value.retention?.evaluated_unapplied_ttl_days) || value.retention.evaluated_unapplied_ttl_days < 1) throw new Error(`${label}: evaluated_unapplied_ttl_days must be a positive integer`);
  if (!['shadow', 'enforce'].includes(value.semantic_dedup_mode)) throw new Error(`${label}: semantic_dedup_mode must be shadow or enforce`);
  return structuredClone(value);
}

export function workerIdsForRuntime(runtime) {
  const count = runtime?.scheduler?.max_active_workers;
  if (!Number.isInteger(count) || count < 1) throw new Error('daily-scan runtime: max_active_workers must be a positive integer');
  return Array.from({ length: count }, (_, index) => `worker-${index + 1}`);
}

export function loadDailyScanRuntime(file = DEFAULT) {
  return validateDailyScanRuntime(JSON.parse(readFileSync(path.resolve(file), 'utf8')), file);
}
