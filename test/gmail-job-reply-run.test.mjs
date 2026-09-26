import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(
  ROOT,
  '.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs',
);
const HEADERS = '| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |';
const DIVIDER = '|---|---|---|---|---|---|---|---|---|';

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function document({ row = null, todo = null, archivedRow = null } = {}) {
  return [
    '# Interview Pipeline',
    '',
    '## Active Processes',
    '',
    HEADERS,
    DIVIDER,
    ...(row ? [row] : []),
    '',
    '## Current TODO',
    '',
    ...(todo ? [todo, ''] : []),
    '## Archived Processes',
    '',
    HEADERS,
    DIVIDER,
    ...(archivedRow ? [archivedRow] : []),
    '',
  ].join('\n');
}

function applications(status = 'Applied', note = '') {
  return [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    `| 1 | 2026-08-01 | Acme | Engineer | 4/5 | ${status} | | | ${note} |`,
    '',
  ].join('\n');
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gmail-reply-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const career = join(root, 'career-ops');
  const state = join(root, 'state');
  const careerDocs = join(root, 'career-docs');
  const interviews = join(careerDocs, 'context/Interview/active-interviews.md');
  mkdirSync(join(career, 'data'), { recursive: true });
  mkdirSync(state, { recursive: true });

  write(join(career, 'pipeline-lock.mjs'), [
    'export async function withPipelineLock(_path, callback) {',
    '  return callback();',
    '}',
    '',
  ].join('\n'));
  write(join(career, 'tracker-utils.mjs'), [
    "import { renameSync } from 'node:fs';",
    'export function renameSyncWithRetry(from, to) { renameSync(from, to); }',
    '',
  ].join('\n'));
  write(join(career, 'verify-pipeline.mjs'), [
    "import { existsSync } from 'node:fs';",
    "const failed = existsSync(new URL('.fail-verify', import.meta.url));",
    "console.log(`Pipeline Health: ${failed ? 1 : 0} errors, 0 warnings`);",
    'if (failed) process.exitCode = 1;',
    '',
  ].join('\n'));
  write(join(career, 'cv-sync-check.mjs'), "console.log('ok');\n");
  write(join(career, 'data/applications.md'), applications(
    options.status,
    options.note,
  ));
  write(join(career, 'data/status-log.tsv'), options.statusLog ?? '');
  write(interviews, options.interviews ?? document());

  const mailboxState = {
    version: 1,
    last_successful_run_at: '2026-01-01T00:00:00.000Z',
  };
  write(join(state, 'gmail-job-reply-state.json'), `${JSON.stringify({
    ...mailboxState,
    processed_message_ids: [],
  }, null, 2)}\n`);
  write(join(state, 'gmail-job-reply-secondary-state.json'), `${JSON.stringify({
    ...mailboxState,
    processed_thread_tokens: [],
    processed_thread_versions: [],
    legacy_thread_tokens: [],
    legacy_thread_token_floor_at: mailboxState.last_successful_run_at,
  }, null, 2)}\n`);

  git(careerDocs, 'init', '-q');
  git(careerDocs, 'config', 'user.name', 'Test User');
  git(careerDocs, 'config', 'user.email', 'test@example.com');
  git(careerDocs, 'add', 'context/Interview/active-interviews.md');
  git(careerDocs, 'commit', '-qm', 'initial interview register');

  return {
    root,
    career,
    state,
    careerDocs,
    interviews,
    common: [
      '--career-ops-root', career,
      '--interviews-file', interviews,
      '--state-root', state,
    ],
  };
}

function command(fx, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, ...fx.common], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = JSON.parse(result.stdout.trim());
  return { ...result, output };
}

function credentials(begin) {
  return ['--run-id', begin.run_id, '--token', begin.token];
}

function candidateDescriptor() {
  return `message_1@${new Date(Date.now() - 5_000).toISOString()}`;
}

function stage(fx, begin, descriptor, mailbox = 'primary') {
  const result = command(
    fx,
    'page',
    ...credentials(begin),
    '--mailbox', mailbox,
    '--query', begin.mailboxes[mailbox].required_query,
    '--page-token', 'START',
    '--next-page-token', 'END',
    '--result-count', '1',
    descriptor,
  );
  assert.equal(result.status, 0, result.stdout);
}

