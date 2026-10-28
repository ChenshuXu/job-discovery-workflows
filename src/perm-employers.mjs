import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const digest = value => JSON.stringify(value);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const text = value => typeof value === 'string' && value.trim().length > 0;
const unidentified = value => /^(?:unknown\b|未具名|多家)/i.test(value);
const https = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };

// Exact names only; legal suffixes do not grant a parent company's status to subsidiaries.
const employerName = value => String(value ?? '').normalize('NFKC').toLowerCase().trim()
  .replace(/[.,]/g, '').replace(/\s+/g, ' ')
  .replace(/(?:\s+(?:incorporated|inc|corporation|corp|llc|ltd|limited|(?:&\s+)?co))+$/, '').trim();

export function validatePermEmployers(catalog) {
  if (catalog?.schema_version !== 1 || catalog.selection !== 'tracker-current-status'
      || !https(catalog.source_url) || !Number.isFinite(Date.parse(catalog.source_snapshot_at))
      || !Number.isFinite(Date.parse(catalog.captured_at)) || !Array.isArray(catalog.companies) || !catalog.companies.length
      || !Array.isArray(catalog.unresolved_groups)
      || catalog.displayed_group_count !== catalog.companies.length + catalog.unresolved_groups.length) {
    throw new Error('invalid PERM employer catalog: require dated source, normal-status companies and reconciled groups');
  }
  const names = new Map();
  for (const entry of [...catalog.companies, ...catalog.unresolved_groups]) {
    if (!text(entry.company) || entry.status !== '正常办理' || !text(entry.information_date)
        || !Array.isArray(entry.sources) || !entry.sources.length || entry.source_count !== entry.sources.length
        || entry.sources.some(source => !text(source.platform) || !text(source.published_label) || (source.url !== null && !https(source.url)))) {
      throw new Error(`invalid PERM company evidence: ${entry?.company ?? '<missing>'}`);
    }
  }
  for (const entry of catalog.companies) {
    if (unidentified(entry.company) || !Array.isArray(entry.aliases) || entry.aliases.some(alias => !text(alias) || unidentified(alias))) {
      throw new Error(`PERM allowlist requires an identified company and explicit aliases: ${entry.company}`);
    }
    for (const name of [entry.company, ...entry.aliases]) {
      const normalized = employerName(name);
      if (!normalized || (names.has(normalized) && names.get(normalized) !== entry.company)) throw new Error(`PERM employer alias collision: ${name}`);
      names.set(normalized, entry.company);
    }
  }
  if (catalog.unresolved_groups.some(entry => !unidentified(entry.company))) throw new Error('identified PERM companies cannot be hidden in unresolved groups');
  return catalog;
}

export function snapshotPermEmployers(file) {
  const resolved = path.resolve(file);
  const catalog = validatePermEmployers(json(resolved));
  return { path: resolved, catalog };
}

export function assertPermEmployersUnchanged(snapshot, { checkLive = true } = {}) {
  if (!snapshot || !path.isAbsolute(snapshot.path ?? '') || !validatePermEmployers(snapshot.catalog)) {
    throw new Error('invalid frozen PERM employer snapshot');
  }
  if (checkLive && digest(snapshotPermEmployers(snapshot.path).catalog) !== digest(snapshot.catalog)) throw new Error('PERM employers changed after baseline; start a new run');
}

export function matchPermEmployer(company, catalog) {
  const normalized = employerName(company);
  if (!normalized) return null;
  return catalog.companies.find(entry => [entry.company, ...entry.aliases].some(name => employerName(name) === normalized)) ?? null;
}

function decision(record, catalog) {
  const match = matchPermEmployer(record.company, catalog);
  return { posting_key: record.primary_key, company: record.company, allowed: Boolean(match),
    decision: match ? 'ALLOW_TRACKER_NORMAL' : 'EXCLUDE_NOT_IN_PERM_ALLOWLIST', matched_company: match?.company ?? null };
}

