import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyScanRuntime } from '../daily-scan-runtime.mjs';
import { resolveCareerPaths } from '../career-ops-paths.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const POST_SCAN_ROOT = path.join(PROJECT_ROOT, '.local/linkedin-post-scan');
export const REPORT_ROOT = path.join(PROJECT_ROOT, '.local/outputs/linkedin-post-scan');
export const DEFAULT_CONFIG = path.join(PROJECT_ROOT, 'config/linkedin-post-scan.json');

const resolveProjectPath = value => path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);

export function loadConfig(file = DEFAULT_CONFIG) {
  const resolved = path.resolve(file);
  let value;
  try { value = JSON.parse(readFileSync(resolved, 'utf8')); }
  catch (error) { throw new Error(`post scan config is not valid JSON: ${resolved}: ${error.message}`); }
  if (!value.phrase_groups || !Object.keys(value.phrase_groups).length) throw new Error('post scan config requires phrase_groups');
  if (!value.role_groups || !Object.keys(value.role_groups).length) throw new Error('post scan config requires role_groups');
  if (!value.location_groups || !Object.keys(value.location_groups).length) throw new Error('post scan config requires location_groups');
  const paths = Object.fromEntries(Object.entries(value.paths ?? {}).map(([key, target]) => [key, resolveProjectPath(target)]));
  if (paths.career_ops_root) {
    const career = resolveCareerPaths(paths.career_ops_root);
    paths.cv = career.cvFile;
    paths.profile = career.profileFile;
  }
  for (const [key, target] of Object.entries(paths)) if (!existsSync(target)) throw new Error(`post scan config path missing (${key}): ${target}`);
  const runtime = loadDailyScanRuntime(paths.daily_scan_runtime);
  return { ...value, file: resolved, paths, runtime };
}
