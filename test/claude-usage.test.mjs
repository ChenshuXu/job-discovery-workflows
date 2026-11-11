import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureClaudeUsageScope, collectClaudeUsage } from '../src/claude-usage.mjs';

const session = '11111111-2222-4333-8444-555555555555';
const agent = 'aea523df2326203c6';
const scope = { host: 'claude', coordinator_thread_id: session, session_id: session, root_turn_id: session };
const usage = ({ input = 2, read = 100, write = 10, output = 20, thinking = 5 } = {}) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output, output_tokens_details: { thinking_tokens: thinking } });
const assistant = (id, { second = 1, stop = 'end_turn', model = 'claude-opus-5-5', tokens = usage() } = {}) => ({ type: 'assistant', timestamp: `2026-11-03T22:00:${String(second).padStart(2, '0')}.000Z`, message: { id, model, stop_reason: stop, usage: tokens, content: [{ type: 'text', text: 'PRIVATE_CONTENT' }] } });

function fixture(t, { main = [], workers = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-usage-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, '-project');
  mkdirSync(path.join(project, session, 'subagents'), { recursive: true });
  writeFileSync(path.join(project, `${session}.jsonl`), main.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'));
  for (const [id, value] of Object.entries(workers)) {
    const base = path.join(project, session, 'subagents', `agent-${id}`);
    writeFileSync(`${base}.jsonl`, value.records.map(item => JSON.stringify(item)).join('\n'));
    if (value.meta) writeFileSync(`${base}.meta.json`, JSON.stringify(value.meta));
  }
  return root;
}

test('captures the coordinator session and reports a missing session id', () => {
  assert.equal(captureClaudeUsageScope({ sessionId: session }).status, 'complete');
  assert.equal(captureClaudeUsageScope({ sessionId: session }).root_turn_id, session);
  assert.equal(captureClaudeUsageScope({ sessionId: session }).host, 'claude');
  const missing = captureClaudeUsageScope({ sessionId: '' });
  assert.equal(missing.status, 'unavailable');
  assert.deepEqual(missing.issues, ['current_session_id_unavailable']);
});

test('counts a streamed message once, maps cache fields and keeps workers separate', t => {
  const first = assistant('msg-1', { stop: 'tool_use' });
  const sessionsDir = fixture(t, {
    main: [{ type: 'user', timestamp: '2026-11-03T22:00:00.000Z', message: { content: 'PRIVATE_CONTENT' } }, first, first, assistant('msg-2', { second: 3 })],
    workers: { [agent]: { meta: { model: 'opus', effort: 'high' }, records: [assistant('msg-3', { second: 2 })] } },
  });
  const value = collectClaudeUsage({ scope, threadIds: [session, agent], sessionsDir, now: '2026-11-03T22:01:00.000Z' });
  assert.equal(value.status, 'complete');
  const [coordinator, worker] = value.threads;
  assert.deepEqual(coordinator.tokens, { input_tokens: 224, cached_input_tokens: 200, cache_write_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 264, uncached_input_tokens: 24 });
  assert.equal(coordinator.response_count, 2);
  assert.equal(coordinator.started_at, '2026-11-03T22:00:00.000Z');
  assert.equal(coordinator.completed_at, '2026-11-03T22:00:03.000Z');
  assert.equal(coordinator.wall_ms, 3000);
  assert.equal(worker.thread_id, agent);
  assert.equal(worker.parent_thread_id, session);
  assert.equal(worker.tokens.total_tokens, 132);
  assert.equal(worker.observed_settings[0].model, 'claude-opus-5-5');
  assert.equal(worker.observed_settings[0].reasoning_effort, 'high');
  assert.equal(JSON.stringify(value).includes('PRIVATE_CONTENT'), false);
});

test('an active last turn stays partial and never reports a completion time', t => {
  const sessionsDir = fixture(t, { main: [assistant('msg-1', { stop: 'tool_use' })] });
  const [thread] = collectClaudeUsage({ scope, threadIds: [session], sessionsDir, now: '2026-11-03T22:01:00.000Z' }).threads;
  assert.equal(thread.status, 'partial');
  assert.deepEqual(thread.issues, ['active_or_incomplete_turn']);
  assert.equal(thread.completed_at, null);
  assert.equal(thread.wall_ms, 59000);
});

test('missing or broken evidence is reported instead of counted as zero', t => {
  const sessionsDir = fixture(t, {
    main: [assistant('msg-1'), '{"type":"assistant"', assistant('msg-2', { tokens: { input_tokens: 'bad' } }), assistant('msg-3', { model: '<synthetic>', tokens: usage({ input: 0, read: 0, write: 0, output: 0, thinking: 0 }) })],
    workers: { [agent]: { records: [assistant('msg-4', { tokens: { ...usage(), output_tokens_details: undefined } })] } },
  });
  const value = collectClaudeUsage({ scope, threadIds: [session, agent, 'aaaaaaaaaaaaaaaaa'], sessionsDir, now: '2026-11-03T22:01:00.000Z' });
  assert.equal(value.status, 'partial');
  assert.deepEqual(value.threads[0].issues, ['malformed_event', 'invalid_token_usage']);
  assert.equal(value.threads[0].response_count, 1);
  assert.deepEqual(value.threads[1].issues, ['reasoning_tokens_unavailable', 'agent_metadata_missing']);
  assert.deepEqual(value.threads[2].issues, ['session_file_missing']);
  assert.equal(value.threads[2].tokens, null);
});

test('rejects a scope without a session and an unsafe id', t => {
  const sessionsDir = fixture(t, { main: [assistant('msg-1')] });
  assert.deepEqual(collectClaudeUsage({ scope: { ...scope, session_id: null }, sessionsDir }).issues, ['usage_scope_unavailable']);
  assert.deepEqual(collectClaudeUsage({ scope, threadIds: ['../escape'], sessionsDir }).issues, ['invalid_thread_id']);
});

test('a refresh after the final reply upgrades the same session to complete', t => {
  const sessionsDir = fixture(t, { main: [assistant('msg-1', { stop: 'tool_use' })] });
  const options = { scope, threadIds: [session], sessionsDir, now: '2026-11-03T22:01:00.000Z' };
  assert.equal(collectClaudeUsage(options).status, 'partial');
  appendFileSync(path.join(sessionsDir, '-project', `${session}.jsonl`), `\n${JSON.stringify(assistant('msg-2', { second: 9 }))}`);
  assert.equal(collectClaudeUsage(options).status, 'complete');
});