export function validatePermAudit(audit, snapshot, runId) {
  if (audit?.schema_version !== 1 || audit.run_id !== runId || JSON.stringify(audit.catalog) !== JSON.stringify(snapshot.catalog)
      || !Array.isArray(audit.results) || audit.pre_scope_count !== audit.results.length
      || audit.accepted_count !== audit.results.filter(item => item.allowed).length
      || audit.excluded_count !== audit.results.filter(item => !item.allowed).length
      || new Set(audit.results.map(item => item.posting_key)).size !== audit.results.length
      || audit.results.some(item => !text(item.posting_key)
        || JSON.stringify(item) !== JSON.stringify(decision({ primary_key: item.posting_key, company: item.company }, snapshot.catalog)))) {
    throw new Error('invalid PERM employer scope audit');
  }
}

export function scopePermEmployers({ root, records, snapshot }) {
  assertPermEmployersUnchanged(snapshot);
  const file = path.join(root, 'triage/perm-employer-scope.json');
  const results = records.map(record => decision(record, snapshot.catalog));
  const audit = existsSync(file) ? json(file) : { schema_version: 1, run_id: path.basename(root), catalog: snapshot.catalog,
    pre_scope_count: results.length, accepted_count: results.filter(item => item.allowed).length,
    excluded_count: results.filter(item => !item.allowed).length, results };
  validatePermAudit(audit, snapshot, path.basename(root));
  const byKey = new Map(audit.results.map(item => [item.posting_key, item]));
  if (results.some(item => JSON.stringify(item) !== JSON.stringify(byKey.get(item.posting_key)))) throw new Error('PERM employer scope differs from captured acquisition');
  return { audit, accepted: records.filter(record => byKey.get(record.primary_key).allowed), excluded: records.filter(record => !byKey.get(record.primary_key).allowed) };
}

export function validatePermRun(root, acquisition, records) {
  const baselineFile = path.join(root, 'baseline.json');
  const snapshot = existsSync(baselineFile) ? json(baselineFile).perm_employers : null;
  const planFile = path.join(root, 'assignments.json');
  const plan = existsSync(planFile) ? json(planFile) : null;
  const auditFile = path.join(root, 'triage/perm-employer-scope.json');
  if (!snapshot) {
    if (plan?.perm_employers || acquisition.perm_employer_scope_audit || existsSync(auditFile)) throw new Error('PERM scope requires a baseline snapshot');
    return;
  }
  assertPermEmployersUnchanged(snapshot, { checkLive: !existsSync(path.join(root, 'receipt.json')) });
  if (!plan) return;
  if (JSON.stringify(plan.perm_employers) !== JSON.stringify(snapshot)
      || plan.perm_employer_scope_audit !== 'triage/perm-employer-scope.json'
      || acquisition.perm_employer_scope_audit !== plan.perm_employer_scope_audit || !existsSync(auditFile)) {
    throw new Error('PERM snapshot and scope audit are required in acquisition and assignments');
  }
  const audit = json(auditFile);
  validatePermAudit(audit, snapshot, path.basename(root));
  if (acquisition.perm_pre_scope_count !== audit.pre_scope_count || acquisition.perm_exclusion_count !== audit.excluded_count) throw new Error('PERM scope counts disagree with acquisition');
  const allowed = new Map(audit.results.filter(item => item.allowed).map(item => [item.posting_key, item]));
  if (records.some(record => !allowed.has(record.primary_key) || allowed.get(record.primary_key).company !== record.company
      || !matchPermEmployer(record.company, snapshot.catalog))) throw new Error('non-allowlisted or unaudited PERM employer remains acquired');
  const location = json(path.join(root, 'triage/location-scope.json'));
  if (JSON.stringify([...allowed.keys()].sort()) !== JSON.stringify(location.results.map(item => item.posting_key).sort())) throw new Error('PERM accepted keys differ from location audit coverage');
}
