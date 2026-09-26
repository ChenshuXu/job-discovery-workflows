#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunProfile } from './adapter-registry.mjs';
import { employmentTypeDisplay, employmentTypeValues } from './employment-type.mjs';
import { legacyPostingKey, matchesStoredPostingKey, normalizePostingKeys, postingKey, primaryPostingKey, samePosting } from './posting-identity.mjs';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const field = (text, name) => text.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)\\r?$`, 'mi'))?.[1]?.trim() ?? '';
const safeKey = key => String(key).replace(/[^A-Za-z0-9._-]/g, '-');

function setMarkdownField(text, name, value) {
  const line = `**${name}:** ${value}`;
  const pattern = new RegExp(`^\\*\\*${name}:\\*\\*.*$`, 'mi');
  if (pattern.test(text)) return text.replace(pattern, line);
  const marker = '\n## Job Description';
  const at = text.indexOf(marker);
  return at >= 0 ? `${text.slice(0, at)}\n${line}${text.slice(at)}` : `${text.trimEnd()}\n${line}\n`;
}

function withMergedMetadata(text, record, runId) {
  let authoritative = setMarkdownField(setMarkdownField(text, 'URL', record.primary_url), 'Posting Key', record.primary_key);
  authoritative = setMarkdownField(authoritative, 'Discovery Run', runId);
  authoritative = setMarkdownField(authoritative, 'Location', (record.locations ?? []).join(' | ') || record.location || 'unknown');
  authoritative = setMarkdownField(authoritative, 'Workplace Type', record.workplace_type || 'unknown');
  authoritative = setMarkdownField(authoritative, 'Workplace Type Source', record.workplace_type_source || 'unknown');
  authoritative = setMarkdownField(authoritative, 'Structured Remote Signal', record.structured_remote_signal === true);
  const values = employmentTypeValues(record.employment_types?.length ? record.employment_types : record.employment_type);
  const withType = setMarkdownField(authoritative, 'Employment Type', employmentTypeDisplay(values));
  return setMarkdownField(withType, 'Employment Type Source', record.employment_type_source || 'unknown');
}

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'index.md').map(name => path.join(dir, name));
}

function summary(runRoot, adapter) {
  const file = path.join(runRoot, 'sources', adapter, 'summary.json');
  if (!existsSync(file)) throw new Error(`missing ${adapter} adapter summary`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['schema_version', 'run_id', 'adapter', 'status', 'raw_rows', 'unique_jobs', 'markdown_jobs', 'errors']) {
    if (!(key in value)) throw new Error(`${adapter} summary missing ${key}`);
  }
  if (value.schema_version !== 1 || value.run_id !== path.basename(runRoot) || value.adapter !== adapter) throw new Error(`${adapter} summary identity mismatch`);
  if (!['SUCCESS', 'FAILED', 'EMPTY'].includes(value.status)) throw new Error(`${adapter} summary has invalid status`);
  for (const key of ['raw_rows', 'unique_jobs', 'markdown_jobs', 'errors']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(`${adapter} summary ${key} must be a non-negative integer`);
  }
  const count = files(path.join(runRoot, 'sources', adapter, 'jobs')).length;
  if (value.unique_jobs !== value.markdown_jobs || value.markdown_jobs !== count) throw new Error(`${adapter} summary counts do not reconcile`);
  if (value.status === 'SUCCESS' && (value.errors !== 0 || count < 1)) throw new Error(`${adapter} SUCCESS requires jobs and zero errors`);
  if (value.status === 'FAILED' && value.errors < 1) throw new Error(`${adapter} FAILED requires at least one error`);
  if (value.status === 'EMPTY' && (value.errors !== 0 || count !== 0)) throw new Error(`${adapter} EMPTY requires zero jobs and zero errors`);
  return value;
}

export function sourceRecord(runRoot, adapter, file) {
  const text = readFileSync(file, 'utf8');
  const url = field(text, 'URL');
  const declaredKey = field(text, 'Posting Key');
  const parsedKey = postingKey(url);
  if (!parsedKey) throw new Error(`${path.relative(runRoot, file)} URL has no parser-v2 exact posting identity`);
  if (declaredKey && !matchesStoredPostingKey(url, declaredKey, { identityParserVersion: 2 }) && declaredKey !== legacyPostingKey(url)) {
    throw new Error(`${path.relative(runRoot, file)} posting key contradicts URL identity`);
  }
  const key = parsedKey;
  if (!url) throw new Error(`${path.relative(runRoot, file)} has no exact posting identity`);
  const linkedinId = field(text, 'LinkedIn Job ID') || url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i)?.[1] || null;
  const location = field(text, 'Location');
  const employmentType = field(text, 'Employment Type') || 'unknown';
  const cardPostedLabel = field(text, 'Card Posted Label') || null;
  const listedAtMs = Number(field(text, 'LinkedIn Listed At Ms')) || null;
  const originalListedAtMs = Number(field(text, 'LinkedIn Original Listed At Ms')) || null;
  return {
    posting_keys: [key], primary_key: key, source_keys: { [adapter]: key }, posting_urls: { [key]: url },
    primary_url: url, linkedin_id: linkedinId, company: field(text, 'Company'), title: field(text, 'Role'),
    location, locations: [location].filter(Boolean), workplace_type: field(text, 'Workplace Type') || 'unknown',
    workplace_type_source: field(text, 'Workplace Type Source') || 'unknown', posted_at: field(text, 'Posted'), sources: [adapter],
    employment_type: employmentType, employment_types: employmentTypeValues(employmentType),
    employment_type_source: field(text, 'Employment Type Source') || 'unknown',
    structured_remote_signal: field(text, 'Structured Remote Signal').toLowerCase() === 'true',
    posting_evidence: adapter === 'ego-browser' ? {
      [key]: { card_posted_label: cardPostedLabel, listed_at_ms: listedAtMs, original_listed_at_ms: originalListedAtMs },
    } : {},
    _text: text, _size: statSync(file).size,
  };
}

function mergePostingEvidence(left = {}, right = {}) {
  const merged = structuredClone(left);
  for (const [key, evidence] of Object.entries(right)) {
    const prior = merged[key] ?? {};
    const next = {};
    for (const fieldName of ['card_posted_label', 'listed_at_ms', 'original_listed_at_ms']) {
      const values = [prior[fieldName], evidence?.[fieldName]].filter(value => value != null && value !== '');
      if (new Set(values.map(String)).size > 1) throw new Error(`${key}: conflicting posting evidence ${fieldName}`);
      next[fieldName] = values[0] ?? null;
    }
    merged[key] = next;
  }
  return merged;
}

function mergeWorkplaceType(left, right) {
  const values = [...new Set([left, right].map(value => String(value ?? '').trim().toLowerCase()).filter(value => value && value !== 'unknown'))];
  return values.length === 1 ? values[0] : values.length > 1 ? 'conflict' : 'unknown';
}

function mergePair(left, right) {
  const postingKeys = normalizePostingKeys([...left.posting_keys, ...right.posting_keys]);
  const primaryKey = primaryPostingKey(postingKeys);
  const chosen = left._size >= right._size ? left : right;
  const urls = { ...left.posting_urls, ...right.posting_urls };
  const leftEmploymentTypes = employmentTypeValues(left.employment_types?.length ? left.employment_types : left.employment_type);
  const rightEmploymentTypes = employmentTypeValues(right.employment_types?.length ? right.employment_types : right.employment_type);
  const employmentTypes = employmentTypeValues([...leftEmploymentTypes, ...rightEmploymentTypes]);
  const employmentTypeSources = [...new Set([left.employment_type_source, right.employment_type_source].filter(value => value && value !== 'unknown'))];
  return {
    ...chosen,
    posting_keys: postingKeys,
    primary_key: primaryKey,
    source_keys: { ...left.source_keys, ...right.source_keys },
    posting_urls: urls,
    primary_url: urls[primaryKey] || chosen.primary_url,
    linkedin_id: left.linkedin_id || right.linkedin_id || null,
    locations: [...new Set([...(left.locations ?? [left.location]), ...(right.locations ?? [right.location])].filter(Boolean))],
    workplace_type: mergeWorkplaceType(left.workplace_type, right.workplace_type),
    workplace_type_source: [...new Set([left.workplace_type_source, right.workplace_type_source].filter(Boolean))].join('+') || 'unknown',
    structured_remote_signal: left.structured_remote_signal === true || right.structured_remote_signal === true,
    employment_type: employmentTypeDisplay(employmentTypes),
    employment_types: employmentTypes,
    employment_type_source: employmentTypeSources.join('+') || 'unknown',
    posting_evidence: mergePostingEvidence(left.posting_evidence, right.posting_evidence),
    sources: [...new Set([...left.sources, ...right.sources])].sort(),
    _size: Math.max(left._size, right._size),
  };
}

export function mergeByPostingKeys(records) {
  const merged = [];
  for (const source of records) {
    let record = { ...source, posting_keys: normalizePostingKeys(source.posting_keys) };
    for (let index = 0; index < merged.length;) {
      if (!samePosting(record, merged[index])) { index++; continue; }
      record = mergePair(record, merged[index]);
      merged.splice(index, 1);
      index = 0;
    }
    merged.push(record);
  }
  return merged.sort((a, b) => a.primary_key.localeCompare(b.primary_key));
}

export function writeAcquisition(runRoot, profile, adapterOutcomes, records, details = {}) {
  const jobsRoot = path.join(runRoot, 'jobs');
  rmSync(jobsRoot, { recursive: true, force: true });
  mkdirSync(jobsRoot, { recursive: true });
  const acquired = records.map(record => {
    const jdPath = `jobs/${safeKey(record.primary_key)}.md`;
    writeFileSync(path.join(runRoot, jdPath), withMergedMetadata(record._text, record, path.basename(runRoot)));
    const { _text, _size, ...publicRecord } = record;
    return { ...publicRecord, jd_path: jdPath };
  });
  const exclusions = profile.adapters.map(adapter => {
    const file = path.join(runRoot, 'sources', adapter, 'excluded-employers.json');
    if (!existsSync(file)) return { adapter, excluded_count: 0, missing: true };
    const audit = JSON.parse(readFileSync(file, 'utf8'));
    return { adapter, excluded_count: Number(audit.excluded_count ?? (Array.isArray(audit) ? audit.length : 0)) };
  });
  const acquisition = {
    schema_version: 1, run_id: path.basename(runRoot), profile_id: profile.profile_id,
    identity_parser_version: details.identityParserVersion ?? 2,
    generated_at: new Date().toISOString(), sources: adapterOutcomes,
    keys: acquired.map(item => item.primary_key), acquired,
    raw_source_jobs: details.rawSourceJobs ?? acquired.length,
    duplicates_removed: (details.rawSourceJobs ?? acquired.length) - acquired.length,
    cross_source_merges: acquired.filter(item => item.sources.length > 1).length,
    employer_exclusions: exclusions,
  };
  const target = path.join(runRoot, 'acquisition.json');
  const staged = `${target}.tmp-${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(acquisition, null, 2)}\n`);
  renameSync(staged, target);
  return acquisition;
}

export function combineRun(runRoot) {
  const root = path.resolve(runRoot);
  const profile = loadRunProfile(root);
  const outcomes = profile.adapters.map(adapter => summary(root, adapter));
  const successful = outcomes.filter(item => item.status === 'SUCCESS');
  if (successful.length < profile.minimum_successful_adapters) throw new Error(`daily profile requires ${profile.minimum_successful_adapters} successful adapter(s), got ${successful.length}`);
  const usable = outcomes.filter(item => item.status === 'SUCCESS' || (item.status === 'FAILED' && item.markdown_jobs > 0));
  const sourceRecords = usable.flatMap(item => files(path.join(root, 'sources', item.adapter, 'jobs')).map(file => sourceRecord(root, item.adapter, file)));
  if (!sourceRecords.length) throw new Error('usable acquisition produced no Markdown JDs');
  return writeAcquisition(root, profile, outcomes, mergeByPostingKeys(sourceRecords), { rawSourceJobs: sourceRecords.length });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const run = arg('--run');
    if (!run) throw new Error('Usage: node src/combine.mjs --run runs/<run-id>');
    const result = combineRun(run);
    console.log(JSON.stringify({ acquired: result.acquired.length, duplicates_removed: result.duplicates_removed, cross_source_merges: result.cross_source_merges }, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
