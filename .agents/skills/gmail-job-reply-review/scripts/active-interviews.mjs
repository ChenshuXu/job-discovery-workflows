import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const SECTION_HEADINGS = Object.freeze({
  active: '## Active Processes',
  todos: '## Current TODO',
  archived: '## Archived Processes',
});

export const ACTIVE_INTERVIEW_COLUMNS = Object.freeze([
  'Identity',
  'Tracker',
  'Company',
  'Role / Requisition',
  'Stage',
  'Date / Deadline',
  'Status',
  'Last Updated',
  'Notes',
]);

export const ACTIVE_INTERVIEW_STATUSES = Object.freeze([
  'Action Required',
  'Scheduled',
  'Waiting',
]);

export const ARCHIVED_INTERVIEW_STATUSES = Object.freeze([
  'Rejected',
  'Withdrawn',
  'Cancelled',
  'Hired',
]);

const ACTIVE_STATUS_SET = new Set(ACTIVE_INTERVIEW_STATUSES);
const ARCHIVED_STATUS_SET = new Set(ARCHIVED_INTERVIEW_STATUSES);
const IDENTITY_RE = /^(?:tracker:#\d+|(?:action|ambiguous):[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)$/u;
const TRACKER_RE = /^#\d+$/u;

export class ActiveInterviewsValidationError extends Error {
  constructor(errors) {
    const sorted = [...errors].sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
    super(`Invalid active-interviews.md:\n${sorted.map(error => `line ${error.line}: ${error.message}`).join('\n')}`);
    this.name = 'ActiveInterviewsValidationError';
    this.errors = sorted;
  }
}

export class ActiveInterviewsLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActiveInterviewsLockError';
    this.code = code;
  }
}

function addError(errors, line, code, message) {
  errors.push({ line: Math.max(1, line), code, message });
}

