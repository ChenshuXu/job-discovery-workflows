---
name: career-ops-daily-linkedin-scan
description: Run, verify, troubleshoot, compare token usage, or schedule the multi-source Daily Job Discovery scan into Career-Ops. Excludes recruiting-post scans, resumes, and applications.
---

# Daily Scan

Job Discovery owns acquisition and identity; Career-Ops owns candidate facts,
scoring guidance and persisted reports/tracker state. Do not modify Career-Ops code.

## Choose the mode

Read only the linked sections needed for the current mode:

| Mode | Entry / outcome |
|---|---|
| Run | Procedure below; [source contract](references/workflow-contract.md#source-selection-and-snapshot), then [delegation](references/workflow-contract.md#worker-delegation-and-evidence), then [commit evidence](references/workflow-contract.md#job-issues-and-savepoints). |
| Resume | [Recovery table](references/workflow-contract.md#resume-and-verification); reuse valid work and remaining retry budgets. Start a new usage segment before continuing and rebind continuing workers. |
| Verify / troubleshoot | [Read-only acceptance](references/workflow-contract.md#read-only-acceptance) of the named run; do not start a scan, cleanup, commit or retry. |
| Compare usage | [Usage accounting](references/workflow-contract.md#usage-accounting-and-comparison); compare only named runs. For read-only requests, read existing observations and state their time. |
| Schedule | Update the existing entry, preserving unrequested fields. Its prompt needs this Skill, run intent and the [compact digest](references/workflow-contract.md#completion-report). |
| Edit workflow | Read affected contract sections and run affected checks from `AGENTS.md`, including `npm run test:daily-scan`. Routine scans use artifact gates, not another repository test run. |

## Execution scope

A run request authorizes configured retention, acquisition, bounded eligible retries,
scoring, and final commit. Make routine decisions from evidence and continue without
reconfirmation. Isolate source/posting failures under the contract; continue independent
work. Human login/verification blocks the affected source, not healthy sources that
meet liveness. Missing identity/candidate facts must not be guessed. A system-level
failure blocks dependent phases; report its evidence and required next action.

Acquire only enabled adapters through the registry runner. The standalone Google
ATS/SerpAPI utility is outside Daily Scan. Exact posting keys control application
identity; semantic aliases do not. Do not run post-score liveness, generate a CV/PDF,
prepare applications, or submit anything. Steps 1–5 do not persist scan results to Career-Ops;
documented preflight bootstrap and retention maintenance are the exception.

## Procedure

Commands run from Job Discovery unless stated otherwise. Use the resolved Career-Ops
path in place of `../career-ops` if the repositories are not siblings.

1. Resolve the workspace using `CAREER_OPS_WORKSPACE`, otherwise walk upward from
   `$PWD`; require `job-discovery/`, `career-ops/`, and `JobSpy/` if enabled.
   Choose `RUN_ID=$(date +%Y%m%d-%H%M%S)` for a new run only.
2. In Career-Ops run `node doctor.mjs --json` and `node cv-sync-check.mjs`.
   Then capture the post-retention baseline:

   ```bash
   npm run daily-scan:baseline -- --run runs/$RUN_ID --career-ops ../career-ops
   ```

   The command owns retention validation, cleanup/recovery,
   `maintenance/evaluated-retention.json`, and the source/policy/health snapshot.
   Before retention it starts `usage-context.json` for the current coordinator root turn.
3. Run only the baseline-enabled adapters, serially in their frozen order:

   ```bash
   npm run daily-scan:sources -- --run runs/$RUN_ID
   ```

   Use the frozen argv and config snapshot. After all enabled sources have run,
   inspect failures and select at most one eligible network/bootstrap/empty retry
   per adapter with `npm run daily-scan:sources -- --run runs/$RUN_ID --retry <adapter-id>`.
   Explicitly non-retryable or unclassified failures cannot be retried. Continue
   degraded only when the frozen `minimum_successful_adapters` passes; inspect both
   LinkedIn path summaries and their `required` flags.
4. Normalize, resolve identity, and plan evaluations in this order:

   ```bash
   node src/combine.mjs --run runs/$RUN_ID
   node src/run-contract.mjs --run runs/$RUN_ID
   node src/resolve-canonical-urls.mjs --run runs/$RUN_ID
   node src/plan-scan-evaluations.mjs --run runs/$RUN_ID --career-ops ../career-ops
   ```

   The planner owns location/history/semantic partitions and candidate-source hashes.
   A changed policy or locked candidate source invalidates the run; do not rewrite its snapshot.
5. Read `assignments.json`. Treat the `assignments.json.runtime` snapshot as the sole source of truth.
   Create `results/`, then dispatch non-empty assignments under the contract's worker
   delegation rules. Workers follow `config/worker-prompt.md` and own JD review,
   structured v4 parts, validation, and deterministic merge. Use that merger for empty
   assignments too; the coordinator inspects completion and targeted failures.
   Bind actual worker UUIDs immediately using the delegation contract; empty assignments
   need no model binding. Send paths and ownership, not copied scoring rules or parent history.
6. Only after one final result file exists for every expected worker id, commit:

   ```bash
   node src/commit-scan.mjs --run runs/$RUN_ID --career-ops ../career-ops --date YYYY-MM-DD
   ```

   The command owns the shared lock, live history recheck (including
   `SEMANTIC_HISTORY_COLLISION`), tracker-append proofs, official writers and rollback.
   Do not reproduce its writes or touch the shared additions queue.
7. Read the verified `receipt.json` written by commit. `daily-scan:closeout` is
   create-only, not a read-only verifier; do not run it again. Report `COMPLETE`
   only from the contract's verified persistence and set-conservation evidence.
8. Refresh the usage observation before replying:

   ```bash
   npm run daily-scan:usage -- refresh --run runs/$RUN_ID
   ```

   Return the [compact completion report](references/workflow-contract.md#completion-report):
   persistence, source coverage and semantic review are separate conclusions. Usage is
   provisional until the final reply completes; missing telemetry never rolls back persistence.
   Keep routine successes in run artifacts. Memory is for durable changes, recurring
   diagnoses and unresolved actions only.