function closeEmptyMailbox(fx, begin, mailbox) {
  const page = command(
    fx,
    'page',
    ...credentials(begin),
    '--mailbox', mailbox,
    '--query', begin.mailboxes[mailbox].required_query,
    '--page-token', 'START',
    '--next-page-token', 'END',
    '--result-count', '0',
  );
  assert.equal(page.status, 0, page.stdout);
  const finish = command(
    fx,
    'mailbox',
    ...credentials(begin),
    '--mailbox', mailbox,
    '--status', 'success',
  );
  assert.equal(finish.status, 0, finish.stdout);
}

function closeEmptySecondary(fx, begin) {
  closeEmptyMailbox(fx, begin, 'secondary');
}

function classifyRejectionAndFinish(fx, begin, descriptor, identity = 'tracker:#1') {
  const classified = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'explicit_rejection',
    '--disposition', 'tracker_rejected',
    '--identity-key', identity,
    descriptor,
  );
  assert.equal(classified.status, 0, classified.stdout);
  const finish = command(
    fx,
    'mailbox',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--status', 'success',
  );
  assert.equal(finish.status, 0, finish.stdout);
  closeEmptySecondary(fx, begin);
  return classified.output;
}

test('begin preserves checked TODOs and commit requires whole-process reconciliation', (t) => {
  const row = '| action:acme-engineer |  | Acme | Engineer | Recruiter Screen | 2026-09-02 | Action Required | 2026-08-31 | |';
  const original = document({ row, todo: '- [x] **Acme Engineer / action:acme-engineer：** Confirm the interview slot' });
  const fx = fixture(t, { interviews: original });
  write(join(fx.careerDocs, 'unrelated.md'), 'keep staged\n');
  git(fx.careerDocs, 'add', 'unrelated.md');
  const priorHead = git(fx.careerDocs, 'rev-parse', 'HEAD');
  const result = command(fx, 'begin');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output.interview_preflight.reconciliation_required, true);
  assert.equal(result.output.interview_preflight.checked_todo_count, 1);
  assert.equal(result.output.interview_preflight.checked_todos[0].identity, 'action:acme-engineer');
  assert.equal(readFileSync(fx.interviews, 'utf8'), original);
  assert.equal(git(fx.careerDocs, 'rev-parse', 'HEAD'), priorHead);
  closeEmptyMailbox(fx, result.output, 'primary');
  closeEmptySecondary(fx, result.output);
  const blocked = command(fx, 'commit', ...credentials(result.output));
  assert.equal(blocked.output.error.code, 'INTERVIEW_RECONCILIATION_REQUIRED');
  write(fx.interviews, document({ row: row.replace('Action Required', 'Scheduled').replace(' | |', ' | Confirmed slot accepted. |') }));
  const committed = command(fx, 'commit', ...credentials(result.output));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(git(fx.careerDocs, 'status', '--porcelain'), 'A  unrelated.md');
  assert.match(readFileSync(fx.interviews, 'utf8'), /Scheduled/u);
});

test('tracker-linked active process must be Interview or Offer before Gmail scanning', (t) => {
  const row = '| tracker:#1 | #1 | Acme | Engineer | Recruiter Screen | 2026-09-02 | Scheduled | 2026-08-31 | |';
  const fx = fixture(t, { interviews: document({ row }) });

  const result = command(fx, 'begin');

  assert.equal(result.status, 1);
  assert.equal(result.output.error.code, 'TRACKER_REGISTER_MISMATCH');
  assert.equal(existsSync(join(fx.state, 'runs/active.json')), false);
});

test('an active process may retain an Offer tracker status', (t) => {
  const row = '| tracker:#1 | #1 | Acme | Engineer | Offer | 2026-09-02 | Waiting | 2026-08-31 | |';
  const fx = fixture(t, { status: 'Offer', interviews: document({ row }) });

  const result = command(fx, 'begin');

  assert.equal(result.status, 0, result.stdout);
});

test('final tracker mismatch fails before committing the interview register', (t) => {
  const fx = fixture(t);
  const priorHead = git(fx.careerDocs, 'rev-parse', 'HEAD');
  const priorState = JSON.parse(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8'));
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  const classified = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'action_required',
    '--disposition', 'register_updated',
    '--identity-key', 'tracker:#1',
    descriptor,
  );
  assert.equal(classified.status, 0, classified.stdout);
  write(fx.interviews, document({
    row: `| tracker:#1 | #1 | Acme | Engineer | Recruiter Screen | 2026-09-02 | Scheduled | 2026-08-31 | ${classified.output.register_markers[0]} |`,
  }));
  assert.equal(command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  ).status, 0);
  assert.equal(command(
    fx,
    'mailbox',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--status', 'success',
  ).status, 0);
  closeEmptySecondary(fx, begin);

  const blocked = command(fx, 'commit', ...credentials(begin));
  assert.equal(blocked.status, 1);
  assert.equal(blocked.output.error.code, 'TRACKER_REGISTER_MISMATCH');
  assert.equal(git(fx.careerDocs, 'rev-parse', 'HEAD'), priorHead);
  assert.equal(
    JSON.parse(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8')).last_successful_run_at,
    priorState.last_successful_run_at,
  );

  write(join(fx.career, 'data/applications.md'), applications('Interview'));
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.notEqual(git(fx.careerDocs, 'rev-parse', 'HEAD'), priorHead);
});

