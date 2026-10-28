# Daily Scan structured report contract (v8)

Worker `report` is a JSON object for a predicted report candidate, otherwise `null`.
It contains only the fields below. Do not write Markdown/YAML, company/role/URL/key,
score/decision, work_auth, next_action, top_strengths, soft_gaps or legitimacy again.
Assignments/acquisition and validated results own those values. New merges require v8; v4/v5/v6/v7 is available only through explicit read-only inspection;
historical receipts and reports are unchanged.

## Fields

```json
{
  "archetype": "Backend / Platform",
  "requirement_importance": [],
  "keywords": ["distributed systems", "APIs", "observability"],
  "reason": "The strongest evidence-bound match reason.",
  "evidence": [
    {"source":"jd","quote":"<continuous exact JD text>","explanation":"<why it matters>"},
    {"source":"candidate","locator":"cv.md/Experience","fact":"<supported fact>","explanation":"<match>"}
  ],
  "gaps": [
    {"quote":"<exact JD baseline/preferred requirement>","locator":"cv.md/Experience","explanation":"<evidenced gap or missing documentation>"}
  ],
  "hiring_manager_review": {
    "summary": "<evidence-bound simulated screening judgment; say when no supported rejection reason exists>",
    "concerns": [
      {"reason":"<why this hiring manager might decline an interview>","jd_quote":"<continuous exact JD requirement>","resume_locator":"cv.md/Experience","resume_quote":"<continuous exact resume passage>","evidence_type":"documented","explanation":"<how the JD and quoted resume support this specific concern>"}
    ]
  },
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

All fields are required; unknown fields are errors. `hiring_manager_review` is
required when assignments freeze `hiring_manager_review_version: 1`; historical
assignments without that marker retain their original fields and rendering.
`archetype` may be null if the
role cannot be classified. `advertised_comp` is null or a continuous exact JD quote;
never estimate compensation. `company_confidential_evidence` is null unless the JD
explicitly says the employer identity is withheld; then supply that exact quote.
A confidentiality/security duty is not evidence of an undisclosed employer.

Evidence: **1–5** substantive items. Each has exactly one source form as above.
Gaps: **0–3** actual gaps, each tied to a JD requirement and a candidate-source locator.
Use `[]` without supported gaps; missing documentation is not missing ability.
Future learning ("become an expert") is not a gap without a separate hiring requirement.

Candidate locators use only `cv.md/<section>`, `profile.yml/<field>` or
`modes/_profile.md/<section>`, bound to the three content-locked files. Read each cited source to verify the claim and requirement relationship; a valid
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
for unknown evidence. New `research_version: 0` plans omit external research and
cannot cite `Research:` sources. Historical research-enabled results may also use
`Research: <id>: <continuous exact passage>` from that result's captured
research source. Research citations are bound
to the relevant compensation/culture/company check; unknown ids, wrong dimensions
and non-exact quotations are rejected. Observation and non-null question are single-line text,
up to 160 characters each. Partial/unknown requires a concrete question.
`confidence_gaps` contains 0–3 distinct concrete checks, up to 160 characters each;
it cannot be empty when questions or eligibility uncertainty remain.
Code derives the canonical evidence tier and rejects a conflicting `confidence`.
Rules/customizations and public research are never candidate evidence locators.
New JD-only reports omit the External research section. For historical research-enabled
results, research checks and source links render inside Score Evidence and count toward
the existing compact budget; source passages remain intact in result parts and
finals. Limited/unavailable research must keep its question in `confidence_gaps`
and cannot become supported evidence for that dimension. Historical reports
without research keep their original presentation.
`risk_summary` has exactly four worker-owned fields:

- classification: `clear | flagged | not_evaluated`
- culture: `pass | caution | fail | not_evaluated`
- interview_redflags: `none | caution | warning | not_evaluated`
- ai_infra: `consistent | mismatch | not_evaluated`

## Generated report

Code generates these headings in order: `## Machine Summary`, `## Verdict`,
`## Evidence`, `## Gaps`, `## Hiring Manager Resume Review` (when present),
`## Work Authorization`, `## Score Evidence`, `## Keywords extracted`. Machine Summary uses YAML with JSON-escaped scalars and fixed indentation.
Machine Summary mirrors the five statuses in `score_evidence` and the checks in
`confidence_gaps`; the Score Evidence table preserves every source, observation and
question. Code derives strengths/gaps from explanations, legitimacy from the result tier,
confidentiality from its evidence, and next action from the final decision and
actual eligibility evidence.
Identity and discovery channel come from the assignment/acquisition, never model text.
Top-level work_authorization follows [scoring judgment](worker-scoring.md). Code checks shape and quote occurrence, supplies labels, and never reclassifies JD meaning.

