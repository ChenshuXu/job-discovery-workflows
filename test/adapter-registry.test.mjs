import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapterRegistry, loadRunProfile, snapshotAdapterProfile } from '../src/adapter-registry.mjs';
import { archiveAttempt, runAdapters } from '../src/run-adapters.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(PROJECT_ROOT, 'src/run-adapters.mjs');

const definitions = enabled => ({
  jobspy: { enabled: enabled.includes('jobspy'), command: ['python3', 'src/adapters/jobspy_linkedin_scan.py'], config: 'config/jobspy-ego.json', employer_exclusions: true },
  'ego-browser': { enabled: enabled.includes('ego-browser'), command: ['node', 'src/adapters/egobrowser_linkedin_scan.mjs'], config: 'config/jobspy-ego.json', employer_exclusions: true },
  jobright: { enabled: enabled.includes('jobright'), command: ['node', 'src/adapters/jobright_recommendations_scan.mjs'], config: 'config/jobright.json', employer_exclusions: true },
});

function registryFixture(t, enabled, minimum = 1) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'adapter-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'registry.json');
  const write = selected => writeFileSync(file, JSON.stringify({
    schema_version: 1,
    registry_version: '1',
    contract_version: 2,
    identity_schema: 'posting-key-v1',
    minimum_successful_adapters: minimum,
    adapters: definitions(selected),
  }));
  write(enabled);
  return { root, file, write };
}

test('enabled order is frozen in the baseline profile', t => {
  const fixture = registryFixture(t, ['jobspy', 'jobright']);
  const snapshot = snapshotAdapterProfile(fixture.file);
  assert.deepEqual(snapshot.adapters, ['jobspy', 'jobright']);
  assert.equal(snapshot.minimum_successful_adapters, 1);
  assert.equal(typeof snapshot.registry_content, 'string');
  assert.equal(JSON.parse(snapshot.registry_content).schema_version, 1);

  const runRoot = path.join(fixture.root, 'runs', 'frozen');
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: snapshot }));
  fixture.write(['ego-browser']);
  assert.deepEqual(loadRunProfile(runRoot, { registryFile: fixture.file }), snapshot);
});

test('a source-config edit blocks an open run but not a finished one', t => {
  const fixture = registryFixture(t, ['jobspy']);
  const snapshot = snapshotAdapterProfile(fixture.file);
  // Equivalent to editing config/jobspy-ego.json after the baseline was captured.
  snapshot.adapter_definitions.jobspy.config_content += ' ';
  const runRoot = path.join(fixture.root, 'runs', 'edited');
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: snapshot }));
  assert.throws(() => loadRunProfile(runRoot), /config changed after baseline capture/);
  writeFileSync(path.join(runRoot, 'receipt.json'), '{}');
  assert.equal(loadRunProfile(runRoot).adapter_definitions.jobspy.config_content, snapshot.adapter_definitions.jobspy.config_content);
});

test('registry rejects zero enabled sources and a minimum above the enabled count', t => {
  const none = registryFixture(t, []);
  assert.throws(() => loadAdapterRegistry(none.file), /enable at least one adapter/);
  const tooHigh = registryFixture(t, ['jobspy'], 2);
  assert.throws(() => loadAdapterRegistry(tooHigh.file), /enabled adapter count \(1\)/);
});

test('runner dry-run previews only current enabled commands without creating a run', t => {
  const fixture = registryFixture(t, ['ego-browser', 'jobright']);
  const runRoot = path.join(PROJECT_ROOT, 'runs', 'dry-run-preview');
  const output = JSON.parse(execFileSync(process.execPath, [RUNNER, '--run', runRoot, '--dry-run'], {
    env: { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: fixture.file },
    encoding: 'utf8',
  }));
  assert.equal(output.dry_run, true);
  assert.deepEqual(output.adapters.map(adapter => adapter.adapter_id), ['ego-browser', 'jobright']);
  for (const { adapter_id, argv } of output.adapters) {
    assert.equal(argv[argv.indexOf('--run-id') + 1], 'dry-run-preview');
    assert.equal(argv[argv.indexOf('--config') + 1], path.join(PROJECT_ROOT, definitions([])[adapter_id].config));
  }
  assert.equal(existsSync(runRoot), false);
});

test('retry is recorded when bootstrap failed before writing source artifacts', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'adapter-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(archiveAttempt(root, 'jobright'), path.join('adapter-attempts', 'jobright-attempt-1'));
  assert.throws(() => archiveAttempt(root, 'jobright'), /retry already used/);
});

