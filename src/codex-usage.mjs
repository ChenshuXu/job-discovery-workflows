import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const EMPTY_TOKENS = () => Object.fromEntries([...TOKEN_FIELDS, 'uncached_input_tokens'].map(key => [key, 0]));
const sessionsDefault = () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
const iso = value => new Date(value ?? Date.now()).toISOString();
const add = (target, value) => { for (const key of Object.keys(target)) target[key] += value[key]; };

function readThreads(sessionsDir, threadIds) {
  const result = new Map(threadIds.map(id => [id, { events: [], files: [], issues: [], meta: null }]));
  let names;
  try { names = readdirSync(sessionsDir, { recursive: true }); }
  catch { for (const value of result.values()) value.issues.push('sessions_directory_unavailable'); return result; }
  for (const name of names.sort()) {
    const id = threadIds.find(id => path.basename(name).endsWith(`-${id}.jsonl`));
    if (!id) continue;
    const value = result.get(id);
    value.files.push(path.basename(name));
    let raw;
    try { raw = readFileSync(path.join(sessionsDir, name), 'utf8'); }
    catch { value.issues.push('session_file_unreadable'); continue; }
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let event;
      try { event = JSON.parse(lines[index]); }
      catch { value.issues.push(index === lines.length - 1 ? 'truncated_tail' : 'malformed_event'); continue; }
      if (!event || typeof event !== 'object' || !Number.isFinite(Date.parse(event.timestamp))) { value.issues.push('malformed_event'); continue; }
      if (event.type === 'session_meta') {
        const { id: metadataId, session_id, parent_thread_id, agent_path } = event.payload ?? {};
        const meta = { id: metadataId, session_id, parent_thread_id, agent_path };
        if (metadataId !== id || (value.meta && JSON.stringify(value.meta) !== JSON.stringify(meta))) value.issues.push('conflicting_session_metadata');
        else value.meta = meta;
      }
      // Only retain the metadata needed for attribution; never retain messages or tool content.
      if (event.type === 'turn_context') {
        const { turn_id, root_turn_id, model, effort } = event.payload ?? {};
        value.events.push({ timestamp: event.timestamp, ordinal: event.ordinal, type: event.type, payload: { turn_id, root_turn_id, model, effort } });
      } else if (event.type === 'token_usage_record') {
        const { thread_id, turn_id, root_turn_id, session_id, response_id, usage, turn_token_usage } = event.payload ?? {};
        value.events.push({ timestamp: event.timestamp, ordinal: event.ordinal, type: event.type, payload: { thread_id, turn_id, root_turn_id, session_id, response_id, usage, turn_token_usage } });
      } else if (event.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(event.payload?.type)) {
        const { type, turn_id, started_at, completed_at, duration_ms } = event.payload;
        value.events.push({ timestamp: event.timestamp, ordinal: event.ordinal, type, payload: { turn_id, started_at, completed_at, duration_ms } });
      }
    }
  }
  for (const value of result.values()) {
    if (!value.files.length) value.issues.push('session_file_missing');
    if (!value.meta) value.issues.push('session_metadata_missing');
    value.events = [...new Map(value.events.map(event => [JSON.stringify(event), event])).values()];
    value.events.sort((a, b) => (Number.isSafeInteger(a.ordinal) && Number.isSafeInteger(b.ordinal) ? a.ordinal - b.ordinal : 0) || (Date.parse(a.timestamp) - Date.parse(b.timestamp)));
  }
  return result;
}

export function captureCodexUsageScope({ sessionsDir = sessionsDefault(), threadId = process.env.CODEX_THREAD_ID, rootTurnId, now } = {}) {
  const base = { status: 'unavailable', coordinator_thread_id: threadId || null, session_id: null, root_turn_id: rootTurnId || null, captured_at: iso(now), selection: null, issues: [] };
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) return { ...base, issues: ['current_thread_id_unavailable'] };
  const data = readThreads(sessionsDir, [threadId]).get(threadId);
  const matching = data.events.filter(event => ['turn_context', 'token_usage_record'].includes(event.type) && (!rootTurnId || event.payload.root_turn_id === rootTurnId || event.payload.turn_id === rootTurnId));
  const latestStart = data.events.filter(event => event.type === 'task_started').at(-1);
  const selected = rootTurnId ? matching.at(-1) : matching.filter(event => event.payload.turn_id === latestStart?.payload.turn_id).at(-1);
  const selectedRoot = rootTurnId || selected?.payload.root_turn_id || (!data.meta?.parent_thread_id && latestStart?.payload.turn_id);
  const issues = [...data.issues];
  if (!selected || !selectedRoot) issues.push('turn_scope_unavailable');
  const selectedStart = data.events.findLastIndex(event => event.type === 'task_started' && event.payload.turn_id === selected?.payload.turn_id);
  const finished = data.events.some((event, index) => index > selectedStart && event.type === 'task_complete' && event.payload.turn_id === selected?.payload.turn_id);
  return {
    ...base,
    status: !selected || !selectedRoot ? 'unavailable' : issues.length ? 'partial' : 'complete',
    coordinator_thread_id: threadId,
    session_id: data.meta?.session_id || null,
    root_turn_id: selectedRoot || null,
    selection: rootTurnId ? 'explicit_root_turn' : finished ? 'latest_completed_turn' : 'latest_active_turn',
    issues: [...new Set(issues)],
  };
}

