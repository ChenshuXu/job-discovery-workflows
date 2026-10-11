# Daily Scan structured report contract (v6)

Worker `report` is a JSON object for a predicted report candidate, otherwise `null`.
It contains only the fields below. Do not write Markdown/YAML, company/role/URL/key,
score/decision, work_auth, next_action, top_strengths, soft_gaps or legitimacy again.
Assignments/acquisition and validated results own those values. New merges require v6; v4/v5 is available only through explicit read-only inspection;
historical receipts and reports are unchanged.

## Fields

```json
{
  "archetype": "Backend / Platform",
  "reason": "The strongest evidence-bound match reason.",
  "evidence": [
    {"source":"jd","quote":"<continuous exact JD text>","explanation":"<why it matters>"},
    {"source":"candidate","locator":"cv.md/Experience","fact":"<supported fact>","explanation":"<match>"}
  ],
  "gaps": [
    {"quote":"<exact JD baseline/preferred requirement>","locator":"cv.md/Experience","explanation":"<evidenced gap or missing documentation>"}
  ],
  "risk_level": "Low",
  "confidence": "Medium",
  "score_evidence": {
    "cv_match": {"status":"supported","source":"cv.md/Experience","observation":"Current experience supports backend delivery.","question":null},
    "north_star": {"status":"supported","source":"modes/_profile.md/Your Target Roles","observation":"The role matches the stated platform target.","question":null},
    "compensation": {"status":"unknown","source":null,"observation":"No usable salary evidence is captured.","question":"What are guaranteed base and variable pay?"},
    "culture": {"status":"supported","source":"JD: <continuous exact JD text>","observation":"The JD directly supports the stated culture requirement.","question":null},
    "red_flags": {"status":"supported","source":"JD: <continuous exact JD text>","observation":"Reviewed requirements contain no unresolved restriction.","question":null}
  },
  "confidence_gaps": ["Confirm guaranteed base and variable pay."],
  "risk_summary": {
    "classification": "clear",
    "culture": "not_evaluated",
    "interview_redflags": "not_evaluated",
    "ai_infra": "consistent"
  },
  "discard_reasons": [],
  "fixed_term_evidence": null,
  "advertised_comp": null,
  "company_confidential_evidence": null
}
```

All fields are required; unknown fields are errors. `archetype` may be null if the
role cannot be classified. `advertised_comp` is null or a continuous exact JD quote;
never estimate compensation. `company_confidential_evidence` is null unless the JD
explicitly says the employer identity is withheld; then supply that exact quote.
A confidentiality/security duty is not evidence of an undisclosed employer.

Evidence: **1–5** substantive items. Each has exactly one source form as above.
Gaps: **0–3** actual gaps, each tied to a JD requirement and a candidate-source locator.
Use `[]` without supported gaps; missing documentation is not missing ability.
Future learning ("become an expert") is not a gap without a separate hiring requirement.

Candidate locators use only `cv.md/<section>`, `profile.yml/<field>` or
`modes/_profile.md/<section>`, bound to the three SHA-256-locked files. Read each cited source to verify the claim and requirement relationship; a valid
locator alone proves neither.

String limits in Unicode characters: archetype 80, locator 100, reason/fact/explanation
160 each, exact quotes 240 each. Semantic prose and locators use one line. Quotes
may include embedded quotes and line breaks; preserve them exactly in JSON strings.
Do not splice, normalize whitespace, truncate or paraphrase quoted source text.

Quote encoding depends on the field; these shapes are not interchangeable:

| Field | Value after JSON decoding |
| --- | --- |
| Top-level `level_evidence`, non-null `eligibility_evidence` | `JD: "<one continuous exact passage>"` |
| `report.evidence[].quote`, `report.gaps[].quote`, `work_authorization.quote`, compensation/confidentiality quotes | The continuous source text itself, without an added `JD:` prefix or wrapping quotation marks |
| `report.score_evidence.<dimension>.source` when citing the JD | `JD: ` followed by one continuous exact passage, without wrapping quotation marks |

