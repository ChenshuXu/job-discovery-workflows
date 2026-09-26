import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkSetup } from '../src/setup-check.mjs';

test('setup inventory is read-only, reports missing inputs and never treats fictional files as confirmed readiness', t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'setup-check-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'job-discovery'); mkdirSync(root);
  const cv = path.join(workspace, 'career-ops/cv.md'); mkdirSync(path.dirname(cv));
  const text = '## PROFESSIONAL EXPERIENCE\n### Engineer, Example\n- Built APIs.\n## TECHNICAL SKILLS\n**Languages:** Python\n';
  writeFileSync(cv, text);
  const before = readdirSync(workspace, { recursive: true });
  const result = checkSetup({ root, envPath: '' });
  assert.equal(result.checks.find(x => x.id === 'candidate:cv').status, 'present');
  assert.equal(result.checks.find(x => x.id === 'career-docs:register').status, 'missing_or_invalid');
  assert.equal(result.checks.find(x => x.id === 'career-docs:register').path, path.join(workspace, 'career-docs/context/Interview/active-interviews.md'));
  assert.equal(result.file_checks_passed, false);
  assert.equal(result.readiness, 'requires_agent_and_user_checks');
  assert.ok(result.manual_checks.length);
  assert.doesNotMatch(JSON.stringify(result), /Built APIs/);
  assert.deepEqual(readdirSync(workspace, { recursive: true }), before);
  assert.equal(readFileSync(cv, 'utf8'), text);
});

test('Gmail Git inventory requires a valid register in HEAD, not just an initialized repository', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-check-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'job-discovery'), careerDocs = path.join(dir, 'career-docs');
  mkdirSync(root); mkdirSync(path.join(careerDocs, 'context/Interview'), { recursive: true });
  const register = 'context/Interview/active-interviews.md';
  const table = '| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
  writeFileSync(path.join(careerDocs, register), `# Interview register\n\n## Active Processes\n${table}\n## Current TODO\n\n## Archived Processes\n${table}`);
  const git = args => execFileSync('git', ['-C', careerDocs, ...args], { stdio: 'pipe' });
  const status = () => checkSetup({ root, careerDocs, envPath: '' }).checks.find(x => x.id === 'career-docs:git').status;
  git(['init']);
  assert.equal(status(), 'missing_or_invalid');
  writeFileSync(path.join(careerDocs, 'README.md'), 'Synthetic workspace\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial workspace']);
  assert.equal(status(), 'missing_or_invalid');
  git(['add', register]);
  git(['-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial register']);
  assert.equal(status(), 'present');
});

test('setup CLI accepts only --career-docs for the private document workspace', t => {
  const careerDocs = mkdtempSync(path.join(tmpdir(), 'setup-check-cli-'));
  t.after(() => rmSync(careerDocs, { recursive: true, force: true }));
  const run = flag => spawnSync(process.execPath, ['src/setup-check.mjs', flag, careerDocs,
    '--career-ops', path.join(careerDocs, 'missing-ops'), '--jobspy', path.join(careerDocs, 'missing-jobspy'), '--json'], { encoding: 'utf8' });
  const current = run('--career-docs');
  const report = JSON.parse(current.stdout);
  assert.equal(current.status, 1); // Other setup inputs are intentionally missing.
  assert.equal(report.checks.find(x => x.id === 'career-docs:register').path, path.join(careerDocs, 'context/Interview/active-interviews.md'));
  assert(!report.checks.some(x => x.id.startsWith('projects:')));
  const legacy = run('--projects');
  assert.equal(legacy.status, 1);
  assert.equal(legacy.stdout, '');
  assert.match(legacy.stderr, /Usage:.*--career-docs PATH/);
});
