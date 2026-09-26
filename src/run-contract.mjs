#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunProfile } from './adapter-registry.mjs';
import { matchExcludedEmployer, validateEmployerExclusionRules } from './employer-exclusions.mjs';
import { isAllowedLocationDecision } from './location-scope.mjs';
import { matchesStoredPostingKey, normalizePostingKeys, primaryPostingKey, samePosting } from './posting-identity.mjs';

const MIN_JD_CONTENT_CHARS = 200;
const BLOCKED_JD_PATTERNS = [
  /^.{0,500}\bsign in to (?:view|continue)\b/i,
  /enable javascript and cookies to continue/i,
  /^.{0,500}\baccess denied\b/i,
  /^.{0,500}\bcaptcha\b/i,
  /job (?:is )?no longer available/i,
];
const markdownField = (text, name) => String(text).match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)\\r?$`, 'mi'))?.[1]?.trim() ?? '';
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEGACY_EXCLUSION_CONFIG = path.join(PROJECT_ROOT, 'config/jobspy-ego.json');

function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }

function employerExclusionsByAdapter(profile) {
  const configs = new Map();
  return new Map(profile.adapters.flatMap(adapter => {
    const definition = profile.adapter_definitions?.[adapter];
    if (!definition?.employer_exclusions) return [];
    const configFile = definition.config ? path.resolve(PROJECT_ROOT, definition.config) : LEGACY_EXCLUSION_CONFIG;
    if (!configs.has(configFile)) configs.set(configFile, validateEmployerExclusionRules(json(configFile).employer_exclusions));
    return [[adapter, configs.get(configFile)]];
  }));
}

function validateJd(text, label) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const errors = [];
  if (normalized.length < MIN_JD_CONTENT_CHARS) errors.push(`${label}: JD is too short (${normalized.length} chars)`);
  const blocked = BLOCKED_JD_PATTERNS.find(pattern => pattern.test(normalized));
  if (blocked) errors.push(`${label}: JD appears to be a blocked/error page`);
  return errors;
}

function validateSources(root, profile, acquisition, errors, warnings) {
  const sourcesRoot = path.join(root, 'sources');
  const unexpected = existsSync(sourcesRoot)
    ? readdirSync(sourcesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !profile.adapters.includes(entry.name))
      .map(entry => entry.name)
      .sort()
    : [];
  if (unexpected.length) errors.push(`unselected source artifacts present: ${unexpected.join(', ')}`);
  const sourceOutcomes = Array.isArray(acquisition.sources) ? acquisition.sources : [];
  const outcomeAdapters = sourceOutcomes.map(item => String(item?.adapter ?? ''));
  if (JSON.stringify(outcomeAdapters) !== JSON.stringify(profile.adapters)) errors.push('acquisition source outcomes do not exactly match selected adapters');
  const outcomes = new Map(sourceOutcomes.map(item => [item.adapter, item]));
  const selectedOutcomes = [];
  for (const adapter of profile.adapters) {
    const item = outcomes.get(adapter);
    if (!item) { errors.push(`acquisition missing source outcome for ${adapter}`); continue; }
    selectedOutcomes.push(item);
    const sourceRoot = path.join(root, 'sources', adapter);
    const actual = existsSync(path.join(sourceRoot, 'jobs')) ? readdirSync(path.join(sourceRoot, 'jobs')).filter(name => name.endsWith('.md')).length : 0;
    if (item.run_id !== path.basename(root) || item.adapter !== adapter || item.schema_version !== 1) errors.push(`${adapter}: invalid summary identity`);
    if (!['SUCCESS', 'FAILED', 'EMPTY'].includes(item.status)) errors.push(`${adapter}: invalid status ${item.status}`);
    if (item.unique_jobs !== item.markdown_jobs || item.markdown_jobs !== actual) errors.push(`${adapter}: summary counts do not reconcile`);
    if (item.status === 'SUCCESS' && (item.errors !== 0 || actual < 1)) errors.push(`${adapter}: SUCCESS requires jobs and zero errors`);
    if (item.status === 'FAILED' && item.errors < 1) errors.push(`${adapter}: FAILED requires errors`);
    if (item.status === 'EMPTY' && (item.errors !== 0 || actual !== 0)) errors.push(`${adapter}: EMPTY requires zero jobs and zero errors`);
    if (profile.adapter_definitions?.[adapter]?.employer_exclusions) {
      const auditFile = path.join(sourceRoot, 'excluded-employers.json');
      if (!existsSync(auditFile)) errors.push(`${adapter}: excluded-employers.json is required`);
      else {
        const audit = json(auditFile);
        if (audit.run_id !== path.basename(root) || !Array.isArray(audit.results) || audit.excluded_count !== audit.results.length) errors.push(`${adapter}: invalid employer-exclusion audit`);
      }
    }
  }
  const successful = selectedOutcomes.filter(item => item.status === 'SUCCESS');
  if (successful.length < profile.minimum_successful_adapters) errors.push(`minimum_successful_adapters=${profile.minimum_successful_adapters}, got ${successful.length}`);
  if (successful.length < profile.adapters.length) warnings.push(`degraded acquisition: successful sources ${successful.map(item => item.adapter).join(', ') || 'none'}`);
}

function validateLocationScope(root, acquisition, records, errors) {
  const scopeFile = path.join(root, 'triage/location-scope.json');
  const assignmentsExist = existsSync(path.join(root, 'assignments.json'));
  const completedReceiptExists = existsSync(path.join(root, 'receipt.json'));
  if (!existsSync(scopeFile)) {
    if (assignmentsExist && !completedReceiptExists) errors.push('triage/location-scope.json is required before scoring');
    return;
  }
  let audit;
  try { audit = json(scopeFile); }
  catch (error) { errors.push(`invalid triage/location-scope.json: ${error.message}`); return; }
  if (audit.schema_version !== 1 || audit.run_id !== path.basename(root) || !Array.isArray(audit.results)) {
    errors.push('invalid location-scope audit identity/schema');
    return;
  }
  const accepted = audit.results.filter(item => item.allowed === true);
  const excluded = audit.results.filter(item => item.allowed !== true);
  const ambiguous = audit.results.filter(item => String(item.decision).startsWith('AMBIGUOUS_'));
  if (audit.pre_scope_count !== audit.results.length
      || audit.accepted_count !== accepted.length
      || audit.excluded_count !== excluded.length
      || audit.ambiguous_count !== ambiguous.length
      || audit.pre_scope_count !== audit.accepted_count + audit.excluded_count) {
    errors.push('location-scope audit counts do not reconcile');
  }
  for (const item of audit.results) if (item.allowed !== isAllowedLocationDecision(item.decision)) errors.push(`${item.posting_key}: location-scope allowed flag contradicts decision`);
  if (!assignmentsExist && !completedReceiptExists) return;
  if (JSON.stringify(audit.policy) !== JSON.stringify(acquisition.location_scope_policy)) errors.push('acquisition location policy does not match location-scope audit');
  if (Number(acquisition.location_exclusion_count) !== Number(audit.excluded_count)
      || Number(acquisition.location_ambiguous_count) !== Number(audit.ambiguous_count)) errors.push('acquisition location counts do not match location-scope audit');
  if (assignmentsExist) {
    const assignments = json(path.join(root, 'assignments.json'));
    if (JSON.stringify(assignments.location_policy) !== JSON.stringify(audit.policy)
        || assignments.location_scope_audit !== 'triage/location-scope.json'
        || Number(assignments.location_exclusion_count) !== Number(audit.excluded_count)
        || Number(assignments.location_ambiguous_count) !== Number(audit.ambiguous_count)) {
      errors.push('assignments location metadata does not match location-scope audit');
    }
  }
  const decisions = new Map(audit.results.map(item => [String(item.posting_key ?? ''), item]));
  if (decisions.size !== audit.results.length || decisions.has('')) errors.push('location-scope audit posting keys must be unique and non-empty');
  const recordKeys = new Set(records.map(record => record.primary_key));
  for (const record of records) {
    const decision = decisions.get(record.primary_key);
    if (!decision || !isAllowedLocationDecision(decision.decision) || decision.allowed !== true) errors.push(`${record.primary_key}: acquired record lacks an allowed location-scope decision`);
    if (!record.location_scope || record.location_scope.decision !== decision?.decision || record.location_scope.allowed !== true) errors.push(`${record.primary_key}: acquisition location_scope does not match the audit`);
  }
  for (const item of excluded) if (recordKeys.has(String(item.posting_key))) errors.push(`${item.posting_key}: excluded location key remains acquired`);
}

export function validateRun(runDir) {
  const root = path.resolve(runDir);
  const profile = loadRunProfile(root);
  const employerExclusions = employerExclusionsByAdapter(profile);
  const acquisitionFile = path.join(root, 'acquisition.json');
  if (!existsSync(acquisitionFile)) throw new Error(`missing ${acquisitionFile}`);
  const acquisition = json(acquisitionFile);
  const errors = [];
  const warnings = [];
  if (acquisition.schema_version !== 1 || acquisition.run_id !== path.basename(root)) errors.push('acquisition identity/schema mismatch');
  const identityParserVersion = Number(acquisition.identity_parser_version ?? 1);
  if (![1, 2].includes(identityParserVersion)) errors.push('unsupported acquisition identity_parser_version');
  if (acquisition.profile_id !== profile.profile_id) errors.push('acquisition profile mismatch');
  if (!Array.isArray(acquisition.acquired) || !Array.isArray(acquisition.keys)) errors.push('acquisition must contain acquired and keys arrays');
  validateSources(root, profile, acquisition, errors, warnings);
  const records = Array.isArray(acquisition.acquired) ? acquisition.acquired : [];
  const primaryKeys = records.map(record => String(record.primary_key ?? ''));
  if (new Set(primaryKeys).size !== primaryKeys.length || primaryKeys.some(key => !key)) errors.push('primary_key values must be unique and non-empty');
  if (JSON.stringify([...acquisition.keys].sort()) !== JSON.stringify([...primaryKeys].sort())) errors.push('acquisition.keys does not match acquired primary_key values');
  for (const [index, record] of records.entries()) {
    const label = record.primary_key || `record ${index + 1}`;
    const keys = normalizePostingKeys(record.posting_keys);
    if (!keys.length || primaryPostingKey(keys) !== record.primary_key) errors.push(`${label}: invalid posting_keys/primary_key`);
    if (!record.source_keys || !Object.keys(record.source_keys).length) errors.push(`${label}: source_keys is required`);
    for (const [source, key] of Object.entries(record.source_keys ?? {})) if (!record.sources?.includes(source) || !keys.includes(key)) errors.push(`${label}: invalid source key ${source}=${key}`);
    for (const source of record.sources ?? []) if (!profile.adapters.includes(source)) errors.push(`${label}: unselected acquisition source ${source}`);
    for (const [key, url] of Object.entries(record.posting_urls ?? {})) if (!keys.includes(key) || !matchesStoredPostingKey(url, key, { identityParserVersion })) errors.push(`${label}: URL does not match posting key ${key}`);
    if (!record.primary_url || !matchesStoredPostingKey(record.primary_url, record.primary_key, { identityParserVersion })) errors.push(`${label}: primary_url does not match primary_key`);
    const jdFile = path.resolve(root, String(record.jd_path ?? ''));
    if (!jdFile.startsWith(`${root}${path.sep}`) || !existsSync(jdFile)) errors.push(`${label}: JD file missing or escapes run root`);
    else {
      const jdText = readFileSync(jdFile, 'utf8');
      errors.push(...validateJd(jdText, label));
      const rules = [...new Map((record.sources ?? []).flatMap(source => employerExclusions.get(source) ?? []).map(rule => [rule.id, rule])).values()];
      const employerExclusion = rules.length ? matchExcludedEmployer({ company: record.company, description: jdText }, rules) : null;
      if (employerExclusion) errors.push(`${label}: JD matches employer exclusion ${employerExclusion.id}: ${employerExclusion.evidence}`);
      if (identityParserVersion >= 2) {
        const jdKey = markdownField(jdText, 'Posting Key');
        const jdUrl = markdownField(jdText, 'URL');
        if (jdKey !== record.primary_key) errors.push(`${label}: JD Posting Key does not match primary_key`);
        if (!jdUrl || !matchesStoredPostingKey(jdUrl, record.primary_key, { identityParserVersion })) errors.push(`${label}: JD URL does not match primary_key`);
      }
    }
  }
  for (let left = 0; left < records.length; left++) for (let right = left + 1; right < records.length; right++) {
    if (samePosting(records[left], records[right])) errors.push(`${records[left].primary_key}: overlaps ${records[right].primary_key}`);
  }
  validateLocationScope(root, acquisition, records, errors);
  return { root, profile, acquisition, records, errors, warnings };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const index = process.argv.indexOf('--run');
    const run = index >= 0 ? process.argv[index + 1] : null;
    if (!run) throw new Error('Usage: node src/run-contract.mjs --run runs/<run-id>');
    const result = validateRun(run);
    console.log(JSON.stringify({ ok: !result.errors.length, acquired: result.records.length, warnings: result.warnings, errors: result.errors }, null, 2));
    if (result.errors.length) process.exit(1);
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
