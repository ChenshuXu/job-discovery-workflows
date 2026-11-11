import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PROJECT_ROOT, 'src/scan-pending.mjs');
const HOUR = 3600 * 1000;

function runsRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scan-pending-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Every file of the run gets the same age, as after a coordinator that died that long ago.
function age(dir, ms) {
  const when = new Date(Date.now() - ms);
  for (const name of readdirSync(dir, { recursive: true })) utimesSync(path.join(dir, name), when, when);
  utimesSync(dir, when, when);
}

function run(root, id, files, ageMs = 2 * HOUR) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const file of ['baseline.json', ...files]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), '{}');
  }
  age(dir, ageMs);
  return dir;
}

function pending(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, '--runs', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a run whose session died after sources finished is pending at preparation', t => {
  const root = runsRoot(t);
  run(root, '20261104-220232', ['source-run.json']);
  const report = pending(root);
  assert.equal(report.status, 'PENDING');
  assert.deepEqual(report.runs.map(r => [r.run_id, r.stage]), [['20261104-220232', 'prepare']]);
  assert.match(report.runs[0].next_action, /daily-scan:prepare/);
});

test('each saved stage maps to the recovery row that owns it', t => {
  const root = runsRoot(t);
  run(root, '20261101-100000', []);
  run(root, '20261101-110000', ['source-run.json', 'triage/canonical-url-resolutions.json']);
  run(root, '20261101-120000', ['source-run.json', 'assignments.json']);
  run(root, '20261101-130000', ['source-run.json', 'assignments.json', 'rendered-reports.json']);
  const report = pending(root, '--max-age-hours', '1000000');
  assert.deepEqual(report.runs.map(r => r.stage).sort(), ['commit', 'planning', 'sources', 'workers']);
});

test('finished, abandoned-before-baseline and non-run directories are not pending', t => {
  const root = runsRoot(t);
  run(root, '20261104-220232', ['receipt.json']);
  mkdirSync(path.join(root, '20261104-230000'));
  run(root, 'installation-preview', []);
  assert.equal(pending(root).status, 'NONE');
});

test('a run past the recovery window is left alone', t => {
  const root = runsRoot(t);
  run(root, '20261001-220000', ['source-run.json'], 72 * HOUR);
  assert.deepEqual(pending(root), { status: 'NONE', runs: [] });
});

test('a run still writing artifacts is active, even when only a nested file moved', t => {
  const root = runsRoot(t);
  const dir = run(root, '20261104-220232', ['assignments.json', 'results/worker-1.json']);
  const recent = new Date();
  utimesSync(path.join(dir, 'results/worker-1.json'), recent, recent);
  const report = pending(root);
  assert.equal(report.status, 'ACTIVE');
  assert.equal(report.runs[0].active_reason, 'recent_artifacts');
});

test('a quiet run with a live adapter is active, not recoverable', async t => {
  const root = runsRoot(t);
  const id = '20261104-220232';
  run(root, id, []);
  const adapter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--run-id', id], { stdio: 'ignore' });
  t.after(() => adapter.kill('SIGKILL'));
  await delay(200);
  const report = pending(root);
  assert.equal(report.status, 'ACTIVE');
  assert.equal(report.runs[0].active_reason, 'live_process');
});

test('an active run does not hide another run that needs recovery', t => {
  const root = runsRoot(t);
  run(root, '20261104-220232', ['source-run.json']);
  run(root, '20261105-220000', [], 60 * 1000);
  const report = pending(root);
  assert.equal(report.status, 'PENDING');
  assert.deepEqual(report.runs.map(r => [r.run_id, r.state]), [['20261104-220232', 'PENDING'], ['20261105-220000', 'ACTIVE']]);
});

test('checking changes nothing in the run', t => {
  const root = runsRoot(t);
  const dir = run(root, '20261104-220232', ['source-run.json']);
  const before = readdirSync(dir, { recursive: true }).sort();
  const mtime = statSync(dir).mtimeMs;
  pending(root);
  assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
  assert.equal(statSync(dir).mtimeMs, mtime);
});

test('an interrupted PERM run is pending and a closed one is not', t => {
  const root = runsRoot(t);
  run(root, 'perm-20261104-220232', ['source-run.json', 'assignments.json']);
  run(root, 'perm-20261103-220232', ['source-run.json', 'assignments.json', 'receipt.json']);
  const report = pending(root);
  assert.equal(report.status, 'PENDING');
  assert.deepEqual(report.runs.map(r => [r.run_id, r.stage]), [['perm-20261104-220232', 'workers']]);
});
