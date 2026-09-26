const UNKNOWN_VALUES = new Set(['', 'unknown', 'unspecified', 'not specified', 'n/a', 'none', 'null']);

const INELIGIBLE_TYPES = [
  ['independent-contractor', /\bindependent[\s-]+contractor\b|\b1099\b/i],
  ['freelance', /\bfreelanc(?:e|er)\b/i],
  ['contract', /\bcontract(?:or)?s?\b/i],
  ['temporary', /\btemporar(?:y|ily)\b|\btemp\b/i],
  ['seasonal', /\bseasonal\b/i],
  ['internship', /\bintern(?:ship)?\b/i],
  ['part-time', /\bpart[\s-]*time\b/i],
  ['volunteer', /^volunteer(?:ing)?$/i],
];

const clean = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const FULL_TIME = /\bfull[\s-]*time\b|\bpermanent(?:\s+employee)?\b/i;
const AMBIGUOUS = /\b(?:temp|contract)[\s-]*to[\s-]*hire\b/i;

export function employmentTypeValues(value) {
  const input = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const values = [];
  for (const item of input) {
    const normalized = clean(item);
    if (UNKNOWN_VALUES.has(normalized.toLowerCase()) || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    values.push(normalized);
  }
  return values;
}

export function employmentTypeDisplay(value) {
  const values = employmentTypeValues(value);
  return values.length ? values.join(' | ') : 'unknown';
}

export function employmentTypeDecision(value) {
  const employmentTypes = employmentTypeValues(value);
  let excluded = null;
  let hasFullTime = false;
  let ambiguous = false;
  for (const employmentType of employmentTypes) {
    const segments = employmentType.split(/[|/]/).map(clean).filter(Boolean);
    const match = INELIGIBLE_TYPES.find(([, pattern]) => segments.some(item => pattern.test(item)));
    hasFullTime ||= segments.some(item => FULL_TIME.test(item));
    ambiguous ||= AMBIGUOUS.test(employmentType);
    if (!excluded && match) excluded = { category: match[0], employment_type: employmentType };
  }
  if (ambiguous || (excluded && hasFullTime)) {
    return { status: 'needs_verification', category: 'employment_type', employment_type: employmentTypes.join(' | ') };
  }
  return excluded ? { status: 'ineligible', ...excluded } : { status: 'eligible', category: null, employment_type: null };
}
