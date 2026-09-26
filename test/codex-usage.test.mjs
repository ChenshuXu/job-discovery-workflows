import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureCodexUsageScope, collectCodexUsage } from '../src/codex-usage.mjs';

const root = 'run-turn';
const scope = { coordinator_thread_id: 'main', session_id: 'main', root_turn_id: root };
const event = (type, payload, second = 0) => ({ timestamp: `2026-09-07T12:00:${String(second).padStart(2, '0')}.000Z`, type, payload });
const meta = id => event('session_meta', { id, session_id: 'main', ...(id === 'main' ? {} : { parent_thread_id: 'main' }), base_instructions: 'PRIVATE_CONTENT' });
const context = (turn = root, effort = 'low', model = 'gpt-model') => event('turn_context', { turn_id: turn, root_turn_id: turn === 'prior-turn' ? turn : root, model, effort });
const start = (turn = root) => event('event_msg', { type: 'task_started', turn_id: turn });
const complete = (turn = root) => event('event_msg', { type: 'task_complete', turn_id: turn, duration_ms: 2000, last_agent_message: 'PRIVATE_CONTENT' }, 2);
const tokens = (input = 100) => ({ input_tokens: input, cached_input_tokens: input / 2, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: input + 20 });
const usage = (response = 'response-1', { id = 'main', turn = root, input = 100, cumulative = tokens(input), second = 1 } = {}) => event('token_usage_record', { thread_id: id, session_id: 'main', root_turn_id: turn === 'prior-turn' ? turn : root, turn_id: turn, response_id: response, usage: tokens(input), turn_token_usage: cumulative }, second);

function fixture(t, records) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-usage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [id, events] of Object.entries(records)) writeFileSync(path.join(dir, `rollout-date-${id}.jsonl`), events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + (typeof events.at(-1) === 'string' ? '' : '\n'));
  return dir;
}

test('sums response usage once, excludes unrelated turns and duplicate legacy events, separates workers', t => {
  const current = usage();
  const sessionsDir = fixture(t, {
    main: [meta('main'), start('prior-turn'), context('prior-turn'), usage('old', { turn: 'prior-turn' }), complete('prior-turn'), start(), context(), current, current, event('event_msg', { type: 'token_count', info: { total_token_usage: tokens(9999) } }), complete()],
    worker: [meta('worker'), start('worker-turn'), context('worker-turn'), usage('worker-response', { id: 'worker', turn: 'worker-turn' }), complete('worker-turn')],
  });
  const result = collectCodexUsage({ scope, threadIds: ['worker'], sessionsDir });
  assert.equal(result.status, 'complete');
  assert.equal(result.tokens.total_tokens, 240);
  assert.equal(result.tokens.uncached_input_tokens, 100);
  assert.equal(result.tokens.reasoning_output_tokens, 10);
  assert.equal(result.wall_ms, 2000);
  assert.equal(result.threads[0].response_count, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONTENT'), false);
});

test('captures explicit historical scope and latest active or completed turn without borrowing prior root', t => {
  const sessionsDir = fixture(t, { main: [meta('main'), start('prior-turn'), context('prior-turn'), complete('prior-turn'), start(), context(), usage()] });
  const active = captureCodexUsageScope({ sessionsDir, threadId: 'main' });
  assert.equal(active.root_turn_id, root);
  assert.equal(captureCodexUsageScope({ sessionsDir, threadId: 'main', rootTurnId: 'prior-turn' }).root_turn_id, 'prior-turn');
  assert.equal(captureCodexUsageScope({ sessionsDir, threadId: 'main', rootTurnId: 'missing' }).status, 'unavailable');
  const result = collectCodexUsage({ scope: active, sessionsDir, now: '2026-09-07T12:00:03Z' });
  assert.equal(result.status, 'partial');
  assert.equal(result.completed_at, null);
  assert.equal(result.wall_ms, 3000);
  assert.ok(result.threads[0].issues.includes('active_or_incomplete_turn'));
});

test('an explicitly selected child coordinator is not replaced with its shared root session', t => {
  const sessionsDir = fixture(t, {
    worker: [meta('worker'), start('worker-turn'), context('worker-turn'), usage('worker-response', { id: 'worker', turn: 'worker-turn' }), complete('worker-turn')],
  });
  const childScope = captureCodexUsageScope({ sessionsDir, threadId: 'worker' });
  assert.equal(childScope.coordinator_thread_id, 'worker');
  assert.equal(childScope.session_id, 'main');
  const result = collectCodexUsage({ scope: childScope, sessionsDir });
  assert.equal(result.status, 'complete');
  assert.equal(result.tokens.total_tokens, 120);
  assert.equal(result.threads.length, 1);
});

test('attributes model and effort changes to observed response records', t => {
  const cumulative = { input_tokens: 300, cached_input_tokens: 150, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 340 };
  const changed = context(root, 'high', 'gpt-other');
  changed.timestamp = '2026-09-07T12:00:01.500Z';
  const sessionsDir = fixture(t, { main: [meta('main'), start(), context(), usage(), changed, usage('response-2', { input: 200, cumulative, second: 2 }), complete()] });
  const result = collectCodexUsage({ scope, sessionsDir });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.threads[0].observed_settings.map(value => [value.model, value.reasoning_effort, value.tokens.total_tokens]), [['gpt-model', 'low', 120], ['gpt-other', 'high', 220]]);
});

