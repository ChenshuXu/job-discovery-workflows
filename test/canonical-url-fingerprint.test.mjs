import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCanonicalFingerprintAudit } from '../src/canonical-url-fingerprint.mjs';

test('planning and precommit shared audit finds the verified Elastic mirror without merging other requisitions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-elastic-'));
  mkdirSync(path.join(root, 'reports'));
  writeFileSync(path.join(root, 'reports/101.md'), '**URL:** https://elastic.ongig.com/jobs/finance-it-operations/united-states/agentic-ai-engineer/8079636\n**Posting Key:** generic:elastic.ongig.com:8079636\n');
  const keys = ['greenhouse:elastic:8079636', 'greenhouse:elastic:8079637', 'greenhouse:other:8079636'];
  const audit = buildCanonicalFingerprintAudit({ records: keys.map(key => ({ primary_key: key, posting_keys: [key] })), careerRoot: root, runId: 'elastic' });
  assert.deepEqual(audit.duplicate_keys, [keys[0]]);
  assert.deepEqual(audit.results[0].matches[0].prior_artifacts, ['career-ops/reports/101.md']);
});

test('history dedupe matches a secondary key in a posting-key set', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-'));
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/001.md'), 'URL: https://www.linkedin.com/jobs/view/1000000105\n');
  const records = [{
    primary_key: 'greenhouse:acme:123456',
    posting_keys: ['greenhouse:acme:123456', 'linkedin:linkedin.com:1000000105'],
  }];
  const audit = buildCanonicalFingerprintAudit({ records, careerRoot: root, runId: 'run-1' });
  assert.equal(audit.exact_set_verified, true);
  assert.deepEqual(audit.duplicate_keys, ['greenhouse:acme:123456']);
  assert.deepEqual(audit.results[0].matched_keys, ['linkedin:linkedin.com:1000000105']);
});

test('history dedupe indexes a report-linked LinkedIn ID beside its ATS primary key', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-linkedin-id-'));
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/102.md'), [
    '**URL:** https://apply.careers.microsoft.com/careers/job/1000000000000001',
    '**Posting Key:** generic:apply.careers.microsoft.com:1000000000000001',
    '**LinkedIn Job ID:** 1000000107',
  ].join('\n'));
  const records = [{
    primary_key: 'linkedin:linkedin.com:1000000107',
    posting_keys: ['linkedin:linkedin.com:1000000107'],
  }];
  const audit = buildCanonicalFingerprintAudit({ records, careerRoot: root, runId: 'run-2' });
  assert.deepEqual(audit.duplicate_keys, ['linkedin:linkedin.com:1000000107']);
  assert.deepEqual(audit.results[0].matches, [{
    posting_key: 'linkedin:linkedin.com:1000000107',
    prior_artifacts: ['career-ops/reports/102.md'],
  }]);
});

test('history dedupe indexes an explicitly labeled posting key without fuzzy company-role matching', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-posting-key-'));
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/099.md'), '**Posting Key:** `greenhouse:acme:987654`\n**Company:** Acme\n**Role:** Platform Engineer\n');
  const audit = buildCanonicalFingerprintAudit({
    records: [{ primary_key: 'greenhouse:acme:987654', posting_keys: ['greenhouse:acme:987654'] }],
    careerRoot: root,
    runId: 'run-3',
  });
  assert.deepEqual(audit.duplicate_keys, ['greenhouse:acme:987654']);
});

test('history dedupe joins an exact CareerPuck mirror to its native Greenhouse posting', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-careerpuck-'));
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/100.md'), 'URL: https://app.careerpuck.com/job-board/acmeco/job/1000000004?gh_jid=1000000004\n');
  const audit = buildCanonicalFingerprintAudit({
    records: [{ primary_key: 'greenhouse:acmeco:1000000004', posting_keys: ['greenhouse:acmeco:1000000004'] }],
    careerRoot: root,
    runId: 'run-careerpuck',
  });
  assert.deepEqual(audit.duplicate_keys, ['greenhouse:acmeco:1000000004']);
});

test('history dedupe upgrades verified Greenhouse redirects across three legacy URL shapes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-greenhouse-legacy-'));
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'reports/examplepay.md'), '**URL:** https://examplepay.com/careers/listing/backend-api-engineer/1000001?gh_src=synthetic\n**Posting Key:** generic:examplepay.com:1000001\n');
  writeFileSync(path.join(root, 'reports/examplecredit.md'), '**URL:** https://app.greenhouse.io/embed/job_app?token=1000002&gh_src=synthetic\n**Posting Key:** greenhouse:app.greenhouse.io:1000002\n');
  writeFileSync(path.join(root, 'reports/exampledev.md'), '**URL:** https://boards.greenhouse.io/embed/job_app?token=1000000003&utm_source=jobright\n**Posting Key:** greenhouse:boards.greenhouse.io:1000000003\n');
  writeFileSync(path.join(root, 'reports/unrelated.md'), '**URL:** https://example.com/careers/1000001?gh_src=not-enough\n');
  const records = [
    { primary_key: 'greenhouse:examplepay:1000001', posting_keys: ['greenhouse:examplepay:1000001'] },
    { primary_key: 'greenhouse:examplecredit:1000002', posting_keys: ['greenhouse:examplecredit:1000002'] },
    { primary_key: 'greenhouse:exampledev:1000000003', posting_keys: ['greenhouse:exampledev:1000000003'] },
  ];

  const audit = buildCanonicalFingerprintAudit({ records, careerRoot: root, runId: 'run-greenhouse-legacy' });

  assert.deepEqual(audit.duplicate_keys, records.map(record => record.primary_key));
  assert.deepEqual(audit.results[0].matches[0].prior_artifacts, ['career-ops/reports/examplepay.md']);
});

test('history dedupe follows the official tracker and scan-history path overrides', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-official-paths-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  writeFileSync(path.join(root, 'applications.md'), '**Posting Key:** greenhouse:acme:111\n');
  writeFileSync(path.join(root, 'data/custom-history.tsv'), 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\nhttps://boards.greenhouse.io/acme/jobs/222\t2026-08-07\ttest\tRole\tAcme\tadded\tSeattle\n');
  const previousTracker = process.env.CAREER_OPS_TRACKER;
  const previousHistory = process.env.CAREER_OPS_SCAN_HISTORY;
  process.env.CAREER_OPS_TRACKER = 'applications.md';
  process.env.CAREER_OPS_SCAN_HISTORY = 'data/custom-history.tsv';
  try {
    const audit = buildCanonicalFingerprintAudit({
      records: [
        { primary_key: 'greenhouse:acme:111', posting_keys: ['greenhouse:acme:111'] },
        { primary_key: 'greenhouse:acme:222', posting_keys: ['greenhouse:acme:222'] },
      ],
      careerRoot: root,
      runId: 'run-official-paths',
    });
    assert.deepEqual(audit.duplicate_keys.sort(), ['greenhouse:acme:111', 'greenhouse:acme:222']);
  } finally {
    if (previousTracker === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = previousTracker;
    if (previousHistory === undefined) delete process.env.CAREER_OPS_SCAN_HISTORY;
    else process.env.CAREER_OPS_SCAN_HISTORY = previousHistory;
  }
});
