import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractPostingIdentity, postingKey } from './posting-identity.mjs';
import { evaluateLocationScope, isAllowedLocationDecision } from './location-scope.mjs';
import { semanticIdentity } from './semantic-jd-identity.mjs';

function filesBelow(root) {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesBelow(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}

function configuredPath(root, value, fallback) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(root, selected);
}

function trackerPath(root) {
  if (process.env.CAREER_OPS_TRACKER) return configuredPath(root, process.env.CAREER_OPS_TRACKER, 'data/applications.md');
  const dataLayout = path.join(root, 'data/applications.md');
  return existsSync(dataLayout) ? dataLayout : path.join(root, 'applications.md');
}

/** Only committed Career-Ops state is history. Failed Job Discovery runs never suppress a retry. */
export function collectHistoricalPostingKeys({ careerRoot, greenhouseKeys = [] }) {
  const root = path.resolve(careerRoot);
  const found = new Map();
  const concreteGreenhouse = [...new Set(greenhouseKeys)].flatMap(key => {
    const match = String(key).match(/^greenhouse:([a-z0-9][a-z0-9_-]*):(\d+)$/i);
    return match ? [{ key, tenant: match[1].toLowerCase(), requisition: match[2] }] : [];
  });
  const greenhouseByRequisition = Map.groupBy(concreteGreenhouse, item => item.requisition);
  const greenhouseByCompanyUrl = new Map(concreteGreenhouse.map(item => [`${item.tenant}.com\0${item.requisition}`, item.key]));
  const add = (key, artifact) => {
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(artifact);
  };
  const surfaces = [
    configuredPath(root, process.env.CAREER_OPS_PIPELINE, 'data/pipeline.md'),
    configuredPath(root, process.env.CAREER_OPS_SCAN_HISTORY, 'data/scan-history.tsv'),
    trackerPath(root),
    path.join(root, 'reports'),
  ];
  for (const surface of [...new Set(surfaces)]) {
    for (const file of filesBelow(surface).filter(item => /\.(?:md|tsv)$/i.test(item))) {
      const text = readFileSync(file, 'utf8');
      const artifact = `career-ops/${path.relative(root, file)}`;
      for (const url of extractPostingIdentity(text).urls) {
        const key = postingKey(url);
        if (!key) continue;
        add(key, artifact);
      }
      for (const match of text.matchAll(/https?:\/\/[^\s<>'"`|)]+/gi)) {
        let url;
        try { url = new URL(match[0].replace(/[),.;]+$/, '')); } catch { continue; }
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const token = url.searchParams.get('token');
        if (/(?:^|\.)(?:app|boards|job-boards)\.greenhouse\.io$/.test(host)
            && url.pathname.replace(/\/+$/, '') === '/embed/job_app'
            && greenhouseByRequisition.get(token)?.length === 1) {
          add(greenhouseByRequisition.get(token)[0].key, artifact);
        }
        const tail = url.pathname.split('/').filter(Boolean).at(-1);
        const companyUrlKey = url.searchParams.has('gh_src') ? greenhouseByCompanyUrl.get(`${host}\0${tail}`) : null;
        if (companyUrlKey) add(companyUrlKey, artifact);
      }
      for (const match of text.matchAll(/^(?:\*\*)?LinkedIn(?: Job)? ID:(?:\*\*)?\s*`?(\d{8,})`?\s*$/gim)) {
        const key = `linkedin:linkedin.com:${match[1]}`;
        add(key, artifact);
      }
      for (const match of text.matchAll(/^(?:\*\*)?Posting Key:(?:\*\*)?\s*`?([A-Za-z][A-Za-z0-9._-]*:[^\s`]+)`?\s*$/gim)) {
        const key = match[1];
        add(key, artifact);
      }
    }
  }
  return found;
}

const markdownField = (text, name) => String(text).match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)\\r?$`, 'mi'))?.[1]?.trim() ?? '';

function committedDailyScanKeys(root) {
  const file = configuredPath(root, process.env.CAREER_OPS_SCAN_HISTORY, 'data/scan-history.tsv');
  if (!existsSync(file)) return new Map();
  const found = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const cells = line.split('\t');
    if (!cells[5]?.startsWith('daily-scan:')) continue;
    const key = postingKey(cells[0]);
    if (!key) continue;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push({ posting_key: key, run_id: cells[5].slice('daily-scan:'.length), scan_history_url: cells[0] });
  }
  return found;
}

/** Rebuild semantic/context history only from a Daily Scan row that also has its committed JD. */
export function collectHistoricalSemanticContexts({ careerRoot, locationPolicy }) {
  const root = path.resolve(careerRoot);
  const committed = committedDailyScanKeys(root);
  const found = new Map();
  for (const file of filesBelow(path.join(root, 'jds')).filter(item => /\/discovery-[^/]+\.md$/i.test(item)).sort()) {
    const text = readFileSync(file, 'utf8');
    const url = markdownField(text, 'URL');
    const key = postingKey(url);
    const commit = key ? (committed.get(key) ?? []).find(item => path.basename(file) === `discovery-${item.run_id}-${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`) : null;
    if (!commit) continue;
    const location = markdownField(text, 'Location');
    const employmentType = markdownField(text, 'Employment Type') || markdownField(text, 'Employment') || 'unknown';
    const record = {
      company: markdownField(text, 'Company'),
      location,
      locations: location.split('|').map(item => item.trim()).filter(Boolean),
      employment_type: employmentType,
      workplace_type: markdownField(text, 'Workplace Type') || 'unknown',
      workplace_type_source: markdownField(text, 'Workplace Type Source') || 'unknown',
      structured_remote_signal: markdownField(text, 'Structured Remote Signal').toLowerCase() === 'true',
    };
    let scope;
    try { scope = evaluateLocationScope(record, locationPolicy); }
    catch { continue; }
    if (!isAllowedLocationDecision(scope.decision)) continue;
    let identity;
    try { identity = semanticIdentity({ record, markdown: text, locationDecision: scope.decision }); }
    catch { continue; }
    const pair = `${identity.semantic_job_key}\0${identity.posting_context_key}`;
    if (!found.has(pair)) found.set(pair, []);
    found.get(pair).push({
      ...commit,
      prior_artifact: `career-ops/${path.relative(root, file)}`,
    });
  }
  return found;
}
