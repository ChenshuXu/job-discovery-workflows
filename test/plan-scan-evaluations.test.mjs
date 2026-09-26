import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDailyScanRuntime } from '../src/daily-scan-runtime.mjs';
import { assignKeys, interleaveBySource } from '../src/plan-scan-evaluations.mjs';

const sources = ['ashby', 'generic', 'greenhouse', 'linkedin', 'workday'];

test('source interleaving is deterministic and preserves every key', () => {
  const keys = sources.flatMap(source => [1, 2, 3].map(index => `${source}:tenant:${index}`));
  const first = interleaveBySource(keys);
  assert.deepEqual(first, interleaveBySource(keys));
  assert.deepEqual([...first].sort(), [...keys].sort());
  assert.deepEqual(first.slice(0, 5).map(key => key.split(':')[0]), sources);
});

test('planner changes only each worker internal order, not cross-worker ownership', () => {
  const keys = sources.flatMap(source => Array.from({ length: 6 }, (_, index) => `${source}:tenant:${index + 1}`)).sort();
  const workerCount = loadDailyScanRuntime().scheduler.max_active_workers;
  const baseline = Object.fromEntries(Array.from({ length: workerCount }, (_, index) => [`worker-${index + 1}`, []]));
  keys.forEach((key, index) => baseline[`worker-${(index % workerCount) + 1}`].push(key));
  const planned = assignKeys(keys, workerCount);
  for (const worker of Object.keys(baseline)) {
    assert.deepEqual([...planned[worker]].sort(), [...baseline[worker]].sort());
    assert.ok(new Set(planned[worker].slice(0, 5).map(key => key.split(':')[0])).size > 1, `${worker} should interleave sources`);
  }
});

test('planner derives assignment IDs and ownership from the configured worker count', () => {
  assert.deepEqual(assignKeys(['a:1', 'b:2', 'c:3'], 2), {
    'worker-1': ['a:1', 'c:3'],
    'worker-2': ['b:2'],
  });
  assert.throws(() => assignKeys(['a:1'], 0), /max_active_workers/);
});
