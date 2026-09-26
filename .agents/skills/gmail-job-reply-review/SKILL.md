---
name: gmail-job-reply-review
description: Review Gmail job-application replies and maintain the full interview register and linked company process summaries. Use for scheduled/manual mailbox reviews and direct process updates, not prep or debrief writing.
---

# Gmail Job Reply Review

Keep the whole interview record consistent. Career Docs owns the sole current-state
register and candidate TODOs:

`../career-docs/context/Interview/active-interviews.md`

Each company's `context/Interview/<company>/process-summary.md` owns process identity
context, dated communication history and source links. The register's Notes cell links
to the matching process section; it is not a running log. Existing prep and debrief
documents remain the source for their content.

Run commands from the `job-discovery/` repository root. Filesystem paths below are
relative to that root unless stated otherwise; use the actual dependency paths
when repositories are not siblings.

Career-Ops owns application lifecycle state. Read its `AGENTS.md` before its operations;
use its existing writers and leave its system code unchanged. Runtime state belongs
in Job Discovery `.local/gmail-job-reply-review/`; do not copy current-state tables,
TODO lists or routine run history into summaries or automation memory.

## Choose the mode

- **Direct confirmation / register edit:** follow the document and write contracts
  below. No mailbox access or transaction is needed.
- **Gmail review:** read [mailbox-transaction.md](references/mailbox-transaction.md),
  which owns account routing, scan/classification, receipts, recovery, and reporting.

Complete authorized work without another approval pause; continue independent work
when an identity or outcome is uncertain. Workflow audits do not start production runs.

## Register writes

Use the canonical writer from the repository root:

```text
node .agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs prepare FILE CANDIDATE
node .agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs apply FILE CANDIDATE BASELINE_SHA256
```

Edit affected summary sections before `prepare`; its baseline also fences linked files.
Use the register as FILE and a unique separate candidate path. Edit only the candidate,
then `apply` with `baseline_sha256` from `prepare`. The shared lock, schema and Identity
checks protect Git HEAD and current contents. Failure preserves both files; success
consumes the candidate. Re-prepare and reconcile concurrent changes.

Use normal file tools for the affected Identity sections in linked summaries. If their
content changes after `prepare`, re-prepare and reconcile before applying. Review
the combined diff and links. For direct updates, commit only the register and summaries
changed for that update; do not push. For Gmail, `begin` precedes `prepare`, and the
transaction's `commit` owns the final scoped Git commit. No direct edits to the canonical
register. `begin` reports checked TODOs; the agent reconciles them before completion.

## Reconcile the whole record

Read the Active table and TODOs at the start of every update. For affected processes
and past-dated scheduled rounds, inspect the relevant summary, new mail, and existing
local completion evidence such as a debrief. Do not reread unrelated prep or transcripts.
No new email does not mean an existing process needs no update.

For each evidenced change, reconcile **Stage, Date / Deadline, Status, Last Updated,
the linked summary, and TODOs together**, including an Archived move when appropriate.
Current columns describe the latest situation; superseded schedules belong in dated
history. A checked TODO is evidence that its stated action is complete, not that a round
was passed or even attended. Record that fact in the summary and remove that TODO; then
derive the current state from the remaining actions and confirmed schedule. An accepted
invitation to a future interview is Scheduled. A completed interview with no candidate
action or next appointment is Waiting.

For a past appointment without completion evidence, state that completion is unconfirmed
and retain the known date; do not keep describing it as upcoming or infer completion from
the clock. Ask for confirmation only when it materially affects the update. A prep draft
or coaching assessment cannot establish attendance or the company's hiring outcome.

Before applying, review every changed process against its summary and TODOs. Mechanical
checks establish structure, identity and evidence integrity, not the meaning of Stage or
Date. Do not call an update complete merely because the checks pass.

## Process summaries

Reuse the company's existing folder. Keep separate process sections for separate
requisitions; never merge by company/title alone. Use this link in the Notes cell:

```markdown
[Process summary](company/process-summary.md#action-company-screen)
```

The target section starts with `## action-company-screen` and a separate line
``Identity: `action:company-screen` ``. Derive the anchor by lowercasing Identity,
replacing runs of non-ASCII letters/digits with `-`, and trimming outer `-`.
Use `###` for subsections so the Identity section stays unambiguous.

Keep concise identity/role context, dated scheduling and recruiter communications,
outcomes, and links to the relevant prep/debrief/original evidence. For an interview
already documented in a debrief, retain only a dated completion milestone and link;
do not copy its questions, answers, performance analysis or feedback detail. An offer
debrief likewise owns detailed terms; link it instead of duplicating them. Distinguish
company feedback from personal assessment. Correct superseded assertions in place or
clearly date them; avoid appending another contradictory account of the current state.

Place Gmail evidence markers in the matching Identity section, near the dated event or
in its evidence list. Preserve existing markers and useful source links during migration;
do not invent message URLs from opaque marker hashes. Preserve terminal history when
reopening. The summary links back to the register for current state and candidate actions;
it does not maintain another status table or checklist.

## Document contract

Admit only explicit recruiter-screen, interview, assessment, take-home, or work-trial
evidence. Generic outreach is not admission. Keep one row per process across rounds;
record completed rounds as concise dated milestones in its linked summary.

- At admission, use `tracker:#N` only for an exact application match. Otherwise use
  stable `action:<slug>` or `ambiguous:<slug>`; never guess or create a tracker row.
  Later resolution fills Tracker while preserving Identity in both row and TODO label.
- An unchecked candidate action means `Action Required`; otherwise use `Scheduled`
  for an upcoming confirmed time and `Waiting` after the current action/round is complete.
  Record direct completion as a dated summary milestone and remove that TODO. Completion
  does not imply passing. A TODO is one candidate action, never waiting for the company;
  old/repeated mail must not reopen completed actions.
- Archive terminal processes as `Rejected`, `Withdrawn`, `Cancelled`, or `Hired`;
  remove their TODOs, retain outcome/date/evidence, and never delete admitted Identities.
  Reopening the same requisition moves the same Identity to Active and preserves the
  previous terminal date/outcome in its summary. A different requisition is a separate process.
- Nonblank Tracker must match Career-Ops `Interview`/`Offer` for Active;
  `Rejected`, `Discarded` (Withdrawn/Cancelled), or `Hired` for the Archived outcome.
- Primary dates/deadlines use America/Los_Angeles. Preserve a useful source timezone,
  user checkbox evidence, and hand-written context when relocating it to the summary.

Keep exactly `## Active Processes`, `## Current TODO`, `## Archived Processes`, in
that order. Both process tables use this exact header and nine-column divider:

```markdown
| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |
|---|---|---|---|---|---|---|---|---|
```

TODOs are ordinary Markdown; the bold label includes `#N` for `tracker:#N`, or the
exact `action:`/`ambiguous:` Identity. Example labels (not rows to insert):

```markdown
- [ ] **Company / #123：** confirm the interview time
- [ ] **Company / action:company-screen：** send availability
```