test('tracker rejection needs only a tracker receipt when the baseline is already Rejected', (t) => {
  const eventDate = '2026-08-31';
  const note = `Gmail rejection received ${eventDate} for REQ-123`;
  const statusLog = `1\t${eventDate}\tApplied\tRejected\tset-status\t\n`;
  const fx = fixture(t, { status: 'Rejected', note, statusLog });
  const beginResult = command(fx, 'begin');
  assert.equal(beginResult.status, 0, beginResult.stdout);
  const begin = beginResult.output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  classifyRejectionAndFinish(fx, begin, descriptor);

  const receipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(receipt.status, 0, receipt.stdout);
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.tracker_receipt_count, 1);
  assert.equal(committed.output.writes.register_receipt_count, 0);
});

test('tracker receipt accepts a detailed note only for the exact rejection date', (t) => {
  const eventDate = '2026-08-31';
  const fx = fixture(t, { status: 'Applied' });
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  classifyRejectionAndFinish(fx, begin, descriptor);
  write(
    join(fx.career, 'data/applications.md'),
    applications('Rejected', `Gmail rejection received ${eventDate} for REQ-123`),
  );
  write(
    join(fx.career, 'data/status-log.tsv'),
    `1\t${eventDate}\tApplied\tRejected\tset-status\t\n`,
  );

  const wrongDate = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', '2026-08-30',
    descriptor,
  );
  assert.equal(wrongDate.status, 1);
  assert.equal(wrongDate.output.error.code, 'TRACKER_STATE_MISMATCH');

  const receipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(receipt.status, 0, receipt.stdout);
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.tracker_receipt_count, 1);
});

test('tracker rejection note matching rejects misleading substrings and wrong boundaries', (t) => {
  const eventDate = '2026-08-31';
  const statusLog = `1\t${eventDate}\tApplied\tRejected\tset-status\t\n`;
  for (const note of [
    `Forwarded: Gmail rejection received ${eventDate} for REQ-123`,
    `Gmail rejection received ${eventDate} formerly REQ-123`,
  ]) {
    const fx = fixture(t, { status: 'Rejected', note, statusLog });
    const begin = command(fx, 'begin').output;
    const descriptor = candidateDescriptor();
    stage(fx, begin, descriptor);
    classifyRejectionAndFinish(fx, begin, descriptor);

    const receipt = command(
      fx,
      'receipt',
      ...credentials(begin),
      '--mailbox', 'primary',
      '--target', 'tracker',
      '--event-date', eventDate,
      descriptor,
    );
    assert.equal(receipt.status, 1);
    assert.equal(receipt.output.error.code, 'TRACKER_STATE_MISMATCH');
  }
});

test('help distinguishes mailbox transaction options from direct register commands', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.common_options, undefined);
  assert.equal(
    output.mailbox_transaction_options,
    '--career-ops-root PATH --interviews-file PATH [--state-root PATH]',
  );
  assert.deepEqual(output.allowed_dispositions.application_confirmation, ['no_action']);
  assert.deepEqual(output.allowed_dispositions.explicit_rejection, ['tracker_rejected', 'no_action']);
});

