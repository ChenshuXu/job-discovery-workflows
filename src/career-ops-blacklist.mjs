#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { careerOpsEnv, resolveCareerPaths } from './career-ops-paths.mjs';
import { postingKey } from './posting-identity.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function careerBlacklistSnapshot(careerRoot) {
  const { blacklistFile } = resolveCareerPaths(careerRoot);
  return { path: blacklistFile, sha256: existsSync(blacklistFile) ? hash(readFileSync(blacklistFile)) : null };
}

export function assertCareerBlacklistUnchanged(careerRoot, expected) {
  if (!expected || JSON.stringify(careerBlacklistSnapshot(careerRoot)) !== JSON.stringify(expected)) {
    throw new Error('Career-Ops blacklist changed after planning; re-plan before evaluating or applying');
  }
}

// Use the installed scanner's parser and matcher so company normalization and
// domain boundaries stay identical to Career-Ops. Its ESM graph is async; a
// short-lived child keeps the planner API synchronous without copying the rules.
export function checkCareerBlacklist(careerRoot, records) {
  const paths = resolveCareerPaths(careerRoot);
  const snapshot = careerBlacklistSnapshot(careerRoot);
  if (snapshot.sha256 === null) return { snapshot, matches: [] };
  const code = `
    import { readFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const api = await import(pathToFileURL(input.module).href);
    if (typeof api.parseBlacklist !== 'function' || typeof api.findBlacklistEntry !== 'function') throw new Error('Career-Ops blacklist interface is incompatible');
    const list = api.parseBlacklist(input.text);
    const matches = input.records.flatMap(record => {
      const entry = api.findBlacklistEntry(list, record.company, record.primary_url);
      return entry ? [{ posting_key: record.primary_key, company: record.company, posting_url: record.primary_url, entry }] : [];
    });
    process.stdout.write(JSON.stringify(matches));
  `;
  const text = readFileSync(paths.blacklistFile, 'utf8');
  if (hash(text) !== snapshot.sha256) throw new Error('Career-Ops blacklist changed while being read');
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', code], {
    cwd: paths.codeRoot, env: careerOpsEnv(paths, { NODE_OPTIONS: '' }), encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ module: path.join(paths.codeRoot, 'scan.mjs'), text, records }),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Career-Ops blacklist check failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim()}`);
  assertCareerBlacklistUnchanged(careerRoot, snapshot);
  let matches;
  try { matches = JSON.parse(result.stdout); } catch { throw new Error('Career-Ops blacklist returned invalid JSON'); }
  if (!Array.isArray(matches)) throw new Error('Career-Ops blacklist returned invalid matches');
  return { snapshot, matches };
}

export function applyCareerBlacklist({ careerRoot, records, runId, allowKeys = [] }) {
  const keys = new Set(records.map(record => record.primary_key));
  if (keys.size !== records.length) throw new Error('blacklist scope contains duplicate posting keys');
  for (const record of records) {
    if (!record.primary_key || postingKey(record.primary_url) !== record.primary_key) throw new Error(`blacklist posting key must match its exact URL: ${record.primary_key || '<missing>'}`);
  }
  const allowed = [...new Set(allowKeys)].sort();
  for (const key of allowed) if (!keys.has(key)) throw new Error(`blacklist override is outside this exact posting scope: ${key}`);
  const { snapshot, matches } = checkCareerBlacklist(careerRoot, records);
  const matchKeys = new Set(matches.map(item => item.posting_key));
  for (const key of allowed) if (!matchKeys.has(key)) throw new Error(`blacklist override does not match a current blacklist entry: ${key}`);
  const excluded = matches.filter(item => !allowed.includes(item.posting_key));
  const excludedKeys = new Set(excluded.map(item => item.posting_key));
  return {
    accepted: records.filter(record => !excludedKeys.has(record.primary_key)),
    excluded,
    snapshot,
    audit: { schema_version: 1, run_id: runId, snapshot, checked_keys: [...keys].sort(),
      overrides: allowed, excluded_count: excluded.length, results: matches.map(item => ({ ...item,
        disposition: allowed.includes(item.posting_key) ? 'EXPLICIT_OVERRIDE' : 'BLACKLIST_HOLD' })) },
  };
}

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const company = arg('--company'), url = arg('--url'), key = arg('--posting-key');
    if (!company || !url || !key) throw new Error('Usage: node src/career-ops-blacklist.mjs --career-ops CODE_ROOT --company COMPANY --url URL --posting-key KEY [--allow-blacklisted KEY]');
    const result = applyCareerBlacklist({ careerRoot: arg('--career-ops'), records: [{ primary_key: key, company, primary_url: url }],
      runId: null, allowKeys: arg('--allow-blacklisted') ? [arg('--allow-blacklisted')] : [] });
    console.log(JSON.stringify({ status: result.excluded.length ? 'REQUIRES_USER_OVERRIDE' : 'CLEAR', ...result.audit }, null, 2));
    if (result.excluded.length) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
