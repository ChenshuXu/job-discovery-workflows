#!/usr/bin/env node
// A bounded correction of persisted acquisition exclusions. Original runs are immutable.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCareerInterfaces } from './commit-scan.mjs';
import { matchExcludedEmployer } from './employer-exclusions.mjs';
import { postingKey } from './posting-identity.mjs';


const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const exact = (items, label) => { if (items.length !== 1) throw new Error(`${label}: expected exactly one match, found ${items.length}`); return items[0]; };
const safeKey = key => key.replace(/[^A-Za-z0-9._-]/g, '-');
const canonical = url => { try { return postingKey(url); } catch { return null; } };
const field = (text, name) => exact([...text.matchAll(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)`, 'gm'))], `JD ${name} header`)[1].trim();

function safePath(file, { missing = false, directory = false } = {}) {
  const absolute = path.resolve(file);
  let cursor = absolute;
  while (true) {
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error(`unsafe symlink path: ${cursor}`);
      if (cursor === absolute && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`unsafe path type: ${cursor}`);
    } else if (cursor === absolute && !missing) throw new Error(`required file is missing: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

function containedFile(root, relative) {
  const file = path.resolve(root, relative), rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`path escapes owner: ${relative}`);
  return safePath(file);
}

function referenceFiles(root) {
  if (!existsSync(root)) { safePath(root, { missing: true, directory: true }); return []; }
  safePath(root, { directory: true });
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`unsafe reference symlink: ${file}`);
    return entry.isDirectory() ? referenceFiles(file) : entry.isFile() && file.endsWith('.md') ? [safePath(file)] : [];
  });
}

