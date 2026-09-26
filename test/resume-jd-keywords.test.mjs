import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCoverage, reportSections, tailoringReportSections } from '../src/resume/jd-keywords.mjs';
import { validateGapKeywords } from '../src/resume/plan-contract.mjs';

const report = `# Report
## A) Role Summary
Build distributed systems.
## B) Match with CV
Python evidence.
## D) Compensation and Demand
Private.
## E) Personalization Plan
Lead with systems.
## F) Interview Plan
Practice.
## G) Posting Legitimacy
Live.
## Extracted Keywords
distributed systems; Python; Rust; C++; Python;`;

test('full report sections remain readable without unrelated sections', () => {
  const sections = reportSections(report, ['A) Role Summary', 'B) Match with CV', 'E) Personalization Plan']);
  assert.deepEqual(Object.keys(sections), ['A) Role Summary', 'B) Match with CV', 'E) Personalization Plan']);
  assert.match(sections['A) Role Summary'], /distributed systems/);
  assert.doesNotMatch(Object.values(sections).join('\n'), /Private|Practice|Live/);
});

test('tailoring context accepts compact reports without A-G expansion', () => {
  const compact = `## Machine Summary
\`\`\`yaml
score: 4.2
\`\`\`
## Verdict
Strong backend match.
## Evidence
- Distributed systems evidence.
## Gaps
- No CUDA evidence.
## Work Authorization
Unstated.`;
  assert.deepEqual(tailoringReportSections(compact), {
    Verdict: 'Strong backend match.',
    Evidence: '- Distributed systems evidence.',
    Gaps: '- No CUDA evidence.',
    'Work Authorization': 'Unstated.',
  });
});

test('tailoring context accepts both full-report E heading aliases', () => {
  for (const title of ['E) Personalization Plan', 'E) Customization Plan']) {
    const sections = tailoringReportSections(`## A) Role Summary\nRole.\n## B) Match with CV\nMatch.\n## ${title}\nPlan.`);
    assert.deepEqual(sections, {
      'A) Role Summary': 'Role.',
      'B) Match with CV': 'Match.',
      'E) Customization Plan': 'Plan.',
    });
  }
});

test('coverage classifies hit, miss, gap, and unverified phrases with safe boundaries', () => {
  const coverage = classifyCoverage(['distributed systems', 'Python', 'Rust', 'C++'], {
    resumeText: 'Built distributed systems for trusted workloads.',
    cvText: 'Python and C++.',
    jdText: 'Distributed systems work with Python, Rust, and C plus plus.',
  });
  assert.deepEqual(coverage, { hit: ['distributed systems'], miss: ['Python'], gap: ['Rust'], unverified: ['C++'] });
});

test('Rust does not match trusted and C++ matches at punctuation boundaries', () => {
  assert.deepEqual(classifyCoverage(['Rust'], { resumeText: 'trusted', cvText: '' }).gap, ['Rust']);
  assert.deepEqual(classifyCoverage(['C++'], { resumeText: 'Used C++.', cvText: '' }).hit, ['C++']);
});

test('cv.md supports multi-word keywords when every content word is present', () => {
  const coverage = classifyCoverage(['production systems', 'AI evaluation', 'coding agents', 'CUDA'], {
    resumeText: 'Focused on reliable services.',
    cvText: 'Built AI agents for production workloads across distributed systems, including model training and evaluation.',
  });
  assert.deepEqual(coverage, {
    hit: [],
    miss: ['production systems', 'AI evaluation'],
    gap: ['coding agents', 'CUDA'],
    unverified: [],
  });
});

test('GAP_KEYWORD rejects only unsupported JD keywords present in resume text', () => {
  assert.throws(() => validateGapKeywords('Built with CUDA.', ['CUDA'], 'Go and Python.'), /GAP_KEYWORD[\s\S]*CUDA/);
  assert.doesNotThrow(() => validateGapKeywords('Built with Go.', ['CUDA'], 'Go and Python.'));
  assert.doesNotThrow(() => validateGapKeywords(
    'Built production systems.',
    ['production systems'],
    'Operated production workloads across distributed systems.',
  ));
});
