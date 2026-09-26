// Entire candidate and metrics below are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '../src/resume/plan-contract.mjs';

const source = {
  summary: 'Senior Software Engineer experienced in AI infrastructure using Go and Python.',
  roles: [
    { id: 'acme', heading: 'Engineer, Acme | Remote', bullets: [
      { id: 'acme-01', text: 'Led Atlas in Go, supporting ~2.3K tasks and ~4.6M samples.' },
      { id: 'acme-02', text: 'Optimized Inventory API to ~480 peak QPS using MySQL/RDS.' },
      { id: 'acme-03', text: 'Productized Query Console, reducing requests from 72 to 0.' },
      { id: 'acme-04', text: 'Proposed an AI on-call agent in Go and React.' },
    ] },
    { id: 'example-cloud', heading: 'Engineer, Example Cloud | Remote', bullets: [
      { id: 'example-cloud-01', text: 'Designed AWS Lambda automation for 20K accounts in 2024.' },
    ] },
  ],
  skills: [
    { label: 'Languages', items: ['Go', 'Python', 'SQL'] },
    { label: 'AI Infrastructure', items: ['AI agents', 'RAG', 'model evaluation'] },
  ],
  vocabulary: {
    skill_items: ['Go', 'Python', 'SQL', 'AI agents', 'RAG', 'model evaluation'],
    numbers_by_bullet: {
      'acme-01': ['~2.3K', '~4.6M'], 'acme-02': ['~480 peak QPS'], 'acme-03': ['72 to 0'],
      'acme-04': [], 'example-cloud-01': ['20K', '2024'],
    },
    numbers_all: ['~2.3K', '~4.6M', '~480 peak QPS', '72 to 0', '20K', '2024'],
  },
};

function validPlan() {
  return {
    report: '101-example-senior-software-engineer',
    summary: '**Senior Software Engineer** experienced in **AI infrastructure** using **Go** and **Python**.',
    keywords: ['distributed systems', 'Python', 'Go', 'AI infrastructure', 'AI agents', 'RAG', 'model evaluation', 'production workloads'],
    experience: [
      { role_id: 'acme', bullets: [{ id: 'acme-04', text: 'Designed an **AI on-call agent** in **Go** and **React**.' }, { id: 'acme-01' }] },
      { role_id: 'example-cloud', bullets: [{ id: 'example-cloud-01' }] },
    ],
    skills: [{ label: 'AI', items: ['RAG', 'AI agents'] }, { label: 'Languages', items: ['Python', 'Go'] }],
    rationale: 'Relevant evidence first.', gaps: [],
  };
}

function expectViolation(mutator, pattern) {
  const plan = validPlan(); mutator(plan);
  assert.throws(() => validatePlan(plan, source, { bundle: plan.report }), pattern);
}

test('accepts supported reordering, labels, deletion, and sentence-initial Designed', () => {
  assert.doesNotThrow(() => validatePlan(validPlan(), source, { bundle: validPlan().report }));
});

test('requires 8-20 unique keywords but does not gate non-literal JD phrasing', () => {
  expectViolation((plan) => { plan.keywords = plan.keywords.slice(0, 7); }, /keywords.length/);
  expectViolation((plan) => { plan.keywords[7] = 'PYTHON'; }, /unique keyword/);
  const plan = validPlan();
  plan.keywords[7] = 'CUDA';
  assert.doesNotThrow(() => validatePlan(plan, source, { bundle: plan.report }));
});

test('rejects altered numbers and reversed ranges while allowing deletion', () => {
  for (const [id, text] of [
    ['acme-02', 'Optimized Inventory API to 480+ QPS using MySQL/RDS.'],
    ['acme-01', 'Led Atlas in Go, supporting 1.5K tasks.'],
    ['acme-03', 'Productized Query Console, reducing requests from 0 to 72.'],
  ]) expectViolation((plan) => { plan.experience[0].bullets = [{ id, text }]; });
  const plan = validPlan();
  plan.experience[0].bullets = [{ id: 'acme-01', text: 'Led **Atlas** in **Go**, supporting ~2.3K tasks.' }];
  assert.doesNotThrow(() => validatePlan(plan, source, { bundle: plan.report }));
});

test('rejects unknown skills but accepts exact skill reorder and relabel', () => {
  expectViolation((plan) => { plan.skills[0].items.push('Kafka'); }, /SKILL[\s\S]*Kafka/);
  const plan = validPlan(); plan.skills = [{ label: 'Core', items: ['SQL', 'Go'] }, { label: 'Models', items: ['model evaluation'] }];
  assert.doesNotThrow(() => validatePlan(plan, source, { bundle: plan.report }));
});

test('enforces structure, emphasis limits, uniqueness, and report binding', () => {
  expectViolation((plan) => { plan.summary += '**'; }, /unpaired/);
  expectViolation((plan) => { plan.experience[0].bullets[0].text = '**A** **AI** **Go** **React**'; }, /4 emphasis segments/);
  expectViolation((plan) => { plan.experience[0].bullets.push({ id: 'acme-04' }); }, /unique bullet id/);
  const plan = validPlan();
  assert.throws(() => validatePlan(plan, source, { bundle: '388-plaid' }), /STRUCTURE report/);
});