function identityReferenced(text, record) {
  const keys = new Set(record.posting_keys ?? [record.primary_key]);
  if ([...keys].some(key => text.includes(key)) || text.includes(record.primary_url)) return true;
  return [...text.matchAll(/https?:\/\/[^\s<>'"`|)]+/gi)].some(match => keys.has(canonical(match[0].replace(/[),.;]+$/, ''))));
}

function configured(careerRoot, environment, fallback) {
  return path.resolve(careerRoot, process.env[environment] || fallback);
}

function buildPlan({ runRoot, careerRoot, manifest, interfaces, trackerText }) {
  if (manifest?.run_id !== path.basename(runRoot) || !/^[A-Za-z0-9._-]+$/.test(manifest.run_id)
      || !Array.isArray(manifest.posting_keys) || !manifest.posting_keys.length || manifest.posting_keys.length > 20
      || manifest.posting_keys.some(key => typeof key !== 'string' || !key) || new Set(manifest.posting_keys).size !== manifest.posting_keys.length) throw new Error('explicit manifest must identify this run and 1-20 unique posting keys');
  safePath(runRoot, { directory: true }); safePath(careerRoot, { directory: true });
  const receiptFile = containedFile(runRoot, 'receipt.json'), acquisitionFile = containedFile(runRoot, 'acquisition.json'), assignmentsFile = containedFile(runRoot, 'assignments.json');
  const receipt = json(receiptFile), acquisition = json(acquisitionFile), assignments = json(assignmentsFile);
  if (receipt.status !== 'COMPLETE' || receipt.run_id !== manifest.run_id || receipt.terminal_equation?.valid !== true
      || assignments.run_id !== manifest.run_id || path.resolve(assignments.career_ops_root) !== careerRoot
      || acquisition.run_id !== manifest.run_id) throw new Error('completed run/Career-Ops identity is not reconciled');
  const archiveRoot = path.join(careerRoot, 'data/daily-scan-corrections', manifest.run_id, 'excluded-employers');
  safePath(archiveRoot, { missing: true, directory: true });
  if (existsSync(archiveRoot)) throw new Error('preexisting correction archive requires review; correction is create-only');
  const trackerFile = safePath(interfaces.trackerUtils.resolveTrackerPath(careerRoot));
  if (trackerText !== undefined && trackerText !== read(trackerFile)) throw new Error('tracker changed during locked read');
  const historyFile = containedFile(careerRoot, path.relative(careerRoot, configured(careerRoot, 'CAREER_OPS_SCAN_HISTORY', 'data/scan-history.tsv')));
  const historyText = read(historyFile), historySegments = historyText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const history = historySegments.map((segment, index) => ({ segment, index, line: segment.replace(/\r?\n$/, ''), cells: segment.replace(/\r?\n$/, '').split('\t') }));
  const support = [trackerFile, configured(careerRoot, 'CAREER_OPS_PIPELINE', 'data/pipeline.md'),
    configured(careerRoot, 'CAREER_OPS_FOLLOWUPS', 'data/follow-ups.md'), path.join(path.dirname(trackerFile), 'status-log.tsv'),
    configured(careerRoot, 'CAREER_OPS_ACTIVE_INTERVIEWS', '../career-docs/context/Interview/active-interviews.md')];
  const reports = referenceFiles(path.join(careerRoot, 'reports')), jds = referenceFiles(path.join(careerRoot, 'jds'));
  const configs = ['jobspy-ego.json', 'jobright.json'].map(name => safePath(path.join(moduleRoot, '../config', name)));
  const rules = configs.map(file => json(file).employer_exclusions.filter(rule => rule.id !== 'jobright-ai'));
  if (JSON.stringify(rules[0]) !== JSON.stringify(rules[1])) throw new Error('shared employer exclusion configs have drifted');
  const inputs = new Set([receiptFile, acquisitionFile, assignmentsFile, historyFile, ...support, ...reports, ...jds, ...configs,
    path.join(moduleRoot, 'repair-excluded-scan-postings.mjs'), path.join(moduleRoot, 'employer-exclusions.mjs')]);
  const effects = manifest.posting_keys.map(key => {
    if (receipt.committed_evaluated_keys?.filter(value => value === key).length !== 1 || receipt.job_issue_keys?.includes(key)
        || receipt.reports?.some(item => item.posting_key === key)) throw new Error(`${key}: not an unreported committed posting`);
    const record = exact(acquisition.acquired.filter(item => item.primary_key === key), `${key}: acquisition`);
    const sourceFile = containedFile(runRoot, record.jd_path), jdFile = containedFile(careerRoot, `jds/discovery-${manifest.run_id}-${safeKey(key)}.md`);
    const sourceText = read(sourceFile), jdText = read(jdFile);
    if (sourceText !== jdText || field(jdText, 'Posting Key') !== key || field(jdText, 'URL') !== record.primary_url
        || field(jdText, 'Discovery Run') !== manifest.run_id || canonical(record.primary_url) !== key) throw new Error(`${key}: frozen/persisted JD identity or bytes changed`);
    const exclusion = matchExcludedEmployer({ company: record.company, description: jdText }, rules[0]);
    if (!exclusion || exclusion.source !== 'jd_attribution') throw new Error(`${key}: explicit JD employer attribution is required`);
    const historyMatches = history.filter(item => (record.posting_keys ?? [key]).includes(canonical(item.cells[0])));
    const owned = exact(historyMatches, `${key}: scan-history identity`);
    // Career-Ops retains the original seven positional columns and appends metadata.
    if (owned.cells[0] !== record.primary_url || owned.cells[5] !== `daily-scan:${manifest.run_id}` || owned.cells.length < 7) throw new Error(`${key}: scan-history is not exactly owned by this run`);
    for (const file of [...support, ...reports, ...jds.filter(file => file !== jdFile)]) {
      safePath(file, { missing: true });
      if (existsSync(file) && identityReferenced(read(file), record)) throw new Error(`${key}: protected reference in ${file}`);
    }
    const worker = exact(Object.keys(assignments.assignments).filter(worker => assignments.assignments[worker].includes(key)), `${key}: worker assignment`);
    const resultFile = containedFile(runRoot, `results/${worker}.json`), result = exact(json(resultFile).results.filter(item => item.posting_key === key), `${key}: final result`);
    if (String(result.status ?? 'EVALUATED').toUpperCase() !== 'EVALUATED' || result.report != null || result.hard_exclusion || !Number.isFinite(result.score)) throw new Error(`${key}: original result is not an unreported successful evaluation`);
    inputs.add(sourceFile); inputs.add(resultFile);
    return { posting_key: key, posting_url: record.primary_url, exclusion, source_jd: sourceFile, jd_file: jdFile,
      jd_sha256: hash(jdText), archive_jd: path.join(archiveRoot, path.basename(jdFile)), history_index: owned.index, history_raw: owned.segment, history_line_sha256: hash(owned.segment) };
  });
  const remove = new Set(effects.map(item => item.history_index));
  const nextHistory = historySegments.filter((_, index) => !remove.has(index)).join('');
  const inputHashes = [...inputs].sort().map(file => { safePath(file, { missing: true }); return { path: file, sha256: existsSync(file) ? hash(readFileSync(file)) : null }; });
  const plan = { schema_version: 1, operation: 'remove-excluded-employer-persistence', run_id: manifest.run_id, run_root: runRoot,
    career_ops_root: careerRoot, archive_root: archiveRoot, tracker_path: trackerFile, history_path: historyFile,
    original_run_untouched: true, history_before_sha256: hash(historyText), history_after_sha256: hash(nextHistory),
    history_rows_before: history.filter(item => canonical(item.cells[0])).length, history_rows_after: history.filter(item => canonical(item.cells[0])).length - effects.length,
    reports_catalog: reports, jds_catalog: jds, input_hashes: inputHashes, effects };
  plan.plan_sha256 = hash(JSON.stringify(plan));
  return { plan, historyText, nextHistory };
}

function verifyInputs(plan, changed = new Set()) {
  for (const [name, expected] of [['reports', plan.reports_catalog], ['jds', plan.jds_catalog.filter(file => !changed.has(file))]]) {
    if (JSON.stringify(referenceFiles(path.join(plan.career_ops_root, name))) !== JSON.stringify(expected)) throw new Error(`correction ${name} catalog changed`);
  }
  for (const input of plan.input_hashes.filter(input => !changed.has(input.path))) {
    safePath(input.path, { missing: true });
    if ((existsSync(input.path) ? hash(readFileSync(input.path)) : null) !== input.sha256) throw new Error(`correction input changed: ${input.path}`);
  }
}

export async function repairExcludedScanPostings({ runRoot, careerRoot, manifest, apply = false, expectedPlanHash, interfaces = null }) {
  runRoot = path.resolve(runRoot); careerRoot = path.resolve(careerRoot);
  const api = interfaces ?? await loadCareerInterfaces(careerRoot);
  if (!apply) return { applied: false, ...buildPlan({ runRoot, careerRoot, manifest, interfaces: api }).plan };
  if (!/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) throw new Error('apply requires the reviewed --expected-plan-hash');
  const commitLock = await api.pipelineLock.acquirePipelineLock(path.join(careerRoot, '.daily-scan-commit'), { timeoutMs: 60_000, staleMs: 10 * 60_000 });
  try {
    const transaction = await api.trackerUtils.openTrackerTransaction(api.trackerUtils.resolveTrackerPath(careerRoot));
    try {
      const historyFile = configured(careerRoot, 'CAREER_OPS_SCAN_HISTORY', 'data/scan-history.tsv');
      return await api.pipelineLock.withPipelineLock(historyFile, async () => {
        const { plan, historyText, nextHistory } = buildPlan({ runRoot, careerRoot, manifest, interfaces: api, trackerText: transaction.read() });
        if (plan.plan_sha256 !== expectedPlanHash) throw new Error('correction plan hash changed; review a new dry-run');
        verifyInputs(plan);
        mkdirSync(path.dirname(plan.archive_root), { recursive: true });
        mkdirSync(plan.archive_root);
        const create = (name, value) => writeFileSync(path.join(plan.archive_root, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        create('plan.json', plan);
        create('scan-history.removed.tsv', plan.effects.map(effect => effect.history_raw).join(''));
        for (const effect of plan.effects) writeFileSync(effect.archive_jd, readFileSync(effect.jd_file), { flag: 'wx' });
        const removed = [];
        try {
          verifyInputs(plan);
          for (const effect of plan.effects) {
            if (hash(readFileSync(effect.archive_jd)) !== effect.jd_sha256) throw new Error('archive JD verification failed');
            unlinkSync(effect.jd_file); removed.push(effect);
          }
          api.trackerUtils.writeFileAtomic(historyFile, nextHistory);
          if (read(historyFile) !== nextHistory || removed.some(effect => existsSync(effect.jd_file))) throw new Error('correction persistence verification failed');
          verifyInputs(plan, new Set([historyFile, ...removed.map(effect => effect.jd_file)]));
          const outcome = { schema_version: 1, status: 'COMPLETE', completed_at: new Date().toISOString(), plan_sha256: plan.plan_sha256,
            removed_count: removed.length, history_after_sha256: hash(read(historyFile)), original_run_untouched: true, recoverable: true };
          create('outcome.json', outcome);
          return { applied: true, ...plan, outcome };
        } catch (error) {
          const failures = [];
          try {
            const current = read(historyFile);
            if (current === nextHistory) api.trackerUtils.writeFileAtomic(historyFile, historyText);
            else if (current !== historyText) throw new Error('history diverged; refused broad rollback');
          } catch (rollback) { failures.push(rollback.message); }
          for (const effect of removed) {
            try {
              if (!existsSync(effect.jd_file)) writeFileSync(effect.jd_file, readFileSync(effect.archive_jd), { flag: 'wx' });
              if (hash(readFileSync(effect.jd_file)) !== effect.jd_sha256) throw new Error(`JD diverged: ${effect.jd_file}`);
            } catch (rollback) { failures.push(rollback.message); }
          }
          create('outcome.json', { status: failures.length ? 'RECOVERY_REQUIRED' : 'ROLLED_BACK', error: error.message, recovery_errors: failures, plan_sha256: plan.plan_sha256 });
          throw new Error(`${error.message}; ${failures.length ? `recovery required: ${failures.join('; ')}` : 'owned changes rolled back; archive retained'}`);
        }
      });
    } finally { transaction.close(); }
  } finally { commitLock.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') options.apply = true;
    else if (['--run', '--career-ops', '--expected-plan-hash', '--manifest'].includes(flag) && args[index + 1]) options[{ '--run': 'runRoot', '--career-ops': 'careerRoot', '--expected-plan-hash': 'expectedPlanHash', '--manifest': 'manifestFile' }[flag]] = args[++index];
    else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  if (!options.runRoot || !options.careerRoot || !options.manifestFile) throw new Error('--run, --career-ops and --manifest are required');
  options.manifest = json(options.manifestFile);
  console.log(JSON.stringify(await repairExcludedScanPostings(options), null, 2));
}
