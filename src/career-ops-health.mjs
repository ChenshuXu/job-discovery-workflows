import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalizePostingUrl, postingKey, legacyPostingKey } from './posting-identity.mjs';

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
  if (stored && parsed !== stored && !legacyKeys.includes(stored)) return null;
  return { file, key: parsed || stored, stored_key: stored || null, url: canonicalizePostingUrl(url) };
}

export function resolveTitleWarnings({ careerRoot, trackerFile, messages }) {
  // The canonical parser is synchronous and has no CLI side effects.
  const require = createRequire(import.meta.url);
  const { resolveTrackerPath } = require(path.join(careerRoot, 'path-resolver.mjs'));
  const tracker = trackerFile || resolveTrackerPath(careerRoot);
  if (!existsSync(tracker)) return { resolved: [], unresolved: messages };
  const { parseTrackerRow, resolveColumns, extractReqNumber, normalizeTextKey } = require(path.join(careerRoot, 'tracker-parse.mjs'));
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
          const link = String(row.report).match(/\]\(([^)]+)\)/)?.[1];
          if (link) {
            const file = [path.resolve(path.dirname(tracker), link), path.resolve(careerRoot, link)].find(existsSync);
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
          return reportEvidence(path.join(careerRoot, 'reports', name));
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

export function checkCareerOpsHealth(careerRoot, trackerFile = null) {
  const env = trackerFile ? { ...process.env, CAREER_OPS_TRACKER: trackerFile } : process.env;
  const result = spawnSync(process.execPath, ['verify-pipeline.mjs'], { cwd: careerRoot, encoding: 'utf8', env });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/Pipeline Health:\s*(\d+) errors?,\s*(\d+) warnings?/i);
  const messages = output.split(/\r?\n/).filter(line => /^⚠️\s*/.test(line)).map(line => line.replace(/^⚠️\s*/, ''));
  let resolution = { resolved: [], unresolved: messages };
  if (match && Number(match[2]) === messages.length && messages.length) {
    try { resolution = resolveTitleWarnings({ careerRoot, trackerFile, messages }); }
    catch { /* Missing/incompatible identity evidence leaves every warning unresolved. */ }
  }
  const complete = match && Number(match[2]) === messages.length;
  return {
    errors: complete ? Number(match[1]) : 1,
    warnings: complete ? resolution.unresolved.length : null,
    exit_code: result.status,
    ...(messages.length ? { raw_warnings: Number(match?.[2] ?? messages.length), ...resolution } : {}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--career-ops');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node src/career-ops-health.mjs --career-ops PATH');
  const health = checkCareerOpsHealth(path.resolve(process.argv[index + 1]));
  console.log(JSON.stringify(health, null, 2));
  process.exitCode = health.exit_code !== 0 || health.errors || health.warnings !== 0 ? 1 : 0;
}
