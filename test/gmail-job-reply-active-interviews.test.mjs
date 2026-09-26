import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ActiveInterviewsValidationError,
  assertInterviewProcessesPreserved,
  readInterviewProcessSummary,
  formatInterviewTodo,
  validateActiveInterviews,
  withActiveInterviewsLock,
} from '../.agents/skills/gmail-job-reply-review/scripts/active-interviews.mjs';

const HEADER = '| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |';
const DIVIDER = '|---|---|---|---|---|---|---|---|---|';

function document({ active = [], todos = [], archived = [] } = {}) {
  return [
    '# Interview Pipeline',
    '',
    '## Active Processes',
    HEADER,
    DIVIDER,
    ...active,
    '',
    '## Current TODO',
    '',
    ...todos,
    '',
    '## Archived Processes',
    HEADER,
    DIVIDER,
    ...archived,
    '',
  ].join('\n');
}

const TRACKED = '| tracker:#101 | #101 | Example Security | Engineer III / R10001 | Recruiter Screen | 2000-01-04 11:00 PT | Action Required | 2000-01-01 | User note stays. |';
const ACTION = '| action:example-labs-backend-recruiter-screen |  | Example Labs | Software Engineer, Backend | Technical Interview |  | Action Required | 2000-01-01 | Keep this note exactly. |';
const AMBIGUOUS = '| ambiguous:example-search-customer-platform |  | Example Search | Engineer, Customer Platform | Recruiter Call |  | Action Required | 2000-01-01 | Exact tracker row unresolved between #102 and #103. |';
const ARCHIVED = '| action:old-role |  | Old Co | Backend Engineer | Recruiter Screen | 1999-12-20 | Rejected | 1999-12-25 | Rejected after interview. |';

test('validates the exact schema and resolves agreed visible TODO identities', () => {
  const markdown = document({
    active: [TRACKED, ACTION, AMBIGUOUS],
    todos: [
      '- [ ] **Example Security R10001 / #101：** accept the calendar invitation',
      '- [ ] **Example Labs / action:example-labs-backend-recruiter-screen：** send four time slots',
      '- [ ] **Example Labs / action:example-labs-backend-recruiter-screen：** confirm Python',
      '- [ ] **Example Search / ambiguous:example-search-customer-platform：** resolve the exact tracker row',
    ],
    archived: [ARCHIVED],
  });

  const parsed = validateActiveInterviews(markdown);
  assert.equal(parsed.active.length, 3);
  assert.equal(parsed.archived.length, 1);
  assert.deepEqual(parsed.todos.map(todo => todo.identity), [
    'tracker:#101',
    'action:example-labs-backend-recruiter-screen',
    'action:example-labs-backend-recruiter-screen',
    'ambiguous:example-search-customer-platform',
  ]);
  assert.equal(parsed.active[0].company, 'Example Security');
  assert.equal(parsed.active[0].role, 'Engineer III / R10001');
});

test('reports structural and status failures with source lines', () => {
  const malformed = document({
    active: [
      '|  |  | Missing ID | Engineer | Screen |  | Scheduled | 2000-01-01 | note |',
      '| action:bad-status |  | Bad Status | Engineer | Screen |  | Rejected | 2000-01-01 | note |',
      '| action:eight |  | Eight | Engineer | Screen |  | Waiting | 2000-01-01 |',
    ],
  });

  assert.throws(
    () => validateActiveInterviews(malformed),
    error => {
      assert.ok(error instanceof ActiveInterviewsValidationError);
      assert.deepEqual(
        error.errors.filter(item => ['missing_identity', 'invalid_status', 'invalid_table_row'].includes(item.code))
          .map(item => [item.line, item.code]),
        [[6, 'missing_identity'], [7, 'invalid_status'], [8, 'invalid_table_row']],
      );
      return true;
    },
  );
});

test('fails closed on malformed identity, tracker drift, and TODO status drift', () => {
  const malformed = document({
    active: [
      '| tracker:#7 | #8 | Acme | Engineer | Screen |  | Waiting | 2000-01-01 | note |',
      '| free text | #8 | Other | Engineer | Screen |  | Action Required | 2000-01-01 | note |',
    ],
    todos: ['- [ ] **Acme / #7：** reply'],
  });

  assert.throws(
    () => validateActiveInterviews(malformed),
    error => error instanceof ActiveInterviewsValidationError
      && ['tracker_identity_mismatch', 'invalid_identity', 'duplicate_tracker', 'todo_status_mismatch']
        .every(code => error.errors.some(item => item.code === code)),
  );
});

