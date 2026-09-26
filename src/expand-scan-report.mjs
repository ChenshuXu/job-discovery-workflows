#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFullReportMarkdown, readCompactReportSummary, replaceMachineSummaryVia } from './scan-report-contract.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CAREER_ROOT = path.resolve(PROJECT_ROOT, '..', 'career-ops');

function headerField(report, name) {
  return report.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s{0,2}$`, 'mi'))?.[1]?.trim() ?? null;
}

function reportBody(report) {
  const marker = '\n---\n\n';
  const index = report.indexOf(marker);
  if (index < 0) throw new Error('report is missing the header/body delimiter');
  return { header: report.slice(0, index + marker.length), body: report.slice(index + marker.length).trim() };
}

function safeKey(key) {
  return key.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function resolveCompactReport(selector, careerRoot = DEFAULT_CAREER_ROOT, discoveryRoot = PROJECT_ROOT) {
  const reportsRoot = path.join(path.resolve(careerRoot), 'reports');
  const value = String(selector ?? '').trim();
  if (!value) throw new Error('report selector is required');
  let candidates = [];
  const direct = path.resolve(value);
  if (existsSync(direct) && path.dirname(direct) === reportsRoot) candidates = [direct];
  else {
    const files = readdirSync(reportsRoot).filter(name => name.endsWith('.md') && !name.endsWith('-RESERVED.md'));
    if (/^\d+$/.test(value)) candidates = files.filter(name => Number(name.match(/^(\d+)-/)?.[1]) === Number(value)).map(name => path.join(reportsRoot, name));
    else candidates = files.filter(name => name === value || name.replace(/\.md$/, '') === value).map(name => path.join(reportsRoot, name));
  }
  if (candidates.length !== 1) throw new Error(`report selector must resolve exactly once; found ${candidates.length}`);
  const reportFile = candidates[0];
  const original = readFileSync(reportFile, 'utf8');
  const { header, body } = reportBody(original);
  const summary = readCompactReportSummary(body);
  const { run_id: runId, posting_key: postingKey, posting_url: postingUrl, score } = summary;
  if (headerField(header, 'Posting Key') !== postingKey || headerField(header, 'URL') !== postingUrl
      || Number(headerField(header, 'Score')?.replace('/5', '')) !== score) throw new Error('compact header and Machine Summary identity/score mismatch');
  const jdFile = path.join(path.resolve(discoveryRoot), 'runs', runId, 'jobs', `${safeKey(postingKey)}.md`);
  if (!existsSync(jdFile)) throw new Error(`bound source JD is missing: ${jdFile}`);
  return { reportFile, jdFile, runId, postingKey, postingUrl, score, header, body, original, summary };
}

export function prepareExpansion(selector, careerRoot = DEFAULT_CAREER_ROOT, discoveryRoot = PROJECT_ROOT) {
  const resolved = resolveCompactReport(selector, careerRoot, discoveryRoot);
  return {
    status: 'READY_FOR_EXPANSION',
    report: resolved.reportFile,
    jd: resolved.jdFile,
    run_id: resolved.runId,
    posting_key: resolved.postingKey,
    posting_url: resolved.postingUrl,
    score: resolved.score,
    full_report_rules: [path.join(careerRoot, 'modes/_shared.md'), path.join(careerRoot, 'modes/oferta.md')],
    candidate_sources: [path.join(careerRoot, 'cv.md'), path.join(careerRoot, 'config/profile.yml'), path.join(careerRoot, 'modes/_profile.md')],
  };
}

export function commitExpansion(selector, draftFile, careerRoot = DEFAULT_CAREER_ROOT, discoveryRoot = PROJECT_ROOT) {
  const resolved = resolveCompactReport(selector, careerRoot, discoveryRoot);
  const compactVia = resolved.summary.via;
  if (!compactVia) throw new Error('compact report is missing a quoted via discovery channel');
  const expandedWithVia = replaceMachineSummaryVia(readFileSync(path.resolve(draftFile), 'utf8'), compactVia, 'expanded report draft');
  const expanded = normalizeFullReportMarkdown(expandedWithVia, 'expanded report draft');
  const backupRoot = path.join(path.resolve(careerRoot), 'reports', '.expansion-backups');
  mkdirSync(backupRoot, { recursive: true });
  const backupFile = path.join(backupRoot, `${path.basename(resolved.reportFile)}.compact.md`);
  if (existsSync(backupFile)) throw new Error(`compact backup already exists: ${backupFile}`);
  writeFileSync(backupFile, resolved.original, { flag: 'wx' });
  const staged = `${resolved.reportFile}.tmp-${process.pid}`;
  writeFileSync(staged, `${resolved.header}${expanded}\n`);
  renameSync(staged, resolved.reportFile);
  return { status: 'EXPANDED', report: resolved.reportFile, compact_backup: backupFile, posting_key: resolved.postingKey };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, selector, draft] = process.argv.slice(2).filter(value => !value.startsWith('--') && value !== arg('--career-ops'));
    const careerRoot = path.resolve(arg('--career-ops') ?? DEFAULT_CAREER_ROOT);
    const result = command === 'prepare' ? prepareExpansion(selector, careerRoot)
      : command === 'commit' ? commitExpansion(selector, draft, careerRoot)
        : (() => { throw new Error('Usage: expand-scan-report.mjs prepare <report> [--career-ops <dir>] | commit <report> <draft> [--career-ops <dir>]'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
