#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { careerOpsCodeRoot } from '../career-ops-paths.mjs';
import { postingKey } from '../posting-identity.mjs';
import { matchExcludedEmployer, validateEmployerExclusionRules } from '../employer-exclusions.mjs';
import { validateJd } from '../run-contract.mjs';
import { fetchOfficialPosting, HttpClient, mapLimit } from './google_ats_direct_scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = 'official-ats';
const SITES = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'], ashby: ['jobs.ashbyhq.com'],
};
// shortcut: upstream Workday discovery merges sites before handoff; add it only with site-preserving discovery.
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const line = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export function loadCareerAtsConfig(file = path.join(ROOT, 'config/official-ats.json')) {
  const config = readJson(file);
  if (config.schema_version !== 1) throw new Error('unsupported official ATS config schema');
  for (const [name, maximum] of [['max_post_age_hours', 168], ['limit_per_ats', 500], ['http_timeout_ms', 120000], ['scan_timeout_ms', 3600000], ['official_fetch_concurrency', 10]]) {
    if (!Number.isInteger(config[name]) || config[name] < 1 || config[name] > maximum) throw new Error(`invalid ${name}`);
  }
  if (!Array.isArray(config.ats) || !config.ats.length || new Set(config.ats).size !== config.ats.length || config.ats.some(id => !Object.hasOwn(SITES, id))) throw new Error('invalid ATS selection');
  for (const name of ['positive', 'negative']) {
    if (!Array.isArray(config.title_filter?.[name]) || config.title_filter[name].some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))) throw new Error(`invalid title_filter.${name}`);
  }
  if (!config.title_filter.positive.length) throw new Error('official ATS requires positive title keywords');
  validateEmployerExclusionRules(config.employer_exclusions);
  return config;
}

function parseArgs(argv) {
  const options = { discoveryRoot: ROOT, configFile: path.join(ROOT, 'config/official-ats.json') };
  const flags = { '--discovery-root': 'discoveryRoot', '--run-id': 'runId', '--config': 'configFile', '--career-ops': 'careerRoot', '--fixture': 'fixtureFile' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (flags[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flags[argv[i]]] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!options.dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId ?? '')) throw new Error('a safe --run-id is required');
  return options;
}

