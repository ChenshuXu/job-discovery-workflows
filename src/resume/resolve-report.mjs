import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAREER_OPS_ROOT } from './cv-source.mjs';

export { CAREER_OPS_ROOT };
const DISCOVERY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function reportStem(reportPath) {
  return basename(reportPath, '.md').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8,}$/, '');
}

function nextVersion(tailoredRoot) {
  if (!existsSync(tailoredRoot)) return 'v001';
  const versions = readdirSync(tailoredRoot).map((name) => name.match(/^v(\d{3})$/)?.[1]).filter(Boolean).map(Number);
  return `v${String((versions.length ? Math.max(...versions) : 0) + 1).padStart(3, '0')}`;
}

function field(markdown, name) {
  return markdown.match(new RegExp(`^${name}:\\s*["']([^"']+)["']\\s*$`, 'm'))?.[1] ?? null;
}

function reportIdentity(reportPath) {
  const report = readFileSync(reportPath, 'utf8');
  const labelledPostingKey = report.match(/^\*\*Posting Key:\*\*\s*(.+?)\s*$/m)?.[1]?.trim() ?? null;
  return { runId: field(report, 'run_id'), postingKey: field(report, 'posting_key') ?? labelledPostingKey };
}

function boundPersistedJd({ runId, postingKey }, careerOpsRoot) {
  if (!postingKey) return null;
  const jdRoot = resolve(careerOpsRoot, 'jds');
  if (!existsSync(jdRoot)) return null;
  const safeKey = postingKey.replace(/[^A-Za-z0-9._-]/g, '-');
  if (runId && /^[A-Za-z0-9._-]+$/.test(runId)) {
    const candidate = resolve(jdRoot, `discovery-${runId}-${safeKey}.md`);
    return existsSync(candidate) ? candidate : null;
  }
  const matches = readdirSync(jdRoot).filter((name) => {
    const match = name.match(/^discovery-(\d{8}-\d{6})-(.+)\.md$/);
    return match?.[2] === safeKey;
  });
  if (matches.length > 1) {
    throw new Error(`IDENTITY_BLOCKER ambiguous persisted JD for posting key ${postingKey}: ${matches.join(', ')}`);
  }
  return matches.length === 1 ? resolve(jdRoot, matches[0]) : null;
}

function boundDiscoveryJd({ runId, postingKey }, discoveryRoot) {
  if (!runId || !postingKey) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const safeKey = postingKey.replace(/[^A-Za-z0-9._-]/g, '-');
  const candidate = resolve(discoveryRoot, 'runs', runId, 'jobs', `${safeKey}.md`);
  return existsSync(candidate) ? candidate : null;
}

function candidateBundles(result, careerOpsRoot) {
  const direct = reportStem(result.reportPath);
  const outputRoot = resolve(careerOpsRoot, 'output');
  const matches = [];
  if (existsSync(resolve(outputRoot, direct))) matches.push(direct);
  for (const name of existsSync(outputRoot) ? readdirSync(outputRoot) : []) {
    if (name.startsWith(`${result.reportNum}-`) && existsSync(resolve(outputRoot, name, 'jd/current.md'))) matches.push(name);
  }
  return [...new Set(matches)];
}

export function resolveReport(query, options = {}) {
  const careerOpsRoot = options.careerOpsRoot ?? CAREER_OPS_ROOT;
  const discoveryRoot = options.discoveryRoot ?? DISCOVERY_ROOT;
  const queryText = String(query);
  const exactBundleQuery = /^\d+-[a-z0-9-]+$/.test(queryText) ? queryText : undefined;
  const findQuery = exactBundleQuery ? queryText.match(/^\d+/)[0] : queryText;
  let results;
  try {
    results = options.results ?? JSON.parse(execFileSync(process.execPath, [resolve(careerOpsRoot, 'find.mjs'), findQuery, '--json'], { encoding: 'utf8' }));
  } catch (error) {
    throw new Error(`IDENTITY_BLOCKER find.mjs failed: ${error.message}`);
  }
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(`IDENTITY_BLOCKER expected one report, found ${Array.isArray(results) ? results.length : 'invalid'}: ${JSON.stringify(results)}`);
  }
  const result = results[0];
  const reportPath = resolve(careerOpsRoot, result.reportPath);
  if (!existsSync(reportPath)) throw new Error(`IDENTITY_BLOCKER missing report: ${reportPath}`);
  const identity = reportIdentity(reportPath);
  const boundJd = boundPersistedJd(identity, careerOpsRoot) ?? boundDiscoveryJd(identity, discoveryRoot);
  const bundles = candidateBundles(result, careerOpsRoot);
  if (bundles.length > 1) throw new Error(`IDENTITY_BLOCKER expected at most one current JD bundle for report ${result.reportNum}, found ${bundles.length}: ${bundles.join(', ')}`);
  const bundle = bundles[0] ?? reportStem(result.reportPath);
  if (exactBundleQuery && bundle !== exactBundleQuery) throw new Error(`IDENTITY_BLOCKER bundle mismatch: ${bundle} ← ${exactBundleQuery}`);
  const bundlePath = resolve(careerOpsRoot, 'output', bundle);
  const outputJd = resolve(bundlePath, 'jd/current.md');
  const jdPath = existsSync(outputJd) ? outputJd : boundJd;
  if (!jdPath) throw new Error(`IDENTITY_BLOCKER missing current JD for report ${result.reportNum}: ${outputJd}`);
  const tailoredRoot = resolve(bundlePath, 'cv/tailored');
  const version = nextVersion(tailoredRoot);
  return {
    ...result, bundle, bundlePath, jdPath, reportPath, tailoredRoot, version,
    targetPath: resolve(tailoredRoot, version),
  };
}
