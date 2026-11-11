import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticIdentity } from '../src/semantic-jd-identity.mjs';

const markdown = body => `# Header\n\n**Company:** Acme\n\n## Job Description\n\n${body}\n`;
const record = overrides => ({
  company: 'Acme', employment_type: 'Full-time', workplace_type: 'remote',
  location_scope: { decision: 'ALLOW_REMOTE_US' }, ...overrides,
});

test('semantic identity ignores representation-only Markdown differences', () => {
  const left = semanticIdentity({ record: record(), markdown: markdown('- Build APIs\n  - Own reliability') });
  const right = semanticIdentity({ record: record(), markdown: markdown('* BUILD APIs\n* Own   reliability') });
  assert.deepEqual(left, right);
});

test('semantic identity keeps employer, body, and context boundaries', () => {
  const base = semanticIdentity({ record: record(), markdown: markdown('Build APIs') });
  assert.notEqual(base.semantic_job_key, semanticIdentity({ record: record({ company: 'Other' }), markdown: markdown('Build APIs') }).semantic_job_key);
  assert.notEqual(base.semantic_job_key, semanticIdentity({ record: record(), markdown: markdown('Build data pipelines') }).semantic_job_key);
  assert.notEqual(base.posting_context_key, semanticIdentity({ record: record({ workplace_type: 'hybrid' }), markdown: markdown('Build APIs') }).posting_context_key);
  const arrayContext = semanticIdentity({ record: record({ employment_types: ['Full-time', 'Contract'] }), markdown: markdown('Build APIs') });
  const displayContext = semanticIdentity({ record: record({ employment_type: 'Full-Time / Contract', employment_types: [] }), markdown: markdown('Build APIs') });
  assert.equal(arrayContext.posting_context_key, displayContext.posting_context_key);
});

test('the context key holds only its own fields, and an older nested key still pairs the same', async () => {
  const { semanticPair } = await import('../src/semantic-jd-identity.mjs');
  const body = 'Build reliable payment APIs for merchants worldwide.';
  const identity = semanticIdentity({ record: record(), markdown: markdown(body) });
  assert.equal(identity.posting_context_key.includes('payment apis'), false, 'the JD body is stored once, in the job key');
  // Runs planned before this change nest the job key inside the context key.
  const [, employment, workplace, location] = JSON.parse(identity.posting_context_key);
  const older = { semantic_job_key: identity.semantic_job_key, posting_context_key: JSON.stringify([2, identity.semantic_job_key, employment, workplace, location]) };
  assert.equal(semanticPair(older), semanticPair(identity));
  const otherJob = semanticIdentity({ record: record(), markdown: markdown('Build data pipelines.') });
  assert.notEqual(semanticPair(otherJob), semanticPair(identity));
  const otherContext = semanticIdentity({ record: record({ workplace_type: 'hybrid' }), markdown: markdown(body) });
  assert.notEqual(semanticPair(otherContext), semanticPair(identity));
});
