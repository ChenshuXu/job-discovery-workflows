import { readFileSync } from 'node:fs';

export const ALLOWED_LOCATION_DECISIONS = new Set(['ALLOW_LOCAL', 'ALLOW_REMOTE_US']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const unique = values => [...new Set((values ?? []).map(clean).filter(Boolean))];
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NON_WA_STATE_CODES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WV WI WY'.split(' '));

function validatePolicy(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (!Array.isArray(value.local_metros) || !value.local_metros.length || value.local_metros.some(item => !clean(item))) {
    throw new Error(`${label}.local_metros must be a non-empty string array`);
  }
  if (clean(value.remote_country).toLowerCase() !== 'united states') throw new Error(`${label}.remote_country must be United States`);
  if (value.require_structured_remote !== true) throw new Error(`${label}.require_structured_remote must be true`);
  if (value.ambiguous_action !== 'exclude') throw new Error(`${label}.ambiguous_action must be exclude`);
  return {
    local_metros: unique(value.local_metros),
    remote_country: 'United States',
    require_structured_remote: true,
    ambiguous_action: 'exclude',
  };
}

export function loadLocationPolicy(profileFile) {
  const text = readFileSync(profileFile, 'utf8');
  const raw = text.match(/^\s{2}scan_policy:\s*(\{.+\})\s*$/m)?.[1];
  if (!raw) throw new Error(`location.scan_policy inline JSON is required: ${profileFile}`);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`location.scan_policy is not valid inline JSON: ${profileFile}: ${error.message}`); }
  return validatePolicy(parsed, 'location.scan_policy');
}

export function normalizeWorkplaceType(value) {
  const text = clean(value).toLowerCase();
  if (!text) return 'unknown';
  if (text === 'conflict') return 'conflict';
  if (/\bremote\b/.test(text)) return 'remote';
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\bon[ -]?site\b/.test(text)) return 'onsite';
  return 'unknown';
}

function localMetroMatch(locations, metros) {
  for (const location of locations) {
    const stateCode = location.match(/,\s*([A-Z]{2})(?:\b|$)/i)?.[1]?.toUpperCase();
    if (stateCode && NON_WA_STATE_CODES.has(stateCode)) continue;
    for (const metro of metros) {
      if (new RegExp(`\\b${escapeRegex(metro)}\\b`, 'i').test(location)) return { location, metro };
    }
  }
  return null;
}

function isUsRemoteLocation(value) {
  const normalized = clean(value)
    .replace(/[()]/g, ' ')
    .replace(/[;,|/\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const tokens = normalized.split(' ').filter(Boolean);
  const allowed = new Set(['remote', 'united', 'states', 'of', 'america', 'usa', 'us', 'u.s.', 'u.s.a.']);
  return tokens.every(token => allowed.has(token))
    && (tokens.includes('remote') || normalized === 'united states' || normalized === 'united states of america' || normalized === 'usa' || normalized === 'us' || normalized === 'u.s.');
}

export function isAllowedLocationDecision(value) {
  return ALLOWED_LOCATION_DECISIONS.has(String(value ?? ''));
}

export function evaluateLocationScope(record, policyInput) {
  const policy = validatePolicy(policyInput, 'location policy');
  const locations = unique([...(Array.isArray(record?.locations) ? record.locations : []), record?.location]);
  const workplaceType = normalizeWorkplaceType(record?.workplace_type);
  const workplaceTypeSource = clean(record?.workplace_type_source) || 'unknown';
  const structuredRemoteSignal = workplaceType === 'remote' && record?.structured_remote_signal === true;
  const local = localMetroMatch(locations, policy.local_metros);
  const base = {
    allowed: false,
    locations,
    workplace_type: workplaceType,
    workplace_type_source: workplaceTypeSource,
    structured_remote_signal: structuredRemoteSignal,
  };
  if (local) return {
    ...base,
    allowed: true,
    decision: 'ALLOW_LOCAL',
    rule_id: 'target-metro',
    reason: `Location matches approved Seattle metro: ${local.metro}`,
    evidence: { location: local.location, metro: local.metro },
  };
  if (!locations.length) return {
    ...base,
    decision: 'AMBIGUOUS_MISSING_LOCATION',
    rule_id: 'missing-location',
    reason: 'Location is missing; fail closed before scoring',
    evidence: { location: null },
  };
  const allUsRemote = locations.every(isUsRemoteLocation);
  if (structuredRemoteSignal && allUsRemote) return {
    ...base,
    allowed: true,
    decision: 'ALLOW_REMOTE_US',
    rule_id: 'structured-us-remote',
    reason: 'Structured Remote signal is paired with United States or unqualified Remote location',
    evidence: { locations, workplace_type_source: workplaceTypeSource },
  };
  if (workplaceType === 'conflict') return {
    ...base,
    decision: 'AMBIGUOUS_WORKPLACE_CONFLICT',
    rule_id: 'workplace-conflict',
    reason: 'Sources disagree on workplace type; fail closed before scoring',
    evidence: { locations, workplace_type_source: workplaceTypeSource },
  };
  if (allUsRemote) return {
    ...base,
    decision: workplaceType === 'remote' ? 'AMBIGUOUS_UNSTRUCTURED_REMOTE_SIGNAL' : 'AMBIGUOUS_NO_REMOTE_SIGNAL',
    rule_id: 'structured-remote-required',
    reason: workplaceType === 'remote'
      ? 'Remote was inferred without a structured source signal; fail closed before scoring'
      : 'United States or Remote location lacks a structured Remote signal; fail closed before scoring',
    evidence: { locations, workplace_type: workplaceType, workplace_type_source: workplaceTypeSource },
  };
  if (workplaceType === 'remote') return {
    ...base,
    decision: 'AMBIGUOUS_REMOTE_GEOGRAPHY',
    rule_id: 'remote-geography-unproven',
    reason: 'Remote signal does not prove the role can be performed from Washington; fail closed before scoring',
    evidence: { locations, workplace_type_source: workplaceTypeSource },
  };
  return {
    ...base,
    decision: 'EXCLUDE_NONLOCAL',
    rule_id: 'outside-target-metro',
    reason: 'Location is outside the approved Seattle metro and is not verified US remote',
    evidence: { locations, workplace_type: workplaceType },
  };
}
