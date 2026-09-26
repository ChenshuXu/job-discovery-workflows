import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchExcludedEmployer, validateEmployerExclusionRules } from '../src/employer-exclusions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(ROOT, 'config/jobspy-ego.json'), 'utf8')).employer_exclusions;
const JOBRIGHT_RULES = JSON.parse(readFileSync(path.join(ROOT, 'config/jobright.json'), 'utf8')).employer_exclusions;
// Synthetic excerpts retain only the short phrases needed by the configured matchers.
const CASES = [
  {
    id: 'direct-company',
    company: 'Amazon Web Services',
    description: 'Build cloud infrastructure for customers.',
    expected: 'amazon-aws',
  },
  {
    id: 'jobright-publisher',
    company: 'Jobright.ai',
    description: 'Hiring Company: Example AI\n\nBuild and optimize agentic systems.',
    expected: 'jobright-ai',
  },
  {
    id: 'jobright-platform-boilerplate',
    company: 'Third Party Board',
    description: 'This role is part of the Jobright TNT.\n\nHow can I join Jobright TNT:',
    expected: 'jobright-ai',
  },
  {
    id: 'aggregator-attribution',
    company: 'Example Publisher',
    description: 'Engineer\n\nAmazon Web Services, Inc.\n\nBuild example services.',
    expected: 'amazon-aws',
  },
  {
    id: 'filing-board-legal-entity-attribution',
    company: 'Example Filing Board',
    description: 'Engineer\n\nAmazon\n\nFiling entity: Amazon Com Services Llc',
    expected: 'amazon-aws',
  },
  {
    id: 'filing-board-repeated-employer-attribution',
    company: 'Example Filing Board',
    description: 'Example Engineer\n\n* Amazon\n\nBuild example services.\n\nEmployees at Amazon are often offered comprehensive health benefits.',
    expected: 'amazon-aws',
  },
  {
    id: 'role-board-direct-employer-attribution',
    company: 'Example Role Board',
    description: 'Example Engineer\n\nAmazon is a technology company and is seeking an engineer for an example team.',
    expected: 'amazon-aws',
  },
  {
    id: 'staffing-board-amazon-sde-attribution',
    company: 'Example Staffing Board',
    description: 'Example duties\n\nAs a SDE – II at Amazon, you will build example services.',
    expected: 'amazon-aws',
  },
  {
    id: 'staffing-board-amazon-scientist-attribution',
    company: 'Example Staffing Board',
    description: 'Example duties\n\nAs an Applied Scientist at Amazon, you will build example models.',
    expected: 'amazon-aws',
  },
  {
    id: 'copied-official-boilerplate',
    company: 'Third Party Board',
    description: 'Why AWS?\n\nAmazon is an equal opportunity employer.\n\nBuild sales-planning systems.',
    expected: 'amazon-aws',
  },
  {
    id: 'aws-is-only-technology',
    company: 'Acme Software',
    description: 'Deploy Python services using Amazon Web Services (AWS), Kubernetes, and Terraform.',
    expected: null,
  },
  {
    id: 'example-jobs-amazon-employer-declaration',
    company: 'Example Jobs',
    // Synthetic case: one employer declaration must suffice without a second signal.
    description: 'Build example services.\n\nEqual Opportunity\n\nAmazon is an equal opportunity employer.',
    expected: 'amazon-aws',
  },
  {
    id: 'standalone-employer-declaration',
    company: 'Third Party Board',
    description: 'Amazon is an equal opportunity employer.',
    expected: 'amazon-aws',
  },
  {
    id: 'employer-declaration-is-quoted-reference',
    company: 'Acme Software',
    description: 'Our training examples include the statement: Amazon is an equal opportunity employer.',
    expected: null,
  },
  {
    id: 'negated-amazon-employer-declaration',
    company: 'Acme Software',
    description: 'Amazon is not the employer for this role. We deploy services on AWS.',
    expected: null,
  },
  {
    id: 'customer-reference-only',
    company: 'Consulting Co',
    description: 'Our customers include Amazon Web Services, Inc. and several other cloud providers.',
    expected: null,
  },
  {
    id: 'role-at-another-employer-using-aws',
    company: 'Acme Software',
    description: 'As a Software Engineer at Acme, you will build services on Amazon Web Services.',
    expected: null,
  },
  {
    id: 'role-collaborating-with-amazon',
    company: 'Consulting Co',
    description: 'As a Software Engineer working with teams at Amazon, you will support our customer integrations.',
    expected: null,
  },
  {
    id: 'amazon-partnership-reference-only',
    company: 'Consulting Co',
    description: 'Amazon is seeking partnerships with consulting firms to expand its cloud ecosystem.',
    expected: null,
  },
  {
    id: 'aws-role-for-another-employer',
    company: 'Example Consulting',
    description: 'AWS DevOps Engineer supporting customer AWS environments. AWS certification is preferred.',
    expected: null,
  },
  {
    id: 'jobright-reference-only',
    company: 'Acme Software',
    description: 'Candidates may use LinkedIn, Jobright.ai, or other platforms during their job search.',
    expected: null,
  },
];