test('page results support selective batched classification and identical page replay', (t) => {
  const fx = fixture(t);
  const statePath = join(fx.state, 'gmail-job-reply-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  write(statePath, JSON.stringify({ ...state, processed_message_ids: ['old_message'] }));
  const begin = command(fx, 'begin').output;
  const received = new Date(Date.parse(begin.mailboxes.primary.scan_cutoff_at) - 1000).toISOString();
  const descriptors = ['new_one', 'old_message', 'new_two'].map(id => `${id}@${received}`);
  descriptors.push(`future_message@${new Date(Date.parse(begin.mailboxes.primary.scan_cutoff_at) + 1000).toISOString()}`);
  const args = [
    'page', ...credentials(begin), '--mailbox', 'primary',
    '--query', begin.mailboxes.primary.required_query,
    '--page-token', 'START', '--next-page-token', 'END',
    '--result-count', '4', ...descriptors,
  ];
  const page = command(fx, ...args);
  assert.equal(page.status, 0, page.stdout);
  assert.deepEqual(page.output.results, descriptors.map((key, index) => ({
    key, status: ['staged', 'previously_committed', 'staged', 'outside_frozen_window'][index],
  })));
  const replay = command(fx, ...args);
  assert.equal(replay.output.idempotent, true);
  assert.deepEqual(replay.output.results, page.output.results);
  const classified = command(fx, 'classify', ...credentials(begin),
    '--mailbox', 'primary', '--category', 'application_confirmation', '--disposition', 'no_action',
    ...page.output.results.filter(item => item.status === 'staged').map(item => item.key));
  assert.equal(classified.output.classified_count, 2);
  assert.equal(command(fx, 'mailbox', ...credentials(begin), '--mailbox', 'primary', '--status', 'success').status, 0);
  closeEmptySecondary(fx, begin);
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.content_classification_complete, true);
  assert.equal(committed.output.writes.receipt_count, 0);
});

test('post-interview rejection requires a verified register receipt', (t) => {
  const activeRow = '| action:acme-engineer | #1 | Acme | Engineer | Recruiter Screen | 2026-08-30 | Waiting | 2026-08-30 | |';
  const fx = fixture(t, { status: 'Interview', interviews: document({ row: activeRow }) });
  const eventDate = '2026-08-31';
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  const classified = classifyRejectionAndFinish(fx, begin, descriptor);
  const marker = classified.register_markers[0];

  write(
    join(fx.career, 'data/applications.md'),
    applications('Rejected', `Gmail rejection received ${eventDate}`),
  );
  write(
    join(fx.career, 'data/status-log.tsv'),
    `1\t${eventDate}\tInterview\tRejected\tset-status\t\n`,
  );
  assert.match(marker, /action:acme-engineer/u);
  const archivedRow = `| action:acme-engineer | #1 | Acme | Engineer | Recruiter Screen | ${eventDate} | Rejected | ${eventDate} | ${marker} |`;
  write(fx.interviews, document({ archivedRow }));

  const trackerReceipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(trackerReceipt.status, 0, trackerReceipt.stdout);
  const blocked = command(fx, 'commit', ...credentials(begin));
  assert.equal(blocked.status, 1);
  assert.equal(blocked.output.error.code, 'WRITE_RECEIPT_MISSING');

  const registerReceipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  );
  assert.equal(registerReceipt.status, 0, registerReceipt.stdout);
  const aborted = command(
    fx,
    'abort',
    ...credentials(begin),
    '--reason-code', 'test_retry',
  );
  assert.equal(aborted.status, 0, aborted.stdout);

  const retry = command(fx, 'begin').output;
  stage(fx, retry, descriptor);
  const retriedClassification = classifyRejectionAndFinish(fx, retry, descriptor);
  assert.deepEqual(retriedClassification.register_markers, [marker]);
  for (const args of [
    ['--target', 'tracker', '--event-date', eventDate],
    ['--target', 'register'],
  ]) {
    const retriedReceipt = command(
      fx,
      'receipt',
      ...credentials(retry),
      '--mailbox', 'primary',
      ...args,
      descriptor,
    );
    assert.equal(retriedReceipt.status, 0, retriedReceipt.stdout);
  }
  const committed = command(fx, 'commit', ...credentials(retry));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.register_receipt_count, 1);
  assert.equal(committed.output.writes.tracker_receipt_count, 1);
});