test('runner does not retry an explicitly non-retryable source failure', t => {
  const runsRoot = path.join(PROJECT_ROOT, 'runs');
  mkdirSync(runsRoot, { recursive: true });
  const runRoot = mkdtempSync(path.join(runsRoot, 'adapter-retry-nonretryable-'));
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: snapshotAdapterProfile() }));
  const sourceRoot = path.join(runRoot, 'sources', 'ego-browser');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'summary.json'), JSON.stringify({
    schema_version: 1,
    run_id: path.basename(runRoot),
    adapter: 'ego-browser',
    status: 'FAILED',
    raw_rows: 1,
    unique_jobs: 0,
    markdown_jobs: 0,
    errors: 1,
    retryable: false,
  }));

  assert.throws(() => runAdapters({ runRoot, retry: 'ego-browser' }), /explicitly non-retryable/);
  assert.equal(existsSync(path.join(runRoot, 'adapter-attempts')), false);
});

test('runner does not retry an unclassified failure or an unreadable summary', t => {
  for (const [name, summary] of [['unclassified', { status: 'FAILED', errors: 1 }], ['unreadable', null]]) {
    const runRoot = mkdtempSync(path.join(PROJECT_ROOT, 'runs', `adapter-retry-${name}-`));
    t.after(() => rmSync(runRoot, { recursive: true, force: true }));
    writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: snapshotAdapterProfile() }));
    const sourceRoot = path.join(runRoot, 'sources', 'ego-browser');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, 'summary.json'), summary ? JSON.stringify({ schema_version: 1, run_id: path.basename(runRoot), adapter: 'ego-browser',
      raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, ...summary }) : '{not json');
    assert.throws(() => runAdapters({ runRoot, retry: 'ego-browser' }), /not classified as retryable/);
    assert.equal(existsSync(path.join(runRoot, 'adapter-attempts')), false);
  }
});

test('a timed-out adapter stops with everything it started and keeps all but its newest capture', async t => {
  mkdirSync(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  const runRoot = mkdtempSync(path.join(PROJECT_ROOT, 'runs', 'adapter-timeout-'));
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));
  const hanging = path.join(runRoot, 'hanging-adapter.mjs');
  const helperLog = path.join(runRoot, 'helper.log');
  const helperPid = path.join(runRoot, 'helper.pid');
  // The helper stands in for a browser CLI the adapter waits on synchronously.
  writeFileSync(hanging, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const dir = ${JSON.stringify(path.join(runRoot, 'sources/jobspy/jobs'))};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/one.md', '# captured before the hang');
fs.utimesSync(dir + '/one.md', new Date(Date.now() - 60000), new Date(Date.now() - 60000));
fs.writeFileSync(dir + '/two.md', '# possibly truncated');
const helper = spawn(process.execPath, ['-e', \`setInterval(() => require('fs').appendFileSync(\${JSON.stringify(${JSON.stringify(helperLog)})}, 'x'), 20)\`], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
setTimeout(() => {}, 60000);
`);
  const passing = path.join(runRoot, 'passing-adapter.mjs');
  writeFileSync(passing, `import fs from 'node:fs';
const root = ${JSON.stringify(path.join(runRoot, 'sources/jobright'))};
fs.mkdirSync(root + '/jobs', { recursive: true });
fs.writeFileSync(root + '/jobs/two.md', '# ok');
fs.writeFileSync(root + '/excluded-employers.json', JSON.stringify({ schema_version: 1, run_id: ${JSON.stringify(path.basename(runRoot))}, excluded_count: 0, results: [] }));
fs.writeFileSync(root + '/summary.json', JSON.stringify({ schema_version: 1, run_id: ${JSON.stringify(path.basename(runRoot))}, adapter: 'jobright', status: 'SUCCESS', raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0 }));
`);
  const profile = snapshotAdapterProfile();
  profile.adapters = ['jobspy', 'jobright'];
  profile.adapter_definitions = {
    jobspy: { ...profile.adapter_definitions.jobspy, command: ['node', hanging], timeout_ms: 1500 },
    jobright: { ...profile.adapter_definitions.jobright, command: ['node', passing] },
  };
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: profile }));
  const result = runAdapters({ runRoot });
  assert.equal(result.status, 'DEGRADED');
  assert.deepEqual(result.successful_adapters, ['jobright']);
  const summary = JSON.parse(readFileSync(path.join(runRoot, 'sources/jobspy/summary.json')));
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.failure_class, 'ADAPTER_TIMEOUT');
  assert.equal(summary.retryable, false);
  assert.equal(summary.markdown_jobs, 1);
  assert.equal(summary.dropped_partial_capture, 'two.md');
  assert.deepEqual(readdirSync(path.join(runRoot, 'sources/jobspy/jobs')), ['one.md']);
  assert.equal(JSON.parse(readFileSync(path.join(runRoot, 'sources/jobspy/excluded-employers.json'))).excluded_count, 0);
  assert.throws(() => process.kill(Number(readFileSync(helperPid, 'utf8')), 0), { code: 'ESRCH' });
  const written = readFileSync(helperLog, 'utf8').length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(readFileSync(helperLog, 'utf8').length, written, 'the helper stopped writing into the run');
});