The compact scoring body must fit **12,000 Unicode characters total**, including all formatting.
This envelope includes all five evidence rows without lossy clipping.
The part validator checks rendering before accepting the batch. On overflow, shorten
semantic explanations or select shorter decisive exact quotes within the existing
per-posting retry budget; never cut source evidence or raise scores to pass a gate.
The keyword and hiring-manager blocks are included in this same budget. No A–G sections, research,
interview/customization plans, or other extra headings.

## Hiring-manager resume review (version 1)

For every report candidate in a review-enabled assignment, answer both questions:

1. 假设你现在是这个岗位的 hiring manager，这是你收到的一份简历。请列出你为什么不会给这个 candidate 面试。
2. 你为什么会得出这个结论？从我的简历里找依据。

Use the exact posting's complete JD and the locked `cv.md` as the received resume.
This is a simulated screening critique, not an employer decision or another fit
score. Rank 0–3 substantive concerns by hiring importance, including strong-fit
reports. Do not invent weaknesses to fill a quota. With no evidence-supported
reason, say so in `summary` and return `concerns: []`.

Each concern has exactly `reason`, `jd_quote`, `resume_locator`, `resume_quote`,
`evidence_type`, `explanation`. Bind the reason to a real JD requirement; preserve
required/preferred strength. `resume_locator` must be `cv.md/<section>` and
`resume_quote` must be one continuous exact passage from that locked resume, not
the profile, custom rules, research, a previous report or inferred experience.
`evidence_type` is `documented` for a concern supported by explicit resume text,
or `not_demonstrated` when the relevant evidence is absent/unclear. Missing
documentation never proves missing ability. For `not_demonstrated`, quote the
closest relevant resume passage; use null only when no relevant passage exists,
and name the section reviewed. A documented concern always requires a quote.
Explain the inference in `explanation`, without inventing a candidate fact.

`summary` and each `explanation` allow 240 Unicode characters; `reason` 160,
`resume_locator` 100, and each exact quote 240. Concerns must be distinct. Code
checks JD and resume quote occurrence and renders the two questions plus their
numbered answers. Mechanical checks do not prove the judgment is substantively
correct. Keep this critique separate from candidate discard reasons and existing
score, legitimacy, status, authorization and report gates. Expansion preserves
the original review verbatim once; never regenerate it or backfill old reports.

## Report reason and finite-term evidence

Read `templates/discard-reasons.yml` from the content-locked Career-Ops code-root
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

Code generates `result_schema_version: 8` in Machine Summary and derives
`risk_summary.fixed_term` as detected/not_detected from this quote. It adds one
plain evidence line inside `## Evidence`, within the same 12,000-character budget.
Historical v4/v5 summaries keep their original field sets and do not gain a
not_detected default; v6 keeps its existing finite-term signal without keywords.
Historical procedural-rule snapshots remain provenance, with
`historical_rule_snapshots_verified: false` on explicit legacy result inspection;
current candidate snapshots and structural evidence are still checked. Such reads
never permit a legacy merge or new commit. Expansion must copy the original
summary and the exact finite-term evidence line, without adding/removing signals.

## ATS keywords (v7)