test('action Identity keeps its process key while tracker receipt binds to its unique Tracker', (t) => {
  const activeRow = '| action:acme-engineer |  | Acme | Engineer | Recruiter Screen | 2026-08-30 | Waiting | 2026-08-30 | |';
  const fx = fixture(t, { interviews: document({ row: activeRow }) });
  const eventDate = '2026-08-31';
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  const wrongProcess = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'explicit_rejection',
    '--disposition', 'tracker_rejected',
    '--identity-key', 'action:not-this-process',
    '--tracker-identity-key', 'tracker:#1',
    descriptor,
  );
  assert.equal(wrongProcess.status, 1);
  assert.equal(wrongProcess.output.error.code, 'INVALID_IDENTITY');
  const classified = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'explicit_rejection',
    '--disposition', 'tracker_rejected',
    '--identity-key', 'action:acme-engineer',
    '--tracker-identity-key', 'tracker:#1',
    descriptor,
  );
  assert.equal(classified.status, 0, classified.stdout);
  const marker = classified.output.register_markers[0];

  write(
    join(fx.career, 'data/applications.md'),
    applications('Rejected', `Gmail rejection received ${eventDate}`),
  );
  write(
    join(fx.career, 'data/status-log.tsv'),
    `1\t${eventDate}\tInterview\tRejected\tset-status\t\n`,
  );
  write(fx.interviews, document({
    archivedRow: `| action:acme-engineer |  | Acme | Engineer | Recruiter Screen | ${eventDate} | Rejected | ${eventDate} | ${marker} |`,
  }));
  const missingBinding = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  );
  assert.equal(missingBinding.status, 1);
  assert.equal(missingBinding.output.error.code, 'INTERVIEW_TRACKER_MISMATCH');

  write(fx.interviews, document({
    archivedRow: `| action:acme-engineer | #1 | Acme | Engineer | Recruiter Screen | ${eventDate} | Rejected | ${eventDate} | ${marker} |`,
  }));
  const receipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(receipt.status, 0, receipt.stdout);
  assert.equal(command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  ).status, 0);
  const ledger = JSON.parse(readFileSync(join(fx.state, 'runs/active.json'), 'utf8'));
  const stored = Object.values(ledger.mailboxes.primary.candidates)[0].classification.receipts
    .find(item => item.target === 'tracker');
  assert.equal(stored.identity_key, 'tracker:#1');
  assert.equal(stored.process_identity_key, 'action:acme-engineer');
});

test('post-interview rejection without a Tracker archives with only a register receipt', (t) => {
  const activeRow = '| action:untracked-interview |  | Untracked Co | Engineer | Recruiter Screen | 2026-08-30 | Waiting | 2026-08-30 | |';
  const fx = fixture(t, { interviews: document({ row: activeRow }) });
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  const classified = classifyRejectionAndFinish(
    fx,
    begin,
    descriptor,
    'action:untracked-interview',
  );
  const eventDate = '2026-08-31';
  write(fx.interviews, document({
    archivedRow: `| action:untracked-interview |  | Untracked Co | Engineer | Recruiter Screen | ${eventDate} | Rejected | ${eventDate} | ${classified.register_markers[0]} |`,
  }));
  const receipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  );
  assert.equal(receipt.status, 0, receipt.stdout);
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.register_receipt_count, 1);
  assert.equal(committed.output.writes.tracker_receipt_count, 0);
});

test('application confirmations permit only no_action', (t) => {
  const fx = fixture(t);
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);

  const rejected = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'application_confirmation',
    '--disposition', 'register_updated',
    '--identity-key', 'action:confirmation',
    descriptor,
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.output.error.code, 'INVALID_ARGUMENT');
  const ignored = command(
    fx,
    'classify',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--category', 'application_confirmation',
    '--disposition', 'no_action',
    descriptor,
  );
  assert.equal(ignored.status, 0, ignored.stdout);
  assert.deepEqual(ignored.output.register_markers, []);
});

test('candidate register markers are stable across aborted retry runs', (t) => {
  const fx = fixture(t);
  const descriptor = candidateDescriptor();

  const first = command(fx, 'begin').output;
  stage(fx, first, descriptor);
  const firstClassification = command(
    fx,
    'classify',
    ...credentials(first),
    '--mailbox', 'primary',
    '--category', 'action_required',
    '--disposition', 'register_updated',
    '--identity-key', 'action:acme-engineer',
    descriptor,
  );
  assert.equal(firstClassification.status, 0, firstClassification.stdout);
  assert.equal(command(
    fx,
    'abort',
    ...credentials(first),
    '--reason-code', 'test_retry',
  ).status, 0);

  const second = command(fx, 'begin').output;
  assert.notEqual(second.run_id, first.run_id);
  stage(fx, second, descriptor);
  const secondClassification = command(
    fx,
    'classify',
    ...credentials(second),
    '--mailbox', 'primary',
    '--category', 'action_required',
    '--disposition', 'register_updated',
    '--identity-key', 'action:acme-engineer',
    descriptor,
  );
  assert.deepEqual(
    secondClassification.output.register_markers,
    firstClassification.output.register_markers,
  );
});