test('registry freezes adapter timeouts and rejects an invalid value', t => {
  const fixture = registryFixture(t, ['jobspy']);
  const registry = JSON.parse(readFileSync(fixture.file, 'utf8'));
  registry.adapters.jobspy.timeout_ms = 1234;
  writeFileSync(fixture.file, JSON.stringify(registry));
  assert.equal(snapshotAdapterProfile(fixture.file).adapter_definitions.jobspy.timeout_ms, 1234);
  registry.adapters.jobspy.timeout_ms = 0;
  writeFileSync(fixture.file, JSON.stringify(registry));
  assert.throws(() => loadAdapterRegistry(fixture.file), /timeout_ms must be a positive integer/);
});

test('the default registry bounds every enabled adapter', () => {
  const profile = snapshotAdapterProfile();
  assert.deepEqual(profile.adapters, ['jobspy', 'ego-browser', 'jobright']);
  for (const adapter of profile.adapters) assert.ok(profile.adapter_definitions[adapter].timeout_ms > 0, adapter);
});

test('explicit user retry authorization is run/source bound and preserves the failed invocation', t => {
  const runRoot = mkdtempSync(path.join(PROJECT_ROOT, 'runs', 'authorized-retry-'));
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));
  const profile = snapshotAdapterProfile();
  profile.adapters = ['ego-browser'];
  profile.adapter_definitions = {'ego-browser': profile.adapter_definitions['ego-browser']};
  profile.minimum_successful_adapters = 1;
  profile.adapter_definitions['ego-browser'].command = [process.execPath, '-e', `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv, value = key => args[args.indexOf(key) + 1];
    const id = value('--run-id'), dir = path.join(value('--discovery-root'), 'runs', id, 'sources/ego-browser');
    fs.mkdirSync(path.join(dir, 'jobs'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'jobs/job.md'), 'captured');
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({schema_version:1, run_id:id, adapter:'ego-browser', status:'SUCCESS', raw_rows:1, unique_jobs:1, markdown_jobs:1, errors:0}));
  `, '--'];
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({adapter_profile:profile}));
  const source = path.join(runRoot, 'sources/ego-browser');
  mkdirSync(source, {recursive:true});
  const failed = {schema_version:1, run_id:path.basename(runRoot), adapter:'ego-browser', status:'FAILED', raw_rows:0, unique_jobs:0, markdown_jobs:0, errors:1, retryable:false};
  writeFileSync(path.join(source, 'summary.json'), JSON.stringify(failed));
  const authorizationFile = path.join(runRoot, 'retry-authorization.json');
  const authorization = {run_id:path.basename(runRoot), adapter:'ego-browser', instruction:'Fix location and reacquire LinkedIn', authorized_by:'user'};
  writeFileSync(authorizationFile, JSON.stringify({...authorization, run_id:'wrong-run'}));
  assert.throws(() => runAdapters({runRoot, retry:'ego-browser', retryAuthorization:authorizationFile}), /authorization/);
  assert.equal(existsSync(path.join(runRoot, 'adapter-attempts')), false);
  writeFileSync(authorizationFile, JSON.stringify(authorization));
  const result = runAdapters({runRoot, retry:'ego-browser', retryAuthorization:authorizationFile});
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.retry_authorization, authorization);
  assert.deepEqual(JSON.parse(readFileSync(path.join(runRoot, result.archived_attempt, 'summary.json'))), failed);
  assert.throws(() => runAdapters({runRoot, retry:'ego-browser', retryAuthorization:authorizationFile}), /successful source/);
});
