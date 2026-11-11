import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { snapshotAdapterProfile } from '../src/adapter-registry.mjs';
import { runAdapters } from '../src/run-adapters.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(PROJECT_ROOT, 'src/run-adapters.mjs');

// Each invocation takes the next behaviour from its plan: success, hang or crash.
const ADAPTER = `import fs from 'node:fs';
import path from 'node:path';
const [plan, adapter] = process.argv.slice(2, 4);
const value = key => process.argv[process.argv.indexOf(key) + 1];
const id = value('--run-id'), root = path.join(value('--discovery-root'), 'runs', id);
const calls = path.join(root, adapter + '.calls');
const count = fs.existsSync(calls) ? Number(fs.readFileSync(calls, 'utf8')) : 0;
fs.writeFileSync(calls, String(count + 1));
const step = plan.split(',')[count];
const dir = path.join(root, 'sources', adapter);
if (step === 'crash') process.exit(3);
if (step === 'fail') {
  fs.mkdirSync(dir + '/jobs', { recursive: true });
  fs.writeFileSync(dir + '/excluded-employers.json', JSON.stringify({ schema_version: 1, run_id: id, excluded_count: 0, results: [] }));
  fs.writeFileSync(dir + '/summary.json', JSON.stringify({ schema_version: 1, run_id: id, adapter, status: 'FAILED', raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, errors: 1, retryable: false, failure_class: 'MULTIPLE_FAILURES' }));
  process.exit(1);
}
fs.mkdirSync(dir + '/jobs', { recursive: true });
fs.writeFileSync(dir + '/jobs/job.md', 'captured');
if (step === 'hang') { fs.writeFileSync(path.join(root, adapter + '.pid'), String(process.pid)); setInterval(() => {}, 1000); }
else {
  fs.writeFileSync(dir + '/excluded-employers.json', JSON.stringify({ schema_version: 1, run_id: id, excluded_count: 0, results: [] }));
  fs.writeFileSync(dir + '/summary.json', JSON.stringify({ schema_version: 1, run_id: id, adapter, status: 'SUCCESS', raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0 }));
}
`;

function fixture(t, plans) {
  mkdirSync(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  const runRoot = mkdtempSync(path.join(PROJECT_ROOT, 'runs', 'source-resume-'));
  const pids = [];
  t.after(() => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(runRoot, { recursive: true, force: true });
  });
  const script = path.join(runRoot, 'adapter.mjs');
  writeFileSync(script, ADAPTER);
  const profile = snapshotAdapterProfile();
  const adapters = Object.keys(plans);
  profile.adapters = adapters;
  profile.minimum_successful_adapters = 1;
  profile.adapter_definitions = Object.fromEntries(adapters.map(id => [id, { ...profile.adapter_definitions[id], command: ['node', script, plans[id], id], timeout_ms: 60000 }]));
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: profile }));
  return { runRoot, pids };
}

const calls = (runRoot, adapter) => {
  const file = path.join(runRoot, `${adapter}.calls`);
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
};

