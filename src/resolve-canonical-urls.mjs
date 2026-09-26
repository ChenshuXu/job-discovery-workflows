#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeByPostingKeys, writeAcquisition } from './combine.mjs';
import { normalizePostingKeys, postingFingerprint, postingKey, primaryPostingKey } from './posting-identity.mjs';
import { validateRun } from './run-contract.mjs';

const urls = text => [...String(text).matchAll(/https?:\/\/[^\s<>'"`|)]+/gi)].map(match => match[0].replace(/[),.;]+$/, ''));
const EXACT_ATS = new Set(['ashby', 'google-careers', 'greenhouse', 'hirebridge', 'icims', 'lever', 'phenom', 'smartrecruiters', 'taleo', 'workday']);
const official = value => {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (unresolvedGreenhouseEmbed(value)) return null;
  const key = postingKey(value);
  if (!key || key.startsWith('linkedin:') || key.startsWith('jobright:')) return null;
  if (EXACT_ATS.has(key.split(':', 1)[0])) return key;
  const looksLikePosting = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com)$/i.test(url.hostname)
    || /(?:^|\.)(?:jobs|careers)\./i.test(url.hostname)
    || /\/(?:jobs?|careers?|positions?|postings?)\//i.test(url.pathname);
  if (!looksLikePosting) return null;
  return key;
};

function unresolvedGreenhouseEmbed(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const token = url.searchParams.get('token');
  return /(?:^|\.)greenhouse\.io$/.test(host)
    && url.pathname.replace(/\/+$/, '') === '/embed/job_app'
    && /^\d+$/.test(token || '')
    && !url.searchParams.get('for')
    ? { url: value, token, placeholder_key: postingKey(value) }
    : null;
}

async function followGreenhouseTenantRedirect(candidate, fetchImpl) {
  try {
    let current = candidate.url;
    for (let redirectCount = 0; redirectCount < 3; redirectCount += 1) {
      const response = await fetchImpl(current, { method: 'HEAD', redirect: 'manual' });
      const location = response.headers.get('location');
      if (!location) return null;
      const resolved = new URL(location, current).toString();
      const unresolved = unresolvedGreenhouseEmbed(resolved);
      if (unresolved) {
        if (unresolved.token !== candidate.token) return null;
        current = resolved;
        continue;
      }
      const fingerprint = postingFingerprint(resolved);
      return fingerprint?.ats === 'greenhouse' && fingerprint.requisitionId === candidate.token
        ? { url: resolved, key: postingKey(fingerprint) }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveCanonicalUrls(runDir, { force = false, fetchImpl = globalThis.fetch } = {}) {
  const run = validateRun(runDir);
  if (run.errors.length) throw new Error(`run contract failed: ${run.errors.join('; ')}`);
  const output = path.join(run.root, 'triage/canonical-url-resolutions.json');
  let superseded = null;
  if (existsSync(output)) {
    if (!force) throw new Error(`resolution ledger exists; use --force: ${output}`);
    superseded = `${output}.superseded-${new Date().toISOString().replace(/[:.]/g, '')}`;
    renameSync(output, superseded);
  }
  const results = [];
  const enriched = [];
  for (const record of run.records) {
    const jdFile = path.join(run.root, record.jd_path);
    const text = readFileSync(jdFile, 'utf8');
    const capturedUrls = urls(text);
    const redirect = capturedUrls.map(unresolvedGreenhouseEmbed).find(Boolean);
    let candidate = capturedUrls.map(url => ({ url, key: official(url) })).find(item => item.key);
    if (!candidate && redirect) candidate = await followGreenhouseTenantRedirect(redirect, fetchImpl);
    const hasLinkedIn = record.posting_keys.some(key => key.startsWith('linkedin:'));
    const needsResolution = hasLinkedIn || Boolean(redirect);
    if (!needsResolution || !candidate) {
      results.push({ posting_key: record.primary_key, status: needsResolution ? 'UNRESOLVED' : 'NOT_APPLICABLE', reason: needsResolution ? 'No exact official posting URL in captured JD' : undefined });
      enriched.push({ ...record, _text: text, _size: statSync(jdFile).size });
      continue;
    }
    const candidateGreenhouse = candidate.key.match(/^greenhouse:[^:]+:(\d+)$/);
    const replacesPlaceholder = redirect?.placeholder_key && candidateGreenhouse?.[1] === redirect.token;
    const replacedKey = replacesPlaceholder ? redirect.placeholder_key : null;
    const postingKeys = normalizePostingKeys([...record.posting_keys.filter(key => key !== replacedKey), candidate.key]);
    const sourceKeys = Object.fromEntries(Object.entries(record.source_keys).map(([source, key]) => [source, key === replacedKey ? candidate.key : key]));
    const postingUrls = { ...record.posting_urls };
    if (replacedKey) delete postingUrls[replacedKey];
    postingUrls[candidate.key] = candidate.url;
    results.push({ posting_key: record.primary_key, status: 'RESOLVED', official_url: candidate.url, official_key: candidate.key, ...(replacedKey ? { replaced_key: replacedKey } : {}) });
    enriched.push({
      ...record, posting_keys: postingKeys, primary_key: primaryPostingKey(postingKeys),
      source_keys: sourceKeys, posting_urls: postingUrls,
      primary_url: candidate.url, _text: text, _size: statSync(jdFile).size,
    });
  }
  const merged = mergeByPostingKeys(enriched);
  const acquisition = writeAcquisition(run.root, run.profile, run.acquisition.sources, merged, {
    rawSourceJobs: run.acquisition.raw_source_jobs,
    identityParserVersion: run.acquisition.identity_parser_version ?? 1,
  });
  mkdirSync(path.dirname(output), { recursive: true });
  const staged = `${output}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify({ schema_version: 1, run_id: path.basename(run.root), results }, null, 2)}\n`);
  renameSync(staged, output);
  return { acquisition, results, output, superseded };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const index = process.argv.indexOf('--run');
    const run = index >= 0 ? process.argv[index + 1] : null;
    if (!run) throw new Error('Usage: node src/resolve-canonical-urls.mjs --run runs/<run-id> [--force]');
    const value = await resolveCanonicalUrls(run, { force: process.argv.includes('--force') });
    console.log(JSON.stringify({ acquired: value.acquisition.acquired.length, resolved: value.results.filter(item => item.status === 'RESOLVED').length, unresolved: value.results.filter(item => item.status === 'UNRESOLVED').length }, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