test('a stable register marker is a valid receipt after abort and retry', (t) => {
  const fx = fixture(t);
  const descriptor = candidateDescriptor();
  const first = command(fx, 'begin').output;
  stage(fx, first, descriptor);
  const firstClassification = command(
    fx,
    'classify',
    ...credentials(first),
    '--mailbox', 'primary',
    '--category', 'action_required',
    '--disposition', 'register_updated',
    '--identity-key', 'action:acme-engineer',
    descriptor,
  );
  assert.equal(firstClassification.status, 0, firstClassification.stdout);
  const marker = firstClassification.output.register_markers[0];
  const row = `| action:acme-engineer |  | Acme | Engineer | Recruiter Screen | 2026-09-02 | Scheduled | 2026-08-31 | ${marker} |`;
  write(fx.interviews, document({ row }));
  const firstReceipt = command(
    fx,
    'receipt',
    ...credentials(first),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  );
  assert.equal(firstReceipt.status, 0, firstReceipt.stdout);
  assert.equal(command(
    fx,
    'abort',
    ...credentials(first),
    '--reason-code', 'test_retry',
  ).status, 0);

  const stableDocument = readFileSync(fx.interviews, 'utf8');
  const retry = command(fx, 'begin').output;
  stage(fx, retry, descriptor);
  const retriedClassification = command(
    fx,
    'classify',
    ...credentials(retry),
    '--mailbox', 'primary',
    '--category', 'action_required',
    '--disposition', 'register_updated',
    '--identity-key', 'action:acme-engineer',
    descriptor,
  );
  assert.deepEqual(retriedClassification.output.register_markers, [marker]);
  for (const mailbox of ['primary', 'secondary']) {
    if (mailbox === 'secondary') closeEmptySecondary(fx, retry);
    else {
      const finish = command(
        fx,
        'mailbox',
        ...credentials(retry),
        '--mailbox', mailbox,
        '--status', 'success',
      );
      assert.equal(finish.status, 0, finish.stdout);
    }
  }
  const retriedReceipt = command(
    fx,
    'receipt',
    ...credentials(retry),
    '--mailbox', 'primary',
    '--target', 'register',
    descriptor,
  );
  assert.equal(retriedReceipt.status, 0, retriedReceipt.stdout);
  const committed = command(fx, 'commit', ...credentials(retry));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.register_receipt_count, 1);
  assert.equal(readFileSync(fx.interviews, 'utf8'), stableDocument);
});