function validTokens(raw) {
  if (!raw || !['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'].every(key => Number.isSafeInteger(raw[key]) && raw[key] >= 0)) return null;
  const tokens = EMPTY_TOKENS();
  for (const key of TOKEN_FIELDS) {
    const value = raw[key] === undefined ? 0 : raw[key];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    tokens[key] = value;
  }
  if (tokens.total_tokens !== tokens.input_tokens + tokens.output_tokens || tokens.cached_input_tokens > tokens.input_tokens || tokens.reasoning_output_tokens > tokens.output_tokens) return null;
  tokens.uncached_input_tokens = tokens.input_tokens - tokens.cached_input_tokens;
  return tokens;
}

function collectThread(threadId, data, scope, allData, now) {
  const issues = [...data.issues];
  const result = { thread_id: threadId, parent_thread_id: data.meta?.parent_thread_id || null, status: 'unavailable', observed_settings: [], tokens: null, started_at: null, completed_at: null, wall_ms: null, response_count: 0, source_files: data.files, issues };
  if (data.meta?.session_id !== scope.session_id) issues.push('session_id_mismatch');
  if (threadId !== scope.coordinator_thread_id) {
    let parent = data.meta?.parent_thread_id;
    const seen = new Set([threadId]);
    while (parent && parent !== scope.coordinator_thread_id && !seen.has(parent)) { seen.add(parent); parent = allData.get(parent)?.meta?.parent_thread_id; }
    if (parent !== scope.coordinator_thread_id) issues.push('parent_thread_mismatch');
  }
  if (issues.some(issue => ['session_id_mismatch', 'parent_thread_mismatch', 'conflicting_session_metadata'].includes(issue))) return result;
  const settings = new Map();
  const responses = new Map();
  const turns = new Map();
  const starts = new Map();
  const completions = new Map();
  for (const [eventIndex, event] of data.events.entries()) {
    const p = event.payload;
    if (event.type === 'turn_context') {
      settings.set(p.turn_id, { model: typeof p.model === 'string' ? p.model : null, reasoning_effort: typeof p.effort === 'string' ? p.effort : null });
      if (p.root_turn_id === scope.root_turn_id) turns.set(p.turn_id, turns.get(p.turn_id) || { tokens: EMPTY_TOKENS(), cumulative: null });
    } else if (event.type === 'task_started') starts.set(p.turn_id, { timestamp: starts.get(p.turn_id)?.timestamp || event.timestamp, index: eventIndex, count: (starts.get(p.turn_id)?.count || 0) + 1 });
    else if (event.type === 'task_complete') completions.set(p.turn_id, { ...event, index: eventIndex });
    else if (event.type === 'turn_aborted' && turns.has(p.turn_id)) issues.push('turn_aborted');
    else if (event.type === 'token_usage_record' && p.root_turn_id === scope.root_turn_id) {
      if (p.thread_id !== threadId || p.session_id !== scope.session_id || !p.turn_id || !p.response_id) { issues.push('usage_identity_invalid'); continue; }
      const tokens = validTokens(p.usage);
      if (!tokens) { issues.push('invalid_token_usage'); continue; }
      const observed = settings.get(p.turn_id) || { model: null, reasoning_effort: null };
      const record = { turn_id: p.turn_id, tokens, ...observed };
      if (responses.has(p.response_id)) {
        if (JSON.stringify(responses.get(p.response_id)) !== JSON.stringify(record)) issues.push('conflicting_response_usage');
        continue;
      }
      responses.set(p.response_id, record);
      if (!observed.model || observed.reasoning_effort === null) issues.push('model_settings_unavailable');
      const turn = turns.get(p.turn_id) || { tokens: EMPTY_TOKENS(), cumulative: null };
      turn.last_usage_index = eventIndex;
      add(turn.tokens, tokens);
      const cumulative = validTokens(p.turn_token_usage);
      if (!cumulative) issues.push('turn_cumulative_unavailable');
      else {
        if (turn.cumulative && TOKEN_FIELDS.some(key => cumulative[key] < turn.cumulative[key])) issues.push('turn_cumulative_reset');
        turn.cumulative = cumulative;
      }
      turns.set(p.turn_id, turn);
    }
  }
  if (!responses.size) { issues.push('token_usage_unavailable_for_root_turn'); return result; }
  result.tokens = EMPTY_TOKENS();
  const groups = new Map();
  for (const response of responses.values()) {
    add(result.tokens, response.tokens);
    const key = JSON.stringify([response.model, response.reasoning_effort]);
    const group = groups.get(key) || { model: response.model, reasoning_effort: response.reasoning_effort, tokens: EMPTY_TOKENS() };
    add(group.tokens, response.tokens);
    groups.set(key, group);
  }
  result.observed_settings = [...groups.values()];
  result.response_count = responses.size;
  for (const [turnId, turn] of turns) {
    if (!turn.cumulative && !turn.tokens.total_tokens) issues.push('turn_usage_missing');
    if (!starts.has(turnId)) issues.push('task_start_missing');
    const completion = completions.get(turnId);
    if (completion && (completion.index < (starts.get(turnId)?.index ?? 0) || completion.index < (turn.last_usage_index ?? 0))) completions.delete(turnId);
    if (!completions.has(turnId)) issues.push('active_or_incomplete_turn');
    if (turn.cumulative && TOKEN_FIELDS.some(key => turn.cumulative[key] !== turn.tokens[key])) issues.push('turn_cumulative_mismatch');
  }
  const selectedStarts = [...turns.keys()].map(id => starts.get(id)?.timestamp).filter(Boolean).sort();
  const selectedCompletions = [...turns.keys()].map(id => completions.get(id)).filter(Boolean);
  result.started_at = selectedStarts[0] || null;
  result.completed_at = selectedCompletions.length === turns.size ? selectedCompletions.map(event => event.timestamp).sort().at(-1) : null;
  if (result.started_at) result.wall_ms = Math.max(0, Date.parse(result.completed_at || now) - Date.parse(result.started_at));
  // Preserve Codex's more precise duration for the usual single-turn case.
  if (turns.size === 1 && starts.get([...turns.keys()][0])?.count === 1 && selectedCompletions.length === 1 && Number.isSafeInteger(selectedCompletions[0].payload.duration_ms) && selectedCompletions[0].payload.duration_ms >= 0) result.wall_ms = selectedCompletions[0].payload.duration_ms;
  result.issues = [...new Set(issues)];
  result.status = result.issues.length ? 'partial' : 'complete';
  return result;
}

