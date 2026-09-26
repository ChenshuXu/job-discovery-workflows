import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCalibration } from '../linkedin-post-scan/src/query-plan.mjs';

const config = {
  phrase_groups: { P1: ['Hiring'], P2: ['Careers'] },
  role_groups: { BACKEND: ['Backend Engineer'] },
  location_groups: { SEATTLE: { query: 'Seattle' } },
  search: { default_strategy: 'combined', p1_phrase_groups: ['P1'], run_limit_minutes: 45, priority_hours: { P1: 24, P2: 48 } },
  schedule_reference: { times: ['12:30', '17:00', '21:00'] },
};
const captures = [{ sample_key: 'sample', variant: 'combined', post_ids: ['1'], actionable_post_ids: ['1'],
  elapsed_ms: 1000, deep_check_count: 1, deep_check_elapsed_ms_total: 1000, result_count: 1 }];

test('calibration uses the cyclic schedule gap only when one run covers every query', () => {
  const covered = summarizeCalibration(config, captures);
  assert.equal(covered.p1_max_gap_hours, 15.5);
  assert.equal(covered.p2_max_gap_hours, 15.5);
  assert.equal(covered.budget_complete, true);

  const pending = summarizeCalibration({ ...config, search: { ...config.search, run_limit_minutes: 0.0001 } }, captures);
  assert.equal(pending.schedule_coverage_complete, false);
  assert.equal(pending.budget_complete, false);
});