`keywords` is required only on report candidates: 1–20 distinct strings, each
at most 80 Unicode characters. Aim for 15–20 substantive JD skills, technologies,
methods and domain terms. A sparse JD may yield fewer; never pad with candidate
skills, general company knowledge or invented synonyms. Select terms from the
complete saved JD body, preserving its spelling and punctuation (case may differ).
Do not splice fragments, translate, include boilerplate benefits or infer missing skills.

Each term must occur within complete word boundaries in the saved JD; Java does
not match JavaScript. Deduplication ignores case and repeated whitespace, matching
the official comparator. Use trimmed plain text without
commas, backslashes, backticks, asterisks, angle/square brackets, pipes, control
characters, line breaks or a terminal period. Keep C++, C#, .NET, CI/CD and Node.js
verbatim. Code emits one unescaped bullet per term under `## Keywords extracted`
so the official Career-Ops parser can read every term without Markdown artifacts.

This is a pre-tailoring diagnostic input, not another fit score or a claim about
candidate experience. Do not emit coverage percentages or edit the CV: the report
page computes coverage against the current base CV through the official matcher.
Missing/thin keywords never justify fabricated experience. v7 changes the result
contract; historical v6 remains read-only with no invented keyword defaults.

## Requirement importance (v8)

Every report candidate supplies `requirement_importance` as an array, including
`[]` only when the complete JD yields no usable requirements. Every row has exactly
`requirement`, `jd_signal`, `evidence`, `importance`, `match`. `requirement` is one
continuous exact JD phrase, at most 160 Unicode characters. Include satisfied
requirements as well as gaps, never just the candidate's weakest areas.

Determine requirements and importance from the JD first; then judge match using
the locked candidate files. Do not revise importance to suit candidate strengths
or gaps. Evidence is `stated | structural | inferred`; importance is
`critical | high | meaningful | preferred | low_signal`; match is
`strong | partial | missing | na`. A stated signal is one exact JD quote; a
structural signal is exact, locatable JD heading/structure text. Both are at most
240 characters. An inferred signal is null and its importance cannot be critical
or high. Inferred importance never creates a hard stop or changes global score.

Sort by importance descending, and unmet (partial/missing) before met (strong/na)
within each band. Keep at most 12 rows unless more than 12 are critical/high;
retain all critical/high rows. Deduplicate requirement text ignoring case and
whitespace. Strong/partial/missing are candidate claims: read the locked sources,
never infer inability from missing documentation; use partial with an honest
existing gap/confidence explanation when consequential evidence is incomplete.

The renderer carries the five-field array unchanged in Machine Summary, without
a second compact requirement matrix. It remains score-neutral and uses the same
12,000-character v8 total budget; shorten prose or choose concise exact phrases,
never truncate or drop high-importance rows to pass. Historical v4-v7 keep their
original fields and 6,000-character budget. Expansion copies the complete summary
unchanged; the full Block B display belongs to the expansion workflow.

The upstream skip-blocker analysis only uses report-backed Skip/Discarded rows.
This field does not add reports for below-threshold or excluded jobs, and must
not be described as full-pipeline rejection statistics.

## Deterministic PERM reference (code only)

For new baselines frozen with `perm_history.report_layout: work-authorization-v1`,
commit appends `### PERM 历史参考（仅供参考）` after the original text in
`## Work Authorization`. The model supplies no PERM data. Worker schema, scores,
eligibility, decisions, Machine Summary and authorization labels/quotes stay unchanged.
The local reference is bounded to 20,000 Unicode characters and checked separately
for exact posting binding, frozen source content, section placement and uniqueness.
The scoring body retains its original budget; only the precisely delimited reference
can be separated for parsing. Its unused Markdown reference definitions delimit the
block without displaying technical markers in the existing page. PERM outcome tables
use three columns (result and the two fiscal years) to fit existing upstream styles.
Local detail paths are identified as workspace files rather than web download links.

Expansion preserves this authorization/reference once, outside its evidence appendix.
Legacy PERM baselines without a layout marker keep their metadata format; pre-integration
runs keep their original contract. No historical backfill or Career-Ops source edits.
