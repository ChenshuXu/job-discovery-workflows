import test from 'node:test';
import assert from 'node:assert/strict';
import { employmentTypeDisplay, employmentTypeValues } from '../src/employment-type.mjs';

test('employment type metadata preserves distinct source values', () => {
  assert.deepEqual(employmentTypeValues(['Contract', 'contract', 'Full-time', 'unknown']), ['Contract', 'Full-time']);
  assert.equal(employmentTypeDisplay(['Contract', 'Full-time']), 'Contract | Full-time');
  assert.equal(employmentTypeDisplay([]), 'unknown');
});