async function waitFor(file) {
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

// Reproduces a host crash: runner and adapter both die with no chance to record anything.
async function killMidCapture({ runRoot, pids }, adapter) {
  const runner = spawn(process.execPath, [RUNNER, '--run', runRoot], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  pids.push(runner.pid);
  const closed = new Promise(resolve => runner.once('close', resolve));
  const pidFile = path.join(runRoot, `${adapter}.pid`);
  await waitFor(pidFile);
  process.kill(runner.pid, 'SIGKILL');
  await closed;
  process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  rmSync(pidFile);
  await delay(100);
}

function interruptedSource(runRoot, adapter) {
  mkdirSync(path.join(runRoot, 'sources', adapter, 'jobs'), { recursive: true });
  writeFileSync(path.join(runRoot, 'sources', adapter, 'jobs/job.md'), 'captured');
}

test('resume recovers a host crash through the CLI without asking anyone', async t => {
  const fx = fixture(t, { 'ego-browser': 'hang,success', jobright: 'success' });
  await killMidCapture(fx, 'ego-browser');
  assert.equal(existsSync(path.join(fx.runRoot, 'sources/ego-browser/summary.json')), false);

  const output = JSON.parse(execFileSync(process.execPath, [RUNNER, '--run', fx.runRoot, '--resume', '--full'], { cwd: PROJECT_ROOT, encoding: 'utf8' }));

  assert.equal(output.status, 'SUCCESS');
  assert.deepEqual(output.resume, { retried_interrupted: ['ego-browser'], started: ['jobright'], abandoned: [] });
  assert.ok(existsSync(path.join(fx.runRoot, 'adapter-attempts/ego-browser-attempt-1/jobs/job.md')));
  assert.equal(existsSync(path.join(fx.runRoot, 'adapter-attempts/jobright-attempt-1')), false, 'a source that never ran keeps its retry');
  assert.equal(JSON.parse(readFileSync(path.join(fx.runRoot, 'source-run.json'))).status, 'SUCCESS');
});

test('a plain retry accepts an interrupted source without user authorization', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'success' });
  interruptedSource(runRoot, 'ego-browser');
  assert.equal(runAdapters({ runRoot, retry: 'ego-browser' }).status, 'SUCCESS');
  assert.equal(calls(runRoot, 'ego-browser'), 1);
});

test('resume and retry refuse while an adapter of this run is alive and change nothing', async t => {
  const fx = fixture(t, { 'ego-browser': 'success' });
  interruptedSource(fx.runRoot, 'ego-browser');
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--run-id', path.basename(fx.runRoot)], { stdio: 'ignore' });
  fx.pids.push(alive.pid);
  await delay(200);
  for (const options of [{ resume: true }, { retry: 'ego-browser' }]) {
    assert.throws(() => runAdapters({ runRoot: fx.runRoot, ...options }), /still running/);
  }
  assert.equal(calls(fx.runRoot, 'ego-browser'), 0);
  assert.ok(existsSync(path.join(fx.runRoot, 'sources/ego-browser/jobs/job.md')));
  assert.equal(existsSync(path.join(fx.runRoot, 'adapter-attempts')), false);
});

test('resume refuses while another runner of this run is alive, even between adapters', async t => {
  const fx = fixture(t, { 'ego-browser': 'success' });
  const runner = path.join(fx.runRoot, 'run-adapters.mjs');
  writeFileSync(runner, 'setInterval(() => {}, 1000);');
  const alive = spawn(process.execPath, [runner, '--run', fx.runRoot], { stdio: 'ignore' });
  fx.pids.push(alive.pid);
  await delay(200);
  assert.throws(() => runAdapters({ runRoot: fx.runRoot, resume: true }), /still running/);
  assert.equal(calls(fx.runRoot, 'ego-browser'), 0);
});

test('resume leaves finished sources alone', t => {
  const { runRoot } = fixture(t, { jobspy: 'success', jobright: 'success' });
  runAdapters({ runRoot });
  const output = runAdapters({ runRoot, resume: true });
  assert.equal(output.status, 'SUCCESS');
  assert.deepEqual(output.resume, { retried_interrupted: [], started: [], abandoned: [] });
  assert.equal(calls(runRoot, 'jobspy'), 1);
  assert.equal(calls(runRoot, 'jobright'), 1);
});

