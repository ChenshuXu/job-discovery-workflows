# Daily Scan contract

Read by phase, not cover to cover. Normal runs need source selection/adapter output,
worker delegation, job issues, receipt equations and completion report. Read retention
internals for cleanup diagnosis, source registration for adapter development, usage
comparison/backfill for measurement, and recovery/acceptance for those modes only.

## Source selection and snapshot

The active registry registers `jobspy` (JobSpy LinkedIn public results), `ego-browser` (user-visible source name: LinkedIn), and `jobright` (Jobright Recommendations). Each explicit `enabled` flag controls the next scan, and registry object order is execution order. The standalone Google ATS/SerpAPI utility remains outside Daily Scan.

Preflight create-once freezes `baseline.json.adapter_profile`: `registry_sha256`, `minimum_successful_adapters`, ordered enabled ids in `adapters`, and their argv prefix, config path/hash, and employer-exclusion flag in `adapter_definitions`. Acquisition and all downstream phases use this run-local snapshot. A later registry edit affects only a new run; a changed snapshotted config fails closed. At least one adapter must be enabled, and the minimum-success threshold cannot exceed the enabled count.

The registry runner passes frozen argv directly, serially. After all enabled sources
finish, select at most one eligible network/bootstrap/empty retry per adapter. A run
request already authorizes this selection. Unknown/unclassified or explicitly
non-retryable failures cannot be retried. Retry archives the unsuccessful invocation
under `adapter-attempts/`. A nonzero process exit with `summary.status=SUCCESS` is a
system error. Evaluate minimum successful sources only after all have finished.
`--dry-run` inspects the next run's order/argv without external access.

## Evaluated retention preflight

`daily-scan:baseline` runs retention before any adapter. The runtime setting
`retention.evaluated_unapplied_ttl_days` owns the TTL; expiry is `age_days >= TTL`
in local calendar dates. Only uniquely linked, untouched Daily Scan `Evaluated`
rows without downstream work qualify. Changed or ambiguous evidence protects a row.

The command owns locks, deletion, derived-index synchronization and rollback.
`maintenance/evaluated-retention.json` is create-only; reuse it when resuming.
Historical runs/receipts remain immutable, and removed rows are not dedup history.
Retention alone has a recovery directory; never reproduce cleanup by hand.
LinkedIn Post Scan uses generic baseline capture without retention.
For protection predicates and interrupted-cleanup diagnosis inspect
[`prepare-daily-scan`](../../../../src/prepare-daily-scan.mjs) and its retention helper.

## Employer and employment scope

Apply the `employer_exclusions` rules in each enabled adapter's frozen configuration;
an empty array excludes no employers. Resolve employer identity from platform metadata
and high-confidence JD attribution/legal-entity or official boilerplate.
Technology/customer mentions are not employer evidence; a publisher name mentioned
in the JD alone is not publisher evidence.
Permanent full-time employment is the target. Use the worker prompt's employment
categories and ambiguity rules; the merger applies the gate to the model judgment after structural and quote checks.

## Adapter output

Every enabled adapter writes `sources/<adapter>/summary.json`, `jobs/*.md`, and
`excluded-employers.json`. Disabled adapters have no run-local source entry or liveness vote.

- `summary.json` uses snake_case with `schema_version`, `run_id`, `adapter`, `status`,
  `raw_rows`, `unique_jobs`, `markdown_jobs`, and `errors`.
  `unique_jobs == markdown_jobs == jobs/*.md`.
- Only `SUCCESS` satisfies adapter liveness: at least one job, zero errors.
  `EMPTY` has neither; `FAILED` has errors and may retain validated JDs. Those JDs
  still enter acquisition; a partial capture never becomes a source success.
- The exclusion audit contains `run_id`, `excluded_count`, `results`; `run-contract`
  reapplies employer exclusions to all retained JDs and stops on an adapter leak.

