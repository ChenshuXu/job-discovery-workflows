import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLinkedIn } from '../adapters/egobrowser_linkedin_scan.mjs';

const JOBSPY = fileURLToPath(new URL('../adapters/jobspy_linkedin_scan.py', import.meta.url));
const EGO = fileURLToPath(new URL('../adapters/egobrowser_linkedin_scan.mjs', import.meta.url));
const CONFIG = fileURLToPath(new URL('../config/jobspy-ego.json', import.meta.url));

test('both LinkedIn adapters derive scope from jobspy-ego.json with no local fallback', () => {
  const expected = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const jobspy = JSON.parse(execFileSync('python3', [JOBSPY, '--dry-run', '--run-id', 'scope-test'], { encoding: 'utf8' }));
  const ego = JSON.parse(execFileSync(process.execPath, [EGO, '--dry-run', '--run-id', 'scope-test'], { encoding: 'utf8' }));
  for (const actual of [jobspy, ego]) {
    assert.equal(actual.location, expected.location);
    assert.equal(actual.hours_old, expected.max_post_age_hours);
    assert.equal(actual.results_wanted, expected.results_wanted);
    assert.deepEqual(actual.queries, expected.queries);
    assert.deepEqual(actual.employer_exclusions, expected.employer_exclusions);
    assert.equal(actual.discovery_root.startsWith('/'), true);
  }
  assert.deepEqual(ego.direct_search, expected.direct_search);
  assert.deepEqual(ego.top_applicant_recommendations, expected.top_applicant_recommendations);
});

test('adapter scope overrides are rejected', () => {
  for (const [command, args] of [
    ['python3', [JOBSPY, '--dry-run', '--query', 'override']],
    [process.execPath, [EGO, '--dry-run', '--location', 'override']],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unrecognized arguments|Unknown argument/);
  }
});

test('LinkedIn direct search and recommendations can be selected independently', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-source-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config.direct_search = { enabled: false, required: false };
  config.top_applicant_recommendations = { ...config.top_applicant_recommendations, enabled: true, required: true };
  delete config.queries;
  writeFileSync(configFile, JSON.stringify(config));

  const recommendationOnly = JSON.parse(execFileSync(process.execPath, [EGO, '--dry-run', '--config', configFile], { encoding: 'utf8' }));
  assert.equal(recommendationOnly.direct_search.enabled, false);
  assert.equal(recommendationOnly.top_applicant_recommendations.enabled, true);

  config.top_applicant_recommendations = { ...config.top_applicant_recommendations, enabled: false, required: false };
  writeFileSync(configFile, JSON.stringify(config));
  const none = spawnSync(process.execPath, [EGO, '--dry-run', '--config', configFile], { encoding: 'utf8' });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /at least one LinkedIn source must be enabled/);
});

