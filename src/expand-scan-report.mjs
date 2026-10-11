#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { normalizeFullReportMarkdown, readCompactReportSummary, readMachineSummary, fixedTermEvidenceLine } from './scan-report-contract.mjs';
import { careerOpsCodeRoot, resolveCareerPaths } from './career-ops-paths.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CAREER_ROOT = careerOpsCodeRoot();
const sha256 = text => createHash('sha256').update(text).digest('hex');

function headerField(report, name) {
  const matches = [...report.matchAll(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.+?)[ \\t]*$`, 'gmi'))];
  if (matches.length !== 1) throw new Error(`report header must contain exactly one ${name}`);
  return matches[0][1].trim();
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
  const paths = resolveCareerPaths(careerRoot);
  const reportsRoot = paths.reportsRoot;
  const value = String(selector ?? '').trim();
  if (!value) throw new Error('report selector is required');
  let candidates = [];
  const direct = path.resolve(value);
  const canonicalReportsRoot = realpathSync(reportsRoot);
  if (existsSync(direct) && path.dirname(realpathSync(direct)) === canonicalReportsRoot) candidates = [direct];
  else {
    const files = readdirSync(reportsRoot).filter(name => name.endsWith('.md') && !name.endsWith('-RESERVED.md'));
    if (/^\d+$/.test(value)) candidates = files.filter(name => Number(name.match(/^(\d+)-/)?.[1]) === Number(value)).map(name => path.join(reportsRoot, name));
    else candidates = files.filter(name => name === value || name.replace(/\.md$/, '') === value).map(name => path.join(reportsRoot, name));
  }
  if (candidates.length !== 1) throw new Error(`report selector must resolve exactly once; found ${candidates.length}`);
  const reportFile = realpathSync(candidates[0]);
  if (path.dirname(reportFile) !== canonicalReportsRoot) throw new Error('selected report resolves outside the configured reports directory');
  const original = readFileSync(reportFile, 'utf8');
  const { header, body } = reportBody(original);
  const summary = readCompactReportSummary(body);
  const { run_id: runId, posting_key: postingKey, posting_url: postingUrl, score } = summary;
  if (header.split('\n')[0] !== `# Evaluation: ${summary.company} — ${summary.role}`) throw new Error('compact header and Machine Summary company/role mismatch');
  if (headerField(header, 'Posting Key') !== postingKey || headerField(header, 'URL') !== postingUrl
      || Number(headerField(header, 'Score')?.replace('/5', '')) !== score) throw new Error('compact header and Machine Summary identity/score mismatch');
  const authLabel = body.match(/^## Work Authorization\n\n(.+?) — /m)?.[1];
  if (/^\*\*Work Auth:/m.test(header) && headerField(header, 'Work Auth') !== authLabel) throw new Error('compact header and work-authorization evidence mismatch');
  if (/^\*\*Legitimacy:/m.test(header) && headerField(header, 'Legitimacy') !== summary.legitimacy_tier) throw new Error('compact header and Machine Summary legitimacy mismatch');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('compact run_id must be a safe run directory name');
  const jdFile = path.join(path.resolve(discoveryRoot), 'runs', runId, 'jobs', `${safeKey(postingKey)}.md`);
  if (!existsSync(jdFile)) throw new Error(`bound source JD is missing: ${jdFile}`);
  return { reportFile, jdFile, runId, postingKey, postingUrl, score, header, body, original, summary, paths };
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
    source_sha256: sha256(resolved.original),
    machine_summary: resolved.summary,
    full_report_rules: [resolved.paths.sharedRulesFile, resolved.paths.ofertaRulesFile],
    candidate_sources: [resolved.paths.cvFile, resolved.paths.profileFile, resolved.paths.profileSummaryFile],
  };
}

function sourceEvidence(body) {
  const parts = body.split(/(?=^## )/m).filter(part => /^## (?:Score Evidence|Evidence|Gaps|Work Authorization)\n/.test(part));
  return `## Original Evaluation Evidence\n\nPreserved verbatim from the source compact evaluation.\n\n${parts.map(part => part.replace(/^## /, '### ')).join('').trim()}`;
}

export async function commitExpansion(selector, draftFile, careerRoot = DEFAULT_CAREER_ROOT, discoveryRoot = PROJECT_ROOT, { sourceSha256 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '')) throw new Error('sourceSha256 from expansion prepare is required');
  const resolved = resolveCompactReport(selector, careerRoot, discoveryRoot);
  if (sha256(resolved.original) !== sourceSha256) throw new Error('source report changed after prepare; prepare expansion again');
  const expanded = normalizeFullReportMarkdown(readFileSync(path.resolve(draftFile), 'utf8'), 'expanded report draft');
  if (!expanded.startsWith('## Machine Summary\n') || /^# /m.test(expanded)) throw new Error('expanded report draft must be a body beginning with Machine Summary, without a second report header');
  const draftSummary = readMachineSummary(expanded, 'expanded report draft');
  for (const name of new Set([...Object.keys(resolved.summary), ...Object.keys(draftSummary)])) {
    if (!isDeepStrictEqual(draftSummary[name], resolved.summary[name])) throw new Error(`expanded report draft changes immutable Machine Summary.${name}`);
  }
  if (/^#{1,6}\s+Original Evaluation Evidence\s*$/m.test(expanded)) throw new Error('expanded report draft must not supply the preserved evidence appendix');
  if (resolved.summary.result_schema_version === 6) {
    const sourceLines = resolved.body.split('\n').filter(line => line.startsWith('Fixed-term contract: ') || line === fixedTermEvidenceLine(null));
    const draftLines = expanded.split('\n').filter(line => line.startsWith('Fixed-term contract: ') || line === fixedTermEvidenceLine(null));
    if (sourceLines.length !== 1 || !isDeepStrictEqual(draftLines, sourceLines)) throw new Error('expanded report draft changes immutable fixed-term evidence');
  }
  const backupRoot = path.join(resolved.paths.reportsRoot, '.expansion-backups');
  const backupFile = path.join(backupRoot, `${path.basename(resolved.reportFile)}.compact.md`);
  if (existsSync(backupFile)) throw new Error(`compact backup already exists: ${backupFile}`);
  const lockModule = path.join(resolved.paths.codeRoot, 'pipeline-lock.mjs');
  if (!existsSync(lockModule)) throw new Error(`Career-Ops canonical lock interface missing: ${lockModule}`);
  const { acquirePipelineLock } = await import(pathToFileURL(lockModule).href);
  if (typeof acquirePipelineLock !== 'function') throw new Error('Career-Ops canonical lock interface is incompatible');
  const lock = await acquirePipelineLock(resolved.reportFile);
  const staged = `${resolved.reportFile}.tmp-${randomUUID()}`;
  let ownsBackup = false, replaced = false;
  try {
    if (readFileSync(resolved.reportFile, 'utf8') !== resolved.original) throw new Error('source report changed during expansion commit');
    if (existsSync(backupFile)) throw new Error(`compact backup already exists: ${backupFile}`);
    const output = `${resolved.header}${expanded}\n\n${sourceEvidence(resolved.body)}\n`;
    writeFileSync(staged, output, { flag: 'wx' });
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(backupFile, resolved.original, { flag: 'wx' });
    ownsBackup = true;
    if (readFileSync(resolved.reportFile, 'utf8') !== resolved.original) throw new Error('source report changed during expansion commit');
    renameSync(staged, resolved.reportFile);
    replaced = true;
    return { status: 'EXPANDED', report: resolved.reportFile, compact_backup: backupFile, posting_key: resolved.postingKey,
      source_sha256: sourceSha256, expanded_sha256: sha256(output) };
  } finally {
    rmSync(staged, { force: true });
    if (ownsBackup && !replaced) rmSync(backupFile, { force: true });
    lock.release();
  }
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const positional = [];
    for (let index = 2; index < process.argv.length; index++) {
      if (['--career-ops', '--discovery', '--source-sha256'].includes(process.argv[index])) index++;
      else positional.push(process.argv[index]);
    }
    const [command, selector, draft] = positional;
    const careerRoot = path.resolve(arg('--career-ops') ?? DEFAULT_CAREER_ROOT);
    const discoveryRoot = path.resolve(arg('--discovery') ?? PROJECT_ROOT);
    const result = command === 'prepare' ? prepareExpansion(selector, careerRoot, discoveryRoot)
      : command === 'commit' ? await commitExpansion(selector, draft, careerRoot, discoveryRoot, { sourceSha256: arg('--source-sha256') })
        : (() => { throw new Error('Usage: expand-scan-report.mjs prepare <report> | commit <report> <draft> --source-sha256 <prepare digest> [--career-ops <code dir>] [--discovery <dir>]'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