test('Action Required always has a visible TODO', () => {
  assert.throws(
    () => validateActiveInterviews(document({ active: [ACTION] })),
    error => error instanceof ActiveInterviewsValidationError
      && error.errors.some(item => item.code === 'action_required_without_todo'),
  );
});

test('rejects duplicate identities across active and archive', () => {
  const duplicate = document({
    active: [TRACKED],
    archived: ['| tracker:#101 | #101 | Example Security | Engineer III / R10001 | Recruiter Screen | 2000-01-04 | Rejected | 2000-01-11 | terminal |'],
  });

  assert.throws(
    () => validateActiveInterviews(duplicate),
    error => error instanceof ActiveInterviewsValidationError
      && error.errors.some(item => item.code === 'identity_in_active_and_archive' && item.line === 14),
  );
});

test('requires every TODO to identify exactly one active process', () => {
  const invalidTodos = document({
    active: [TRACKED],
    todos: [
      '- [ ] **Unknown / action:not-present：** do something',
      '- [ ] **Old Co / action:old-role：** follow up',
    ],
    archived: [ARCHIVED],
  });

  assert.throws(
    () => validateActiveInterviews(invalidTodos),
    error => {
      assert.ok(error instanceof ActiveInterviewsValidationError);
      assert.ok(error.errors.some(item => item.code === 'todo_identity_missing' && item.line === 10));
      assert.ok(error.errors.some(item => item.code === 'archive_open_todo' && item.line === 11));
      return true;
    },
  );
});

test('checked TODOs retain exact process fields until evidence is reconciled', () => {
  const parsed = validateActiveInterviews(document({
    active: [TRACKED],
    todos: ['- [x] **Example Security / #101：** accept the calendar invitation'],
  }));
  assert.equal(parsed.todos[0].checked, true);
  assert.equal(parsed.active[0].status, 'Action Required');
  assert.equal(parsed.active[0].dateOrDeadline, '2000-01-04 11:00 PT');
});

test('admitted identities persist and reopened terminal history remains visible', () => {
  const active = TRACKED.replace('Action Required', 'Waiting');
  const previous = validateActiveInterviews(document({ active: [active], archived: [ARCHIVED] }));
  const snapshot = [
    ...previous.active.map(row => ({ ...row, kind: 'active' })),
    ...previous.archived.map(row => ({ ...row, kind: 'archived' })),
  ];
  assert.throws(
    () => assertInterviewProcessesPreserved(snapshot, document({ active: [active] })),
    error => error instanceof ActiveInterviewsValidationError
      && error.errors.some(item => item.code === 'process_removed'),
  );
  assert.throws(
    () => assertInterviewProcessesPreserved(snapshot, document({
      active: [active, '| action:old-role |  | Old Co | Backend Engineer | Recruiter Screen | 2000-01-03 | Waiting | 2000-01-03 | reopened |'],
    })),
    error => error instanceof ActiveInterviewsValidationError
      && error.errors.some(item => item.code === 'terminal_history_missing'),
  );
  assert.doesNotThrow(() => assertInterviewProcessesPreserved(snapshot, document({
    active: [active, '| action:old-role |  | Old Co | Backend Engineer | Recruiter Screen | 2000-01-03 | Waiting | 2000-01-03 | Reopened after Rejected outcome on 1999-12-20. |'],
  })));
});

