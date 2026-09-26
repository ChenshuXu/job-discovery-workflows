import test from 'node:test';
import assert from 'node:assert/strict';
import { postingRequisition } from '../src/posting-identity.mjs';

// Career-Ops MIT-licensed note grammar; see THIRD_PARTY_NOTICES.md. Live acceptance is separate.
const regex = /\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/i;

test('rendered job-id note form matches the pinned Career-Ops note grammar', () => {
  for (const key of ['greenhouse:acme:123456', 'linkedin:linkedin.com:4448051338', 'workday:tenant/site:JR2022556']) {
    assert.match(`Daily Scan evaluation; job id ${postingRequisition(key)};`, regex);
  }
});
