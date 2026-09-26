import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitExpansion, prepareExpansion } from '../src/expand-scan-report.mjs';
import { requiredScanReportHeadings, renderCompactReport } from '../src/scan-report-contract.mjs';

const KEY = 'workday:example/exampleexternalcareersite:JR1000003';
const POSTING_URL = 'https://example.wd5.myworkdayjobs.com/exampleexternalcareersite/job/x/JR1000003';

function compact() {
  return renderCompactReport({
    runId: 'run-1',
    record: { primary_key: KEY, primary_url: POSTING_URL, company: 'Example Company', title: 'Senior Software Engineer', sources: ['jobspy'] },
    result: {
      posting_key: KEY, score: 4.2, report_decision: 'Apply', legitimacy_tier: 'High Confidence',
      work_authorization: { value: 'unstated', label: '⚠️ Unstated', quote: null },
      report: {
        archetype: 'Senior Backend Engineer', reason: 'Strong backend match.',
        evidence: [{ source: 'jd', quote: 'backend', explanation: 'Relevant scope.' }], gaps: [],
        risk_level: 'Low', confidence: 'High', advertised_comp: null, company_confidential_evidence: null,
        risk_summary: { classification: 'clear', culture: 'not_evaluated', interview_redflags: 'not_evaluated', ai_infra: 'consistent' },
      },
    },
  });
}

function full() {
  return [
    '## Machine Summary\n```yaml\nscore: 4.2\nvia: null\n```',
    '## A) Role Summary\nSummary.', '## B) Match with CV\nMatch.',
    '## C) Level and Strategy\nStrategy.', '## D) Comp and Demand\nDemand.',
    '## E) Customization Plan\nPlan.', '## F) Interview Plan\nPlan.',
    '## G) Posting Legitimacy\nHigh Confidence.',
    '## Risk Summary\nLow.', '## Keywords extracted\nbackend, platform',
  ].join('\n\n');
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'expand-report-'));
  const discovery = path.join(root, 'job-discovery');
  const career = path.join(root, 'career-ops');
  const jd = path.join(discovery, 'runs/run-1/jobs/workday-example-exampleexternalcareersite-JR1000003.md');
  const report = path.join(career, 'reports/007-example-2026-08-07.md');
  mkdirSync(path.dirname(jd), { recursive: true });
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(jd, '# JD\nbackend role\n');
  writeFileSync(report, `# Evaluation: Example Company — Senior Software Engineer\n\n**Report Number:** 007  \n**Score:** 4.2/5  \n**URL:** ${POSTING_URL}  \n**Posting Key:** ${KEY}  \n\n---\n\n${compact()}\n`);
  return { root, discovery, career, jd, report };
}

test('report-contract headings and compact validator stay aligned', () => {
  const contract = readFileSync(new URL('../config/report-contract.md', import.meta.url), 'utf8');
  for (const heading of requiredScanReportHeadings()) assert.ok(contract.includes('`' + heading + '`'));
  assert.deepEqual(compact().split('\n').filter(line => /^## /.test(line)), requiredScanReportHeadings());
});

test('on-demand expansion binds the original JD and preserves a compact backup', () => {
  const fx = fixture();
  const prepared = prepareExpansion('7', fx.career, fx.discovery);
  assert.equal(prepared.posting_key, KEY);
  assert.equal(prepared.jd, fx.jd);
  const draft = path.join(fx.root, 'expanded.md');
  writeFileSync(draft, full());
  const result = commitExpansion('7', draft, fx.career, fx.discovery);
  assert.equal(result.status, 'EXPANDED');
  assert.equal(existsSync(result.compact_backup), true);
  assert.match(readFileSync(fx.report, 'utf8'), /## G\) Posting Legitimacy/);
  assert.match(readFileSync(fx.report, 'utf8'), /^via: "LinkedIn"$/m);
  assert.match(readFileSync(result.compact_backup, 'utf8'), /## Verdict/);
});

test('expansion rejects identity/score disagreement and duplicate generated fields without writing', () => {
  for (const mutate of [
    text => text.replace('score: 4.2', 'score: 4.1'),
    text => text.replace('score: 4.2', 'score: 4.2\nscore: 4.1'),
    text => text.replace('  legitimacy:', 'legitimacy:'),
  ]) {
    const fx = fixture();
    const invalid = mutate(readFileSync(fx.report, 'utf8'));
    writeFileSync(fx.report, invalid);
    assert.throws(() => prepareExpansion('7', fx.career, fx.discovery), /mismatch|duplicate|unsupported/);
    assert.equal(readFileSync(fx.report, 'utf8'), invalid);
    assert.equal(existsSync(path.join(fx.career, 'reports/.expansion-backups')), false);
  }
});
