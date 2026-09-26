---
name: career-ops-tailored-resume
description: Tailor a truthful one-page Word resume for one user-selected Career-Ops report and report JD coverage. Requires an existing report; excludes scans, standalone pasted JDs, and PDF export.
---

# Career-Ops Tailored Resume

Produce one truthful, one-page Word resume for one selected Career-Ops report. Start from the
human-curated DOCX baseline, then swap only the evidence this JD makes necessary. The model writes a
plan; code preserves the template, checks facts, counts pages, and reports keyword coverage.

Run every command from the `job-discovery/` repository root. The default layout places
`career-ops/` beside it; `../career-ops` is relative to this working directory.
For a different Career-Ops location, set `CAREER_OPS_ROOT` to its absolute path for
setup-check and all resume commands. Report lookup, CV reading and output use that root.
See the repository README for the dependency layout.

## Decision criteria

Honor the user's selected role and requested changes using verified `cv.md` facts.
Within that evidence boundary, prioritize one-page fit, JD coverage, then polish.
When a requested claim lacks support, identify the gap and continue supported edits.

## Boundaries

- Exactly one existing Career-Ops report selected by the user. A pasted JD without a report is not
  enough; stop with `IDENTITY_BLOCKER`.
- `assets/cv-template.docx` is the layout and selection baseline. Candidate facts still come only
  from the resolved Career-Ops `cv.md`; never invent or upgrade technology, title, seniority, ownership,
  metric, attribution, time window, causal claim, or production scope.
- Preserve every retained metric's value, unit, approximation, scope, and attribution.
- A coverage `GAP` is named by the JD but unsupported by `cv.md`. It is forbidden in resume text;
  the build enforces this. `UNVERIFIED` means the proposed keyword is not a literal JD phrase and is
  a report warning, not a build failure.
- Read the bound `jd/current.md` in full. Use only the report sections emitted by `resume:context`;
  do not reopen or expand the report separately.
- Do not modify Career-Ops code, `cv.md`, reports, tracker, database, application state, or existing
  resume versions. The only Career-Ops write is a new non-overwriting
  `output/<bundle>/cv/tailored/vNNN/` containing `cv.docx` and `changes.md`.
- Never run during Daily Scan. Do not verify Apply/liveness, export PDF, or submit an application.

## Workflow

For a missing or changed personal template, follow `assets/README.md` and run
`npm run resume:template` before tailoring. Never substitute fictional candidate data.

1. Run `npm run resume:context -- <report-slug>`. Missing or ambiguous input is an
   `IDENTITY_BLOCKER`; do not guess. Compact Daily Scan reports are valid input.
2. Read the context output and complete JD. `TEMPLATE BASELINE` is the current one-pager and the
   starting point. Identify baseline bullets this JD makes irrelevant and pool bullets it makes
   essential. Extract 8-20 important JD keywords or short phrases, including material unsupported
   requirements rather than cherry-picking only supported terms.
3. Read [plan-authoring.md](references/plan-authoring.md). Run `mkdir -p .tmp` before writing
   `.tmp/plan-<slug>.json` starting
   from the baseline. Swap roughly one-for-one, order each role strongest-first for this JD, and
   rewrite only when the JD enables sharper supported framing. Keep existing baseline `**...**`;
   author 1-3 emphasis spans only for bullets swapped in or rewritten.
4. Iterate with `npm run resume:build -- <report-slug> .tmp/plan-<slug>.json --dry-run`. This runs
   all gates and writes no Career-Ops version. Read coverage and the `RENDERED TEXT` block, apply the
   self-critique checklist, fix the plan, and rerun. Work supported `MISS` items where useful; never
   force a `GAP` into the resume. For overflow, remove the least relevant whole bullet rather than
   changing fonts, margins, line spacing, or indentation.
5. Run `npm run resume:build -- <report-slug> .tmp/plan-<slug>.json` once the plan passes. It writes
   the next unused Career-Ops `vNNN` directly. Deliver the exact `cv.docx` path and summarize the
   coverage, page result, principal swaps, and honest gaps from `changes.md`.

Never hand-edit generated DOCX or OOXML. Revise `plan.json` and rebuild.

## Output

```text
.tmp/plan-<slug>.json                              local authoring input
../career-ops/output/<bundle>/cv/tailored/vNNN/   successful normal build
  cv.docx
  changes.md
```

Never overwrite a version. A requested revision creates the next unused `vNNN` and repeats every
gate.

## Page result

Word is authoritative when available: more than one page fails the build. If Word is unavailable,
the calibrated estimator becomes the gate and `changes.md` records `PAGE_COUNT: NOT RUN` with the
reason. Never describe that result as Word-verified. Set `RESUME_DISABLE_WORD=1` only when Word
automation is intentionally unavailable; the estimator still runs.