test('conflicting duplicate, reset and truncated tail report partial rather than authoritative totals', t => {
  const sessionsDir = fixture(t, { main: [meta('main'), start(), context(), usage(), usage('response-1', { input: 200 }), usage('response-2', { input: 20, second: 2 }), complete(), '{"type":'] });
  const result = collectCodexUsage({ scope, sessionsDir });
  assert.equal(result.status, 'partial');
  assert.equal(result.tokens.total_tokens, 160);
  for (const issue of ['conflicting_response_usage', 'turn_cumulative_reset', 'turn_cumulative_mismatch', 'truncated_tail']) assert.ok(result.threads[0].issues.includes(issue), issue);
});

test('missing usage is unavailable, missing child is partial, and optional zero reasoning is valid', t => {
  const noReasoning = usage();
  delete noReasoning.payload.usage.reasoning_output_tokens;
  delete noReasoning.payload.turn_token_usage.reasoning_output_tokens;
  const sessionsDir = fixture(t, { main: [meta('main'), start(), context(), noReasoning, complete()], empty: [meta('empty')] });
  const result = collectCodexUsage({ scope, threadIds: ['missing'], sessionsDir });
  assert.equal(result.status, 'partial');
  assert.equal(result.tokens.reasoning_output_tokens, 0);
  assert.equal(result.threads[1].tokens, null);
  assert.equal(collectCodexUsage({ scope: { ...scope, root_turn_id: 'absent' }, sessionsDir }).status, 'unavailable');
  assert.equal(captureCodexUsageScope({ sessionsDir, threadId: '' }).status, 'unavailable');
});

test('a resumed active turn cannot reuse an earlier completion marker', t => {
  const resumed = start();
  resumed.timestamp = '2026-09-07T12:00:03.000Z';
  const sessionsDir = fixture(t, { main: [meta('main'), start(), context(), usage(), complete(), resumed] });
  const result = collectCodexUsage({ scope, sessionsDir, now: '2026-09-07T12:00:04Z' });
  assert.equal(result.status, 'partial');
  assert.equal(result.completed_at, null);
  assert.equal(result.wall_ms, 4000);
});

test('replayed identical lifecycle events preserve exact final duration', t => {
  const finished = complete();
  finished.payload.duration_ms = 1997;
  const events = [meta('main'), start(), context(), usage(), finished];
  const sessionsDir = fixture(t, { main: [...events, ...events] });
  const result = collectCodexUsage({ scope, sessionsDir });
  assert.equal(result.status, 'complete');
  assert.equal(result.wall_ms, 1997);
  assert.equal(result.tokens.total_tokens, 120);
});

test('persisted ordinals preserve model attribution when wall timestamps go backward', t => {
  const cumulative = { input_tokens: 300, cached_input_tokens: 150, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 340 };
  const events = [meta('main'), start(), context(), usage(), context(root, 'high', 'gpt-other'), usage('response-2', { input: 200, cumulative, second: 2 }), complete()];
  events.forEach((item, ordinal) => { item.ordinal = ordinal; });
  events[4].timestamp = '2026-09-07T12:00:00.500Z';
  const sessionsDir = fixture(t, { main: events });
  const result = collectCodexUsage({ scope, sessionsDir });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.threads[0].observed_settings.map(item => [item.model, item.tokens.total_tokens]), [['gpt-model', 120], ['gpt-other', 220]]);
});

test('missing cache metrics and mismatched bound children cannot become complete zero-usage workers', t => {
  const missingCache = usage('child-response', { id: 'worker', turn: 'worker-turn' });
  delete missingCache.payload.usage.cached_input_tokens;
  const foreign = meta('foreign');
  foreign.payload.session_id = 'another-session';
  const sessionsDir = fixture(t, {
    main: [meta('main'), start(), context(), usage(), complete()],
    worker: [meta('worker'), start('worker-turn'), context('worker-turn'), missingCache, complete('worker-turn')],
    foreign: [foreign, start(), context(), usage('foreign-response', { id: 'foreign' }), complete()],
    unrelated: [meta('unrelated'), start('prior-turn'), context('prior-turn'), usage('old', { id: 'unrelated', turn: 'prior-turn' }), complete('prior-turn')],
  });
  const result = collectCodexUsage({ scope, sessionsDir, threadIds: ['worker', 'foreign', 'unrelated'] });
  assert.equal(result.status, 'partial');
  assert.equal(result.tokens.total_tokens, 120);
  for (const thread of result.threads.slice(1)) assert.equal(thread.tokens, null);
  assert.ok(result.threads[1].issues.includes('invalid_token_usage'));
  assert.ok(result.threads[2].issues.includes('session_id_mismatch'));
  assert.ok(result.threads[3].issues.includes('token_usage_unavailable_for_root_turn'));
});
