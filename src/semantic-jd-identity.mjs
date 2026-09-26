import { createHash } from 'node:crypto';
import { employmentTypeValues } from './employment-type.mjs';
import { normalizeWorkplaceType } from './location-scope.mjs';

export const SEMANTIC_JD_NORMALIZER_VERSION = 1;

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  return sha256(`v1\0${employer}\0${normalizeJobDescriptionBody(markdown)}`);
}

function postingContextKey({ semantic_job_key, employment_types, employment_type, workplace_type, location_decision }) {
  if (!semantic_job_key) throw new Error('posting context requires semantic_job_key');
  const employment = [...new Set(employmentTypeValues(employment_types?.length ? employment_types : employment_type)
    .flatMap(value => value.split(/[|/]/))
    .map(normalizeField)
    .filter(Boolean))]
    .sort()
    .join('|') || 'unknown';
  const workplace = normalizeWorkplaceType(workplace_type);
  const location = String(location_decision ?? 'unknown').trim() || 'unknown';
  return sha256(`v1\0${semantic_job_key}\0${employment}\0${workplace}\0${location}`);
}

export function semanticIdentity({ record, markdown, locationDecision = record?.location_scope?.decision }) {
  const semantic_job_key = semanticJobKey({ company: record?.company, markdown });
  return {
    normalizer_version: SEMANTIC_JD_NORMALIZER_VERSION,
    semantic_job_key,
    posting_context_key: postingContextKey({
      semantic_job_key,
      employment_types: record?.employment_types,
      employment_type: record?.employment_type,
      workplace_type: record?.workplace_type,
      location_decision: locationDecision,
    }),
  };
}
