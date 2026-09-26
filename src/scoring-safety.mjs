// The worker owns JD interpretation. Code checks evidence and result consistency,
// then derives mechanical caps, decisions and presentation from that judgment.
export const RESULT_SCHEMA_VERSION = 4;
const LEVEL_SIGNALS = new Set(['target', 'staff_equivalent', 'unclear']);
const ELIGIBILITY_STATUSES = new Set(['eligible', 'ineligible', 'needs_verification']);
const ELIGIBILITY_CATEGORIES = new Set(['no_sponsorship', 'work_authorization', 'citizenship', 'export_control',
  'security_clearance', 'public_trust', 'mandatory_unacceptable_location', 'employment_type', 'internal_only']);
const LEGITIMACY_TIERS = new Set(['High Confidence', 'Proceed with Caution', 'Suspicious']);
const AUTH_LABELS = {
  sponsors: '✅ Sponsors', no_sponsorship: '⛔ No sponsorship', unstated: '⚠️ Unstated',
  needs_verification: '⚠️ Verify sponsorship', not_needed: '➖ Not needed',
};
const RESULT_FIELDS = new Set(['posting_key', 'status', 'fit_score', 'level_signal', 'level_evidence',
  'eligibility_status', 'eligibility_category', 'eligibility_evidence', 'legitimacy_tier',
  'rationale', 'report', 'work_authorization']);
const quoteFromEvidence = value => typeof value === 'string' ? value.trim().match(/^JD:\s*["“]([\s\S]+)["”]\.?$/)?.[1] : null;

function requireQuote(evidence, jdText, label) {
  const quote = quoteFromEvidence(evidence);
  if (!quote?.trim() || !jdText.includes(quote)) throw new Error(`${label} is not an exact JD substring`);
}

export function deriveReportWorkAuthorization({ item, jdText, candidateText }) {
  const auth = item?.work_authorization;
  const label = `${item?.posting_key ?? '<missing>'}: work_authorization`;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)
      || Object.keys(auth).length !== 2 || !Object.hasOwn(auth, 'value') || !Object.hasOwn(auth, 'quote')
      || typeof auth.value !== 'string' || !Object.hasOwn(AUTH_LABELS, auth.value)) throw new Error(`${label} requires a supported value and quote`);
  if (['unstated', 'not_needed'].includes(auth.value)) {
    if (auth.quote !== null) throw new Error(`${label} ${auth.value} requires a null quote`);
  } else if (typeof auth.quote !== 'string' || !auth.quote.trim() || !jdText.includes(auth.quote)) {
    throw new Error(`${label} quote is not an exact JD substring`);
  }
  // This checks an explicit locked profile field, not natural-language JD meaning.
  const needs = [...String(candidateText ?? '').matchAll(/^\s*needs_sponsorship:\s*(true|false)\s*(?:#.*)?$/gm)].map(match => match[1]);
  if (auth.value === 'not_needed' && (!needs.length || needs.some(value => value !== 'false'))) {
    throw new Error(`${label} not_needed requires locked needs_sponsorship: false`);
  }
  if (auth.value === 'no_sponsorship' && needs.includes('true') && item.eligibility_status === 'eligible') {
    throw new Error(`${label} conflicts with eligible status and locked sponsorship need`);
  }
  if (auth.value === 'needs_verification' && needs.includes('true') && item.eligibility_status === 'eligible') {
    throw new Error(`${label} uncertainty requires needs_verification or ineligible status`);
  }
  return { value: auth.value, label: AUTH_LABELS[auth.value], quote: auth.quote };
}

export function applyScoringSafety({ item, jdText, threshold }) {
  const key = item?.posting_key;
  const fit = item?.fit_score;
  if (typeof key !== 'string' || !key.trim() || typeof fit !== 'number' || !Number.isFinite(fit)
      || fit < 1 || fit > 5 || Math.round(fit * 10) !== fit * 10) throw new Error(`${key || '<missing>'}: invalid fit_score`);
  if (!LEVEL_SIGNALS.has(item.level_signal)) throw new Error(`${key}: invalid level_signal`);
  if (!ELIGIBILITY_STATUSES.has(item.eligibility_status)) throw new Error(`${key}: invalid eligibility_status`);
  if (!LEGITIMACY_TIERS.has(item.legitimacy_tier)) throw new Error(`${key}: invalid legitimacy_tier`);
  if (['score', 'hard_exclusion', 'hard_exclusion_evidence', 'report_allowed', 'report_decision', 'semantic_job_key', 'posting_context_key'].some(field => Object.hasOwn(item, field))) throw new Error(`${key}: worker must not write derived legacy fields`);
  const unknown = Object.keys(item).find(field => !RESULT_FIELDS.has(field));
  if (unknown) throw new Error(`${key}: unsupported result field ${unknown}`);
  if (item.status !== undefined && item.status !== 'EVALUATED') throw new Error(`${key}: invalid evaluated result`);
  requireQuote(item.level_evidence, jdText, `${key}: level_evidence`);
  if (item.eligibility_status === 'eligible') {
    if (item.eligibility_category !== null || item.eligibility_evidence !== null) throw new Error(`${key}: eligible result must not carry eligibility category/evidence`);
  } else {
    if (!ELIGIBILITY_CATEGORIES.has(item.eligibility_category)) throw new Error(`${key}: invalid eligibility_category`);
    requireQuote(item.eligibility_evidence, jdText, `${key}: eligibility_evidence`);
  }

  const fitScore = item.level_signal === 'staff_equivalent' ? Math.min(fit, 3.5) : fit;
  const hardExclusion = item.eligibility_status === 'ineligible';
  const score = hardExclusion ? Math.min(fitScore, 3.5) : fitScore;
  const reportAllowed = score >= threshold && !hardExclusion && item.level_signal !== 'staff_equivalent';
  if (reportAllowed ? !item.report || typeof item.report !== 'object' || Array.isArray(item.report) : item.report !== null) {
    throw new Error(`${key}: report payload must exist exactly for report candidates`);
  }
  const rationale = reportAllowed ? null : item.rationale;
  if (!reportAllowed && (typeof rationale !== 'string' || !rationale.trim() || /[\r\n]/.test(rationale) || [...rationale].length > 150)) {
    throw new Error(`${key}: non-candidate result requires a single-line rationale of at most 150 characters`);
  }
  return {
    ...item, fit_score: fitScore, score,
    hard_exclusion: hardExclusion,
    hard_exclusion_evidence: hardExclusion ? item.eligibility_evidence : null,
    rationale, report_allowed: reportAllowed,
    report_decision: !reportAllowed ? 'Skip' : item.eligibility_status === 'needs_verification' ? 'Research first'
      : item.legitimacy_tier === 'High Confidence' ? 'Apply' : 'Consider',
  };
}
