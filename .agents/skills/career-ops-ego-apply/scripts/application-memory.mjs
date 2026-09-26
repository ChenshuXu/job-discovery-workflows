#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const VALID_SCOPES = new Set(['global', 'company', 'job']);
const SCOPE_RANK = { global: 1, company: 2, job: 3 };
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
    args[ARG_NAMES[name] || name] = value;
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
function slug(value) { return normalizeLabel(value).replace(/\s+/g, '_') || 'unknown'; }
export function scopeKey(scope, company = '', role = '') {
  if (scope === 'global') return 'global';
  if (scope === 'company') return slug(required(company, 'company'));
  if (scope === 'job') return `${slug(required(company, 'company'))}/${slug(required(role, 'role'))}`;
  throw new Error(`Invalid scope: ${scope}`);
}
export function emptyMemory(now = new Date().toISOString()) {
  return { version: 3, updatedAt: now, records: [], rules: [] };
}
function readMemory(path) {
  if (!existsSync(path)) return emptyMemory();
  const memory = JSON.parse(readFileSync(path, 'utf8'));
  if (!memory || typeof memory !== 'object' || !Array.isArray(memory.records)) {
    throw new Error('Application memory must be an object with a records array');
  }
  if (memory.rules !== undefined && !Array.isArray(memory.rules)) {
    throw new Error('Application memory rules must be an array');
  }
  return { ...memory, rules: memory.rules || [] };
}
function scopeApplies(record, company, role) {
  if (record.scope === 'global') return true;
  if (record.scope === 'company') return Boolean(company) && record.scopeKey === scopeKey('company', company);
  if (record.scope === 'job') return Boolean(company && role) && record.scopeKey === scopeKey('job', company, role);
  return false;
}
function publicRecord(record, matchedBy) {
  const {
    key, label, aliases = [], value, scope, scopeKey: resolvedScopeKey,
    source = null, subject = null, domain = null, threshold = null,
    comparison = null, logic = null, qualifiers = null,
  } = record;
  return {
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
    topic, relation, timeframe, qualifier, source,
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
  const rule = { ...common, answerKey, ...dimensions };
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
    .filter(record => scopeApplies(record, company, role))
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
  return value === true || /^(?:yes|true)$/i.test(String(value ?? '').trim());
}

function isNegative(value) {
  return value === false || /^(?:no|false)$/i.test(String(value ?? '').trim());
}

function inferenceMetadata(input) {
  const subject = normalizeLabel(input.subject);
  const domain = normalizeLabel(input.domain);
  if (!subject || !domain || input.threshold === undefined || input.threshold === null || input.threshold === '') return null;
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('threshold must be a non-negative number');
  return {
    subject,
    domain,
    threshold,
    comparison: normalizeLabel(input.comparison),
    logic: normalizeLabel(input.logic),
    qualifiers: normalizeLabel(input.qualifiers),
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
    if (normalizeLabel(record.subject) !== baseline.subject
      || normalizeLabel(record.domain) !== baseline.domain) return [];
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
  if (field !== 'threshold') return normalizeLabel(value);
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
  const normalized = normalizeLabel(label);
  const applicable = memory.records.filter(record => scopeApplies(record, company, role));
  const exactCandidates = applicable.flatMap((record) => {
    if (!scopeApplies(record, company, role) || (key && record.key !== key)) return [];
    if (!label) return [{ record, matchedBy: 'key' }];
    if ([record.normalizedLabel, record.label].map(normalizeLabel).includes(normalized)) {
      return [{ record, matchedBy: 'canonical_label' }];
    }
    if ((record.aliases || []).map(normalizeLabel).includes(normalized)) {
      return [{ record, matchedBy: 'alias' }];
    }
    return [];
  });
  const bestExact = bestScoped(exactCandidates);
  if (bestExact.length) {
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
    if (bestKey.length) {
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
    const recordSubject = normalizeLabel(record.subject);
    const recordDomain = normalizeLabel(record.domain);
    return recordSubject === requested.subject && recordDomain === requested.domain;
  });
  const deducedCandidates = semanticRecords.flatMap((record) => {
    const metadata = inferenceMetadata(record);
    if (!isAtomicUnqualified(metadata)) return [];
    if (metadata.threshold < requested.threshold || !isAffirmative(record.value)) return [];
    return [{ record, matchedBy: 'threshold_deduction' }];
  });
  deducedCandidates.sort((left, right) =>
    SCOPE_RANK[right.record.scope] - SCOPE_RANK[left.record.scope]
    || Number(left.record.threshold) - Number(right.record.threshold));
  if (deducedCandidates.length) {
    const candidateRank = SCOPE_RANK[deducedCandidates[0].record.scope];
    const candidateRecords = new Set(deducedCandidates.map(({ record }) => record));
    const sourceKey = deducedCandidates[0].record.key;
    const conflicts = applicable.filter((record) => {
      if (SCOPE_RANK[record.scope] < candidateRank) return false;
      if (candidateRecords.has(record)) return false;
      const sameSemanticDomain = normalizeLabel(record.subject) === requested.subject
        && normalizeLabel(record.domain) === requested.domain;
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
  if (direct.status === 'exact' || direct.status === 'deduced' || direct.status === 'conflict') {
    return direct;
  }
  if (!input.intent) return direct;
  const intent = normalizeLabel(input.intent).replace(/\s+/g, '.');
  const matchingRules = (memory.rules || [])
    .filter(rule => rule.kind === 'answer' && rule.intent === intent);
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
    key: rule.answerKey,
    company: input.company,
    role: input.role,
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
  const value = required(input.value, 'value');
  const scope = String(input.scope ?? 'job').trim();
  if (!VALID_SCOPES.has(scope)) throw new Error(`Invalid scope: ${scope}`);
  const reuseAuthorized = input.reuseAuthorized === true || input.reuseAuthorized === 'true';
  if (scope !== 'job' && !reuseAuthorized) {
    throw new Error(`${scope} scope requires explicit reuse authorization`);
  }
  const resolvedScopeKey = scopeKey(scope, input.company, input.role);
  const id = `${key}::${scope}:${resolvedScopeKey}`;
  const records = [...memory.records];
  const index = records.findIndex((record) => record.id === id);
  const previous = index >= 0 ? records[index] : {};
  const normalized = normalizeLabel(label);
  const sameCanonical = previous.label && normalizeLabel(previous.label) === normalized;
  const approvedAlias = (previous.aliases || []).some(alias => normalizeLabel(alias) === normalized);
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
  if (aliasUse && JSON.stringify(previous.value) !== JSON.stringify(value)) {
    throw new Error('alias approval cannot change the existing answer');
  }
  if (aliasUse) {
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
    normalizedLabel: normalizeLabel(previous.label || label),
    aliases,
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
    memory: { ...memory, version: 3, updatedAt: now, records, rules: memory.rules || [] },
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
    if (record.value === undefined || record.value === null || String(record.value).trim() === '') {
      errors.push(`${at}.value is missing`);
    }
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
function usage() {
  return [
    'Usage:',
    '  node application-memory.mjs resolve --memory <file> --label <verbatim ATS question> [--intent <canonical intent> --meaning-confirmed true --topic <topic> --relation <relation> --timeframe <timeframe> --qualifier <qualifier>] [--company <name>] [--role <title>]',
    '  node application-memory.mjs search --memory <file> --query <canonical fact keywords> [--company <name>] [--role <title>] [--limit <1-100>]',
    '  node application-memory.mjs lookup --memory <file> (--key <key> | --label <exact ATS question>) [--company <name>] [--role <title>] [--subject <name> --domain <name> --threshold <number> --comparison at_least --logic atomic --qualifiers none]',
    '  node application-memory.mjs remember --memory <file> --key <key> --label <exact ATS question> --value <answer> [--scope global|company|job] [--reuse-authorized true] [--approve-alias true] [--source <source>] [--company <name>] [--role <title>] [--subject <name> --domain <name> --threshold <number> --comparison at_least --logic atomic --qualifiers none]',
    '  node application-memory.mjs remember-rule --memory <file> --id <rule id> --kind answer --intent <intent> --meaning <canonical meaning> --answer-key <key> --topic <topic> --relation <relation> --timeframe <timeframe> --qualifier <qualifier> --reuse-authorized true [--source <source>]',
    '  node application-memory.mjs rules --memory <file>',
    '  node application-memory.mjs verify --memory <file>',
  ].join('\n');
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || !args.memory) throw new Error(usage());
  const path = resolve(args.memory);
  const memory = readMemory(path);
  if (args.command === 'resolve') return console.log(JSON.stringify(resolveQuestion(memory, args), null, 2));
  if (args.command === 'search') return console.log(JSON.stringify(search(memory, args), null, 2));
  if (args.command === 'lookup') return console.log(JSON.stringify(lookup(memory, args), null, 2));
  if (args.command === 'remember') {
    const result = remember(memory, args);
    const validation = verify(result.memory);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    writeMemory(path, result.memory);
    console.log(JSON.stringify({ action: result.action, key: args.key, scope: args.scope, verification: validation }, null, 2));
    return;
  }
  if (args.command === 'remember-rule') {
    const result = rememberRule(memory, args);
    const validation = verify(result.memory);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    writeMemory(path, result.memory);
    console.log(JSON.stringify({ action: result.action, id: args.id, verification: validation }, null, 2));
    return;
  }
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
    console.error(error.message);
    process.exitCode = 1;
  });
}