export async function runCareerAts(options) {
  const config = loadCareerAtsConfig(options.configFile);
  const codeRoot = careerOpsCodeRoot(options.careerRoot);
  const scanner = path.join(codeRoot, 'scan-ats-full.mjs');
  if (!existsSync(scanner)) throw new Error(`Career-Ops ATS scanner missing: ${scanner}`);
  const args = ['--since', String(config.max_post_age_hours / 24), '--ats', config.ats.join(','), '--limit', String(config.limit_per_ats), '--dry-run', '--json'];
  if (options.dryRun) return { dry_run: true, adapter: ID, scanner, args, config };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId ?? '')) throw new Error('a safe run id is required');
  const source = path.resolve(options.discoveryRoot, 'runs', options.runId, 'sources', ID);
  if (existsSync(source)) throw new Error(`source artifacts already exist: ${source}`);
  mkdirSync(path.join(source, 'jobs'), { recursive: true });
  const runtime = path.join(source, 'upstream');
  mkdirSync(runtime);
  // Keep candidate history and profile gates out of upstream discovery.
  const portals = path.join(runtime, 'portals.yml');
  writeJson(path.join(source, 'config.json'), config);
  writeJson(portals, { title_filter: config.title_filter, tracked_companies: [] });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAREER_OPS_')));
  Object.assign(env, { NODE_OPTIONS: '', CAREER_OPS_ROOT: runtime, CAREER_OPS_DATA_DIR: runtime, CAREER_OPS_PORTALS: portals,
    CAREER_OPS_TRACKER: path.join(runtime, 'data/applications.md'), CAREER_OPS_SCAN_HISTORY: path.join(runtime, 'data/scan-history.tsv'),
    CAREER_OPS_PIPELINE: path.join(runtime, 'data/pipeline.md') });
  const errors = [], audit = [], exclusions = [], captured = [];
  const fixture = options.fixtureFile ? readJson(options.fixtureFile) : null;
  const now = new Date(fixture?.now ?? Date.now());
  const http = new HttpClient(fixture, config.http_timeout_ms);
  let upstream = null;
  try {
    const child = spawnSync(process.execPath, ['--permission', '--allow-net', '--allow-fs-read=*', `--allow-fs-write=${runtime}`, scanner, ...args], {
      cwd: codeRoot, env, encoding: 'utf8', timeout: config.scan_timeout_ms, maxBuffer: 30 * 1024 * 1024,
    });
    writeFileSync(path.join(source, 'upstream.stdout.txt'), child.stdout ?? '');
    writeFileSync(path.join(source, 'upstream.stderr.txt'), child.stderr ?? '');
    if (child.status !== 0) throw new Error(`upstream scan failed: ${child.error?.message ?? `exit ${child.status}`}`);
    upstream = JSON.parse(child.stdout);
    if (!Array.isArray(upstream.offers) || JSON.stringify(upstream.sources) !== JSON.stringify(config.ats)
      || ['companiesScanned', 'companiesAvailable', 'unreachableBoards', 'cappedBoards'].some(field => !Number.isInteger(upstream[field]) || upstream[field] < 0)
      || typeof upstream.stoppedByOutage !== 'boolean'
      || typeof upstream.capHit !== 'boolean' || config.ats.some(id => !['ok', 'stale', 'empty'].includes(upstream.datasetStatus?.[id]))) throw new Error('unsupported upstream scan receipt');
    if (upstream.stoppedByOutage || upstream.unreachableBoards || upstream.cappedBoards || config.ats.some(id => upstream.datasetStatus[id] !== 'ok')) {
      errors.push({ stage: 'discovery', code: 'PARTIAL_COVERAGE', message: 'ATS discovery has unavailable, stale, empty, truncated or interrupted boards; validated JDs remain usable.' });
    }
    const seen = new Set();
    await mapLimit(upstream.offers, config.official_fetch_concurrency, async offer => {
      try {
        const key = postingKey(offer.url);
        if (!key || !config.ats.includes(key.split(':')[0])) throw new Error('offer has no supported exact ATS identity');
        if (seen.has(key)) { audit.push({ posting_key: key, status: 'DUPLICATE' }); return; }
        seen.add(key);
        const posting = await fetchOfficialPosting({ link: offer.url }, { ats_sites: config.ats.map(id => ({ id, domains: SITES[id] })) }, http, now);
        const posted = Date.parse(posting.posted_at);
        if (!Number.isFinite(posted) || posted < now.getTime() - config.max_post_age_hours * 3600000 || posted > now.getTime() + 300000) {
          audit.push({ posting_key: key, status: 'SKIPPED_AGE', posted_at: posting.posted_at || null }); return;
        }
        if (!posting.company || !posting.title || validateJd(posting.description, key).length) throw new Error('official JD is incomplete or blocked');
        const excluded = matchExcludedEmployer(posting, config.employer_exclusions);
        if (excluded) { exclusions.push({ posting_key: key, company: posting.company, url: posting.canonical_url, ...excluded }); return; }
        const fields = { 'Posting Key': key, 'URL': posting.canonical_url, 'Company': posting.company, 'Role': posting.title, 'Location': posting.location || 'unknown',
          'Employment Type': posting.employment_type || 'unknown', 'Employment Type Source': posting.employment_type_source || 'unknown',
          'Workplace Type': posting.workplace_type, 'Workplace Type Source': posting.workplace_type_source, 'Structured Remote Signal': posting.structured_remote_signal,
          'Posted': posting.posted_at, 'Source': 'Career-Ops official ATS', 'Discovery Run': options.runId };
        const markdown = `# ${line(posting.company)} - ${line(posting.title)}\n\n${Object.entries(fields).map(([name, value]) => `**${name}:** ${line(value)}`).join('\n')}\n\n## Job Description\n\n${posting.description.trim()}\n`;
        const file = `jobs/${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`;
        writeFileSync(path.join(source, file), markdown, { flag: 'wx' });
        captured.push({ posting_key: key, url: posting.canonical_url, file });
        audit.push({ posting_key: key, status: 'CAPTURED', file });
      } catch (error) { errors.push({ stage: 'official-jd', url: offer?.url ?? null, message: error.message }); }
    });
  } catch (error) { errors.push({ stage: 'discovery', message: error.message }); }
  writeJson(path.join(source, 'official-responses.json'), { json: Object.fromEntries(http.jsonCache), text: Object.fromEntries(http.textCache) });
  writeJson(path.join(source, 'candidate-audit.json'), { schema_version: 1, run_id: options.runId, results: audit });
  writeJson(path.join(source, 'excluded-employers.json'), { schema_version: 1, run_id: options.runId, excluded_count: exclusions.length, results: exclusions });
  writeJson(path.join(source, 'capture-manifest.json'), { schema_version: 1, run_id: options.runId, captured });
  writeJson(path.join(source, 'errors.json'), { schema_version: 1, run_id: options.runId, errors });
  const summary = { schema_version: 1, run_id: options.runId, adapter: ID, status: errors.length ? 'FAILED' : captured.length ? 'SUCCESS' : 'EMPTY',
    raw_rows: upstream?.offers?.length ?? 0, unique_jobs: captured.length, markdown_jobs: captured.length, errors: errors.length,
    retryable: false, started_at: now.toISOString(), max_post_age_hours: config.max_post_age_hours,
    coverage: upstream && { ats: config.ats, limit_per_ats: config.limit_per_ats, cap_hit: upstream.capHit, companies_available: upstream.companiesAvailable,
      companies_scanned: upstream.companiesScanned, unreachable_boards: upstream.unreachableBoards, capped_boards: upstream.cappedBoards, dataset_status: upstream.datasetStatus } };
  writeJson(path.join(source, 'summary.json'), summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const summary = await runCareerAts(options);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status === 'FAILED') process.exitCode = 1;
  } catch (error) {
    if (options && !options.dryRun) {
      const source = path.resolve(options.discoveryRoot, 'runs', options.runId, 'sources', ID);
      if (!existsSync(source)) {
        mkdirSync(path.join(source, 'jobs'), { recursive: true });
        writeJson(path.join(source, 'excluded-employers.json'), { schema_version: 1, run_id: options.runId, excluded_count: 0, results: [] });
        writeJson(path.join(source, 'summary.json'), { schema_version: 1, run_id: options.runId, adapter: ID, status: 'FAILED', raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, errors: 1, retryable: false });
        writeJson(path.join(source, 'errors.json'), { errors: [{ stage: 'bootstrap', message: error.message }] });
      }
    }
    console.error(error.stack ?? error.message); process.exitCode = 1;
  }
}