test('apply CLI rejects an Identity rename without touching the canonical file', t => {
  const root = mkdtempSync(join(tmpdir(), 'active-interviews-check-'));
  const file = join(root, 'context/Interview/active-interviews.md');
  const candidate = join(root, 'candidate.md');
  const script = join(import.meta.dirname, '../.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs');
  const runCli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'context/Interview'), { recursive: true });

  const original = document({
    active: [AMBIGUOUS],
    todos: ['- [ ] **Example Search / ambiguous:example-search-customer-platform：** resolve the exact tracker row'],
  });
  writeFileSync(file, original);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'context/Interview/active-interviews.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd: root });

  const prepared = runCli('prepare', file, candidate);
  assert.equal(prepared.status, 0, prepared.stdout);
  const baselineSha256 = JSON.parse(prepared.stdout).baseline_sha256;
  assert.equal(statSync(candidate).mode & 0o777, 0o600);

  writeFileSync(candidate, original
    .replace('ambiguous:example-search-customer-platform |  ', 'ambiguous:example-search-customer-platform | #103 ')
    .replace('Example Search / ambiguous:example-search-customer-platform：', 'Example Search / #103：'));
  const relabeled = runCli('apply', file, candidate, baselineSha256);
  assert.equal(relabeled.status, 1);
  assert.match(relabeled.stdout, /todo_identity_missing/u);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(candidate), true);

  writeFileSync(candidate, original
    .replace('ambiguous:example-search-customer-platform |  ', 'tracker:#103 | #103 ')
    .replace('ambiguous:example-search-customer-platform：', '#103：'));
  const renamed = runCli('apply', file, candidate, baselineSha256);
  assert.equal(renamed.status, 1);
  assert.match(renamed.stdout, /process_removed|Previously admitted process/u);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(candidate), true);

  const resolved = original.replace(
    'ambiguous:example-search-customer-platform |  ',
    'ambiguous:example-search-customer-platform | #103 ',
  );
  writeFileSync(candidate, resolved);
  const preserved = runCli('apply', file, candidate, baselineSha256);
  assert.equal(preserved.status, 0, preserved.stdout);
  assert.equal(JSON.parse(preserved.stdout).candidate_removed, true);
  assert.equal(readFileSync(file, 'utf8'), resolved);
  assert.equal(existsSync(candidate), false);

  const staleCandidate = join(root, 'stale-candidate.md');
  const stalePrepared = runCli('prepare', file, staleCandidate);
  assert.equal(stalePrepared.status, 0, stalePrepared.stdout);
  const staleSha256 = JSON.parse(stalePrepared.stdout).baseline_sha256;
  const concurrent = resolved.replace('Exact tracker row unresolved', 'Concurrent note. Exact tracker row unresolved');
  writeFileSync(file, concurrent);
  const stale = runCli('apply', file, staleCandidate, staleSha256);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /changed since candidate preparation/u);
  assert.equal(readFileSync(file, 'utf8'), concurrent);
  assert.equal(existsSync(staleCandidate), true);
});

