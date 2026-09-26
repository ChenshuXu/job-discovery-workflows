import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateLocationScope, loadLocationPolicy } from '../src/location-scope.mjs';

const POLICY = {
  local_metros: ['Seattle', 'Bellevue', 'Redmond', 'Kirkland', 'Bothell', 'Renton', 'Issaquah', 'SeaTac', 'Tacoma', 'Everett'],
  remote_country: 'United States',
  require_structured_remote: true,
  ambiguous_action: 'exclude',
};

const evaluate = (location, workplaceType = 'unknown', structuredRemoteSignal = false) => evaluateLocationScope({
  location,
  locations: [location],
  workplace_type: workplaceType,
  workplace_type_source: 'fixture',
  structured_remote_signal: structuredRemoteSignal,
}, POLICY);

test('profile location policy parses exact approved metros and fail-closed remote rule', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'location-policy-'));
  const file = path.join(root, 'profile.yml');
  writeFileSync(file, `location:\n  scan_policy: ${JSON.stringify(POLICY)}\n`);
  assert.deepEqual(loadLocationPolicy(file), POLICY);
});

test('approved Seattle metro locations pass without requiring Remote', () => {
  for (const city of POLICY.local_metros) {
    const result = evaluate(`${city}, WA`, city === 'Seattle' ? 'onsite' : 'unknown');
    assert.equal(result.decision, 'ALLOW_LOCAL', city);
    assert.equal(result.allowed, true, city);
  }
  assert.equal(evaluate('Redmond, OR').decision, 'EXCLUDE_NONLOCAL');
  assert.equal(evaluate('Bellevue, NE').decision, 'EXCLUDE_NONLOCAL');
});

test('only structured United States Remote passes the remote gate', () => {
  assert.equal(evaluate('United States', 'remote', true).decision, 'ALLOW_REMOTE_US');
  assert.equal(evaluate('Remote', 'remote', true).decision, 'ALLOW_REMOTE_US');
  assert.equal(evaluate('Remote, United States', 'remote', true).decision, 'ALLOW_REMOTE_US');
  assert.equal(evaluate('United States of America', 'remote', true).decision, 'ALLOW_REMOTE_US');
  assert.equal(evaluate('United States', 'remote').decision, 'AMBIGUOUS_UNSTRUCTURED_REMOTE_SIGNAL');
  assert.equal(evaluate('United States').decision, 'AMBIGUOUS_NO_REMOTE_SIGNAL');
  assert.equal(evaluate('Remote').decision, 'AMBIGUOUS_NO_REMOTE_SIGNAL');
  assert.equal(evaluate('San Francisco, CA', 'remote', true).decision, 'AMBIGUOUS_REMOTE_GEOGRAPHY');
});

test('cities outside the approved metros are deterministic nonlocal exclusions', () => {
  for (const location of ['New York, NY', 'San Francisco, CA', 'Sunnyvale, CA']) {
    const result = evaluate(location);
    assert.equal(result.decision, 'EXCLUDE_NONLOCAL', location);
    assert.equal(result.allowed, false, location);
  }
});

test('missing and conflicting location evidence fail closed', () => {
  assert.equal(evaluateLocationScope({ workplace_type: 'unknown' }, POLICY).decision, 'AMBIGUOUS_MISSING_LOCATION');
  assert.equal(evaluate('United States', 'conflict').decision, 'AMBIGUOUS_WORKPLACE_CONFLICT');
});
