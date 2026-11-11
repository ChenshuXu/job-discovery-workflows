import { employmentTypeValues } from './employment-type.mjs';
import { normalizeWorkplaceType } from './location-scope.mjs';

export const SEMANTIC_JD_NORMALIZER_VERSION = 3;

const normalizeField = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function extractJobDescriptionBody(markdown) {
  const match = String(markdown ?? '').replace(/\r\n?/g, '\n').match(/^## Job Description\s*\n([\s\S]+)$/m);
  if (!match?.[1]?.trim()) throw new Error('JD is missing a non-empty ## Job Description body');
  return match[1];
}

function normalizeJobDescriptionBody(markdown) {
  return extractJobDescriptionBody(markdown)
    .normalize('NFKC')
    .toLowerCase()
    .split('\n')
    .map(line => line.replace(/^\s*(?:(?:[-+*•]|\d+[.)])\s+)?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function semanticJobKey({ company, markdown }) {
  const employer = normalizeField(company);
  if (!employer) throw new Error('semantic identity requires company');
  return JSON.stringify([2, employer, normalizeJobDescriptionBody(markdown)]);
}

// The context key carries only employment, workplace and location; the job key already
// holds the JD body, and identities are always compared as a (job, context) pair.
function postingContextKey({ employment_types, employment_type, workplace_type, location_decision }) {
  const employment = [...new Set(employmentTypeValues(employment_types?.length ? employment_types : employment_type)
    .flatMap(value => value.split(/[|/]/))
    .map(normalizeField)
    .filter(Boolean))]
    .sort()
    .join('|') || 'unknown';
  const workplace = normalizeWorkplaceType(workplace_type);
  const location = String(location_decision ?? 'unknown').trim() || 'unknown';
  return JSON.stringify([3, employment, workplace, location]);
}

/** One comparable string for a (job, context) pair. Version-2 context keys nested the job key. */
export function semanticPair(identity) {
  let context = identity?.posting_context_key ?? '';
  try {
    const parsed = JSON.parse(context);
    if (Array.isArray(parsed) && parsed[0] === 2) context = JSON.stringify([3, ...parsed.slice(2)]);
  } catch {}
  return `${identity?.semantic_job_key ?? ''}\0${context}`;
}

export function semanticIdentity({ record, markdown, locationDecision = record?.location_scope?.decision }) {
  const semantic_job_key = semanticJobKey({ company: record?.company, markdown });
  return {
    normalizer_version: SEMANTIC_JD_NORMALIZER_VERSION,
    semantic_job_key,
    posting_context_key: postingContextKey({
      employment_types: record?.employment_types,
      employment_type: record?.employment_type,
      workplace_type: record?.workplace_type,
      location_decision: locationDecision,
    }),
  };
}