test('JobSpy adapter bootstraps into the repository venv before scanning', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jobspy-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(root, '.venv')]);
  const result = JSON.parse(execFileSync('python3', [JOBSPY, '--runtime-check', '--jobspy-root', root], { encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(path.resolve(result.prefix), path.resolve(result.venv));
});

test('Node LinkedIn launcher preserves exit codes, archives failures, and always cleans up', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'ego-browser');
  const log = path.join(root, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const input = fs.readFileSync(0, 'utf8');
if (input.includes('await collectLinkedIn(')) {
  const config = JSON.parse(input.match(/await collectLinkedIn\\((.*)\\)/)[1]);
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(config) + '\\n');
  if (process.env.WRITE_SUMMARY === 'yes') {
    const dir = path.join(config.discovery_root, 'runs', config.run_id, 'sources/ego-browser');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ status: process.env.SCAN_STATUS }));
  }
  process.exitCode = Number(process.env.SCAN_EXIT);
} else {
  fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ cleanup: true }) + '\\n');
  process.exitCode = Number(process.env.CLEANUP_EXIT);
}
`);
  chmodSync(executable, 0o755);
  const invoke = (runId, scanExit, cleanupExit, summary = '') => spawnSync(process.execPath,
    [EGO, '--discovery-root', '.', '--run-id', runId], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: root, CALL_LOG: log, SCAN_EXIT: String(scanExit), CLEANUP_EXIT: String(cleanupExit), WRITE_SUMMARY: summary ? 'yes' : 'no', SCAN_STATUS: summary },
    });
  for (const [id, scan, cleanup, summary, expected] of [
    ['success', 0, 0, 'SUCCESS', 0],
    ['empty', 3, 0, 'EMPTY', 3],
    ['failed', 7, 9, '', 7],
    ['cleanup-failed', 0, 9, 'SUCCESS', 9],
    ['missing-summary', 0, 0, '', 1],
  ]) {
    const result = invoke(id, scan, cleanup, summary);
    assert.equal(result.status, expected, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.at(-2).discovery_root, realpathSync(root));
    assert.deepEqual(calls.at(-1), { cleanup: true });
    if (!summary) {
      const source = path.join(root, 'runs', id, 'sources/ego-browser');
      assert.equal(JSON.parse(readFileSync(path.join(source, 'summary.json'))).status, 'FAILED');
      assert.equal(JSON.parse(readFileSync(path.join(source, 'excluded-employers.json'))).excluded_count, 0);
    }
  }
  const before = readFileSync(log, 'utf8');
  assert.equal(invoke('success', 0, 0, 'SUCCESS').status, 2);
  assert.equal(readFileSync(log, 'utf8'), before);
  const failedSource = path.join(root, 'runs/failed/sources/ego-browser');
  writeFileSync(path.join(failedSource, 'evidence.txt'), 'keep me');
  assert.equal(invoke('failed', 0, 0, 'SUCCESS').status, 0);
  const attempts = path.join(root, 'runs/failed/adapter-attempts');
  assert.equal(readFileSync(path.join(attempts, readdirSync(attempts)[0], 'evidence.txt'), 'utf8'), 'keep me');
  assert.equal(existsSync(path.join(failedSource, 'evidence.txt')), false);
  for (const args of [['--run-id', '../escape'], ['--config'], ['--run-id', '--dry-run']]) {
    assert.equal(spawnSync(process.execPath, [EGO, '--dry-run', ...args], { encoding: 'utf8' }).status, 2);
  }
});

test('recommendation collector records missing modules, delayed wrong links and authentication failures', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linkedin-collector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  copyFileSync(new URL('../src/employer-exclusions.mjs', import.meta.url), path.join(root, 'src/employer-exclusions.mjs'));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const health = { login_form: false, challenge: false, auth_path: false, login_text: false };
  const absent = { ...health, href: '', diagnostic: { ...health, expected_heading_count: 0, scoped_show_all_count: 0 } };
  const wrong = { ...health, href: 'https://example.com/jobs/search-results/', diagnostic: { ...health, expected_heading_count: 1, scoped_show_all_count: 1 } };
  const helpers = { useOrCreateTaskSpace: async () => ({ id: 'fixture' }), cliLog() {},
    openOrReuseTab: async () => {}, waitForLoad: async () => {}, wait: async () => {}, js: undefined };
  const originals = Object.fromEntries(Object.keys(helpers).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    process.exitCode = exitCode;
  });
  Object.assign(globalThis, helpers);
  for (const [sequence, expected] of [
    [[absent], 'MODULE_ABSENT'],
    [[health, absent, wrong], 'UNEXPECTED_DESTINATION'],
    [[{ ...health, challenge: true }], 'AUTH_OR_CHALLENGE'],
  ]) {
    let calls = 0;
    globalThis.js = async () => sequence[Math.min(calls++, sequence.length - 1)];
    await collectLinkedIn({ ...config, discovery_root: root, run_id: expected,
      direct_search: { enabled: false, required: false },
      top_applicant_recommendations: { ...config.top_applicant_recommendations, enabled: true, required: true },
    });
    const summary = JSON.parse(readFileSync(path.join(root, 'runs', expected, 'sources/ego-browser/summary.json')));
    assert.equal(process.exitCode, 1);
    assert.equal(summary.status, 'FAILED');
    assert.equal(summary.failure_class, expected);
    assert.equal(summary.retryable, false);
    assert.equal(summary.markdown_jobs, 0);
    if (expected === 'UNEXPECTED_DESTINATION') assert.ok(summary.top_applicant_recommendations.diagnostic.discovery_attempts > 1);
  }
});
