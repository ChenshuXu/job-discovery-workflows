import test from 'node:test';
import assert from 'node:assert/strict';
import { employmentTypeDecision, employmentTypeDisplay, employmentTypeValues } from '../src/employment-type.mjs';

test('employment type metadata preserves distinct source values', () => {
  assert.deepEqual(employmentTypeValues(['Contract', 'contract', 'Full-time', 'unknown']), ['Contract', 'Full-time']);
  assert.equal(employmentTypeDisplay(['Contract', 'Full-time']), 'Contract | Full-time');
  assert.equal(employmentTypeDisplay([]), 'unknown');
});

test('explicit non-full-time classifications are ineligible', () => {
  for (const value of ['Contract', 'Hourly contract', 'Freelance', 'Independent Contractor / 1099', 'Temporary', 'Seasonal', 'Internship', 'Part-time', 'Volunteer']) {
    assert.equal(employmentTypeDecision(value).status, 'ineligible', `${value} must be ineligible`);
  }
});

test('unknown and permanent full-time classifications are not excluded', () => {
  for (const value of ['unknown', 'Full-time', 'Permanent employee', 'Volunteer experience']) assert.equal(employmentTypeDecision(value).status, 'eligible');
});

test('compound full-time classifications require verification instead of exclusion', () => {
  for (const value of ['Full-Time / Contract', 'Full-Time | Part-Time', ['Full-time', 'Contract'], 'Temp-to-hire']) {
    assert.equal(employmentTypeDecision(value).status, 'needs_verification');
  }
  assert.equal(employmentTypeDecision('Independent Contractor / 1099').status, 'ineligible');
});