test('a second interruption ends as a failed source, keeps both captures archived and does not loop', async t => {
  const fx = fixture(t, { 'ego-browser': 'hang,hang', jobright: 'success' });
  await killMidCapture(fx, 'ego-browser');
  const resumed = spawn(process.execPath, [RUNNER, '--run', fx.runRoot, '--resume'], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  fx.pids.push(resumed.pid);
  const closed = new Promise(resolve => resumed.once('close', resolve));
  const pidFile = path.join(fx.runRoot, 'ego-browser.pid');
  await waitFor(pidFile);
  process.kill(resumed.pid, 'SIGKILL');
  await closed;
  process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  await delay(100);

  const output = runAdapters({ runRoot: fx.runRoot, resume: true });

  assert.equal(output.status, 'DEGRADED');
  assert.deepEqual(output.successful_adapters, ['jobright']);
  assert.deepEqual(output.resume.abandoned, ['ego-browser']);
  assert.equal(calls(fx.runRoot, 'ego-browser'), 2);
  const summary = JSON.parse(readFileSync(path.join(fx.runRoot, 'sources/ego-browser/summary.json')));
  assert.equal(summary.failure_class, 'ADAPTER_INTERRUPTED');
  assert.equal(summary.retryable, false);
  assert.equal(summary.markdown_jobs, 0, 'a killed process can truncate its last JD, so its captures stay out of acquisition');
  assert.ok(existsSync(path.join(fx.runRoot, 'adapter-attempts/ego-browser-attempt-1/jobs/job.md')));
  assert.ok(existsSync(path.join(fx.runRoot, 'adapter-attempts/ego-browser-attempt-2/jobs/job.md')));
  assert.throws(() => runAdapters({ runRoot: fx.runRoot, retry: 'ego-browser' }), /non-retryable/);
});

test('an adapter that crashed by itself is not treated as interrupted', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'crash,success' });
  assert.throws(() => runAdapters({ runRoot }), /summary\.json missing/);
  assert.throws(() => runAdapters({ runRoot, retry: 'ego-browser' }), /not classified as retryable/);
  assert.throws(() => runAdapters({ runRoot, resume: true }), /summary\.json missing/);
  assert.equal(calls(runRoot, 'ego-browser'), 1);
});

test('an adapter killed by a signal while its runner survived counts as interrupted', async t => {
  const fx = fixture(t, { 'ego-browser': 'hang,success' });
  const runner = spawn(process.execPath, [RUNNER, '--run', fx.runRoot], { cwd: PROJECT_ROOT, stdio: 'ignore' });
  fx.pids.push(runner.pid);
  const closed = new Promise(resolve => runner.once('close', resolve));
  const pidFile = path.join(fx.runRoot, 'ego-browser.pid');
  await waitFor(pidFile);
  process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  await closed;
  assert.equal(runAdapters({ runRoot: fx.runRoot, resume: true }).status, 'SUCCESS');
});

test('an unreadable summary is not retried by resume', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'success' });
  mkdirSync(path.join(runRoot, 'sources/ego-browser'), { recursive: true });
  writeFileSync(path.join(runRoot, 'sources/ego-browser/summary.json'), '{not json');
  assert.throws(() => runAdapters({ runRoot, resume: true }), /invalid summary\.json/);
  assert.equal(calls(runRoot, 'ego-browser'), 0);
  assert.equal(existsSync(path.join(runRoot, 'adapter-attempts')), false);
});

test('a kill before the source directory exists is interrupted, not a log collision', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'success' });
  mkdirSync(path.join(runRoot, 'adapter-attempts'));
  writeFileSync(path.join(runRoot, 'adapter-attempts/ego-browser-attempt-1.stdout.log'), '');
  writeFileSync(path.join(runRoot, 'adapter-attempts/ego-browser-attempt-1.stderr.log'), '');
  const output = runAdapters({ runRoot, resume: true });
  assert.equal(output.status, 'SUCCESS');
  assert.deepEqual(output.resume.retried_interrupted, ['ego-browser']);
});

test('resume keeps the closed-run guard and rejects being combined with retry', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'success' });
  const cli = args => spawnSync(process.execPath, [RUNNER, '--run', runRoot, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.match(cli(['--resume', '--retry', 'ego-browser']).stderr, /cannot be combined/);
  assert.match(cli(['--resume', '--dry-run']).stderr, /cannot be combined/);
  writeFileSync(path.join(runRoot, 'receipt.json'), '{}');
  assert.throws(() => runAdapters({ runRoot, resume: true }), /closed for this run/);
  assert.deepEqual(readdirSync(runRoot).filter(name => name === 'sources'), []);
});

