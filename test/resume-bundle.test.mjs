import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveReport } from '../src/resume/resolve-report.mjs';
import { generateChangesMarkdown, writeBundle } from '../src/resume/write-bundle.mjs';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'resume-bundle-test-'));
  mkdirSync(resolve(root, 'reports'), { recursive: true });
  mkdirSync(resolve(root, 'output/9-acme-engineer/jd'), { recursive: true });
  mkdirSync(resolve(root, 'output/9-acme-engineer/cv/tailored/v001'), { recursive: true });
  writeFileSync(resolve(root, 'reports/9-acme-engineer-2026-01-01.md'), 'report');
  writeFileSync(resolve(root, 'output/9-acme-engineer/jd/current.md'), 'job description');
  return root;
}

const source = { roles: [{ id: 'acme', bullets: [{ id: 'acme-01', text: 'Built 10 APIs.' }, { id: 'acme-02', text: 'Operated systems.' }] }], skills: [{ label: 'Languages', items: ['Go'] }, { label: 'Backend', items: ['APIs'] }] };
const plan = { experience: [{ role_id: 'acme', bullets: [{ id: 'acme-01', text: 'Built **10 APIs**.' }] }], skills: [{ label: 'Core', items: ['Go'] }, { label: 'Interfaces', items: ['APIs'] }], rationale: 'Direct match.', gaps: ['No queue evidence.'] };
const baseline = { experience: [{ role_id: 'acme', bullets: [{ id: 'acme-02', text: 'Operated **systems**.' }] }], skills: source.skills };
const fit = { estimated_lines: 20, capacity: 40, overflow_lines: 0 };

test('resolves one exact report and selects next unused version', () => {
  const root = fixture();
  const resolved = resolveReport('9', { careerOpsRoot: root, results: [{ reportNum: '9', company: 'Acme', role: 'Engineer', reportPath: 'reports/9-acme-engineer-2026-01-01.md' }] });
  assert.equal(resolved.bundle, '9-acme-engineer');
  assert.equal(resolved.version, 'v002');
  assert.throws(() => resolveReport('9-wrong', { careerOpsRoot: root, results: [{ reportNum: '9', company: 'Acme', role: 'Engineer', reportPath: 'reports/9-acme-engineer-2026-01-01.md' }] }), /bundle mismatch/);
});

test('compact report resolves its exact Job Discovery JD without a Career-Ops output bundle', () => {
  const root = fixture();
  const discovery = resolve(root, 'job-discovery');
  const reportPath = resolve(root, 'reports/10-acme-platform-2026-01-02.md');
  const jdPath = resolve(discovery, 'runs/run-10/jobs/workday-acme-REQ-10.md');
  mkdirSync(resolve(discovery, 'runs/run-10/jobs'), { recursive: true });
  writeFileSync(jdPath, '# Exact bound JD\n');
  writeFileSync(reportPath, '## Machine Summary\n```yaml\nrun_id: "run-10"\nposting_key: "workday:acme:REQ-10"\n```\n');
  const resolved = resolveReport('10', {
    careerOpsRoot: root,
    discoveryRoot: discovery,
    results: [{ reportNum: '10', company: 'Acme', role: 'Platform Engineer', reportPath: 'reports/10-acme-platform-2026-01-02.md' }],
  });
  assert.equal(resolved.bundle, '10-acme-platform');
  assert.equal(resolved.jdPath, jdPath);
  assert.equal(resolved.version, 'v001');
});

test('legacy compact report resolves its exact persisted Career-Ops JD without run_id', () => {
  const root = fixture();
  const reportPath = resolve(root, 'reports/11-acme-legacy-2026-01-03.md');
  const jdPath = resolve(root, 'jds/discovery-20260103-120000-workday-acme-REQ-11.md');
  mkdirSync(resolve(root, 'jds'), { recursive: true });
  writeFileSync(jdPath, '# Exact persisted legacy JD\n');
  writeFileSync(reportPath, '**Posting Key:** workday:acme:REQ-11  \n');
  const resolved = resolveReport('11', {
    careerOpsRoot: root,
    results: [{ reportNum: '11', company: 'Acme', role: 'Legacy Engineer', reportPath: 'reports/11-acme-legacy-2026-01-03.md' }],
  });
  assert.equal(resolved.jdPath, jdPath);
});

test('legacy compact report refuses ambiguous persisted Career-Ops JDs', () => {
  const root = fixture();
  const reportPath = resolve(root, 'reports/12-acme-ambiguous-2026-01-04.md');
  mkdirSync(resolve(root, 'jds'), { recursive: true });
  writeFileSync(resolve(root, 'jds/discovery-20260104-120000-workday-acme-REQ-12.md'), '# First JD\n');
  writeFileSync(resolve(root, 'jds/discovery-20260105-120000-workday-acme-REQ-12.md'), '# Second JD\n');
  writeFileSync(reportPath, '## Machine Summary\n```yaml\nposting_key: "workday:acme:REQ-12"\n```\n');
  assert.throws(() => resolveReport('12', {
    careerOpsRoot: root,
    results: [{ reportNum: '12', company: 'Acme', role: 'Ambiguous Engineer', reportPath: 'reports/12-acme-ambiguous-2026-01-04.md' }],
  }), /IDENTITY_BLOCKER ambiguous persisted JD/);
});

test('passing build writes directly and refuses overwrite', () => {
  const root = fixture();
  const resolved = resolveReport('9', { careerOpsRoot: root, results: [{ reportNum: '9', company: 'Acme', role: 'Engineer', reportPath: 'reports/9-acme-engineer-2026-01-01.md' }] });
  const pageCount = { status: 'NOT RUN', reason: 'disabled for test' };
  const coverage = { hit: ['Go'], miss: ['APIs'], gap: ['Rust'], unverified: ['Kubernetes-native'] };
  const expected = generateChangesMarkdown({ resolved, source, baseline, plan, fit, pageCount, coverage });
  writeBundle({ resolved, source, baseline, plan, docxBuffer: Buffer.from('docx'), fit, pageCount, coverage });
  assert.equal(readFileSync(resolve(resolved.targetPath, 'changes.md'), 'utf8'), expected);
  assert.match(expected, /## JD keyword coverage[\s\S]*4 keywords · 1 hit · 1 miss · 1 gap · 1 unverified/);
  assert.doesNotMatch(expected, /## Status|precision|Estimator disagreed/);
  assert.throws(() => writeBundle({ resolved, source, baseline, plan, docxBuffer: Buffer.from('docx'), fit, pageCount, coverage }), /OUTPUT_EXISTS/);
  assert.ok(existsSync(resolve(resolved.targetPath, 'cv.docx')));
});
