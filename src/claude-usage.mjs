import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Claude Code keeps one transcript per session and one per subagent, so the session is
// the measured scope: a scheduled scan owns its session, and a resume adds another one.
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'uncached_input_tokens'];
const EMPTY_TOKENS = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
const projectsDefault = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
const iso = value => new Date(value ?? Date.now()).toISOString();
const add = (target, value) => { for (const key of FIELDS) target[key] += value[key]; };
const count = value => Number.isSafeInteger(value) && value >= 0;

export function captureClaudeUsageScope({ sessionId = process.env.CLAUDE_CODE_SESSION_ID, now } = {}) {
  const base = { host: 'claude', status: 'unavailable', coordinator_thread_id: sessionId || null, session_id: sessionId || null, root_turn_id: sessionId || null, captured_at: iso(now), selection: null, issues: [] };
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return { ...base, coordinator_thread_id: null, session_id: null, root_turn_id: null, issues: ['current_session_id_unavailable'] };
  return { ...base, status: 'complete', selection: 'claude_session' };
}

function sessionDirectory(projectsDir, sessionId) {
  let names;
  try { names = readdirSync(projectsDir); }
  catch { return null; }
  const name = names.find(item => existsSync(path.join(projectsDir, item, `${sessionId}.jsonl`)));
  return name ? path.join(projectsDir, name) : null;
}

// Claude reports the three input classes separately; the shared shape counts cache reads
// and writes as part of input, and thinking as part of output.
function tokensFrom(usage) {
  const { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } = usage ?? {};
  if (![input, read, write, output].every(count)) return null;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  const inputTotal = input + read + write;
  return {
    input_tokens: inputTotal, cached_input_tokens: read, cache_write_input_tokens: write, output_tokens: output,
    reasoning_output_tokens: count(thinking) ? thinking : 0, total_tokens: inputTotal + output, uncached_input_tokens: inputTotal - read,
    reasoning_known: count(thinking),
  };
}

function collectThread(threadId, file, { parent, effort, metadataMissing, now }) {
  const issues = [];
  const result = { thread_id: threadId, parent_thread_id: parent, status: 'unavailable', observed_settings: [], tokens: null, started_at: null, completed_at: null, wall_ms: null, response_count: 0, source_files: [], issues };
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch { issues.push('session_file_missing'); return result; }
  result.source_files.push(path.basename(file));
  const responses = new Map();
  let lastAssistant = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { issues.push('malformed_event'); continue; }
    if (event.timestamp && !result.started_at) result.started_at = event.timestamp;
    const message = event.message;
    if (event.type !== 'assistant' || !message || message.model === '<synthetic>') continue;
    lastAssistant = event;
    const tokens = tokensFrom(message.usage);
    if (!tokens) { issues.push('invalid_token_usage'); continue; }
    if (!message.id) { issues.push('usage_identity_invalid'); continue; }
    // A message with several content blocks is written once per block with the same usage.
    const record = { tokens, model: message.model ?? null };
    if (responses.has(message.id)) {
      if (JSON.stringify(responses.get(message.id)) !== JSON.stringify(record)) issues.push('conflicting_response_usage');
      continue;
    }
    responses.set(message.id, record);
  }
  if (!responses.size) { issues.push('token_usage_unavailable_for_session'); result.issues = [...new Set(issues)]; return result; }
  result.tokens = EMPTY_TOKENS();
  const groups = new Map();
  for (const { tokens, model } of responses.values()) {
    if (!tokens.reasoning_known) issues.push('reasoning_tokens_unavailable');
    add(result.tokens, tokens);
    const group = groups.get(model) ?? { model, reasoning_effort: effort, tokens: EMPTY_TOKENS() };
    add(group.tokens, tokens);
    groups.set(model, group);
  }
  if (metadataMissing) issues.push('agent_metadata_missing');
  result.observed_settings = [...groups.values()];
  result.response_count = responses.size;
  const stop = lastAssistant?.message.stop_reason;
  if (!stop || stop === 'tool_use') issues.push('active_or_incomplete_turn');
  else result.completed_at = lastAssistant.timestamp;
  if (result.started_at) result.wall_ms = Math.max(0, Date.parse(result.completed_at || now) - Date.parse(result.started_at));
  result.issues = [...new Set(issues)];
  result.status = result.issues.length ? 'partial' : 'complete';
  return result;
}

function agentEffort(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).effort ?? null; }
  catch { return null; }
}

export function collectClaudeUsage({ scope, threadIds = [], sessionsDir = projectsDefault(), now } = {}) {
  const collectedAt = iso(now);
  const result = { status: 'unavailable', tokens: null, threads: [], started_at: null, completed_at: null, wall_ms: null, collected_at: collectedAt, issues: [] };
  const session = scope?.session_id;
  if (!session || !scope.coordinator_thread_id) return { ...result, issues: ['usage_scope_unavailable'] };
  const ids = [...new Set([session, ...threadIds])];
  if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) return { ...result, issues: ['invalid_thread_id'] };
  const directory = sessionDirectory(sessionsDir, session) ?? path.join(sessionsDir, 'unknown-project');
  result.threads = ids.map(id => {
    if (id === session) return collectThread(id, path.join(directory, `${session}.jsonl`), { parent: null, effort: null, metadataMissing: false, now: collectedAt });
    const base = path.join(directory, session, 'subagents', `agent-${id}`);
    const effort = agentEffort(`${base}.meta.json`);
    return collectThread(id, `${base}.jsonl`, { parent: session, effort, metadataMissing: effort === null, now: collectedAt });
  });
  for (const thread of result.threads) {
    if (thread.tokens) { result.tokens ||= EMPTY_TOKENS(); add(result.tokens, thread.tokens); }
    result.issues.push(...thread.issues.map(issue => `${thread.thread_id}:${issue}`));
  }
  result.status = !result.tokens ? 'unavailable' : result.threads.every(thread => thread.status === 'complete') ? 'complete' : 'partial';
  const coordinator = result.threads[0];
  result.started_at = result.threads.map(thread => thread.started_at).filter(Boolean).sort()[0] || null;
  result.completed_at = coordinator.completed_at;
  if (result.started_at) result.wall_ms = Math.max(0, Date.parse(result.completed_at || collectedAt) - Date.parse(result.started_at));
  return result;
}
