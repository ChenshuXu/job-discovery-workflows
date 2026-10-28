#!/usr/bin/env node
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const VALID_SCOPES = new Set(['global', 'company', 'job', 'posting']);
const SCOPE_RANK = { global: 1, company: 2, job: 3, posting: 4 };
const ARG_NAMES = {
  'reuse-authorized': 'reuseAuthorized',
  'approve-alias': 'approveAlias',
  'answer-key': 'answerKey',
  'meaning-confirmed': 'meaningConfirmed',
};
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument near: ${flag ?? '<end>'}`);
    }
    const name = flag.slice(2);
    const field = ARG_NAMES[name] || name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[field] = ['context', 'value'].includes(field) && /^[{[]/.test(value) ? JSON.parse(value) : value;
  }
  return args;
}

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
export function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export function normalizeQuestion(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[?.]+$/, '').trim().replace(/\s+/g, ' ');
}
function semanticText(value) { return normalizeQuestion(value).replace(/_/g, ' ').trim().replace(/\s+/g, ' '); }
function truth(value) { return value === true || value === 'true'; }
function slug(value) { return normalizeLabel(value).replace(/\s+/g, '_') || 'unknown'; }
export function scopeKey(scope, company = '', role = '', postingKey = '') {
  if (scope === 'global') return 'global';
  if (scope === 'posting') return required(postingKey, 'postingKey');
  if (scope === 'company') return slug(required(company, 'company'));
  if (scope === 'job') return `${slug(required(company, 'company'))}/${slug(required(role, 'role'))}`;
  throw new Error(`Invalid scope: ${scope}`);
}
export function emptyMemory(now = new Date().toISOString()) {
  return { version: 3, updatedAt: now, records: [], rules: [] };
}
export function readMemory(path) {
  return existsSync(path) ? parseMemory(readFileSync(path, 'utf8')) : emptyMemory();
}
function checkedMemoryText(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Memory must be an owner-only regular file');
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readMemoryChecked(path) {
  const text = checkedMemoryText(path);
  return text === null ? emptyMemory() : parseMemory(text);
}
function parseMemory(text) {
  const memory = JSON.parse(text);
  if (!memory || typeof memory !== 'object' || !Array.isArray(memory.records)) {
    throw new Error('Application memory must be an object with a records array');
  }
  if (memory.rules !== undefined && !Array.isArray(memory.rules)) {
    throw new Error('Application memory rules must be an array');
  }
  return { ...memory, rules: memory.rules || [] };
}
function scopeApplies(record, company, role, postingKey) {
  if (record.scope === 'global') return true;
  if (record.scope === 'posting') return Boolean(postingKey) && record.scopeKey === postingKey;
  if (record.scope === 'company') return Boolean(company) && record.scopeKey === scopeKey('company', company);
  if (record.scope === 'job') return Boolean(company && role) && record.scopeKey === scopeKey('job', company, role);
  return false;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function targetRevision(target) {
  return target ? createHash('sha256').update(JSON.stringify(canonical(target))).digest('hex') : null;
}
function contextValue(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const result = Object.fromEntries(Object.keys(context).sort().map(key => [key,
    Array.isArray(context[key]) ? context[key].map(semanticText).sort() : semanticText(context[key])
  ]));
  return result;
}
function validateContext(context) {
  const fields = ['section', 'intent', 'subject', 'domain', 'timeframe', 'qualifier', 'comparison', 'conditions'];
  if (!context || fields.some(field => typeof context[field] !== 'string' || !context[field].trim()) || !Array.isArray(context.options) || context.options.some(option => typeof option !== 'string')) throw new Error('Reviewed context requires section, intent, subject, domain, timeframe, qualifier, comparison, conditions and options');
}
function validateSelection(input) {
  if (!['global', 'company', 'posting'].includes(input.answerSource)) throw new Error('Invalid answerSource');
  if (input.answerSource === 'company') required(input.company, 'company');
  if (input.answerSource === 'posting') required(input.postingKey, 'postingKey');
}
function selectedApplies(record, input) {
  if (!scopeApplies(record, input.company, input.role, input.postingKey)) return false;
  if (!input.answerSource) return true;
  validateSelection(input);
  if (record.sharedBasic && record.reviewedMeaning && record.scope === 'global') return true;
  return record.scope === input.answerSource;
}
function contextConflict(record, input) {
  if (!input.answerSource && !input.context && !record.context) return false;
  if (!input.context || !record.context) return true;
  return JSON.stringify(contextValue(record.context)) !== JSON.stringify(contextValue(input.context));
}
function factualCounterevidence(memory, matches, input) {
  if (!input.answerSource) return [];
  const selected = matches[0]?.record;
  if (!selected) return [];
  return memory.records.filter(record => !matches.some(match => match.record === record)
    && scopeApplies(record, input.company, input.role, input.postingKey)
    && (record.sharedBasic || record.factual === true)
    && record.key === selected.key && !contextConflict(record, input)
    && factualValuesConflict(selected, record));
}
function factualValuesConflict(left, right) {
  const a = inferenceMetadata(left), b = inferenceMetadata(right);
  if (isAtomicUnqualified(a) && isAtomicUnqualified(b) && a.subject === b.subject && a.domain === b.domain) return thresholdStatementsConflict(left, a, right, b);
  return JSON.stringify(left.value) !== JSON.stringify(right.value);
}
function answerValue(value) {
  if (!value || typeof value !== 'object') return required(value, 'value');
  if (Array.isArray(value) || Object.keys(value).some(key => !['type', 'value'].includes(key))) throw new Error('Invalid typed value');
  const item = value.value;
  if (value.type === 'text' && typeof item === 'string' && item.trim()) return value;
  if (value.type === 'boolean' && typeof item === 'boolean') return value;
  if (value.type === 'multi' && Array.isArray(item) && item.every(v => typeof v === 'string') && new Set(item).size === item.length) return value;
  if (value.type === 'blank' && item === null) return value;
  if (value.type === 'date' && typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item)
    && !Number.isNaN(Date.parse(item)) && new Date(item).toISOString().slice(0, 10) === item) return value;
  throw new Error(`Invalid typed ${value.type || 'unknown'} value`);
}
export function answerTarget(memory, input) {
  if (input.targetType === 'rule' || (input.id && !input.key)) {
    const id = required(input.id, 'rule id');
    const target = (memory.rules || []).find(rule => rule.id === id);
    return { type: 'rule', id, revision: targetRevision(target), target: target ? publicRule(target) : null };
  }
  const scope = input.scope || input.answerSource || 'job';
  const identity = scopeKey(scope, input.company, input.role, input.postingKey);
  const id = `${required(input.key, 'key')}::${scope}:${identity}`;
  const target = memory.records.find(record => record.id === id);
  return { type: 'record', id, scope, scopeKey: identity, revision: targetRevision(target), target: target ? publicRecord(target, 'target') : null };
}

function publicRecord(record, matchedBy) {
  const {
    key, label, aliases = [], value, scope, scopeKey: resolvedScopeKey,
    source = null, subject = null, domain = null, threshold = null,
    comparison = null, logic = null, qualifiers = null,
  } = record;
  return {
    id: record.id, revision: targetRevision(record), context: record.context || null, sharedBasic: record.sharedBasic || false,
    key, label, aliases, value, scope, scopeKey: resolvedScopeKey,
    source, subject, domain, threshold, comparison, logic, qualifiers, matchedBy,
  };
}

const BUILT_IN_TRAP_MATCHERS = [
  'human_identity_challenge',
  'captcha_challenge',
  'one_time_security_code',
];
const RULE_DIMENSIONS = ['topic', 'relation', 'timeframe', 'qualifier'];

function publicRule(rule) {
  const {
    id, kind, intent, meaning, answerKey = null,
    topic = null, relation = null, timeframe = null, qualifier = null,
    source = null,
  } = rule;
  return {
    id, kind, intent, meaning, answerKey,
    topic, relation, timeframe, qualifier, source, revision: targetRevision(rule),
  };
}

function trapMatcherMatches(matcher, label) {
  const text = normalizeLabel(label);
  if (matcher === 'captcha_challenge') {
    return /\b(?:captcha|recaptcha|hcaptcha)\b/.test(text)
      || /\bi am not a robot\b/.test(text);
  }
  if (matcher === 'one_time_security_code') {
    return /\b(?:verification|security|one time|otp) (?:code|password)\b/.test(text)
      || /\b(?:code|password)\b.{0,40}\b(?:sent|emailed|texted)\b/.test(text);
  }
  if (matcher === 'human_identity_challenge') {
    return /\b(?:verify|confirm|prove|demonstrate)\b.{0,50}\b(?:you are|you re|applicant is)\b.{0,30}\b(?:human|not a bot|not a robot)\b/.test(text)
      || /\b(?:select|choose|check|type|enter|write|answer)\b.{0,50}\b(?:human|not a bot|not a robot)\b/.test(text)
      || /\bif you are\b.{0,25}\b(?:an? )?(?:ai|bot|robot|automated agent|language model)\b/.test(text)
      || /\b(?:ai assistant|automated agent|language model|bot|robot)s?\b.{0,60}\b(?:do not|must not|should not|select|choose|type|enter|answer)\b/.test(text);
  }
  return false;
}

function classifyQuestion(input) {
  required(input.label, 'label');
  const matcher = BUILT_IN_TRAP_MATCHERS.find(value => trapMatcherMatches(value, input.label));
  return matcher
    ? { status: 'human_only', action: 'manual_handoff', matcher }
    : { status: 'ordinary_question', action: 'continue' };
}

function normalizedRuleDimensions(input) {
  return Object.fromEntries(RULE_DIMENSIONS.map(field => [field, normalizeLabel(input[field])]));
}

export function rememberRule(memory, input, now = new Date().toISOString()) {
  const id = required(input.id, 'id');
  const kind = input.kind ? required(input.kind, 'kind') : 'answer';
  const intent = required(input.intent, 'intent');
  const meaning = required(input.meaning, 'meaning');
  const reuseAuthorized = input.reuseAuthorized === true || input.reuseAuthorized === 'true';
  if (!reuseAuthorized) throw new Error('question rules require explicit reuse authorization');
  if (kind !== 'answer') throw new Error(`Invalid rule kind: ${kind}`);

  const rules = [...(memory.rules || [])];
  const index = rules.findIndex(rule => rule.id === id);
  const previous = index >= 0 ? rules[index] : {};
  if (previous.kind && previous.kind !== kind) throw new Error('rule kind cannot change');
  const common = {
    ...previous,
    id,
    kind,
    intent: normalizeLabel(intent).replace(/\s+/g, '.'),
    meaning,
    source: input.source || previous.source || 'current_conversation',
    updatedAt: now,
  };
  const answerKey = required(input.answerKey, 'answer-key');
  const dimensions = normalizedRuleDimensions(input);
  for (const field of RULE_DIMENSIONS) required(dimensions[field], field);
  const target = input.answerId ? memory.records.find(record => record.id === input.answerId && record.key === answerKey) : null;
  if (input.answerSource && (!target || !selectedApplies(target, input))) throw new Error('strict rule requires an existing exact selected-source answerId');
  if (input.answerSource && targetRevision(target) !== input.answerRevision) throw new Error('Rule answer revision is stale; review current meaning');
  const rule = { ...common, answerKey, ...dimensions, ...(target ? { answerId: target.id, answerRevision: targetRevision(target), scope: target.scope, scopeKey: target.scopeKey } : {}) };
  if (index >= 0) rules[index] = rule;
  else rules.push(rule);
  return {
    action: index >= 0 ? 'rule_updated' : 'rule_created',
    memory: { ...memory, version: 3, updatedAt: now, rules },
  };
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'been', 'being', 'by', 'did', 'do',
  'does', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
]);

function searchTokens(value) {
  return normalizeLabel(value)
    .split(' ')
    .filter(token => token.length >= 3 && !SEARCH_STOP_WORDS.has(token));
}

function keywordMatches(keyword, candidate) {
  if (keyword === candidate) return true;
  const shorterLength = Math.min(keyword.length, candidate.length);
  if (shorterLength < 4) return false;
  let commonPrefixLength = 0;
  while (commonPrefixLength < shorterLength
    && keyword[commonPrefixLength] === candidate[commonPrefixLength]) {
    commonPrefixLength += 1;
  }
  return commonPrefixLength >= Math.min(5, shorterLength);
}

export function search(memory, input) {
  const query = required(input.query, 'query');
  const keywords = [...new Set(searchTokens(query))];
  if (!keywords.length) throw new Error('query must contain at least one searchable keyword');
  const limit = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  const { company = '', role = '' } = input;
  const candidates = memory.records
    .filter(record => selectedApplies(record, input))
    .flatMap((record) => {
      const tokens = searchTokens([
        record.key, record.label, ...(record.aliases || []), record.subject, record.domain, record.qualifiers,
      ].join(' '));
      const matchedKeywords = keywords.filter(keyword => tokens.some(token => keywordMatches(keyword, token)));
      if (!matchedKeywords.length) return [];
      return [{
        ...publicRecord(record, 'keyword_search'),
        matchedKeywords,
        canonicalMatches: keywords.filter(keyword => searchTokens(record.key).some(token => keywordMatches(keyword, token))).length,
      }];
    })
    .sort((left, right) =>
      right.matchedKeywords.length - left.matchedKeywords.length
      || right.canonicalMatches - left.canonicalMatches
      || SCOPE_RANK[right.scope] - SCOPE_RANK[left.scope]
      || left.key.localeCompare(right.key))
    .slice(0, limit);
  return {
    status: candidates.length ? 'matches' : 'unresolved',
    query,
    keywords,
    candidates,
  };
}

function sameValue(records) {
  return new Set(records.map(({ record }) => JSON.stringify(record.value))).size <= 1;
}

function bestScoped(candidates) {
  candidates.sort((left, right) => SCOPE_RANK[right.record.scope] - SCOPE_RANK[left.record.scope]);
  const bestRank = candidates.length ? SCOPE_RANK[candidates[0].record.scope] : 0;
  return candidates.filter(({ record }) => SCOPE_RANK[record.scope] === bestRank);
}

function isAffirmative(value) {
  if (['boolean', 'text'].includes(value?.type)) value = value.value;
  return value === true || /^(?:yes|true)$/i.test(String(value ?? '').trim());
}

function isNegative(value) {
  if (['boolean', 'text'].includes(value?.type)) value = value.value;
  return value === false || /^(?:no|false)$/i.test(String(value ?? '').trim());
}

function inferenceMetadata(input) {
  const subject = semanticText(input.subject);
  const domain = semanticText(input.domain);
  if (!subject || !domain || input.threshold === undefined || input.threshold === null || input.threshold === '') return null;
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('threshold must be a non-negative number');
  return {
    subject,
    domain,
    threshold,
    comparison: semanticText(input.comparison),
    logic: semanticText(input.logic),
    qualifiers: semanticText(input.qualifiers),
  };
}

function isAtomicUnqualified(metadata) {
  return metadata?.comparison === 'at least'
    && metadata.logic === 'atomic'
    && metadata.qualifiers === 'none';
}

function sameInferenceMetadata(left, right) {
  if (!left || !right) return left === right;
  return left.subject === right.subject
    && left.domain === right.domain
    && left.threshold === right.threshold
    && left.comparison === right.comparison
    && left.logic === right.logic
    && left.qualifiers === right.qualifiers;
}

function thresholdStatementsConflict(leftRecord, leftMetadata, rightRecord, rightMetadata) {
  const leftYes = isAffirmative(leftRecord.value);
  const leftNo = isNegative(leftRecord.value);
  const rightYes = isAffirmative(rightRecord.value);
  const rightNo = isNegative(rightRecord.value);
  if ((!leftYes && !leftNo) || (!rightYes && !rightNo)) {
    return JSON.stringify(leftRecord.value) !== JSON.stringify(rightRecord.value);
  }
  if ((leftYes && rightYes) || (leftNo && rightNo)) return false;
  const yesThreshold = leftYes ? leftMetadata.threshold : rightMetadata.threshold;
  const noThreshold = leftNo ? leftMetadata.threshold : rightMetadata.threshold;
  return yesThreshold >= noThreshold;
}

function exactSemanticConflicts(applicable, exactMatches, requested) {
  const selected = exactMatches[0]?.record;
  if (!selected) return [];
  const selectedMetadata = inferenceMetadata(selected);
  if (requested && !sameInferenceMetadata(requested, selectedMetadata)) {
    return [{ record: selected, matchedBy: 'query_metadata_conflict' }];
  }
  const baseline = requested || selectedMetadata;
  if (!baseline) return [];
  const exactMetadataConflicts = exactMatches.slice(1).flatMap(({ record }) => {
    const metadata = inferenceMetadata(record);
    return sameInferenceMetadata(baseline, metadata)
      ? [] : [{ record, matchedBy: 'exact_metadata_conflict' }];
  });
  if (exactMetadataConflicts.length) return exactMetadataConflicts;
  if (!isAtomicUnqualified(baseline)) return [];
  const exactRank = SCOPE_RANK[selected.scope];
  const exactRecords = new Set(exactMatches.map(({ record }) => record));
  return applicable.flatMap((record) => {
    if (exactRecords.has(record) || SCOPE_RANK[record.scope] < exactRank) return [];
    if (semanticText(record.subject) !== baseline.subject
      || semanticText(record.domain) !== baseline.domain) return [];
    const metadata = inferenceMetadata(record);
    if (!isAtomicUnqualified(metadata)
      || thresholdStatementsConflict(selected, baseline, record, metadata)) {
      return [{ record, matchedBy: 'semantic_counterevidence' }];
    }
    return [];
  });
}

const SEMANTIC_FIELDS = ['subject', 'domain', 'threshold', 'comparison', 'logic', 'qualifiers'];
function normalizedSemanticField(field, value) {
  if (field !== 'threshold') return semanticText(value);
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('threshold must be a non-negative number');
  return threshold;
}

function assertAliasMetadataMatches(previous, input) {
  for (const field of SEMANTIC_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue;
    const incoming = normalizedSemanticField(field, input[field]);
    const existing = previous[field] === undefined || previous[field] === null
      ? null : normalizedSemanticField(field, previous[field]);
    if (incoming !== existing) throw new Error(`alias metadata conflict for ${field}`);
  }
}

export function lookup(memory, input) {
  const { key, label, company = '', role = '' } = input;
  if (!key && !label) throw new Error('lookup requires --key or --label');
  const normalized = normalizeQuestion(label);
  if (input.answerSource) validateSelection(input);
  if (label && classifyQuestion({ label }).status === 'human_only') return classifyQuestion({ label });
  const applicable = memory.records.filter(record => selectedApplies(record, input));
  const exactCandidates = applicable.flatMap((record) => {
    if (!selectedApplies(record, input) || (key && record.key !== key)) return [];
    if (!label) return [{ record, matchedBy: 'key' }];
    if ([record.label].map(normalizeQuestion).includes(normalized)) {
      return [{ record, matchedBy: 'canonical_label' }];
    }
    if ((record.aliases || []).map(normalizeQuestion).includes(normalized)) {
      return [{ record, matchedBy: 'alias' }];
    }
    return [];
  });
  const bestExact = bestScoped(exactCandidates);
  if (bestExact.length) {
    const contextConflicts = bestExact.filter(({ record }) => contextConflict(record, input));
    if (contextConflicts.length) return { status: 'conflict', selected: null, reason: 'field meaning or context changed', candidates: contextConflicts.map(({record}) => publicRecord(record, 'context_conflict')) };
    const counterevidence = factualCounterevidence(memory, bestExact, input);
    if (counterevidence.length) return { status: 'conflict', selected: null, reason: 'confirmed factual counterevidence', candidates: counterevidence.map(record => publicRecord(record, 'factual_counterevidence')) };
    const effectiveKeys = new Set(bestExact.map(({ record }) => record.key));
    if (effectiveKeys.size !== 1) {
      return {
        status: 'conflict',
        selected: null,
        candidates: bestExact.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
      };
    }
    const effectiveKey = key || [...effectiveKeys][0];
    const exactRank = SCOPE_RANK[bestExact[0].record.scope];
    const moreSpecificKeyRecords = applicable.filter(record =>
      record.key === effectiveKey && SCOPE_RANK[record.scope] > exactRank);
    if (moreSpecificKeyRecords.length) {
      const records = [...bestExact.map(({ record }) => record), ...moreSpecificKeyRecords];
      const baselineMetadata = inferenceMetadata(input) || inferenceMetadata(bestExact[0].record);
      const hasMetadataConflict = moreSpecificKeyRecords.some(record =>
        !sameInferenceMetadata(baselineMetadata, inferenceMetadata(record)));
      return {
        status: !hasMetadataConflict && sameValue(records.map(record => ({ record })))
          ? 'key_review' : 'conflict',
        selected: null,
        candidates: [
          ...bestExact.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
          ...moreSpecificKeyRecords.map(record => publicRecord(record, 'more_specific_key_record')),
        ],
      };
    }
    const requested = inferenceMetadata(input);
    const semanticConflicts = exactSemanticConflicts(applicable, bestExact, requested);
    if (semanticConflicts.length) {
      return {
        status: 'conflict',
        selected: null,
        candidates: [
          ...bestExact.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
          ...semanticConflicts.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
        ],
      };
    }
    const status = sameValue(bestExact) ? 'exact' : 'conflict';
    return {
      status,
      selected: status === 'exact' ? publicRecord(bestExact[0].record, bestExact[0].matchedBy) : null,
      candidates: exactCandidates.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
    };
  }

  if (key) {
    const keyCandidates = applicable
      .filter(record => record.key === key)
      .map(record => ({ record, matchedBy: 'key_review' }));
    const bestKey = bestScoped(keyCandidates);
    if (bestKey.length && !isAtomicUnqualified(inferenceMetadata(input))) {
      return {
        status: sameValue(bestKey) ? 'key_review' : 'conflict',
        selected: null,
        candidates: keyCandidates.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
      };
    }
  }

  const requested = inferenceMetadata(input);
  if (!isAtomicUnqualified(requested)) {
    return { status: 'unresolved', selected: null, candidates: [] };
  }
  const semanticRecords = applicable.filter((record) => {
    const recordSubject = semanticText(record.subject);
    const recordDomain = semanticText(record.domain);
    return recordSubject === requested.subject && recordDomain === requested.domain;
  });
  const deducedCandidates = semanticRecords.flatMap((record) => {
    const metadata = inferenceMetadata(record);
    if (!isAtomicUnqualified(metadata) || contextConflict(record, input)) return [];
    if (metadata.threshold < requested.threshold || !isAffirmative(record.value)) return [];
    return [{ record, matchedBy: 'threshold_deduction' }];
  });
  deducedCandidates.sort((left, right) =>
    SCOPE_RANK[right.record.scope] - SCOPE_RANK[left.record.scope]
    || Number(left.record.threshold) - Number(right.record.threshold));
  if (deducedCandidates.length) {
    const counterevidence = factualCounterevidence(memory, deducedCandidates, input);
    if (counterevidence.length) return { status: 'conflict', selected: null, reason: 'confirmed factual counterevidence', candidates: [...deducedCandidates.map(({ record, matchedBy }) => publicRecord(record, matchedBy)), ...counterevidence.map(record => publicRecord(record, 'factual_counterevidence'))] };
    const candidateRank = SCOPE_RANK[deducedCandidates[0].record.scope];
    const candidateRecords = new Set(deducedCandidates.map(({ record }) => record));
    const sourceKey = deducedCandidates[0].record.key;
    const conflicts = applicable.filter((record) => {
      if (SCOPE_RANK[record.scope] < candidateRank) return false;
      if (candidateRecords.has(record)) return false;
      const sameSemanticDomain = semanticText(record.subject) === requested.subject
        && semanticText(record.domain) === requested.domain;
      return record.key === sourceKey || sameSemanticDomain;
    });
    if (conflicts.length) {
      return {
        status: 'conflict',
        selected: null,
        candidates: [
          ...deducedCandidates.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
          ...conflicts.map(record => publicRecord(record, 'scope_or_qualifier_conflict')),
        ],
      };
    }
    return {
      status: 'deduced',
      selected: publicRecord(deducedCandidates[0].record, deducedCandidates[0].matchedBy),
      candidates: deducedCandidates.map(({ record, matchedBy }) => publicRecord(record, matchedBy)),
    };
  }

  return {
    status: 'unresolved',
    selected: null,
    candidates: [],
  };
}

export function resolveQuestion(memory, input) {
  const label = required(input.label, 'label');
  const classification = classifyQuestion({ label });
  if (classification.status === 'human_only') return classification;

  const direct = lookup(memory, input);
  if (input.intent && direct.status === 'exact' && direct.selected.context && semanticText(input.intent) !== semanticText(direct.selected.context.intent)) return { status: 'conflict', selected: null, reason: 'supplied intent conflicts with stored field meaning' };
  if (input.intent && direct.status === 'exact' && !direct.selected.context) {
    const rules = (memory.rules || []).filter(rule => rule.answerKey === direct.selected.key);
    if (!rules.some(rule => rule.intent === normalizeLabel(input.intent).replace(/\s+/g, '.') && RULE_DIMENSIONS.every(field => rule[field] === normalizedRuleDimensions(input)[field]))) return { status: 'conflict', selected: null, reason: 'direct label does not establish supplied semantic intent' };
  }
  if (direct.status === 'exact' || direct.status === 'deduced' || direct.status === 'conflict') {
    return direct;
  }
  if (!input.intent) return direct;
  const intent = normalizeLabel(input.intent).replace(/\s+/g, '.');
  const matchingRules = (memory.rules || [])
    .filter(rule => rule.kind === 'answer' && rule.intent === intent
      && (!input.answerSource || (rule.answerId && memory.records.some(record => record.id === rule.answerId && selectedApplies(record, input) && targetRevision(record) === rule.answerRevision))));
  if (matchingRules.length !== 1) {
    return {
      status: matchingRules.length ? 'conflict' : 'unresolved',
      selected: null,
      rules: matchingRules.map(publicRule),
    };
  }
  const rule = matchingRules[0];
  const meaningConfirmed = input.meaningConfirmed === true || input.meaningConfirmed === 'true';
  if (!meaningConfirmed) {
    return {
      status: 'unresolved',
      selected: null,
      rule: publicRule(rule),
      reason: 'semantic meaning must be explicitly confirmed',
    };
  }
  const dimensions = normalizedRuleDimensions(input);
  const mismatches = RULE_DIMENSIONS.filter(field => dimensions[field] !== rule[field]);
  if (mismatches.length) {
    return {
      status: 'unresolved',
      selected: null,
      rule: publicRule(rule),
      reason: 'semantic dimensions do not match the approved rule',
      mismatches,
    };
  }
  const resolved = lookup(memory, {
    ...input, label: undefined, key: rule.answerKey,
  });
  if (resolved.status !== 'exact') {
    return { ...resolved, rule: publicRule(rule) };
  }
  return {
    ...resolved,
    selected: { ...resolved.selected, matchedBy: 'semantic_rule' },
    rule: publicRule(rule),
  };
}

export function remember(memory, input, now = new Date().toISOString()) {
  const key = required(input.key, 'key');
  const label = required(input.label, 'label');
  const value = answerValue(input.value);
  const scope = String(input.scope ?? input.answerSource ?? 'job').trim();
  if (input.answerSource) {
    validateSelection(input);
    if (scope !== input.answerSource && !truth(input.sharedBasic)) throw new Error('save scope must equal selected answer source');
    if (!truth(input.userConfirmed)) throw new Error('learning requires deliberate final user confirmation');
    validateContext(input.context);
  }
  if (truth(input.sharedBasic) && (scope !== 'global' || !truth(input.reviewedMeaning) || !/^profile\.(identity|contact|education|history)\./.test(input.context?.intent || ''))) throw new Error('shared basic requires reviewed profile meaning and global scope');
  if (!VALID_SCOPES.has(scope)) throw new Error(`Invalid scope: ${scope}`);
  const reuseAuthorized = input.reuseAuthorized === true || input.reuseAuthorized === 'true';
  if (scope !== 'job' && scope !== 'posting' && !reuseAuthorized) {
    throw new Error(`${scope} scope requires explicit reuse authorization`);
  }
  const resolvedScopeKey = scopeKey(scope, input.company, input.role, input.postingKey);
  const id = `${key}::${scope}:${resolvedScopeKey}`;
  const records = [...memory.records];
  const index = records.findIndex((record) => record.id === id);
  const previous = index >= 0 ? records[index] : {};
  const normalized = normalizeQuestion(label);
  const sameCanonical = previous.label && normalizeQuestion(previous.label) === normalized;
  const approvedAlias = (previous.aliases || []).some(alias => normalizeQuestion(alias) === normalized);
  const correcting = truth(input.correct) || (sameCanonical && JSON.stringify(previous.value) !== JSON.stringify(value));
  if (correcting && index < 0) throw new Error('correction target does not exist');
  if (index >= 0 && input.context && JSON.stringify(contextValue(input.context)) !== JSON.stringify(contextValue(previous.context))) throw new Error('context meaning conflict; create a distinct canonical target');
  const approveAlias = input.approveAlias === true || input.approveAlias === 'true';
  if (index >= 0 && !sameCanonical && !approvedAlias && !approveAlias) {
    throw new Error('new wording for an existing key requires reviewed alias approval');
  }
  if (approveAlias && (index < 0 || sameCanonical)) {
    throw new Error('alias approval requires new wording for an existing answer');
  }
  const aliases = [...new Set([
    ...(previous.aliases || []),
    ...(index >= 0 && !sameCanonical ? [label] : []),
  ].filter(Boolean))];
  const aliasUse = index >= 0 && !sameCanonical;
  if (aliasUse && !correcting && JSON.stringify(previous.value) !== JSON.stringify(value)) {
    throw new Error('alias approval cannot change the existing answer');
  }
  if (aliasUse && !correcting) {
    assertAliasMetadataMatches(previous, input);
    const record = { ...previous, aliases, updatedAt: now };
    records[index] = record;
    return {
      action: approvedAlias ? 'alias_confirmed' : 'alias_added',
      memory: { ...memory, version: 3, updatedAt: now, records, rules: memory.rules || [] },
    };
  }
  const metadata = inferenceMetadata(input);
  const record = {
    ...previous,
    id,
    key,
    label: previous.label || label,
    normalizedLabel: normalizeQuestion(previous.label || label),
    aliases: correcting ? [] : aliases,
    ...(input.context ? { context: contextValue(input.context) } : {}),
    ...(truth(input.sharedBasic) ? { sharedBasic: true, reviewedMeaning: true } : {}),
    ...(truth(input.factual) && truth(input.reviewedMeaning) ? { factual: true } : {}),
    value,
    scope,
    scopeKey: resolvedScopeKey,
    source: input.source || previous.source || 'current_conversation',
    ...(metadata || {}),
    updatedAt: now,
    confirmedAt: now,
  };
  if (index >= 0) records[index] = record;
  else records.push(record);
  return {
    action: index >= 0 && JSON.stringify(previous.value) !== JSON.stringify(value) ? 'updated'
        : index >= 0 ? 'confirmed' : 'created',
    memory: { ...memory, version: 4, updatedAt: now, records, rules: correcting ? (memory.rules || []).filter(rule => rule.answerId ? rule.answerId !== id : rule.answerKey !== key) : memory.rules || [] },
  };
}

export function verify(memory) {
  const errors = [];
  const ids = new Set();
  memory.records.forEach((record, index) => {
    const at = `records[${index}]`;
    if (!record.id) errors.push(`${at}.id is missing`);
    else if (ids.has(record.id)) errors.push(`${at}.id is duplicated`);
    else ids.add(record.id);
    if (!record.key) errors.push(`${at}.key is missing`);
    if (!record.label) errors.push(`${at}.label is missing`);
    if (record.aliases !== undefined && !Array.isArray(record.aliases)) errors.push(`${at}.aliases must be an array`);
    if (!VALID_SCOPES.has(record.scope)) errors.push(`${at}.scope is invalid`);
    if (!record.scopeKey) errors.push(`${at}.scopeKey is missing`);
    try { answerValue(record.value); } catch (error) { errors.push(`${at}.value: ${error.message}`); }
  });
  const ruleIds = new Set();
  (memory.rules || []).forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (!rule.id) errors.push(`${at}.id is missing`);
    else if (ruleIds.has(rule.id)) errors.push(`${at}.id is duplicated`);
    else ruleIds.add(rule.id);
    if (rule.kind !== 'answer') errors.push(`${at}.kind is invalid`);
    if (!rule.intent) errors.push(`${at}.intent is missing`);
    if (!rule.meaning) errors.push(`${at}.meaning is missing`);
    if (!rule.answerKey) errors.push(`${at}.answerKey is missing`);
    else if (!memory.records.some(record => record.key === rule.answerKey)) {
      errors.push(`${at}.answerKey does not reference an answer record`);
    }
    for (const field of RULE_DIMENSIONS) {
      if (!rule[field]) errors.push(`${at}.${field} is missing`);
    }
  });
  return {
    ok: errors.length === 0,
    recordCount: memory.records.length,
    ruleCount: (memory.rules || []).length,
    errors,
  };
}
function writeMemory(path, memory) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(memory, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
export async function mutateMemory(requestedPath, command, input, { assertCurrent } = {}) {
  if (assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new Error('Invalid live authority assertion');
  const parent = dirname(resolve(requestedPath));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = resolve(realpathSync(parent), resolve(requestedPath).slice(parent.length + 1));
  const lock = `${path}.lock`;
  const token = randomUUID();
  const started = Date.now();
  const timeout = input.lockTimeoutMs === undefined ? 2000 : Number(input.lockTimeoutMs);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error('Invalid lock timeout');
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, hostname: hostname(), token }), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // No stale-lock deletion: PID reuse and incomplete acquisition cannot establish ownership loss.
      if (Date.now() - started >= timeout) throw new Error('Memory writer busy: lock remains owned or requires explicit recovery');
      await delay(Math.min(25, timeout));
    }
  }
  try {
    const original = checkedMemoryText(path);
    const memory = original === null ? emptyMemory() : parseMemory(original);
    const targetInput = { ...input, targetType: command.endsWith('rule') ? 'rule' : 'record' };
    const target = answerTarget(memory, targetInput);
    const absent = truth(input.expectedAbsent);
    if (absent && input.expectedRevision) throw new Error('Use one expected target precondition');
    if (!absent && !input.expectedRevision) throw new Error('Mutation requires expectedRevision or explicit expectedAbsent');
    if ((absent && target.revision) || (!absent && target.revision !== input.expectedRevision)) {
      const error = new Error('Target revision conflict; review latest target without replaying the old decision');
      error.code = 'REVISION_CONFLICT'; error.target = target; throw error;
    }
    // Library-only synchronous authority gate: queued UI work cannot outlive its scope.
    // The reducer, write and readback below do not await after this assertion.
    if (assertCurrent) {
      const asserted = assertCurrent();
      if (asserted && typeof asserted.then === 'function') throw new Error('Live authority assertion must be synchronous');
    }
    let result;
    if (command === 'remember') {
      if (classifyQuestion(input).status === 'human_only' || /password|secret|credential/i.test(`${input.key || ''} ${input.label || ''}`)) throw new Error('Human verification and credentials cannot be learned');
      result = remember(memory, input);
    } else if (command === 'remember-rule') result = rememberRule(memory, input);
    else if (command === 'forget' || command === 'forget-rule') {
      if (!target.revision) throw new Error('Forget target does not exist');
      const removed = memory.records.find(record => record.id === target.id);
      result = { action: 'forgotten', memory: { ...memory, records: memory.records.filter(record => command === 'forget-rule' || record.id !== target.id), rules: (memory.rules || []).filter(rule => command === 'forget-rule' ? rule.id !== target.id : rule.answerId ? rule.answerId !== target.id : rule.answerKey !== removed.key) } };
    } else throw new Error('Unknown memory mutation');
    result.memory.version = 4;
    result.memory.updatedAt = new Date().toISOString();
    const validation = verify(result.memory);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (existsSync(path) && memory.version !== 4) {
      const backup = `${path}.v${memory.version || 1}-backup`;
      if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    }
    writeMemory(path, result.memory);
    const committed = readMemoryChecked(path);
    if (targetRevision(committed) !== targetRevision(result.memory)) throw new Error('Committed memory verification failed');
    return { action: result.action, ...answerTarget(committed, targetInput), verification: verify(committed) };
  } finally {
    const owner = JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8'));
    if (owner.token === token) rmSync(lock, { recursive: true });
  }
}
function usage() {
  return [
    'Usage:',
    '  node application-memory.mjs resolve --memory <file> --label <verbatim ATS question> [--intent <canonical intent> --meaning-confirmed true --topic <topic> --relation <relation> --timeframe <timeframe> --qualifier <qualifier>] [--company <name>] [--role <title>]',
    '  node application-memory.mjs search --memory <file> --query <canonical fact keywords> [--company <name>] [--role <title>] [--limit <1-100>]',
    '  node application-memory.mjs lookup --memory <file> (--key <key> | --label <exact ATS question>) [--company <name>] [--role <title>] [--subject <name> --domain <name> --threshold <number> --comparison at_least --logic atomic --qualifiers none]',
    '  node application-memory.mjs remember --memory <file> --key <key> --label <exact ATS question> --value <answer> [--scope global|company|posting|job] (--expected-revision <hash> | --expected-absent true) [--reuse-authorized true] [--approve-alias true] [--source <source>] [--company <name>] [--role <title>] [--subject <name> --domain <name> --threshold <number> --comparison at_least --logic atomic --qualifiers none]',
    '  node application-memory.mjs remember-rule --memory <file> --id <rule id> --kind answer --intent <intent> --meaning <canonical meaning> --answer-key <key> --topic <topic> --relation <relation> --timeframe <timeframe> --qualifier <qualifier> --reuse-authorized true (--expected-revision <hash> | --expected-absent true) [--source <source>]',
    '  node application-memory.mjs target --memory <file> (--key <key> --scope <scope> | --id <rule-id> --target-type rule) [--company <company> --role <role> --posting-key <exact-key>]',
    '  node application-memory.mjs forget --memory <file> --key <key> --scope <scope> --expected-revision <hash>',
    '  node application-memory.mjs forget-rule --memory <file> --id <rule-id> --expected-revision <hash>',
    '  All selected-source reads use --answer-source global|company|posting, --posting-key <exact-key>, and --context <JSON>.',
    '  node application-memory.mjs rules --memory <file>',
    '  node application-memory.mjs verify --memory <file>',
  ].join('\n');
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || !args.memory) throw new Error(usage());
  const path = resolve(args.memory);
  if (['remember', 'remember-rule', 'forget', 'forget-rule'].includes(args.command)) {
    return console.log(JSON.stringify(await mutateMemory(path, args.command, args), null, 2));
  }
  const memory = args.answerSource ? readMemoryChecked(path) : readMemory(path);
  if (args.command === 'target') return console.log(JSON.stringify(answerTarget(memory, args), null, 2));
  if (args.command === 'resolve') return console.log(JSON.stringify(resolveQuestion(memory, args), null, 2));
  if (args.command === 'search') return console.log(JSON.stringify(search(memory, args), null, 2));
  if (args.command === 'lookup') return console.log(JSON.stringify(lookup(memory, args), null, 2));
  if (args.command === 'rules') {
    return console.log(JSON.stringify({ rules: (memory.rules || []).map(publicRule) }, null, 2));
  }
  if (args.command === 'verify') {
    if (!existsSync(path)) throw new Error(`Memory file not found: ${path}`);
    const result = verify(memory);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(usage());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message, code: error.code || 'INVALID_MEMORY_OPERATION', ...(error.target ? { target: error.target } : {}) }));
    process.exitCode = 1;
  });
}
