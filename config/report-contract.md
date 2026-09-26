# Daily Scan structured report contract (v4)

Worker `report` is a JSON object for a predicted report candidate, otherwise `null`.
It contains only the fields below. Do not write Markdown/YAML, company/role/URL/key,
score/decision, work_auth, next_action, top_strengths, soft_gaps or legitimacy again.
Assignments/acquisition and validated results own those values. The merger rejects v2/v3;
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
  "confidence": "High",
  "risk_summary": {
    "classification": "clear",
    "culture": "not_evaluated",
    "interview_redflags": "not_evaluated",
    "ai_infra": "consistent"
  },
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

`risk_level` and `confidence`: `Low | Medium | High`.
`risk_summary` has exactly four worker-owned fields:

- classification: `clear | flagged | not_evaluated`
- culture: `pass | caution | fail | not_evaluated`
- interview_redflags: `none | caution | warning | not_evaluated`
- ai_infra: `consistent | mismatch | not_evaluated`

## Generated report

Code generates these headings in order: `## Machine Summary`, `## Verdict`,
`## Evidence`, `## Gaps`, `## Work Authorization`. Machine Summary uses YAML with JSON-escaped scalars and fixed indentation.
Code derives strengths/gaps from explanations, legitimacy from the result tier,
confidentiality from its evidence, and next action from the final decision and
actual eligibility evidence.
Identity and discovery channel come from the assignment/acquisition, never model text.
Top-level work_authorization follows [scoring judgment](worker-scoring.md). Code checks shape and quote occurrence, supplies labels, and never reclassifies JD meaning.

The compact body must fit **2,500 Unicode characters total**, including all formatting.
The part validator checks rendering before accepting the batch. On overflow, shorten
semantic explanations or select shorter decisive exact quotes within the existing
per-posting retry budget; never cut source evidence or raise scores to pass a gate.
No A–G sections, research, interview/customization plans, or extra headings.