test('a missing required receipt blocks Git commit and cursor advancement', (t) => {
  const fx = fixture(t);
  const original = JSON.parse(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8'));
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  classifyRejectionAndFinish(fx, begin, descriptor);
  const head = git(fx.careerDocs, 'rev-parse', 'HEAD');
  const edited = readFileSync(fx.interviews, 'utf8').replace('# Interview Pipeline', '# Updated Interview Pipeline');
  write(fx.interviews, edited);

  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 1);
  assert.equal(committed.output.error.code, 'WRITE_RECEIPT_MISSING');
  assert.equal(git(fx.careerDocs, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(fx.interviews, 'utf8'), edited);
  const after = JSON.parse(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8'));
  assert.equal(after.last_successful_run_at, original.last_successful_run_at);
  assert.equal(existsSync(join(fx.state, 'runs/active.json')), true);
});

test('verification failure preserves the uncommitted register until a successful retry', (t) => {
  const fx = fixture(t);
  const begin = command(fx, 'begin').output;
  closeEmptyMailbox(fx, begin, 'primary');
  closeEmptySecondary(fx, begin);
  const head = git(fx.careerDocs, 'rev-parse', 'HEAD');
  const cursor = readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8');
  const edited = readFileSync(fx.interviews, 'utf8').replace('# Interview Pipeline', '# Updated Interview Pipeline');
  write(fx.interviews, edited);
  write(join(fx.career, '.fail-verify'), '1');
  const failed = command(fx, 'commit', ...credentials(begin));
  assert.equal(failed.output.error.code, 'VERIFICATION_GATE_FAILED');
  assert.equal(git(fx.careerDocs, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(fx.interviews, 'utf8'), edited);
  assert.equal(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8'), cursor);
  rmSync(join(fx.career, '.fail-verify'));
  const retried = command(fx, 'commit', ...credentials(begin));
  assert.equal(retried.status, 0, retried.stdout);
  assert.notEqual(git(fx.careerDocs, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.careerDocs, 'show', 'HEAD:context/Interview/active-interviews.md'), edited.trim());
});

test('invalid interview structure fails before a run ledger is created', (t) => {
  const duplicate = '| action:duplicate |  | Acme | Engineer | Screen |  | Waiting | 2026-08-31 | |';
  const fx = fixture(t, {
    interviews: document({ row: duplicate, archivedRow: duplicate.replace('Waiting', 'Rejected') }),
  });

  const result = command(fx, 'begin');

  assert.equal(result.status, 1);
  assert.equal(result.output.error.code, 'ACTIVE_INTERVIEWS_INVALID');
  assert.equal(result.output.error.errors[0].code, 'identity_in_active_and_archive');
  assert.equal(existsSync(join(fx.state, 'runs/active.json')), false);
});

test('preflight and final gate refuse to delete admitted process identities', (t) => {
  const archived = '| action:old-role |  | Old Co | Engineer | Recruiter Screen | 2026-08-20 | Rejected | 2026-08-21 | closed |';
  const preflightFx = fixture(t, { interviews: document({ archivedRow: archived }) });
  write(preflightFx.interviews, document());
  const preflight = command(preflightFx, 'begin');
  assert.equal(preflight.status, 1);
  assert.equal(preflight.output.error.code, 'ACTIVE_INTERVIEWS_INVALID');
  assert.equal(preflight.output.error.errors[0].code, 'process_removed');
  assert.match(git(preflightFx.careerDocs, 'show', 'HEAD:context/Interview/active-interviews.md'), /action:old-role/u);

  const active = '| action:current-role |  | Current Co | Engineer | Recruiter Screen | 2026-08-30 | Waiting | 2026-08-30 | |';
  const finalFx = fixture(t, { interviews: document({ row: active }) });
  const begin = command(finalFx, 'begin').output;
  closeEmptyMailbox(finalFx, begin, 'primary');
  closeEmptySecondary(finalFx, begin);
  write(finalFx.interviews, document());
  const committed = command(finalFx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 1);
  assert.equal(committed.output.error.code, 'ACTIVE_INTERVIEWS_INVALID');
  assert.equal(committed.output.error.errors[0].code, 'process_removed');
  assert.match(git(finalFx.careerDocs, 'show', 'HEAD:context/Interview/active-interviews.md'), /action:current-role/u);
});

test('receipts refresh after mailbox finish and verification failure', (t) => {
  const fx = fixture(t);
  const eventDate = '2026-08-31';
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  classifyRejectionAndFinish(fx, begin, descriptor);

  write(
    join(fx.career, 'data/applications.md'),
    applications('Rejected', `Gmail rejection received ${eventDate}`),
  );
  write(
    join(fx.career, 'data/status-log.tsv'),
    `1\t${eventDate}\tApplied\tRejected\tset-status\t\n`,
  );
  const receipt = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(receipt.status, 0, receipt.stdout);

  write(join(fx.career, '.fail-verify'), 'fail\n');
  const failed = command(fx, 'commit', ...credentials(begin));
  assert.equal(failed.status, 1);
  assert.equal(failed.output.error.code, 'VERIFICATION_GATE_FAILED');

  write(
    join(fx.career, 'data/status-log.tsv'),
    `1\t${eventDate}\tApplied\tRejected\tset-status\t\n2\t${eventDate}\tApplied\tInterview\tset-status\t\n`,
  );
  const refreshed = command(
    fx,
    'receipt',
    ...credentials(begin),
    '--mailbox', 'primary',
    '--target', 'tracker',
    '--event-date', eventDate,
    descriptor,
  );
  assert.equal(refreshed.status, 0, refreshed.stdout);
  assert.equal(refreshed.output.idempotent_count, 1);
  rmSync(join(fx.career, '.fail-verify'));

  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  const state = JSON.parse(readFileSync(join(fx.state, 'gmail-job-reply-state.json'), 'utf8'));
  assert.equal(state.last_successful_run_at, begin.mailboxes.primary.scan_cutoff_at);
});

test('linked receipts bind exact sections, detect summary edits, and commit only changed linked files', t => {
  const fx = fixture(t);
  const unrelated = join(fx.careerDocs, 'context/Interview/Other/process-summary.md');
  write(unrelated, 'Unrelated staged summary\n');
  git(fx.careerDocs, 'add', 'context/Interview/Other/process-summary.md');
  const begin = command(fx, 'begin').output;
  const descriptor = candidateDescriptor();
  stage(fx, begin, descriptor);
  const classified = command(fx, 'classify', ...credentials(begin), '--mailbox', 'primary', '--category', 'action_required', '--disposition', 'register_updated', '--identity-key', 'action:acme-engineer', descriptor);
  assert.equal(classified.status, 0, classified.stdout);
  const marker = classified.output.register_markers[0];
  const summaryPath = join(fx.careerDocs, 'context/Interview/Acme/process-summary.md');
  const summary = (first, other = '') => `# Acme\n\n## action-acme-engineer\nIdentity: \`action:acme-engineer\`\n${first}\n\n## action-acme-other\nIdentity: \`action:acme-other\`\n${other}\n`;
  write(fx.interviews, document({ row: '| action:acme-engineer |  | Acme | Engineer | Recruiter Screen | 2026-09-02 | Scheduled | 2026-08-31 | [Process summary](Acme/process-summary.md#action-acme-engineer) |' }));
  write(summaryPath, summary('Scheduled.', marker));
  const receiptArgs = ['receipt', ...credentials(begin), '--mailbox', 'primary', '--target', 'register', descriptor];
  assert.equal(command(fx, ...receiptArgs).output.error.code, 'REGISTER_RECEIPT_MISSING');
  write(summaryPath, summary(`Scheduled. ${marker}`));
  assert.equal(command(fx, ...receiptArgs).status, 0);
  assert.equal(command(fx, 'mailbox', ...credentials(begin), '--mailbox', 'primary', '--status', 'success').status, 0);
  closeEmptySecondary(fx, begin);
  write(summaryPath, summary(`Scheduled. ${marker}`, 'Concurrent note.'));
  assert.equal(command(fx, 'commit', ...credentials(begin)).output.error.code, 'REGISTER_RECEIPT_STALE');
  assert.equal(command(fx, ...receiptArgs).status, 0);
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(git(fx.careerDocs, 'status', '--porcelain'), 'A  context/Interview/Other/process-summary.md');
  assert.deepEqual(git(fx.careerDocs, 'show', '--pretty=format:', '--name-only', 'HEAD').split('\n').sort(), ['context/Interview/Acme/process-summary.md', 'context/Interview/active-interviews.md']);
});

test('commit preserves baseline summary edits and refuses to combine them with new run changes', t => {
  const fx = fixture(t);
  const summaryPath = join(fx.careerDocs, 'context/Interview/Acme/process-summary.md');
  const summary = '# Acme\n\n## action-acme-engineer\nIdentity: `action:acme-engineer`\nScheduled.\n';
  write(summaryPath, summary);
  write(fx.interviews, document({ row: '| action:acme-engineer |  | Acme | Engineer | Screen | 2026-09-02 | Scheduled | 2026-08-31 | [Process summary](Acme/process-summary.md#action-acme-engineer) |' }));
  git(fx.careerDocs, 'add', 'context/Interview/active-interviews.md', 'context/Interview/Acme/process-summary.md');
  git(fx.careerDocs, 'commit', '-qm', 'linked baseline');
  write(summaryPath, summary + 'Pre-existing staged note.\n');
  git(fx.careerDocs, 'add', 'context/Interview/Acme/process-summary.md');
  const staged = git(fx.careerDocs, 'show', ':context/Interview/Acme/process-summary.md');
  const begin = command(fx, 'begin').output;
  closeEmptyMailbox(fx, begin, 'primary');
  closeEmptySecondary(fx, begin);
  write(summaryPath, summary + 'Pre-existing staged note.\nNew run note.\n');
  const blocked = command(fx, 'commit', ...credentials(begin));
  assert.equal(blocked.output.error.code, 'GIT_COMMIT_CONFLICT');
  assert.equal(git(fx.careerDocs, 'show', ':context/Interview/Acme/process-summary.md'), staged);
});

test('summary-only updates commit and report a change while preserving the register bytes', t => {
  const fx = fixture(t);
  const summaryPath = join(fx.careerDocs, 'context/Interview/Acme/process-summary.md');
  write(summaryPath, '# Acme\n\n## action-acme-engineer\nIdentity: `action:acme-engineer`\nScheduled.\n');
  const register = document({ row: '| action:acme-engineer |  | Acme | Engineer | Screen | 2026-09-02 | Scheduled | 2026-08-31 | [Process summary](Acme/process-summary.md#action-acme-engineer) |' });
  write(fx.interviews, register);
  git(fx.careerDocs, 'add', 'context/Interview');
  git(fx.careerDocs, 'commit', '-qm', 'linked baseline');
  const begin = command(fx, 'begin').output;
  closeEmptyMailbox(fx, begin, 'primary');
  closeEmptySecondary(fx, begin);
  write(summaryPath, readFileSync(summaryPath, 'utf8') + 'Recruiter confirmed the interviewer name.\n');
  const committed = command(fx, 'commit', ...credentials(begin));
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal(committed.output.writes.interview_evidence_changed, true);
  assert.equal(readFileSync(fx.interviews, 'utf8'), register);
  assert.equal(git(fx.careerDocs, 'show', '--pretty=format:', '--name-only', 'HEAD'), 'context/Interview/Acme/process-summary.md');
});