test('prepare CLI refuses a live active-interviews writer with a specific error', t => {
  const root = mkdtempSync(join(tmpdir(), 'active-interviews-live-lock-'));
  const file = join(root, 'context/Interview/active-interviews.md');
  const candidate = join(root, 'candidate.md');
  const script = join(import.meta.dirname, '../.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'context/Interview'), { recursive: true });
  writeFileSync(file, document());
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'context/Interview/active-interviews.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd: root });

  const blocked = withActiveInterviewsLock(file, () => (
    spawnSync(process.execPath, [script, 'prepare', file, candidate], { encoding: 'utf8' })
  ));

  assert.equal(blocked.status, 1, blocked.stdout);
  assert.equal(JSON.parse(blocked.stdout).error.code, 'REGISTER_LOCK_BUSY');
  assert.equal(existsSync(candidate), false);
});

test('prepare CLI atomically reclaims a lock left by a dead process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'active-interviews-stale-lock-'));
  const file = join(root, 'context/Interview/active-interviews.md');
  const candidate = join(root, 'candidate.md');
  const script = join(import.meta.dirname, '../.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs');
  const lockModule = new URL('../.agents/skills/gmail-job-reply-review/scripts/active-interviews.mjs', import.meta.url).href;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'context/Interview'), { recursive: true });
  writeFileSync(file, document());
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'context/Interview/active-interviews.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd: root });

  const crashed = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { withActiveInterviewsLock } from ${JSON.stringify(lockModule)}; withActiveInterviewsLock(${JSON.stringify(file)}, () => process.exit(0));`,
  ], { encoding: 'utf8' });
  assert.equal(crashed.status, 0, crashed.stderr);
  const lockPath = join(
    tmpdir(),
    `active-interviews-${createHash('sha256').update(realpathSync(file)).digest('hex').slice(0, 32)}.pid.lock`,
  );
  // shlock deliberately avoids replacing a lock created in the same timestamp tick.
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1100));
  const recovered = spawnSync(process.execPath, [script, 'prepare', file, candidate], {
    encoding: 'utf8',
  });
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).command, 'prepare');
  assert.equal(existsSync(candidate), true);
  assert.equal(existsSync(lockPath), false);
});

test('formatter emits ordinary Markdown with exact visible identity', () => {
  assert.equal(
    formatInterviewTodo({
      identity: 'tracker:#101',
      label: 'Example Security R10001',
      action: 'accept the calendar invitation',
    }),
    '- [ ] **Example Security R10001 / #101：** accept the calendar invitation',
  );
  assert.equal(
    formatInterviewTodo({
      identity: 'action:example-labs-backend-recruiter-screen',
      label: 'Example Labs',
      action: 'send four time slots',
      checked: true,
    }),
    '- [x] **Example Labs / action:example-labs-backend-recruiter-screen：** send four time slots',
  );
});

test('linked summary reads only the matching identity and rejects out-of-scope or mismatched links', t => {
  const root = mkdtempSync(join(tmpdir(), 'interview-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const register = join(root, 'active-interviews.md');
  const summary = join(root, 'Example Labs', 'process-summary.md');
  mkdirSync(join(root, 'Example Labs'));
  writeFileSync(register, '');
  writeFileSync(summary, '# Process history\n\n## tracker-101\nIdentity: `tracker:#101`\nOld Rejected on 1999-12-20.\n\n## tracker-102\nIdentity: `tracker:#102`\nOther evidence.\n');
  const row = { identity: 'tracker:#101', line: 6, notes: '[Process summary](Example%20Labs/process-summary.md#tracker-101)' };
  const result = readInterviewProcessSummary(row, register);
  assert.match(result.text, /Old Rejected/);
  assert.doesNotMatch(result.text, /Other evidence/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => readInterviewProcessSummary({ ...row, identity: 'tracker:#102' }, register), /exactly tracker:#102/u);
  assert.throws(() => readInterviewProcessSummary({ ...row, notes: row.notes + ' extra log' }, register), /only/u);
  assert.throws(() => readInterviewProcessSummary({ ...row, notes: '[Process summary](../process-summary.md#tracker-101)' }, register), /one company folder/u);
  assert.throws(() => readInterviewProcessSummary({ ...row, notes: '[Process summary](Example%20Labs/process-summary.md#missing)' }, register), /one heading/u);
  assert.equal(readInterviewProcessSummary({ ...row, notes: 'Legacy note' }, register), null);
  const previous = [{ identity: 'tracker:#101', kind: 'archived', status: 'Rejected', dateOrDeadline: '1999-12-20' }];
  const reopened = TRACKED.replace('Action Required', 'Waiting').replace('User note stays.', row.notes);
  assert.doesNotThrow(() => assertInterviewProcessesPreserved(previous, document({ active: [reopened] }), { registerPath: register }));
});

test('prepare baseline detects linked summary changes before apply', t => {
  const root = mkdtempSync(join(tmpdir(), 'interview-summary-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const register = join(root, 'context/Interview/active-interviews.md');
  const summary = join(root, 'context/Interview/Acme/process-summary.md');
  const candidate = join(root, 'candidate.md');
  mkdirSync(join(root, 'context/Interview/Acme'), { recursive: true });
  writeFileSync(summary, '# Acme\n\n## tracker-101\nIdentity: `tracker:#101`\nScheduled.\n');
  const original = document({ active: [TRACKED.replace('Action Required', 'Scheduled').replace('User note stays.', '[Process summary](Acme/process-summary.md#tracker-101)')] });
  writeFileSync(register, original);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'context'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd: root });
  const script = join(import.meta.dirname, '../.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const prepared = run('prepare', register, candidate);
  assert.equal(prepared.status, 0, prepared.stdout);
  writeFileSync(summary, readFileSync(summary, 'utf8') + 'Concurrent change.\n');
  const applied = run('apply', register, candidate, JSON.parse(prepared.stdout).baseline_sha256);
  assert.equal(applied.status, 1);
  assert.equal(JSON.parse(applied.stdout).error.code, 'STATE_CONFLICT');
  assert.equal(readFileSync(register, 'utf8'), original);
  assert.equal(existsSync(candidate), true);
});
