import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
  assert.equal(result.checks.find(x => x.id === 'projects:register').status, 'missing_or_invalid');
  assert.equal(result.checks.find(x => x.id === 'projects:register').path, path.join(workspace, 'career-docs/context/Interview/active-interviews.md'));
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
  const root = path.join(dir, 'job-discovery'), projects = path.join(dir, 'career-docs');
  mkdirSync(root); mkdirSync(path.join(projects, 'context/Interview'), { recursive: true });
  const register = 'context/Interview/active-interviews.md';
  const table = '| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
  writeFileSync(path.join(projects, register), `# Interview register\n\n## Active Processes\n${table}\n## Current TODO\n\n## Archived Processes\n${table}`);
  const git = args => execFileSync('git', ['-C', projects, ...args], { stdio: 'pipe' });
  const status = () => checkSetup({ root, projects, envPath: '' }).checks.find(x => x.id === 'projects:git').status;
  git(['init']);
  assert.equal(status(), 'missing_or_invalid');
  writeFileSync(path.join(projects, 'README.md'), 'Synthetic workspace\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial workspace']);
  assert.equal(status(), 'missing_or_invalid');
  git(['add', register]);
  git(['-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial register']);
  assert.equal(status(), 'present');
});
