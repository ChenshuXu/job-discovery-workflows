import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScoringSafety, deriveReportWorkAuthorization } from '../src/scoring-safety.mjs';

const candidateText = 'visa_status: "H-1B"\nneeds_sponsorship: true\n';
const jdText = '**Role:** Senior Backend Engineer\n## Requirements\nBuild backend systems.\n';
const item = overrides => ({ posting_key: 'example:1', fit_score: 3.7,
  level_signal: 'target', level_evidence: 'JD: "**Role:** Senior Backend Engineer"',
  eligibility_status: 'eligible', eligibility_category: null, eligibility_evidence: null,
  legitimacy_tier: 'High Confidence', rationale: 'The worker found material experience gaps.', report: null, ...overrides });
const evaluate = (value, text = jdText) => applyScoringSafety({ item: value, jdText: text, threshold: 4 });

test('model judgments survive unfamiliar wording, language, joined headings and required-section bullets', () => {
  for (const [category, quote, status = 'ineligible'] of [
    ['no_sponsorship', 'Please note our company does not provide visa support or sponsorship for employees.'],
    ['no_sponsorship', 'No immigration sponsorship is available for this position.'],
    ['work_authorization', 'US Citizen or Green Card holder'],
    ['citizenship', 'US CitizenshipPreferred qualifications:'],
    ['export_control', 'U.S. Person status is required as this position needs to access export controlled data'],
    ['mandatory_unacceptable_location', 'Team members in this role must live within commuting distance of our New York hub.'],
    ['mandatory_unacceptable_location', 'Flexible Arbeitsorte: Berlin oder Rhein-Main – bundesweit mit Remote-Option.'],
    ['mandatory_unacceptable_location', 'We are considering candidates from US and Canada only (EST time zone).', 'needs_verification'],
    ['no_sponsorship', 'Looking for Visa Independent candidate', 'needs_verification'],
  ]) {
    const value = item({ eligibility_status: status, eligibility_category: category, eligibility_evidence: `JD: "${quote}"` });
    const result = evaluate(value, `${jdText}${quote}`);
    assert.equal(result.eligibility_status, status);
    assert.equal(result.eligibility_category, category);
    assert.equal(result.eligibility_evidence, value.eligibility_evidence);
    assert.equal(result.rationale, value.rationale);
    assert.equal(result.hard_exclusion, status === 'ineligible');
  }
});

test('code preserves the model level and enforces its mechanical score cap without inferring from the JD', () => {
  for (const quote of ['10+years of experience', '8+ years building business systems or GTM platforms',
    'Experience Required: 10+ Years', "Bachelor's degree (or equivalent) with 10 years of experience"]) {
    const result = evaluate(item({ fit_score: 4.8, level_signal: 'staff_equivalent', level_evidence: `JD: "${quote}"` }), `${jdText}${quote}`);
    assert.equal(result.level_signal, 'staff_equivalent');
    assert.equal(result.score, 3.5);
    assert.equal(result.hard_exclusion, false);
    assert.equal(result.report_allowed, false);
  }
  // Semantic correctness is the worker's responsibility, including alternatives
  // and negations. Merely adding words to a JD must not mutate a supplied decision.
  const value = item();
  assert.deepEqual(evaluate(value, `${jdText}Principal Engineer; no sponsorship`), evaluate(value));
});