export function collectCodexUsage({ scope, threadIds = [], sessionsDir = sessionsDefault(), now } = {}) {
  const collectedAt = iso(now);
  const result = { status: 'unavailable', tokens: null, threads: [], started_at: null, completed_at: null, wall_ms: null, collected_at: collectedAt, issues: [] };
  if (!scope?.coordinator_thread_id || !scope?.session_id || !scope?.root_turn_id) return { ...result, issues: ['usage_scope_unavailable'] };
  const ids = [...new Set([scope.coordinator_thread_id, ...threadIds])];
  if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) return { ...result, issues: ['invalid_thread_id'] };
  const data = readThreads(sessionsDir, ids);
  result.threads = ids.map(id => collectThread(id, data.get(id), scope, data, collectedAt));
  for (const thread of result.threads) {
    if (thread.tokens) { result.tokens ||= EMPTY_TOKENS(); add(result.tokens, thread.tokens); }
    result.issues.push(...thread.issues.map(issue => `${thread.thread_id}:${issue}`));
  }
  result.status = !result.tokens ? 'unavailable' : result.threads.every(thread => thread.status === 'complete') ? 'complete' : 'partial';
  const coordinator = result.threads.find(thread => thread.thread_id === scope.coordinator_thread_id);
  result.started_at = result.threads.map(thread => thread.started_at).filter(Boolean).sort()[0] || null;
  result.completed_at = coordinator?.completed_at || null;
  if (result.started_at) result.wall_ms = Math.max(0, Date.parse(result.completed_at || collectedAt) - Date.parse(result.started_at));
  if (result.started_at === coordinator?.started_at) result.wall_ms = coordinator.wall_ms;
  return result;
}