Use the one registry-declared source config: schema version, positive age limit,
and source-specific scope. Query sources require queries; Jobright uses its accepted
`filter_snapshot`. Do not recreate adapter filtering in the coordinator.

LinkedIn's `direct_search` and `top_applicant_recommendations` each have `enabled`
and `required` flags. Inspect both path summaries: required failure fails LinkedIn;
optional failure is degraded only when another enabled path succeeds. Recommendation
capture must use the configured Top Applicant module, verified Past 24 hours filter
and structured listing time, not a different Show all module. Both paths deduplicate
exact LinkedIn IDs. Authentication/challenge, selector ambiguity/drift, destination or
filter mismatch and access limits are non-retryable. Cleanup belongs to the adapter.

Jobright requires existing login, validates but never changes the accepted filter
snapshot, and captures responses from normal scrolling. Detail text is Jobright's
structured content, not guaranteed employer-verbatim text. Past 24 hours / `daysAgo=1`
provides freshness; `publishTime` has no verified timezone. Match scores,
recommendation reasons, H-1B labels and profile/debug data are not scoring evidence.

Each JD preserves structured location, employment/workplace type and their provenance.
Only a structured platform/API field can set `Structured Remote Signal: true`;
JobSpy `is_remote` is heuristic. Preserve all non-unknown employment classifications
through combining; the worker resolves their meaning with the complete JD.

## Registering another source

A new adapter must have a stable lowercase-hyphen id, accept the common CLI arguments, own one in-repository config, and produce the standard summary, Markdown JDs, and employer-exclusion audit. Each JD must carry parser-v2 exact identity, complete body text, and structured location/employment/workplace evidence. Register it disabled first, prove its live artifacts through `combine` and `run-contract`, then enable it and complete one integrated Daily Scan receipt. Do not add source-specific merge, location, semantic/context, scoring, report, or Career-Ops write paths.

## Identity

Acquisition retains `posting_keys`, `primary_key`, `source_keys`, `posting_urls`
and `primary_url`; the parser and resolver own their construction.

Records merge only when exact key sets intersect. ATS keys are primary; unresolved LinkedIn records retain only their LinkedIn key. Parser-v2 identities use exact stable requisitions under
[`posting-identity`](../../../../src/posting-identity.mjs); unknown URLs must not gain
an identity from title/company similarity. Cross-day history comes only from committed Career-Ops state. After location scope, strict semantic identity hashes the normalized employer and complete normalized JD body; posting context adds normalized employment type, workplace type, and accepted location decision. Shadow mode observes same-context aliases; enforce mode removes only those aliases before assignment. Exact identities remain in `triage/canonical-url-resolutions.json` for application handoff. The shared commit lock repeats exact and semantic/context history lookup, producing `HISTORY_DUPLICATE` or `SEMANTIC_HISTORY_COLLISION` when another run committed during scoring.

## Location scope

The Career-Ops profile owns one baseline-snapshotted policy. Local eligibility is an exact match against `baseline.location_policy.local_metros`, carried into `assignments.json.location_policy`. Remote eligibility requires both a `United States`/unqualified `Remote` location and `Structured Remote Signal: true`. Search parameters, country-only `United States`, inferred text-only Remote, missing locations, source conflicts, and nonlocal cities never enter worker assignments.

`triage/location-scope.json` contains one decision per combined pre-scope posting. Decisions are either `ALLOW_LOCAL`, `ALLOW_REMOTE_US`, an `EXCLUDE_*`, or an `AMBIGUOUS_*`. Exclusions and ambiguities remain in that run-local audit but are removed from combined `jobs/`, `acquisition.keys`, and assignments before scoring. `assignments.json` and every retained acquisition record carry the policy/allowed decision, and both the run contract and deterministic worker merger fail closed if an unapproved key appears.

## Worker result