test('mechanical report gates preserve eligibility, fit, legitimacy and rationale', () => {
  const quote = 'US / Canada (EST time zone)';
  for (const [status, tier, decision] of [
    ['eligible', 'High Confidence', 'Apply'], ['eligible', 'Proceed with Caution', 'Consider'],
    ['eligible', 'Suspicious', 'Consider'], ['needs_verification', 'High Confidence', 'Research first'],
  ]) {
    const value = item({ fit_score: 4.2, eligibility_status: status, legitimacy_tier: tier, report: {},
      ...(status === 'needs_verification' ? { eligibility_category: 'mandatory_unacceptable_location', eligibility_evidence: `JD: "${quote}"` } : {}) });
    const result = evaluate(value, `${jdText}${quote}`);
    assert.equal(result.score, 4.2);
    assert.equal(result.report_decision, decision);
    assert.equal(result.report_allowed, true);
  }
  const excluded = evaluate(item({ fit_score: 4.8, eligibility_status: 'ineligible', eligibility_category: 'employment_type', eligibility_evidence: 'JD: "Build backend systems."' }));
  assert.equal(excluded.fit_score, 4.8);
  assert.equal(excluded.score, 3.5);
  assert.equal(excluded.report_decision, 'Skip');
});

test('invalid enums, invented evidence, derived fields and inconsistent payloads remain errors', () => {
  for (const [overrides, pattern] of [
    [{ fit_score: '4.2' }, /fit_score/], [{ fit_score: NaN }, /fit_score/], [{ fit_score: 5.1 }, /fit_score/],
    [{ fit_score: 3.75 }, /fit_score/], [{ level_signal: 'senior' }, /level_signal/],
    [{ eligibility_status: 'maybe' }, /eligibility_status/], [{ legitimacy_tier: 'Trusted' }, /legitimacy_tier/],
    [{ level_evidence: 'JD: "Invented title"' }, /exact JD substring/],
    [{ eligibility_evidence: 'JD: "Build backend systems."' }, /eligible result/],
    [{ eligibility_status: 'ineligible', eligibility_category: 'technology_gap' }, /eligibility_category/],
    [{ eligibility_status: 'needs_verification', eligibility_category: 'public_trust', eligibility_evidence: 'Ambiguous' }, /exact JD substring/],
    [{ score: 5 }, /derived legacy fields/], [{ extra: true }, /unsupported result field/],
    [{ fit_score: 4.2 }, /report payload/], [{ report: {} }, /report payload/],
    [{ rationale: '' }, /rationale/], [{ rationale: 'a\nb' }, /rationale/], [{ rationale: 'x'.repeat(151) }, /rationale/],
  ]) assert.throws(() => evaluate(item(overrides)), pattern);
});

test('work authorization uses model-supplied evidence and fixed labels, without JD phrase matching', () => {
  const text = `${jdText}Visa assistance can be arranged following individual review.`;
  const derive = (auth, overrides = {}, facts = candidateText) => deriveReportWorkAuthorization({
    item: item({ work_authorization: auth, ...overrides }), jdText: text, candidateText: facts,
  });
  assert.deepEqual(derive({ value: 'needs_verification', quote: 'Visa assistance can be arranged following individual review.' }, { eligibility_status: 'needs_verification' }), {
    value: 'needs_verification', label: '⚠️ Verify sponsorship', quote: 'Visa assistance can be arranged following individual review.',
  });
  assert.equal(derive({ value: 'sponsors', quote: 'Build backend systems.' }).value, 'sponsors');
  assert.equal(derive({ value: 'unstated', quote: null }).value, 'unstated');
  assert.equal(derive({ value: 'not_needed', quote: null }, {}, 'needs_sponsorship: false').value, 'not_needed');
  for (const auth of [undefined, { value: 'sponsors', quote: 'Invented' }, { value: 'unstated', quote: 'Build backend systems.' },
    { value: 'sponsors', quote: 'Build backend systems.', label: 'custom label' }, { value: ['sponsors'], quote: 'Build backend systems.' }]) {
    assert.throws(() => derive(auth), /work_authorization/);
  }
  assert.throws(() => derive({ value: 'not_needed', quote: null }), /locked needs_sponsorship/);
  assert.throws(() => derive({ value: 'no_sponsorship', quote: 'Build backend systems.' }), /conflicts with eligible/);
  assert.throws(() => derive({ value: 'needs_verification', quote: 'Build backend systems.' }), /uncertainty requires/);
});
