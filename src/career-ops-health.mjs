import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalizePostingUrl, postingKey, legacyPostingKey, matchesStoredPostingKey } from './posting-identity.mjs';
import { careerOpsEnv, resolveCareerPaths } from './career-ops-paths.mjs';
import { sourceRecord } from './combine.mjs';
import { validateJd } from './run-contract.mjs';

// Native Career-Ops groups duplicate warnings by title. Resolve only the exact
// reported members, with distinct persisted posting identities; retain its raw
// counts. This does not infer that cross-source postings are different applications.
function reportEvidence(file) {
  const text = readFileSync(file, 'utf8');
  const field = name => text.match(new RegExp(`\\*\\*${name}:\\*\\*[ \\t]*(\\S+)`))?.[1] ?? '';
  const url = field('URL').replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
  const stored = field('Posting Key');
  const parsed = postingKey(url);
  // Archived v1 reports used these two exact old key formats. Reconcile them
  // from their saved URL only; do not broaden live acquisition's ID parser.
  const oldJobrightId = url.match(/^https:\/\/jobright\.ai\/jobs\/info\/(b2b_\d+_\d+)(?:\?|$)/)?.[1];
  const oldJobrightKey = oldJobrightId ? `generic:jobright.ai:${oldJobrightId.toUpperCase()}` : null;
  const oldWorkdayKey = parsed?.startsWith('workday:')
    ? parsed.replace(/:[^:]+$/, suffix => suffix.replaceAll('-', '')) : null;
  const legacyKeys = [legacyPostingKey(url), oldJobrightKey, oldWorkdayKey].filter(Boolean);
  if (!parsed && (!stored || !legacyKeys.includes(stored))) return null;
  // Reuse the identity contract's exact legacy mappings (including Google);
  // compare group members by the current canonical key below.
  if (stored && !matchesStoredPostingKey(url, stored) && !legacyKeys.includes(stored)) return null;
  return { file, key: parsed || stored, stored_key: stored || null, url: canonicalizePostingUrl(url) };
}