`assignments.json` keeps `result_schema_version: 4`, the immutable runtime snapshot, ordered worker keys, `primary_urls`, assignment-owned semantic/context keys, and SHA-256 locks for `cv.md`, `config/profile.yml`, and `modes/_profile.md`. Expected worker ids remain `worker-1` through `worker-N`. Only non-empty assignments spawn model workers. Each `results/<worker-id>.part-<part>.json` and `results/<worker-id>.json` carries result schema version 4, and the merger proves exact ordered ownership before producing one final per worker.

The worker-authored part schema and example live in
[`config/worker-prompt.md`](../../../../config/worker-prompt.md). Use that input
shape; `score`, `hard_exclusion`, work-authorization display labels, and semantic/context compatibility fields in the
merged final are merger-owned, not additional worker output.

The worker owns JD meaning, score, level, eligibility and work-authorization judgment.
The merger rechecks source hashes, enums, exact quote occurrence, caps and report rules;
it does not match JD predicates or override semantic judgments. No validator pass proves
semantic correctness or replaces reading the complete JD. No safety rule calls a second model.
Version 4 is required for new evaluations; current validation rejects v2/v3 or mixed parts.
Read historical receipts as recorded; do not relabel old parts or automatically reinterpret them.

## Worker delegation and evidence

The coordinator owns phase transitions, dispatch, failure classification, and closeout.
Workers own only their ordered keys and `results/<worker-id>.part-<part>.json` files;
the existing merger owns `results/<worker-id>.json` and derived fields.

- Expected ids use `N = runtime.scheduler.max_active_workers`; batching uses
  `runtime.scheduler.batch_size`, the report gate `runtime.reporting.full_report_threshold`,
  and retry exhaustion `runtime.failure.per_job_retry_limit`.
- Spawn independent non-empty assignments concurrently, up to the frozen worker
  limit and available host slots. If fewer slots are available, queue the remaining
  original assignments without repartitioning keys. Source acquisition remains serial.
- Use an available general-purpose worker with explicit `runtime.worker.model` and
  `runtime.worker.reasoning_effort`. Avoid a role that pins a conflicting model. For
  collaboration tools, use `fork_turns="none"` so the worker reads its bounded inputs
  instead of inheriting the coordinator's history. If the requested settings cannot
  be selected, report the execution blocker; do not silently substitute a model.
- Pass absolute Job Discovery/run roots, worker id, assignments path, and the complete
  worker-prompt path. Tell the worker to follow that prompt, preserve other workers'
  files, and return final/part paths plus failed counts and blockers, not full reports.
  Do not copy scoring rules into the dispatch message. Workers do not subdelegate.
- Retain returned agent ids; send targeted corrections to the same worker. Wait for
  completion using the host's completion events/bounded wait, not repeated file polling.
  Reuse valid parts and inspect only evidence implicated by errors or an explicit audit.
  Bind each returned id with `daily-scan:usage -- bind` immediately after dispatch;
  repeat the binding when continuing that worker under a resumed coordinator turn.
  A host may return only a task name. In that case use the worker's observed
  `CODEX_THREAD_ID` from its first progress message, never `CODEX_SESSION_ID` or
  the task name. The collector independently checks parent/session/root-turn identity.
- Empty assignments use the existing merger, without a model call. Require
  `result_schema_version: 4` and one final for every expected id before commit.

The final JSON's `model` and `reasoning_effort` are copied from the assignment config
by the merger. They establish requested settings, not actual model execution. Use
the usage collector's per-turn execution metadata for observed settings; otherwise
say execution model is unverified. Never relabel requested settings as observed.
The refreshable usage sidecar is not a second persistence receipt.

The worker prompt owns full-JD review, evidence-preserving repair, and bounded retries.
Do not rescore successful parts in the coordinator. A targeted evidence review may
reopen the implicated JD; a format error alone does not justify another scoring pass.