function isUnescapedPipe(line, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

function parseTableLine(line) {
  const first = line.search(/\S/u);
  if (first < 0 || line[first] !== '|') return null;

  let last = line.length - 1;
  while (last >= 0 && /\s/u.test(line[last])) last -= 1;
  if (last <= first || line[last] !== '|') return null;

  const separators = [];
  for (let index = first; index <= last; index += 1) {
    if (line[index] === '|' && isUnescapedPipe(line, index)) separators.push(index);
  }
  if (separators[0] !== first || separators.at(-1) !== last || separators.length < 2) return null;

  const cells = [];
  for (let index = 0; index < separators.length - 1; index += 1) {
    const start = separators[index] + 1;
    const end = separators[index + 1];
    cells.push(line.slice(start, end).trim());
  }
  return { cells };
}

function tableBounds(lines, headingIndex, nextHeadingIndex) {
  const end = nextHeadingIndex >= 0 ? nextHeadingIndex : lines.length;
  let header = headingIndex + 1;
  while (header < end && lines[header].trim() === '') header += 1;
  return { header, end };
}

function publicRow(row) {
  return {
    identity: row.identity,
    tracker: row.tracker,
    company: row.company,
    role: row.role,
    stage: row.stage,
    dateOrDeadline: row.dateOrDeadline,
    status: row.status,
    lastUpdated: row.lastUpdated,
    notes: row.notes,
    line: row.line,
  };
}

function parseTable(lines, headingIndex, nextHeadingIndex, kind, errors) {
  if (headingIndex < 0) return [];
  const { header, end } = tableBounds(lines, headingIndex, nextHeadingIndex);
  if (header >= end) {
    addError(errors, headingIndex + 1, 'missing_table', `${SECTION_HEADINGS[kind]} must contain a 9-column table`);
    return [];
  }

  const parsedHeader = parseTableLine(lines[header]);
  if (!parsedHeader || parsedHeader.cells.length !== ACTIVE_INTERVIEW_COLUMNS.length
      || parsedHeader.cells.some((cell, index) => cell !== ACTIVE_INTERVIEW_COLUMNS[index])) {
    addError(errors, header + 1, 'invalid_table_header', `${SECTION_HEADINGS[kind]} must use the exact 9-column header`);
  }

  const dividerIndex = header + 1;
  const divider = dividerIndex < end ? parseTableLine(lines[dividerIndex]) : null;
  if (!divider || divider.cells.length !== ACTIVE_INTERVIEW_COLUMNS.length
      || divider.cells.some(cell => !/^:?-{3,}:?$/u.test(cell))) {
    addError(errors, Math.min(dividerIndex + 1, end || 1), 'invalid_table_divider', `${SECTION_HEADINGS[kind]} must have a 9-column Markdown divider`);
  }

  const rows = [];
  for (let index = dividerIndex + 1; index < end; index += 1) {
    if (lines[index].trim() === '') continue;
    const parsed = parseTableLine(lines[index]);
    if (!parsed || parsed.cells.length !== ACTIVE_INTERVIEW_COLUMNS.length) {
      addError(errors, index + 1, 'invalid_table_row', `${SECTION_HEADINGS[kind]} rows must have exactly 9 columns`);
      continue;
    }

    const [identity, tracker, company, role, stage, dateOrDeadline, status, lastUpdated, notes] = parsed.cells;
    if (!identity) {
      addError(errors, index + 1, 'missing_identity', 'Identity must not be empty');
    } else if (!IDENTITY_RE.test(identity)) {
      addError(errors, index + 1, 'invalid_identity', `Identity "${identity}" must use tracker:#N, action:<slug>, or ambiguous:<slug>`);
    }
    for (const [field, value] of [['Company', company], ['Role / Requisition', role], ['Stage', stage]]) {
      if (!value) addError(errors, index + 1, 'missing_required_field', `${field} must not be empty`);
    }
    if (tracker && !TRACKER_RE.test(tracker)) {
      addError(errors, index + 1, 'invalid_tracker', `Tracker "${tracker}" must be blank or #N`);
    }
    const identityTracker = identity.match(/^tracker:(#\d+)$/u)?.[1];
    if (identityTracker && tracker !== identityTracker) {
      addError(errors, index + 1, 'tracker_identity_mismatch', `Identity "${identity}" requires Tracker "${identityTracker}"`);
    }
    if (!validDate(lastUpdated)) {
      addError(errors, index + 1, 'invalid_last_updated', 'Last Updated must be a valid YYYY-MM-DD date');
    }
    const allowedStatuses = kind === 'active' ? ACTIVE_STATUS_SET : ARCHIVED_STATUS_SET;
    if (!allowedStatuses.has(status)) {
      addError(
        errors,
        index + 1,
        'invalid_status',
        `${kind === 'active' ? 'Active' : 'Archived'} status "${status}" is not allowed`,
      );
    }
    rows.push({
      identity,
      tracker,
      company,
      role,
      stage,
      dateOrDeadline,
      status,
      lastUpdated,
      notes,
      line: index + 1,
    });
  }
  return rows;
}

function parseTodoLine(line, lineNumber, errors) {
  const match = line.match(/^\s*-\s+\[([ xX])\]\s+\*\*(.+?)\*\*\s+(.+?)\s*$/u);
  if (!match) {
    addError(errors, lineNumber, 'invalid_todo', 'TODO must use "- [ ] **label / Identity：** one concrete action"');
    return null;
  }

  const label = match[2].trim().replace(/[：:]\s*$/u, '').trim();
  const action = match[3].trim();
  if (!label || !action) {
    addError(errors, lineNumber, 'invalid_todo', 'TODO label and action must not be empty');
    return null;
  }
  return {
    checked: match[1].toLowerCase() === 'x',
    label,
    action,
    line: lineNumber,
    raw: line,
  };
}

function visibleAliases(identity) {
  const aliases = [identity];
  const tracker = identity.match(/^tracker:(#\d+)$/u);
  if (tracker) aliases.push(tracker[1]);
  return aliases;
}

function isBoundary(character) {
  return character === undefined || /[\s/|,;:：()[\]{}—–-]/u.test(character);
}

function containsVisibleAlias(label, alias) {
  let from = 0;
  while (from <= label.length - alias.length) {
    const index = label.indexOf(alias, from);
    if (index < 0) return false;
    if (isBoundary(label[index - 1]) && isBoundary(label[index + alias.length])) return true;
    from = index + 1;
  }
  return false;
}

function matchTodoIdentity(todo, active, archived, errors) {
  const rows = [...active, ...archived];
  const matches = rows.filter(row => row.identity
    && visibleAliases(row.identity).some(alias => containsVisibleAlias(todo.label, alias)));

  if (matches.length === 0) {
    addError(errors, todo.line, 'todo_identity_missing', 'TODO label must visibly contain one known process Identity');
    return null;
  }
  if (matches.length > 1) {
    addError(errors, todo.line, 'todo_identity_ambiguous', `TODO label matches multiple process Identities: ${matches.map(row => row.identity).join(', ')}`);
    return null;
  }

  const match = matches[0];
  if (archived.includes(match)) {
    addError(
      errors,
      todo.line,
      todo.checked ? 'todo_not_active' : 'archive_open_todo',
      `${todo.checked ? 'Checked TODO' : 'Open TODO'} belongs to archived process "${match.identity}"`,
    );
    return null;
  }
  todo.identity = match.identity;
  todo.processLine = match.line;
  return match;
}

function inspect(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const lines = markdown.split(/\r?\n/u);
  const errors = [];
  const headingIndexes = {};

  for (const [kind, heading] of Object.entries(SECTION_HEADINGS)) {
    const matches = [];
    lines.forEach((line, index) => {
      if (line.trim() === heading) matches.push(index);
    });
    headingIndexes[kind] = matches[0] ?? -1;
    if (matches.length === 0) addError(errors, 1, 'missing_section', `Missing required section "${heading}"`);
    for (const duplicate of matches.slice(1)) {
      addError(errors, duplicate + 1, 'duplicate_section', `Duplicate section "${heading}"`);
    }
  }

  lines.forEach((line, index) => {
    const heading = line.trim();
    if (/^##\s+/u.test(heading) && !Object.values(SECTION_HEADINGS).includes(heading)) {
      addError(errors, index + 1, 'unexpected_section', `Unexpected level-2 section "${heading}"`);
    }
  });

  if (headingIndexes.active >= 0 && headingIndexes.todos >= 0 && headingIndexes.archived >= 0
      && !(headingIndexes.active < headingIndexes.todos && headingIndexes.todos < headingIndexes.archived)) {
    addError(errors, headingIndexes.todos + 1, 'section_order', 'Sections must be ordered Active Processes, Current TODO, Archived Processes');
  }

  const active = parseTable(lines, headingIndexes.active, headingIndexes.todos, 'active', errors);
  const archived = parseTable(lines, headingIndexes.archived, lines.length, 'archived', errors);

  const identities = new Map();
  const trackers = new Map();
  for (const row of [...active, ...archived]) {
    if (!row.identity) continue;
    const prior = identities.get(row.identity);
    if (prior) {
      const crossesSections = prior.kind !== (active.includes(row) ? 'active' : 'archived');
      addError(
        errors,
        row.line,
        crossesSections ? 'identity_in_active_and_archive' : 'duplicate_identity',
        `Identity "${row.identity}" also appears on line ${prior.line}`,
      );
    } else {
      identities.set(row.identity, { line: row.line, kind: active.includes(row) ? 'active' : 'archived' });
    }
    if (TRACKER_RE.test(row.tracker)) {
      const priorTracker = trackers.get(row.tracker);
      if (priorTracker) {
        addError(errors, row.line, 'duplicate_tracker', `Tracker "${row.tracker}" also appears on line ${priorTracker}`);
      } else {
        trackers.set(row.tracker, row.line);
      }
    }
  }

  const todos = [];
  if (headingIndexes.todos >= 0) {
    const end = headingIndexes.archived >= 0 ? headingIndexes.archived : lines.length;
    for (let index = headingIndexes.todos + 1; index < end; index += 1) {
      if (lines[index].trim() === '') continue;
      const todo = parseTodoLine(lines[index], index + 1, errors);
      if (!todo) continue;
      const process = matchTodoIdentity(todo, active, archived, errors);
      if (process && process.status !== 'Action Required') {
        addError(errors, todo.line, 'todo_status_mismatch', `TODO process "${process.identity}" must have status "Action Required"`);
      }
      todos.push(todo);
    }
  }

  const todoIdentities = new Set(todos.map(todo => todo.identity).filter(Boolean));
  for (const row of active) {
    if (row.status === 'Action Required' && !todoIdentities.has(row.identity)) {
      addError(errors, row.line, 'action_required_without_todo', `Process "${row.identity}" is Action Required but has no TODO`);
    }
  }

  return { active, archived, todos, errors };
}

function assertValid(document) {
  if (document.errors.length > 0) throw new ActiveInterviewsValidationError(document.errors);
  return document;
}

/** Validate and parse the canonical three-section interview register. */
export function validateActiveInterviews(markdown) {
  const document = assertValid(inspect(markdown));
  return {
    active: document.active.map(publicRow),
    archived: document.archived.map(publicRow),
    todos: document.todos.map(todo => ({
      checked: todo.checked,
      label: todo.label,
      action: todo.action,
      identity: todo.identity,
      line: todo.line,
      processLine: todo.processLine,
    })),
  };
}

/** Resolve only the exact linked Identity section, never another process in the same file. */
export function readInterviewProcessSummary(row, registerPath) {
  if (!row.notes.startsWith('[Process summary]')) return null; // Legacy inline Notes remain readable.
  const match = row.notes.match(/^\[Process summary\]\(([^)#]+)\/process-summary\.md#([a-z0-9][a-z0-9-]*)\)$/u);
  const fail = message => { throw new ActiveInterviewsValidationError([{ line: row.line, code: 'invalid_process_summary', message }]); };
  if (!match) fail('Notes must contain only [Process summary](Company/process-summary.md#anchor)');
  let company;
  try { company = decodeURIComponent(match[1]); } catch { fail('Invalid process-summary path encoding'); }
  if (!company || ['.', '..'].includes(company) || /[\\/\r\n]/u.test(company)) fail('Process summary must be in one company folder below Interview');
  const root = realpathSync(dirname(registerPath));
  const path = join(root, company, 'process-summary.md');
  if (!existsSync(path)) fail(`Missing process summary: ${path}`);
  const actualPath = realpathSync(path);
  if (relative(root, actualPath) !== join(company, 'process-summary.md')) fail('Process summary must not escape its company folder');
  const fullText = readFileSync(actualPath, 'utf8');
  const lines = fullText.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => line === `## ${match[2]}` ? [index] : []);
  if (headings.length !== 1) fail(`Process summary requires one heading ## ${match[2]}`);
  const start = headings[0];
  const next = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const text = lines.slice(start, next < 0 ? undefined : next).join('\n');
  const identities = [...text.matchAll(/^Identity: `([^`]+)`\s*$/gmu)].map(item => item[1]);
  if (identities.length !== 1 || identities[0] !== row.identity) fail(`Process summary section must identify exactly ${row.identity}`);
  return { path: actualPath, text, sha256: sha256(fullText) };
}

/** Ensure an admitted process is never deleted and reopened terminal history stays visible. */
export function assertInterviewProcessesPreserved(previousProcesses, markdown, { registerPath } = {}) {
  if (!Array.isArray(previousProcesses)) throw new TypeError('previousProcesses must be an array');
  const current = assertValid(inspect(markdown));
  const currentRows = new Map([
    ...current.active.map(row => [row.identity, { ...row, kind: 'active' }]),
    ...current.archived.map(row => [row.identity, { ...row, kind: 'archived' }]),
  ]);
  const errors = [];
  for (const previous of previousProcesses) {
    const row = currentRows.get(previous.identity);
    if (!row) {
      addError(errors, 1, 'process_removed', `Previously admitted process "${previous.identity}" must remain in Active or Archived Processes`);
      continue;
    }
    if (previous.kind === 'archived' && row.kind === 'active') {
      const terminalDate = previous.dateOrDeadline?.match(/\d{4}-\d{2}-\d{2}/u)?.[0]
        ?? previous.lastUpdated;
      const notes = (registerPath ? readInterviewProcessSummary(row, registerPath)?.text ?? row.notes : row.notes).toLowerCase();
      if (!notes.includes(terminalDate.toLowerCase())
          || !notes.includes(previous.status.toLowerCase())) {
        addError(errors, row.line, 'terminal_history_missing', `Reopened process "${previous.identity}" process summary must preserve terminal date "${terminalDate}" and outcome "${previous.status}"`);
      }
    }
  }
  if (errors.length > 0) throw new ActiveInterviewsValidationError(errors);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function runShlock(lockPath) {
  const result = spawnSync('/usr/bin/shlock', ['-p', String(process.pid), '-f', lockPath], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new ActiveInterviewsLockError(
      'REGISTER_LOCK_UNAVAILABLE',
      `Cannot run /usr/bin/shlock: ${result.error.message}`,
    );
  }
  return result.status === 0;
}

/** Serialize every compliant writer for this canonical register. */
export function withActiveInterviewsLock(filePath, callback) {
  const absolutePath = realpathSync(resolve(filePath));
  const lockPath = join(tmpdir(), `active-interviews-${sha256(absolutePath).slice(0, 32)}.pid.lock`);
  const acquired = runShlock(lockPath);
  if (!acquired) {
    throw new ActiveInterviewsLockError(
      existsSync(lockPath) ? 'REGISTER_LOCK_BUSY' : 'REGISTER_LOCK_UNAVAILABLE',
      existsSync(lockPath)
        ? 'active-interviews.md is locked by another writer'
        : 'Could not create the active-interviews.md lock',
    );
  }
  try {
    return callback();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
        rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

/** Format a plain Markdown TODO whose process Identity remains visible. */
export function formatInterviewTodo({ identity, label = '', action, checked = false }) {
  for (const [name, value] of [['identity', identity], ['action', action]]) {
    if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) {
      throw new TypeError(`${name} must be a non-empty single line`);
    }
  }
  if (typeof label !== 'string' || /[\r\n]/u.test(label)) throw new TypeError('label must be a single line');

  const cleanIdentity = identity.trim();
  const displayIdentity = cleanIdentity.match(/^tracker:(#\d+)$/u)?.[1] ?? cleanIdentity;
  const cleanLabel = label.trim().replace(/[：:]\s*$/u, '');
  const visibleLabel = cleanLabel && !visibleAliases(cleanIdentity).some(alias => containsVisibleAlias(cleanLabel, alias))
    ? `${cleanLabel} / ${displayIdentity}`
    : cleanLabel || displayIdentity;
  return `- [${checked ? 'x' : ' '}] **${visibleLabel}：** ${action.trim()}`;
}