test('employer exclusion config catches configured publishers without blocking references', () => {
  validateEmployerExclusionRules(RULES);
  for (const item of CASES) {
    const actual = matchExcludedEmployer(item, RULES);
    assert.equal(actual?.id ?? null, item.expected, item.id);
  }
  const aggregator = matchExcludedEmployer(CASES.find(item => item.id === 'aggregator-attribution'), RULES);
  assert.equal(aggregator.source, 'jd_attribution');
  assert.equal(aggregator.evidence, 'JD attribution: Amazon Web Services, Inc.');
  const filing = matchExcludedEmployer(CASES.find(item => item.id === 'filing-board-legal-entity-attribution'), RULES);
  assert.equal(filing.source, 'jd_attribution');
  assert.equal(filing.evidence, 'JD attribution: Filing entity: Amazon Com Services Llc');
});

test('Jobright uses the same actual-employer exclusions as LinkedIn', () => {
  assert.deepEqual(JOBRIGHT_RULES, RULES.filter(rule => rule.id !== 'jobright-ai'));
});

test('Python and JavaScript LinkedIn adapters classify the same employer fixtures', () => {
  const helper = `
import json, sys
sys.path.insert(0, sys.argv[1])
from employer_exclusions import match_excluded_employer
payload = json.load(sys.stdin)
print(json.dumps([match_excluded_employer(item['company'], item['description'], payload['rules']) for item in payload['cases']]))
`;
  const python = JSON.parse(execFileSync('python3', ['-c', helper, path.join(ROOT, 'adapters')], {
    input: JSON.stringify({ rules: RULES, cases: CASES }),
    encoding: 'utf8',
  }));
  const javascript = CASES.map(item => matchExcludedEmployer(item, RULES));
  assert.deepEqual(python, javascript);
});


test('explicit empty employer policy is allowed in both runtimes; missing policy still fails', () => {
  assert.deepEqual(validateEmployerExclusionRules([]), []);
  assert.equal(matchExcludedEmployer({ company: 'Example' }, []), null);
  assert.throws(() => validateEmployerExclusionRules(undefined), /must be an array/);
  execFileSync('python3', ['-c', 'from employer_exclusions import validate_employer_exclusion_rules, match_excluded_employer; assert validate_employer_exclusion_rules([]) == []; assert match_excluded_employer("Example", "", []) is None'], { cwd: path.join(ROOT, 'adapters') });
  assert.throws(() => execFileSync('python3', ['-c', 'from employer_exclusions import validate_employer_exclusion_rules; validate_employer_exclusion_rules(None)'], { cwd: path.join(ROOT, 'adapters'), stdio: 'pipe' }));
});