export function resolveTitleWarnings({ careerRoot, trackerFile, messages, dataRoot, reportsRoot }) {
  // The canonical parser is synchronous and has no CLI side effects.
  const require = createRequire(import.meta.url);
  const paths = dataRoot && reportsRoot ? { dataRoot, reportsRoot, trackerFile } : resolveCareerPaths(careerRoot);
  const tracker = trackerFile ? path.resolve(careerRoot, trackerFile) : paths.trackerFile;
  if (!existsSync(tracker)) return { resolved: [], unresolved: messages };
  const { parseTrackerRow, resolveColumns, extractReqNumber, normalizeTextKey, parseMarkdownLinks } = require(path.join(careerRoot, 'tracker-parse.mjs'));
  const lines = readFileSync(tracker, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  const rows = lines.map(line => parseTrackerRow(line, columns)).filter(Boolean);
  const byNumber = new Map(rows.map(row => [Number(row.num), row]));
  const resolved = [], unresolved = [];
  for (const message of messages) {
    let members = null;
    try {
      const trackerWarning = message.match(/^Possible duplicates: ((?:#\d+(?:, )?)+) \(.+\)$/);
      const reportWarning = message.match(/^Duplicate reports for same company\+role: (.+)$/);
      if (trackerWarning) {
        const ids = [...trackerWarning[1].matchAll(/#(\d+)/g)].map(match => Number(match[1]));
        members = ids.map(id => {
          const row = byNumber.get(id);
          if (!row) return null;
          const link = parseMarkdownLinks(String(row.report))[0]?.target;
          if (link) {
            const file = [path.resolve(path.dirname(tracker), link), path.resolve(paths.dataRoot, link)].find(existsSync);
            const evidence = file ? reportEvidence(file) : null;
            return evidence ? { tracker_id: id, ...evidence } : null;
          }
          const req = extractReqNumber(row.notes);
          // A recruiter-sourced row may carry an explicit requisition without a report.
          return req ? { tracker_id: id, key: `requisition:${normalizeTextKey(row.company)}:${req}`, requisition: req, url: null } : null;
        });
      } else if (reportWarning) {
        const names = reportWarning[1].split(', ');
        members = names.map(name => {
          if (path.basename(name) !== name || !name.endsWith('.md')) return null;
          return reportEvidence(path.join(paths.reportsRoot, name));
        });
      }
    } catch { members = null; }
    const keys = members?.map(member => member?.key);
    const urls = members?.map(member => member?.url).filter(Boolean);
    const reqCollision = members?.some(member => member?.requisition && members.some(other =>
      other !== member && other?.key?.split(':').at(-1) === member.requisition));
    if (members?.length > 1 && keys.every(Boolean)
        && !reqCollision && new Set(keys).size === members.length && new Set(urls).size === urls.length) {
      resolved.push({ message, reason: 'distinct_recorded_posting_identities', members });
    } else unresolved.push(message);
  }
  return { resolved, unresolved };
}

// Upstream's archive lookup recognizes report-number filenames. Discovery keeps
// the complete capture under its immutable run/posting identity instead. Credit
// only that exact archive, retaining the original warning and checked evidence.
export function resolveDiscoveryArchiveWarnings({ dataRoot, reportsRoot, messages }) {
  const resolved = [], unresolved = [];
  for (const message of messages) {
    try {
      const match = message.match(/^([^/\\]+\.md): no "## Job Description" section with archived JD text, and no jds\/ capture found for report (\d+) \(company slug "([^"]+)"\) — tracker row is still live \(or unresolved\), so this is a soft warning, not a blocker$/);
      if (!match || !match[1].startsWith(`${String(Number(match[2])).padStart(3, '0')}-${match[3]}-`)) throw new Error('not a known archive warning');
      const file = path.join(reportsRoot, match[1]);
      const report = readFileSync(file, 'utf8');
      const scalar = name => {
        const fields = [...report.matchAll(new RegExp(`^${name}: ([^\\r\\n]+)$`, 'gm'))];
        if (fields.length !== 1) throw new Error('ambiguous report identity');
        return JSON.parse(fields[0][1]);
      };
      const runId = scalar('run_id'), key = scalar('posting_key'), url = scalar('posting_url');
      if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId) || typeof key !== 'string'
          || postingKey(url) !== key) throw new Error('invalid report identity');
      const evidence = reportEvidence(file);
      if (!evidence || evidence.key !== key || evidence.url !== canonicalizePostingUrl(url)) throw new Error('report identities disagree');
      const archive = path.join(dataRoot, 'jds', `discovery-${runId}-${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`);
      const record = sourceRecord(dataRoot, 'persisted', archive);
      const text = record._text;
      const field = name => text.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim();
      const body = text.split(/^## Job Description[^\r\n]*\r?\n/m).slice(1).join('\n');
      if (record.primary_key !== key || record.primary_url !== url || field('Posting Key') !== key
          || field('Discovery Run') !== runId || validateJd(body, key).length) throw new Error('archive contract mismatch');
      resolved.push({ message, reason: 'exact_discovery_jd_archive', members: [{ file, archive_file: archive,
        key, url, run_id: runId, content_contract: 'validated_job_description_body' }] });
    } catch { unresolved.push(message); }
  }
  return { resolved, unresolved };
}

// Snapshot the official verifier's code dependencies and data-contract inputs.
// Copying rather than linking is essential: both reservation GC and provider
// plugin lock pinning are write-capable. Node's permission model is an additional
// guard for trusted upstream code, not a sandbox for untrusted plugins.
const HEALTH_CODE_DIRS = ['lib', 'templates', 'providers', 'plugins', 'plugins.local', 'plugins-registry', 'node_modules'];
const HEALTH_DATA_DIRS = ['data', 'reports', 'jds', 'batch', 'config', 'modes'];

function healthSnapshot(paths, trackerFile) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'career-ops-health-')));
  const mirror = file => path.join(root, 'fs', path.resolve(file).slice(path.parse(path.resolve(file)).root.length));
  const copied = new Set();
  const copy = file => {
    const absolute = path.resolve(file);
    if (!existsSync(absolute) || copied.has(absolute)) return;
    mkdirSync(path.dirname(mirror(absolute)), { recursive: true });
    cpSync(absolute, mirror(absolute), { recursive: true, dereference: true, preserveTimestamps: true });
    copied.add(absolute);
  };
  const copyRoot = (source, directories) => {
    if (!existsSync(source)) return;
    mkdirSync(mirror(source), { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) copy(path.join(source, entry.name));
      else if (directories.includes(entry.name)) copy(path.join(source, entry.name));
      else if (entry.isSymbolicLink()) {
        // Root-level file links (not directory links) include the interview register.
        const target = path.join(source, entry.name);
        if (!lstatSync(realpathSync(target)).isDirectory()) copy(target);
      }
    }
  };
  try {
    copyRoot(paths.codeRoot, HEALTH_CODE_DIRS);
    copyRoot(paths.dataRoot, HEALTH_DATA_DIRS);
    const reportsRoot = paths.healthReportsRoot || paths.reportsRoot;
    const portalsFile = paths.portalsFile || path.join(paths.dataRoot, 'portals.yml');
    copy(reportsRoot);
    copy(trackerFile);
    copy(portalsFile);
    copy(paths.profileFile);
    // External tracker layouts can link outside the data root. Mirror both
    // canonical link lookup locations without changing the tracker contents.
    const { parseMarkdownLinks } = createRequire(import.meta.url)(path.join(paths.codeRoot, 'tracker-parse.mjs'));
    if (existsSync(trackerFile)) for (const link of parseMarkdownLinks(readFileSync(trackerFile, 'utf8'))) {
      for (const base of [path.dirname(trackerFile), paths.dataRoot]) copy(path.join(base, link.target));
    }
    return { root, codeRoot: mirror(paths.codeRoot), dataRoot: mirror(paths.dataRoot), trackerFile: mirror(trackerFile),
      reportsRoot: mirror(reportsRoot), portalsFile: mirror(portalsFile), profileFile: mirror(paths.profileFile) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function checkCareerOpsHealth(careerRoot, trackerFile = null) {
  let snapshot;
  try {
    const paths = resolveCareerPaths(careerRoot);
    const tracker = trackerFile ? path.resolve(paths.codeRoot, trackerFile) : paths.trackerFile;
    for (const name of ['verify-pipeline.mjs', 'path-resolver.mjs', 'tracker-parse.mjs']) {
      if (!existsSync(path.join(paths.codeRoot, name))) throw new Error(`Career-Ops canonical health interface missing: ${name}`);
    }
    snapshot = healthSnapshot(paths, tracker);
    const env = careerOpsEnv(paths, { NODE_OPTIONS: '', CAREER_OPS_CODE_ROOT: snapshot.codeRoot,
      CAREER_OPS_ROOT: snapshot.dataRoot, CAREER_OPS_DATA_DIR: snapshot.dataRoot,
      CAREER_OPS_TRACKER: snapshot.trackerFile, CAREER_OPS_REPORTS: snapshot.reportsRoot,
      CAREER_OPS_PORTALS: snapshot.portalsFile, CAREER_OPS_PROFILE: snapshot.profileFile });
    const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', `--allow-fs-write=${snapshot.root}`,
      path.join(snapshot.codeRoot, 'verify-pipeline.mjs')], { cwd: snapshot.codeRoot, encoding: 'utf8', env });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(/Pipeline Health:\s*(\d+) errors?,\s*(\d+) warnings?/i);
    const messages = output.split(/\r?\n/).filter(line => /^⚠️\s*/.test(line)).map(line => line.replace(/^⚠️\s*/, ''));
    let resolution = { resolved: [], unresolved: messages };
    if (match && Number(match[2]) === messages.length && messages.length) {
      try {
        resolution = resolveTitleWarnings({ careerRoot: snapshot.codeRoot, trackerFile: snapshot.trackerFile,
          dataRoot: snapshot.dataRoot, reportsRoot: snapshot.reportsRoot, messages });
        const archives = resolveDiscoveryArchiveWarnings({ dataRoot: snapshot.dataRoot,
          reportsRoot: snapshot.reportsRoot, messages: resolution.unresolved });
        resolution = { resolved: [...resolution.resolved, ...archives.resolved], unresolved: archives.unresolved };
        for (const item of resolution.resolved) for (const member of item.members) {
          if (member.file) member.file = member.file.replace(snapshot.root + '/fs', '');
          if (member.archive_file) member.archive_file = member.archive_file.replace(snapshot.root + '/fs', '');
        }
      }
      catch { /* Missing/incompatible identity evidence leaves every warning unresolved. */ }
    }
    const complete = match && Number(match[2]) === messages.length;
    return {
      errors: complete ? Number(match[1]) : 1,
      warnings: complete ? resolution.unresolved.length : null,
      exit_code: result.status ?? 1,
      read_only: true,
      verifier_output: output.trim().replaceAll(snapshot.root + '/fs', ''),
      isolation: { mode: 'copied_inputs_with_node_write_permissions',
        reservation_cleanup: 'snapshot_only; source reservations retained',
        git_blame: 'unavailable in isolated audit; lifecycle mismatch warnings remain blocking' },
      ...(messages.length ? { raw_warnings: Number(match?.[2] ?? messages.length), ...resolution } : {}),
    };
  } catch (error) {
    return { errors: 1, warnings: null, exit_code: 1, read_only: true, error: error.message };
  } finally { if (snapshot) rmSync(snapshot.root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--career-ops');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node src/career-ops-health.mjs --career-ops PATH');
  const health = checkCareerOpsHealth(path.resolve(process.argv[index + 1]));
  console.log(JSON.stringify(health, null, 2));
  process.exitCode = health.exit_code !== 0 || health.errors || health.warnings !== 0 ? 1 : 0;
}
