import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCareerOpsHealth, resolveTitleWarnings } from '../src/career-ops-health.mjs';

function fixture(t, records) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'data')); mkdirSync(path.join(root, 'reports'));
  writeFileSync(path.join(root, 'path-resolver.mjs'), `import path from 'node:path'; export const resolveTrackerPath = root => path.join(root, 'data/applications.md');`);
  writeFileSync(path.join(root, 'tracker-parse.mjs'), `
    export const resolveColumns = () => ({});
    export const normalizeTextKey = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    export const extractReqNumber = s => s.match(/job id (\\S+)/)?.[1] || '';
    export function parseTrackerRow(line) {
      const c = line.split('|').slice(1,-1).map(s => s.trim());
      return /^\\d+$/.test(c[0] || '') ? {num:+c[0],company:c[2],role:c[3],report:c[7],notes:c[8]} : null;
    }
  `);
  const rows = records.map((r, index) => {
    const id = index + 1;
    const name = `${id}-acme-engineer-2026-10-01.md`;
    if (r.report !== false) writeFileSync(path.join(root, 'reports', name), `# Evaluation: Acme — Engineer\n**URL:** ${r.url || 'N/A'}\n${r.key ? `**Posting Key:** ${r.key}\n` : ''}`);
    return `| ${id} | 2026-10-01 | Acme | Engineer | N/A | Evaluated | ❌ | ${r.report === false ? '—' : `[${id}](../reports/${name})`} | ${r.notes || ''} |`;
  });
  writeFileSync(path.join(root, 'data/applications.md'), rows.join('\n'));
  return root;
}
const trackerWarning = 'Possible duplicates: #1, #2 (Acme — Engineer)';
const reportWarning = 'Duplicate reports for same company+role: 1-acme-engineer-2026-10-01.md, 2-acme-engineer-2026-10-01.md';
const posting = id => ({ url: `https://boards.greenhouse.io/acme/jobs/${id}`, key: `greenhouse:acme:${id}` });

test('distinct exact posting identities resolve both warnings with member evidence', t => {
  const root = fixture(t, [posting(100), posting(200)]);
  const result = resolveTitleWarnings({ careerRoot: root, messages: [trackerWarning, reportWarning] });
  assert.equal(result.resolved.length, 2); assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.resolved[0].members.map(m => m.key), ['greenhouse:acme:100', 'greenhouse:acme:200']);
});

test('same posting through tracking and locale variants remains a warning', t => {
  const root = fixture(t, [posting(100), { ...posting(100), url: 'https://job-boards.greenhouse.io/acme/jobs/100?gh_src=example' }]);
  assert.deepEqual(resolveTitleWarnings({ careerRoot: root, messages: [trackerWarning, reportWarning] }).unresolved, [trackerWarning, reportWarning]);
});

test('missing identity, corrupt metadata and missing members fail closed', t => {
  for (const record of [{ report: false }, { report: false, notes: 'job id 100' }, { url: 'N/A' }, { ...posting(200), key: 'greenhouse:acme:999' }]) {
    const root = fixture(t, [posting(100), record]);
    assert.equal(resolveTitleWarnings({ careerRoot: root, messages: [trackerWarning] }).unresolved.length, 1);
  }
  const root = fixture(t, [posting(100)]);
  assert.equal(resolveTitleWarnings({ careerRoot: root, messages: [trackerWarning] }).unresolved.length, 1);
});

test('old saved Workday and Jobright identity spellings reconcile only to their exact URLs', t => {
  const records = [
    {url:'https://acme.wd5.myworkdayjobs.com/External/job/Remote/Engineer_JR100-1',key:'workday:acme/external:JR1001'},
    {url:'https://jobright.ai/jobs/info/b2b_123456789_10',key:'generic:jobright.ai:B2B_123456789_10'},
  ];
  const root = fixture(t, records);
  assert.equal(resolveTitleWarnings({ careerRoot: root, messages: [trackerWarning] }).resolved.length, 1);
});

test('native errors, unknown warnings and incomplete summaries remain blocking', t => {
  const root = fixture(t, [posting(100), posting(200)]);
  for (const [text, expected] of [
    ['⚠️ Unexpected warning\nPipeline Health: 0 errors, 1 warning', { errors:0, warnings:1 }],
    ['Pipeline Health: 0 errors', { errors:1, warnings:null }],
    ['Pipeline Health: 0 errors, 1 warning', { errors:1, warnings:null }],
    ['Pipeline Health: 2 errors, 0 warnings', { errors:2, warnings:0 }],
  ]) {
    writeFileSync(path.join(root, 'verify-pipeline.mjs'), `console.log(${JSON.stringify(text)})`);
    const result = checkCareerOpsHealth(root);
    assert.equal(result.errors, expected.errors); assert.equal(result.warnings, expected.warnings);
  }
});

test('health result retains native count and exact resolution evidence', t => {
  const root = fixture(t, [posting(100), posting(200)]);
  writeFileSync(path.join(root, 'verify-pipeline.mjs'), `console.log(${JSON.stringify(`⚠️ ${trackerWarning}\nPipeline Health: 0 errors, 1 warning`)})`);
  const result = checkCareerOpsHealth(root);
  assert.equal(result.warnings, 0); assert.equal(result.raw_warnings, 1); assert.equal(result.resolved.length, 1);
});