For rejected evaluations follow [worker repair](../../../../config/worker-prompt.md#result-contract):
CLI-recorded payloads, exact errors and observed attempt counts are preserved; identical
revalidation is not a repair. Library verification is read-only. No truthful repair
uses `--no-repair-reason` without claiming exhaustion; no-evaluation attempt counts remain
worker declarations. [Report fields](../../../../config/report-contract.md) have one owner.
Current evaluation inputs require v4; finish incompatible old runs with their original
code or stop before creating a new run, never relabel their parts.

## Usage accounting and comparison

Normal `daily-scan:baseline` starts `usage-context.json` before retention. This file
binds exact coordinator thread/root-turn segments and explicit worker agent ids;
it does not infer ownership from a model name, directory, or a worker result file.
On each independent coordinator turn that resumes the scan, run
`npm run daily-scan:usage -- start --run runs/$RUN_ID` before continued work,
then bind the continuing workers again. Preserve earlier segments and bindings.
Repeated registration of the same scope must not double-count it.

The receipt writer collects provisional `usage.json`, separate from immutable
`receipt.json`. Missing telemetry never blocks or rolls back persistence. Refresh
updates only usage and includes the active final reply only after its turn completes.

```bash
npm run daily-scan:usage -- bind --run runs/$RUN_ID --worker worker-1=RETURNED_AGENT_ID
npm run daily-scan:usage -- refresh --run runs/$RUN_ID
npm run daily-scan:usage -- compare --run runs/ID1 --run runs/ID2
npm run --silent daily-scan:usage -- compare --all --csv
```

Repeat `--worker worker-N=RETURNED_AGENT_ID` for each actual non-empty assignment.
`compare` refreshes only frozen bound scopes, then writes a Markdown table to stdout;
`--json` or `--csv` changes the output format; use `npm run --silent` for parseable
output without npm's banner. `--all` selects only runs already
containing `usage-context.json`; it never starts a scan or guesses historical scope.
An explicitly read-only request reads existing observations without these commands.
To backfill a completed historical run without a usage context, identify its exact
coordinator scope first:

```bash
npm run daily-scan:usage -- start --run runs/OLD_ID --coordinator-thread THREAD_ID --root-turn TURN_ID
```

Then bind its evidenced worker ids and refresh. Unknown historical ownership stays
unverified; do not attach the current comparison turn to that old run.

Report requested worker model/effort separately from observed per-turn coordinator
and worker settings, including mixed settings and unavailable evidence. Token counts
distinguish input, cached input, uncached input, output, reasoning output and total;
cached input is part of input and reasoning output is part of output, not extra tokens.
Full coverage requires evidence for every required scope. An empty assignment needs
no model call; a non-empty assignment with missing telemetry is not zero usage.
Run wall time and summed worker time are different because workers run concurrently;
resumed runs can also contain idle gaps. Keep timing scope and partial coverage visible.

For fair benchmarks use one Daily Scan per root turn, without unrelated work. Comparison
flags coordinator root turns shared by the selected runs; frozen scopes keep later
comparison turns out of old usage totals. Compare workload/candidate/policy fingerprints
and scheduling settings before attributing changes to model/effort. Different daily
job samples and frozen-subset recovery runs are not controlled A/B tests. Recovery
does not perform live acquisition or retention; selected keys may exceed assigned keys
after history deduplication. Per-job ratios are undefined for zero or unknown assignments.
Worker failures, reports, persistence and source outcomes are operational proxies only:
semantic quality remains unreviewed until an evidence-based review is actually performed.

## Resume and verification

Inspect existing artifacts before choosing a command:

| Existing state | Next action |
|---|---|
| `receipt.json` exists | Read the terminal outcome and requested evidence. Do not rerun commit or create-only closeout. |
| `rendered-reports.json` exists without a receipt, or a commit was interrupted | Inspect exact Career-Ops writes and commit diagnostics before recovery. Do not assume rollback completed or blindly start a new run. |
| `assignments.json` exists and commit has not started | Verify locked sources and existing parts; reuse valid batches and resume incomplete work with its original owner within the remaining retry budget. Keep terminal `FAILED` items; resuming does not reset attempts. Use the existing merger for final files. |
| Only baseline/source artifacts exist | Reuse the baseline and captured sources; use the runner's bounded eligible retry where needed, then continue normalization/planning. Do not repeat destructive preflight. |

The baseline freezes source selection/config and location policy; the planner later
freezes worker runtime and candidate-source hashes. Prompt/scoring-reference/report/scorer files have observation hashes in usage context,
not enforced run locks. If these changed during an interrupted run, inspect
compatibility before continuing and report any unverifiable version boundary. Do not
rewrite an old snapshot to match live settings. Reinvoking the planner with existing
assignments compares its runtime to live config and can reject a mismatch; it is not
needed merely to resume valid existing assignments.

Skill edits and green contract tests alone do not establish production quality or
authorize a fresh scan. Use the read-only acceptance procedure below to assess a run.

## Read-only acceptance

Distinguish persistence integrity, source coverage and semantic quality. Read receipt,
source summaries, assigned parts/finals and the relevant saved JDs/reports; use read-only
library validators when needed, never create-only closeout or writing repair helpers.
State exactly which records and conditions were reviewed and what remains unverified.
For reported duplicate candidates compare saved official URLs and exact requisitions,
not only titles or context hashes. A parser gap is an identity defect: preserve assigned
keys and record it for the identity owner; do not invent worker-side merging. Different
application IDs and format-only JD variants are not proof of one ATS requisition.
Review network applications and metadata/body employment conflicts under the shared
[scoring judgment](../../../../config/worker-scoring.md). Preserve historical receipts;
record confirmed defects and evidence without relabeling the original run as clean.

## Job issues and savepoints

Every error attributable to one acquired `posting_key` is a job issue after its configured retry is exhausted or the evidence-preserving no-repair helper terminalizes it. Stable examples include `WORKER_FAILED`, `HISTORY_DUPLICATE`, `JD_CONTRACT_ERROR`, `REPORT_CONTRACT_ERROR`, `REPORT_RENDER_FAILED`, `JD_PERSIST_FAILED`, `TRACKER_MERGE_FAILED`, `TRACKER_EXISTING_ROW_CHANGED`, `TRACKER_APPEND_COUNT_INVALID`, `TRACKER_REPORT_MISMATCH`, `TRACKER_IDENTITY_MISMATCH`, and `TRACKER_URL_MISMATCH`.

The committer prepares each report and isolated tracker addition in a temporary
tracker copy, with PDF/batch reconciliation disabled. Before official publication it
proves exactly one appended row, unchanged parsed cells for every existing row, and
agreement between report/tracker URL, posting key and report link. Failed proofs remove
that candidate's report without changing the live tracker. The key appears only in
`receipt.json.job_issues`, never in persisted JD/history or a placeholder/recovery queue.
Concurrent tracker changes stop commit; there is no automatic rebase. The derived SQLite
index synchronizes once after the canonical Markdown set succeeds.

Before finalizing persistence, including after isolating an issue, require a non-empty valid evaluated set. Here `eligible_evaluated_keys` means eligible for persistence, not `eligibility_status=eligible`: valid below-threshold and hard-excluded evaluations also enter scan history. Any non-empty valid evaluated set is persisted regardless of the number or ratio of job issues. Zero valid evaluated postings produces `FAILED` with no Career-Ops persistence. System failures are not job issues and remove only this invocation's exact owned writes.

## Receipt equations

The verifier derives all sets from files:

```text
selected_adapters = baseline.adapter_profile.adapters (ordered ids)
acquisition.sources.map(adapter) = selected_adapters
successful_adapters = {acquisition.sources where status = SUCCESS}
|successful_adapters| >= baseline.adapter_profile.minimum_successful_adapters
location_scope.pre_scope = location_scope.accepted ⊎ location_scope.excluded
location_scope.excluded includes every AMBIGUOUS_* decision
location_scope.accepted = exact_history_duplicates ⊎ same_context_semantic_aliases ⊎ assignment_keys
expected_worker_ids = worker-1 through worker-N, where N = assignments.runtime.scheduler.max_active_workers
acquisition.keys = disjoint union(assignments[worker_id] for worker_id in expected_worker_ids)
assignments union = results posting_key union
committed_evaluated ⊎ job_issues = acquired
report_threshold = assignments.runtime.reporting.full_report_threshold
committed_candidates = {committed_evaluated | score >= report_threshold and hard_exclusion=false}
below_threshold = {committed_evaluated | score < report_threshold and hard_exclusion=false}
hard_exclusion = {committed_evaluated | hard_exclusion=true}
committed_candidates ⊎ below_threshold ⊎ hard_exclusion = committed_evaluated
report_keys = tracker_keys = committed_candidates
scan-history(run) = committed_evaluated
```

In shadow mode semantic aliases are advisory and remain assignments. In enforce mode the displayed identity partitions are disjoint, and assignments plus report pairs are unique by `(semantic_job_key, posting_context_key)`.

Every report must contain its authoritative primary URL and posting key; exactly one tracker row links it, and its note contains the exact posting key. CV/profile consistency belongs to the preflight check. The commit path has no writer for `cv.md` or `output/` and does not invoke any resume, PDF, or application workflow; it therefore does not hash, inventory, snapshot, or restore those unowned surfaces.

Receipt schema version 4 retains top-level `status: COMPLETE|FAILED` and includes `job_issues`, `job_issue_keys`, informational `job_issue_ratio`, `persistence_decision`, `eligible_evaluated_keys`, `committed_evaluated_keys`, and `terminal_equation`. Receipt closeout is a pure audit followed by one create-only write; retries never create provisional receipts, and an existing receipt is never overwritten. `persistence_decision.allowed` depends only on a non-empty eligible set and the terminal set equation, never on the issue ratio. Each job issue contains `posting_key`, `stage`, stable `code`, `reason`, exact `evidence`, and `existing_report` when known.

Career-Ops pipeline verification runs before and after, but Daily Scan consumes only its exit code and error count. Warning text and counts are not parsed or stored and never affect completion. A nonzero verifier exit, pipeline error, database/tracker sync failure, missing canonical writer, or set non-conservation is system-level and removes only this run's exact writes.

On a system failure, the committer rolls back only this invocation's exact new
report/JD paths, appended tracker rows and `daily-scan:<run-id>` history rows through
the official locks. It never restores whole files/directories or the derived SQLite
index. The shared additions queue, `cv.md`, `output/` and unrelated state are unowned.

This is a single-writer workflow with no WAL, crash-recovery state machine, automatic
rebase or retry/quarantine ledger. The recovery directory belongs only to retention
preflight. A process kill during final writes requires the recovery-table inspection;
do not claim cross-file ACID or blindly rerun commit.

## Completion report

Report phase changes and material findings; omit per-query/worker narration and
provisional counts. When the host requires periodic progress, give one brief waiting
update without extra file polling or repeating the workflow rules.

The compact digest contains:
- Receipt/status and both terminal/evaluation-bucket equations; report counts mean
  generated reports, not independently verified unique openings.
- Source successes out of enabled sources, failed/partial sources with retained counts
  and retry outcome. `COMPLETE` never means every source succeeded.
- Semantic review scope and confirmed issues, or "not reviewed". Do not infer quality
  from zero terminal failures or claim a known duplicate is a separate opportunity.
- Retention cleaned/protected counts and audit link; exclusion/dedup counts, not key lists.
- Top 10 generated reports by score with company/role/link, any decision-useful caveat,
  and the number of additional reports in Career-Ops.
- One usage line: coordinator/worker/total tokens, observed model/effort, wall time,
  coverage and `usage.json`; mark an active-turn observation provisional.

Keep full evidence in artifacts, omit pipeline warnings, and compress workflow boundaries
into one line. An explicitly requested audit may expand evidence; routine completion
does not require another model scoring pass or a full content audit.
