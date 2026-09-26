import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapterRegistry, loadRunProfile, snapshotAdapterProfile } from '../src/adapter-registry.mjs';
import { archiveAttempt, runAdapters } from '../src/run-adapters.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(PROJECT_ROOT, 'src/run-adapters.mjs');

const definitions = enabled => ({
  jobspy: { enabled: enabled.includes('jobspy'), command: ['python3', 'adapters/jobspy_linkedin_scan.py'], config: 'config/jobspy-ego.json', employer_exclusions: true },
  'ego-browser': { enabled: enabled.includes('ego-browser'), command: ['node', 'adapters/egobrowser_linkedin_scan.mjs'], config: 'config/jobspy-ego.json', employer_exclusions: true },
  jobright: { enabled: enabled.includes('jobright'), command: ['node', 'adapters/jobright_recommendations_scan.mjs'], config: 'config/jobright.json', employer_exclusions: true },
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

test('active registry declares all three sources in execution order', () => {
  const registry = loadAdapterRegistry();
  assert.deepEqual(Object.keys(registry.adapters), ['jobspy', 'ego-browser', 'jobright']);
  assert.deepEqual(Object.values(registry.adapters).map(adapter => adapter.enabled), [true, true, true]);
  assert.deepEqual(Object.values(registry.adapters).map(adapter => adapter.config), [
    'config/jobspy-ego.json', 'config/jobspy-ego.json', 'config/jobright.json',
  ]);
  assert.ok(Object.values(registry.adapters).every(adapter => adapter.employer_exclusions && /^[a-f0-9]{64}$/.test(adapter.config_sha256)));
});

test('enabled order is frozen in the baseline profile', t => {
  const fixture = registryFixture(t, ['jobspy', 'jobright']);
  const snapshot = snapshotAdapterProfile(fixture.file);
  assert.deepEqual(snapshot.adapters, ['jobspy', 'jobright']);
  assert.equal(snapshot.minimum_successful_adapters, 1);
  assert.match(snapshot.registry_sha256, /^[a-f0-9]{64}$/);

  const runRoot = path.join(fixture.root, 'runs', 'frozen');
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, 'baseline.json'), JSON.stringify({ adapter_profile: snapshot }));
  fixture.write(['ego-browser']);
  assert.deepEqual(loadRunProfile(runRoot, { registryFile: fixture.file }), snapshot);
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
  assert.deepEqual(output.adapters.map(adapter => adapter.argv.slice(-4, -2)), [
    ['--run-id', 'dry-run-preview'], ['--run-id', 'dry-run-preview'],
  ]);
  assert.equal(output.adapters[0].argv.at(-1), path.join(PROJECT_ROOT, 'config/jobspy-ego.json'));
  assert.equal(output.adapters[1].argv.at(-1), path.join(PROJECT_ROOT, 'config/jobright.json'));
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