// Stands in for the host tools, so a test decides whether the machine slept during the attempt.
// A sleep is logged at the moment the adapter last started, which always lies inside its attempt.
function hostTools(t, { slept }) {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'runs', 'source-resume-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const line = slept ? `echo "$(date -r "${slept}" '+%Y-%m-%d %H:%M:%S %z') Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active"` : '';
  writeFileSync(path.join(dir, 'pmset'), `#!/bin/sh\necho "2020-01-01 00:00:00 +0000 Sleep               \tEntering Sleep state due to 'Idle Sleep'"\n${line}\n`);
  writeFileSync(path.join(dir, 'caffeinate'), `#!/bin/sh\necho "$@" > "${dir}/caffeinate.args"\n`);
  for (const tool of ['pmset', 'caffeinate']) chmodSync(path.join(dir, tool), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

const runCli = (runRoot, env, ...args) => spawnSync(process.execPath, [RUNNER, '--run', runRoot, ...args], { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
const summary = (runRoot, adapter) => JSON.parse(readFileSync(path.join(runRoot, 'sources', adapter, 'summary.json'), 'utf8'));

test('a source that failed while the host slept gets its one retry and keeps its failure class', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'fail,success', jobspy: 'success' });
  const { env } = hostTools(t, { slept: path.join(runRoot, 'ego-browser.calls') });
  assert.equal(runCli(runRoot, env).status, 0);
  const failed = summary(runRoot, 'ego-browser');
  assert.equal(failed.retryable, true);
  assert.equal(failed.failure_class, 'MULTIPLE_FAILURES');
  assert.ok(failed.host_sleeps >= 1);
  assert.equal(summary(runRoot, 'jobspy').status, 'SUCCESS');
  assert.equal(runCli(runRoot, env, '--retry', 'ego-browser').status, 0);
  assert.equal(summary(runRoot, 'ego-browser').status, 'SUCCESS');
});

test('a source that failed with the host awake stays non-retryable, whatever older sleeps the log holds', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'fail', jobspy: 'success' });
  const { env } = hostTools(t, { slept: false });
  assert.equal(runCli(runRoot, env).status, 0);
  assert.equal(summary(runRoot, 'ego-browser').retryable, false);
  assert.equal('host_sleeps' in summary(runRoot, 'ego-browser'), false);
  assert.notEqual(runCli(runRoot, env, '--retry', 'ego-browser').status, 0);
});

test('a second failure across a sleep cannot earn another retry', t => {
  const { runRoot } = fixture(t, { 'ego-browser': 'fail,fail,success', jobspy: 'success' });
  const { env } = hostTools(t, { slept: path.join(runRoot, 'ego-browser.calls') });
  runCli(runRoot, env);
  runCli(runRoot, env, '--retry', 'ego-browser');
  assert.notEqual(runCli(runRoot, env, '--retry', 'ego-browser').status, 0);
  assert.equal(calls(runRoot, 'ego-browser'), 2);
});

test('the runner holds the host awake for itself during acquisition, but not for a dry run', { skip: process.platform !== 'darwin' }, async t => {
  const { runRoot } = fixture(t, { jobspy: 'success' });
  const { dir, env } = hostTools(t, { slept: false });
  runCli(runRoot, env, '--dry-run');
  await delay(100);
  assert.equal(existsSync(path.join(dir, 'caffeinate.args')), false);
  assert.equal(runCli(runRoot, env).status, 0);
  await waitFor(path.join(dir, 'caffeinate.args'));
  assert.match(readFileSync(path.join(dir, 'caffeinate.args'), 'utf8'), /^-i -s -w \d+\n$/);
});
