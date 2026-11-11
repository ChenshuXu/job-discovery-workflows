import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fetchLinkedInJobPosting } from '../src/adapters/egobrowser_linkedin_scan.mjs';

test('LinkedIn detail transport bounds recovery and never retries access restrictions', async () => {
  const valid = JSON.stringify({ data: { title: 'Engineer', description: { text: 'complete body' } } });
  for (const [responses, expected, count] of [
    [[{ status: 200, body: valid }], 'ok', 1],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer', entityUrn: 'urn:li:fs_normalized_jobPosting:123' } }) }], 'ok', 1],
    [[{ status: 200, body: '<html>temporary</html>' }, { status: 200, body: valid }], 'ok', 2],
    [[{ status: 200, body: '<html>SECRET</html>' }, { status: 200, body: '<html>SECRET</html>' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 200, body: '{}' }, { status: 200, body: '{}' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer' }, included: {} }) }, { status: 200, body: '{}' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 429, body: 'SECRET' }], 'DETAIL_HTTP_ERROR', 1],
    [[{ status: 403, body: 'SECRET' }], 'DETAIL_HTTP_ERROR', 1],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer', description: { text: 'complete body' }, entityUrn: 'urn:li:jobPosting:999' } }) }], 'DETAIL_IDENTITY_MISMATCH', 1],
  ]) {
    let calls = 0;
    const context = vm.createContext({ document: { cookie: 'JSESSIONID="test"' }, fetch: async () => {
      const response = responses[calls++];
      assert.ok(response, 'retry budget exceeded');
      return { ok: response.status === 200, status: response.status, text: async () => response.body };
    } });
    const result = await vm.runInContext(`(${fetchLinkedInJobPosting.toString()})('123')`, context);
    assert.equal(result.ok ? 'ok' : result.failureCode, expected);
    assert.equal(calls, count);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
});

test('a browser that dies after capturing JDs leaves a summary that counts them', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const work = mkdtempSync(path.join(os.tmpdir(), 'ego-bootstrap-'));
  try {
    const bin = path.join(work, 'bin');
    mkdirSync(bin);
    // Stands in for the browser CLI: the collection call captures one JD and dies; cleanup succeeds.
    writeFileSync(path.join(bin, 'ego-browser'), `#!/usr/bin/env node
const input = require('fs').readFileSync(0, 'utf8');
if (input.includes('completeTaskSpace')) process.exit(0);
const discoveryRoot = input.match(/"discovery_root":"([^"]+)"/)[1], runId = input.match(/"run_id":"([^"]+)"/)[1];
const jobs = require('path').join(discoveryRoot, 'runs', runId, 'sources/ego-browser/jobs');
require('fs').mkdirSync(jobs, { recursive: true });
require('fs').writeFileSync(jobs + '/one.md', '# captured');
process.exit(1);
`);
    chmodSync(path.join(bin, 'ego-browser'), 0o755);
    const discovery = path.join(work, 'discovery');
    mkdirSync(path.join(discovery, 'runs'), { recursive: true });
    const result = spawnSync(process.execPath, [path.join(root, 'src/adapters/egobrowser_linkedin_scan.mjs'), '--discovery-root', discovery,
      '--run-id', 'bootstrap-run', '--config', path.join(root, 'config/jobspy-ego.json')],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(readFileSync(path.join(discovery, 'runs/bootstrap-run/sources/ego-browser/summary.json'), 'utf8'));
    assert.equal(summary.failure_class, 'BOOTSTRAP_FAILED');
    assert.equal(summary.markdown_jobs, 1);
    assert.equal(summary.unique_jobs, 1);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('a failed task-space cleanup is a warning on a successful capture, not a failure', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const work = mkdtempSync(path.join(os.tmpdir(), 'ego-cleanup-'));
  try {
    const bin = path.join(work, 'bin');
    mkdirSync(bin);
    // The collection call writes a complete successful source; only the cleanup call fails.
    writeFileSync(path.join(bin, 'ego-browser'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const input = fs.readFileSync(0, 'utf8');
if (input.includes('completeTaskSpace')) process.exit(1);
const discoveryRoot = input.match(/"discovery_root":"([^"]+)"/)[1], runId = input.match(/"run_id":"([^"]+)"/)[1];
const dir = path.join(discoveryRoot, 'runs', runId, 'sources/ego-browser');
fs.mkdirSync(dir + '/jobs', { recursive: true });
fs.writeFileSync(dir + '/jobs/one.md', '# captured');
fs.writeFileSync(dir + '/summary.json', JSON.stringify({ schema_version: 1, run_id: runId, adapter: 'ego-browser', status: 'SUCCESS', raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0 }));
`);
    chmodSync(path.join(bin, 'ego-browser'), 0o755);
    const discovery = path.join(work, 'discovery');
    mkdirSync(path.join(discovery, 'runs'), { recursive: true });
    const result = spawnSync(process.execPath, [path.join(root, 'src/adapters/egobrowser_linkedin_scan.mjs'), '--discovery-root', discovery,
      '--run-id', 'cleanup-run', '--config', path.join(root, 'config/jobspy-ego.json')],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(path.join(discovery, 'runs/cleanup-run/sources/ego-browser/summary.json'), 'utf8'));
    assert.equal(summary.status, 'SUCCESS');
    assert.deepEqual(summary.warnings, ['task_space_cleanup_failed']);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