Two separately exact passages joined into one value are still an invalid quote.
Select the decisive passage or use separate report evidence items when appropriate;
put synthesis in the explanation/observation, never inside a quote. Explanations
must preserve the requirement's scope and strength; do not add requirements absent
from the quoted passage and its JD context.

`risk_level` and `confidence`: `Low | Medium | High`.
`score_evidence` has exactly `cv_match`, `north_star`, `compensation`, `culture`,
and `red_flags`; each has `status` (`supported | partial | unknown`), `source`,
`observation`, and `question`. A source is `JD: ` followed by a continuous exact
quote (without added quotation marks), an approved candidate locator, or null only
for unknown evidence. Observation and non-null question are single-line text,
up to 160 characters each. Partial/unknown requires a concrete question.
`confidence_gaps` contains 0–3 distinct concrete checks, up to 160 characters each;
it cannot be empty when questions or eligibility uncertainty remain.
Code derives the canonical evidence tier and rejects a conflicting `confidence`.
Rules/customizations are never candidate evidence locators.
`risk_summary` has exactly four worker-owned fields:

- classification: `clear | flagged | not_evaluated`
- culture: `pass | caution | fail | not_evaluated`
- interview_redflags: `none | caution | warning | not_evaluated`
- ai_infra: `consistent | mismatch | not_evaluated`

## Generated report

Code generates these headings in order: `## Machine Summary`, `## Verdict`,
`## Evidence`, `## Gaps`, `## Work Authorization`, `## Score Evidence`. Machine Summary uses YAML with JSON-escaped scalars and fixed indentation.
Machine Summary mirrors the five statuses in `score_evidence` and the checks in
`confidence_gaps`; the Score Evidence table preserves every source, observation and
question. Code derives strengths/gaps from explanations, legitimacy from the result tier,
confidentiality from its evidence, and next action from the final decision and
actual eligibility evidence.
Identity and discovery channel come from the assignment/acquisition, never model text.
Top-level work_authorization follows [scoring judgment](worker-scoring.md). Code checks shape and quote occurrence, supplies labels, and never reclassifies JD meaning.

The compact body must fit **6,000 Unicode characters total**, including all formatting.
This envelope includes all five evidence rows without lossy clipping.
The part validator checks rendering before accepting the batch. On overflow, shorten
semantic explanations or select shorter decisive exact quotes within the existing
per-posting retry budget; never cut source evidence or raise scores to pass a gate.
No A–G sections, research, interview/customization plans, or extra headings.

## Report reason and finite-term evidence

Read `templates/discard-reasons.yml` from the SHA-256-locked Career-Ops code-root
rule source. For a predicted Consider report, return 1–3 distinct reasons, using
canonical ids only when their `when` definitions fit the existing evidence. Use a
short free-text reason when none fits; never guess a synonym or force a category.
Apply and Research first require `discard_reasons: []`. Each reason is non-empty,
single-line text, at most 160 Unicode characters. These are forecasts, not the
candidate's recorded discard decision. Do not create low-score/excluded reports
for statistics, modify status, or change the score to satisfy this field.

`fixed_term_evidence` is null after reviewing the complete JD if no explicit
finite employment term is disclosed, otherwise one continuous exact quote of at
most 240 characters. Preserve stated durations verbatim. Read role context:
customer contracts, contract law/management and contractor status alone do not
establish a finite term. Code does not interpret keywords. The signal itself does
not change score or legitimacy; existing permanent-full-time eligibility policy
still excludes incompatible terms and retains uncertainty for conflicting terms.

Code generates `result_schema_version: 6` in Machine Summary and derives
`risk_summary.fixed_term` as detected/not_detected from this quote. It adds one
plain evidence line inside `## Evidence`, within the same 6,000-character budget.
Historical v4/v5 summaries keep their original field sets and do not gain a
not_detected default. Historical procedural-rule hashes remain provenance, with
`historical_rule_hashes_verified: false` on explicit legacy result inspection;
current candidate hashes and structural evidence are still checked. Such reads
never permit a legacy merge or new commit. Expansion must copy the original
summary and the exact finite-term evidence line, without adding/removing signals.
