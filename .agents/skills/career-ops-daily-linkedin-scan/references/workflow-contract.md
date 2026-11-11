# Daily Scan contract

Read by phase, not cover to cover. Normal runs need source selection/adapter output,
evaluation preparation, worker delegation, job issues, receipt equations and completion
report. Read retention internals for cleanup diagnosis, source registration for adapter
development, usage comparison/backfill for measurement, and recovery/acceptance for those
modes only.

## Source selection and snapshot

The active registry registers `jobspy` (JobSpy LinkedIn public results), `ego-browser` (user-visible source name: LinkedIn), `jobright` (Jobright Recommendations), and `official-ats` (Career-Ops public ATS discovery, currently disabled). Each explicit `enabled` flag controls the next scan, and registry object order is execution order. An adapter's optional `timeout_ms` is frozen with its definition. The standalone Google ATS/SerpAPI utility remains outside Daily Scan.

Preflight create-once freezes `baseline.json.adapter_profile`: `registry_content`, `minimum_successful_adapters`, ordered enabled ids in `adapters`, and their argv prefix, config path/content, and employer-exclusion flag in `adapter_definitions`. Acquisition and all downstream phases use this run-local snapshot. A later registry edit affects only a new run; a changed snapshotted config fails closed. At least one adapter must be enabled, and the minimum-success threshold cannot exceed the enabled count.

The registry runner passes frozen argv directly, serially. After all enabled sources
finish, select at most one eligible network/bootstrap/empty retry per adapter. A run
request already authorizes this selection. A FAILED source is retryable only when its
summary says `retryable: true`; a source that never started has nothing to classify and
stays eligible, and so does an interrupted one. Unknown/unclassified, unreadable or
explicitly non-retryable failures, and an adapter that exited by itself without a summary,
cannot be retried. Retry archives the unsuccessful invocation
under `adapter-attempts/`. A nonzero process exit with `summary.status=SUCCESS` is a
system error. An adapter that exceeds `timeout_ms` is stopped together with every
process it started and recorded as a non-retryable FAILED source (`ADAPTER_TIMEOUT`).
It keeps its captured JDs except the newest, which a kill can truncate, so the remaining
sources still decide the run. A killed browser adapter may leave its task space open. Evaluate minimum successful sources only after all have finished.
`--dry-run` inspects the next run's order/argv without external access.

A source is interrupted when it started and left neither a summary nor a self-reported
exit, or a signal killed it: a host crash, a killed session or a killed runner. Recover
with `npm run daily-scan:sources -- --run runs/$RUN_ID --resume`, without asking. It
refuses while any adapter or runner of the run is alive. It leaves terminal sources alone,
gives an interrupted source its one retry, and starts sources that never ran as a first
attempt with their retry intact. A source interrupted twice becomes a non-retryable FAILED
source (`ADAPTER_INTERRUPTED`) with no jobs, since a killed process can truncate its last
JD; both captures stay under `adapter-attempts/`. `source-run.json.resume` lists each action.

An explicit user instruction can authorize one otherwise non-retryable invocation.
Record it as `{run_id, adapter, authorized_by:"user", instruction}` in a run-local
file and pass `--retry <adapter> --retry-authorization <file>`. Never create that
authorization from a routine scan request. Existing success/closed-run/config and
one-retry guards still apply; the original failure is archived unchanged.

## Evaluated retention preflight

`daily-scan:baseline` runs retention before any adapter. The runtime setting
`retention.evaluated_unapplied_ttl_days` owns the TTL; expiry is `age_days >= TTL`
in local calendar dates, using the tracker record date. Uniquely linked Daily Scan
`Evaluated`, `SKIP` (also recognized as `Skipped`), and `Discarded` rows without
downstream work qualify. For `SKIP`/`Discarded`, status history confined to these
three states is allowed; application-stage, unknown, or inconsistent history still
protects the row. Ordinary closure, explicit non-submission/cancellation and known
eligibility-blocker notes do not by themselves protect a row. Actual application,
interview or uncertain-submission evidence takes precedence over those notes;
unrecognized notes remain protected. Interview/follow-up references and other
artifact/identity protections remain. The append-only status ledger is retained.

The command owns locks, deletion, derived-index synchronization and rollback.
`maintenance/evaluated-retention.json` is create-only; reuse it when resuming.
Historical runs/receipts remain immutable, and removed rows are not dedup history.
Retention alone has a recovery directory; never reproduce cleanup by hand.
LinkedIn Post Scan uses generic baseline capture without retention.
For protection predicates and interrupted-cleanup diagnosis inspect
[`prepare-daily-scan`](../../../../src/prepare-daily-scan.mjs) and its retention helper.

## Employer and employment scope

The separate [PERM company workflow](../../career-ops-perm-scan/SKILL.md) supplies
`--perm-employers <catalog.json>` to baseline. Its catalog is validated before
retention and frozen as `baseline.perm_employers`. After canonical URL resolution,
the planner records every employer decision in `triage/perm-employer-scope.json`
and removes unmatched companies before location triage and worker assignment.
Raw source JDs and adapter liveness stay under the source contract. Planning,
worker merge and commit reject an active run's changed catalog; completed runs
retain their frozen evidence. Ordinary baselines have no PERM employer restriction.

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
and `required` flags. The second path keeps its config key, but now reads the
`Jobs that match your profile` section. Inspect both path summaries: required failure
fails LinkedIn; optional failure is degraded only when another enabled path succeeds.
Recommendation capture clicks that section's scoped Show all link on the Jobs page,
applies and verifies the Past 24 hours filter, then reads every result page until a
short or repeated page ends the list. It uses structured listing time and never a
different Show all module. Without the filter the list runs to hundreds of months-old
postings, so `max_pages` bounds it. Both paths deduplicate exact LinkedIn IDs and report
`cap_reached` when a limit, not the end of the list, stopped capture. Authentication/challenge,
selector ambiguity/drift, destination or filter mismatch and access limits are
non-retryable. An access limit also stops every remaining LinkedIn page and query.
Cleanup belongs to the adapter.

JobSpy paces LinkedIn through `jobspy_pacing` in its config: search-page, detail and
between-query delays, a failure backoff and a consecutive-failure limit. Each job detail
is fetched once per run, however many queries return it. The adapter wraps JobSpy's
LinkedIn scraper at runtime and fails as `JOBSPY_INTERFACE_CHANGED` if an upstream update
removes what it wraps. Repeated detail failures or a blocked search page stop the source
as a non-retryable `RATE_LIMITED` failure that keeps its captures. A failed search page
is an error rather than a shorter result. `dropped_missing_description` and `pacing` in
the summary show rows lost and requests made.

Direct search pins the verified Greater Seattle Area geoId for the configured
`Seattle, WA` scope and checks the effective geoId, visible location and 24-hour
filter before reading each page. Its query diagnostics preserve the observed scope.

Jobright requires existing login, validates but never changes the accepted filter
snapshot, and captures responses from normal scrolling. Detail text is Jobright's
structured content, not guaranteed employer-verbatim text. Past 24 hours / `daysAgo=1`
provides freshness; `publishTime` has no verified timezone. Match scores,
recommendation reasons, H-1B labels and profile/debug data are not scoring evidence.

Each JD preserves structured location, employment/workplace type and their provenance.
Only a structured platform/API field can set `Structured Remote Signal: true`;
JobSpy `is_remote` is heuristic. Preserve all non-unknown employment classifications
through combining; the worker resolves their meaning with the complete JD.

`official-ats` is disabled in the active registry: its bounded sample rarely reached
the target location and unreachable boards failed it on every run. When enabled, it runs
the installed upstream `scan-ats-full.mjs --dry-run --json`
with a run-local data root, no candidate history and filesystem writes restricted to
that root. Its frozen config supplies title keywords, ATS selection, age, per-ATS
company cap and timeouts. It then fetches complete official JDs and exact posting
dates, checks identity and employer exclusions, and preserves public API/page
responses. It never writes Career-Ops Pipeline/history or borrows upstream title-only
deduplication as application identity. Location, history, semantic identity, scoring
and persistence stay in the shared downstream phases.

Missing/old/future posting times are audited and omitted. Detail failures, stale or
empty directories, unreachable/page-capped boards and interrupted sweeps produce
FAILED with valid captures retained; they do not count toward source liveness.
The configured company cap is a declared coverage boundary, recorded separately
from failures. An EMPTY source is not a success. Current failures are conservatively
non-retryable; preserve the diagnostics rather than restarting the sweep. The ATS
source is supplemental and does not raise the existing minimum-success threshold.
Supported discovery vendors are Greenhouse, Lever and Ashby. Workday is deliberately
excluded: the upstream scanner collapses same-number postings across recruiting
sites before handoff, while Daily Scan retains site-scoped exact identity.

## Registering another source

A new adapter must have a stable lowercase-hyphen id, accept the common CLI arguments, own one in-repository config, and produce the standard summary, Markdown JDs, and employer-exclusion audit. Each JD must carry parser-v2 exact identity, complete body text, and structured location/employment/workplace evidence. Register it disabled first, prove its live artifacts through `combine` and `run-contract`, then enable it and complete one integrated Daily Scan receipt. Do not add source-specific merge, location, semantic/context, scoring, report, or Career-Ops write paths.

## Identity

Acquisition retains `posting_keys`, `primary_key`, `source_keys`, `posting_urls`
and `primary_url`; the parser and resolver own their construction.

Canonical URL resolution reads the JD header fields first. A URL in the JD body counts only when it is the single exact ATS identity there; generic or competing body links leave the record on its source key. Records merge only when exact key sets intersect. ATS keys are primary; unresolved LinkedIn records retain only their LinkedIn key. Parser-v2 identities use exact stable requisitions under
[`posting-identity`](../../../../src/posting-identity.mjs); unknown URLs must not gain
an identity from title/company similarity. Cross-day history comes only from committed Career-Ops state. After location scope, strict semantic identity serializes the normalized employer and complete normalized JD body; posting context adds normalized employment type, workplace type, and accepted location decision. Shadow mode observes same-context aliases; enforce mode removes only those aliases before assignment. Exact identities remain in `triage/canonical-url-resolutions.json` for application handoff. The shared commit lock repeats exact and semantic/context history lookup, producing `HISTORY_DUPLICATE` or `SEMANTIC_HISTORY_COLLISION` when another run committed during scoring.

## Location scope

The Career-Ops profile owns one baseline-snapshotted policy. Local eligibility is an exact match against `baseline.location_policy.local_metros`, carried into `assignments.json.location_policy`. Each place in a multi-location value is checked separately and must be the metro alone or qualified as a Washington or US area, so same-named places elsewhere fail closed. Remote eligibility requires both a `United States`/unqualified `Remote` location and `Structured Remote Signal: true`. Search parameters, country-only `United States` without that signal, inferred text-only Remote, missing locations, source conflicts, and nonlocal cities never enter worker assignments.

`triage/location-scope.json` contains one decision per combined pre-scope posting. Decisions are either `ALLOW_LOCAL`, `ALLOW_REMOTE_US`, an `EXCLUDE_*`, or an `AMBIGUOUS_*`. Exclusions and ambiguities remain in that run-local audit but are removed from combined `jobs/`, `acquisition.keys`, and assignments before scoring. `assignments.json` and every retained acquisition record carry the policy/allowed decision, and both the run contract and deterministic worker merger fail closed if an unapproved key appears.

## Worker result

`assignments.json` keeps `result_schema_version: 8`, the immutable runtime snapshot, ordered worker keys, `primary_urls`, assignment-owned semantic/context keys, and separate content locks for candidate facts (`cv.md`, `config/profile.yml`, `modes/_profile.md`) and canonical/custom scoring rules, Career-Ops code-root `templates/discard-reasons.yml` definitions, plus the three worker references. Expected worker ids remain `worker-1` through `worker-N`. Only non-empty assignments spawn model workers. Each `results/<worker-id>.part-<part>.json` and `results/<worker-id>.json` carries result schema version 8, and the merger proves exact ordered ownership before producing one final per worker.

The worker-authored part schema and example live in
[`config/worker-prompt.md`](../../../../config/worker-prompt.md). Use that input
shape; `score`, `hard_exclusion`, work-authorization display labels, and semantic/context compatibility fields in the
merged final are merger-owned, not additional worker output.

New plans freeze `research_version: 0`, without `research_not_before`. Workers
evaluate the complete JD against locked candidate facts and scoring rules; no
external company, culture, operating-risk or market-salary searches, page reading
or prior company-research reuse. Results omit `research`, including below-threshold
and hard-excluded evaluations; the merger rejects a research payload or placeholder.
Reports use supported JD/approved-candidate evidence, preserve all five dimensions,
eligibility/level/work-authorization gates and threshold, and retain partial/unknown
facts with original confidence rules. Missing evidence is not a mechanical score
or legitimacy penalty. No company-research cache or extra scoring pass is required.

Historical plans with `research_version: 1` retain `research_not_before`, all three
research checks and their frozen instructions. For those plans only, sources, exact
passages, dates, query outcomes and tool references live in top-level `research`
in the existing worker-owned part/final, never in candidate files. Public facts
must not become candidate claims or override JD-level eligibility. Query failures
remain evidence gaps; they do not automatically lower score or legitimacy.
On a worker's provider quota/429 notice, relay the provider, error and original
reference to all active workers so they skip that provider for the rest of the run
and use an independent available search provider under the worker prompt's bounds.
Do not fabricate per-posting attempts from the shared notice. If no usable public
search provider remains, resolve that research blocker before assigning more work.
Do not edit locked config or replan an active run to adopt a new fallback policy;
new instructions take effect in the next plan.

For historical research-enabled plans, the merger checks exact posting/employer bindings, all three attempted checks,
opened-source metadata, market evidence for complete compensation, research
citations and confidence consistency. It cannot prove a tool was called or a
source's meaning. Compact reports show check findings and HTTPS source links
inside Score Evidence under the existing 12,000-character budget. Report repair
and expansion preserve this evidence. Existing plans without the research marker
retain their original contract; do not backfill old parts, receipts or reports.

The worker owns JD meaning, research interpretation, score, level, eligibility and work-authorization judgment.
The merger rechecks source snapshots, enums, exact quote occurrence, caps and report rules;
it does not match JD predicates or override semantic judgments. No validator pass proves
semantic correctness or replaces reading the complete JD. No safety rule calls a second model.
Version 8 is required for new evaluations; current writes reject v2/v3/v4/v5/v6/v7 or mixed parts.
Read historical receipts as recorded; do not relabel old parts or automatically reinterpret them.
Explicit read-only inspection (`loadScanResults(..., {allowLegacy: true})`) also
supports frozen v8 rules after a policy upgrade and returns
`historical_rule_snapshots_verified: false`. Candidate content, approved source
paths, snapshot shape, research and ordered part/final checks remain required.
Planner reuse, worker merge and commit keep strict live-rule matching.

## Evaluation preparation

After all frozen sources and eligible retries finish, run:

```bash
npm run daily-scan:prepare -- --run runs/$RUN_ID --career-ops ../career-ops
```

The thin CLI runs `combineRun` → run-contract validation → `resolveCanonicalUrls`
→ `planEvaluations` → final run-contract validation. Existing function boundary
checks remain, including validation after URL and planner mutations. No validation
cache or bypass is introduced. The command reports counts and artifact paths without
printing candidate snapshots. It stops at the first failure and retains existing
artifacts and the diagnostic error; no later stage or automatic retry runs.

`daily-scan:baseline` remains separate and owns retention, usage start and baseline
capture. Preparation does not clean, acquire sources, score or commit. It rejects
`assignments.json`, `rendered-reports.json` or `receipt.json` before any mutation;
resume those states through the recovery table below.

The combined command preserves only the relevant existing options:

- `--runtime-config <file>` selects the planner's runtime config; its normal default
  and frozen-run checks remain.
- `--allow-blacklisted key1,key2` passes exact primary posting keys to the planner.
  Only explicit user authorization for those keys permits the exception.
- `--force` permits the resolver to archive an existing resolution ledger under its
  `.superseded-*` name. It does not override assignments or closed-run guards.

Standalone commands remain available to locate and recover the failing boundary:

```bash
node src/combine.mjs --run runs/$RUN_ID
node src/run-contract.mjs --run runs/$RUN_ID
node src/resolve-canonical-urls.mjs --run runs/$RUN_ID
node src/plan-scan-evaluations.mjs --run runs/$RUN_ID --career-ops ../career-ops
node src/run-contract.mjs --run runs/$RUN_ID
```

Run only the needed stage after repairing its input. If URL resolution succeeded
but planning failed before creating assignments, fix the planner input and invoke
the standalone planner, then validate the run. An existing resolution ledger requires
explicit `--force` to repeat resolution; do not recombine merely to retry planning.
Use the standalone planner's `--full` only when its complete snapshot is needed;
the combined command has no `--full`. Source retry eligibility and worker retry
budgets remain unchanged.

## Worker delegation and evidence

New plans use `assignment_policy: employer-affinity-v1`: exact company labels are
grouped for scheduling, balanced within `ceil(assigned / worker_count)` capacity.
Known publishers, missing or explicitly ambiguous employer identities remain
singletons. This is neither employer verification nor a research-reuse grant.
Existing assignments retain their original ownership/order on resume.

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
- Codex uses the base `worker` values. In a Claude Code shell `CLAUDECODE` selects
  `hosts.claude.worker`, which the planner freezes into `assignments.json.runtime`;
  `DAILY_SCAN_HOST` overrides the detection, and an empty value forces the base worker.
  Dispatch each worker with the Agent tool, using `subagent_type: "general-purpose"` and
  the frozen `model` and `effort`, as a fresh agent with no conversation history. A run
  keeps the host it was planned on; resume rejects a different worker snapshot.
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
  On Claude Code bind the agent id each Agent call returned; the measured scope is the
  coordinator session, and `CODEX_THREAD_ID` does not apply. Workers report only through
  their final message there, so wait for completion notifications.
- Empty assignments use the existing merger, without a model call. Require
  `result_schema_version: 8` and one final for every expected id before commit.

## Compact handoff and waiting

Default planner/worker-merge output is a deterministic compact summary linking the
complete artifact. Use `--full` only to expand needed data. Source execution writes
complete stdout/stderr to `adapter-attempts/<adapter>-attempt-N.*.log`, and all source
outcomes to `source-run.json`; this preserves errors and does not change liveness.
Read each failed/empty source's `sources/<adapter>/summary.json`, retry classification,
required/optional LinkedIn paths and the implicated logs before deciding recovery.
An output limit never changes a failed source into a success or hides a blocker.

Summaries are at most 2,000 Unicode characters, with exact counts, artifact paths,
`error_count`, `preview_count` and `truncated`. Error previews contain at most five
items. Expand every decision-relevant anomaly in the full artifact, including those
outside the preview. Workers still read their full JDs, locked facts/rules and actual
research pages. Coordinator progress never dumps all parts or implementation snapshots.

Workers report validated batches, immediate provider outages/blockers and final
completion with counts and paths. They own batch validation and final merge; do not
repeat their prefix validation or reread successful parts on every progress message.

Wait only for unfinished workers through host completion events or an interruptible
bounded wait of at most 60 seconds. No-change timeout means wait again without
rereading assignments/parts/usage/logs. Process new user input and progress promptly;
provider quota notices still propagate immediately to every active worker. An
unusually long absence of progress warrants one targeted actual-status inspection;
further reads require changed state or specific new evidence. A timeout never
authorizes a replacement worker, repartitioning or a reset of attempts. Keep user
progress updates and the original final/semantic/PERM/commit/receipt checks.

Worker validation uses `--json` for compact diagnostics. For active runs, the full
derived view is `results/<worker>.validation-diagnostics.json`, with input hashes,
field/code/key and observed attempt counts; the existing validation-evidence ledger
alone owns attempts. `--json --full` expands diagnostics directly. Finalized runs
remain read-only: on failure their compact view points to frozen inputs, and the
full mode returns diagnostics without creating files. Diagnose all independent
errors on the same payload before its one permitted repair; never use a free
pre-validation model repair loop. Library reads, final merge and commit retain all gates.

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
Current evaluation writes require v8. Historical v4/v5/v6/v7 supports explicit read-only
inspection; finish incompatible old runs with their original code or start a new
run, never relabel their parts. The compact report uses the five canonical Career-Ops
scoring dimensions and evidence-confidence rules; code rejects inconsistent tiers.

New v8 report candidates include `requirement_importance` under the report contract;
the field does not change scoring or persistence eligibility. The compact total
budget is 12,000 Unicode characters; historical v4-v7 retains 6,000. Commit derives
opaque Greenhouse/Lever/Ashby triples from supported official primary URLs and uses
the installed official listing fingerprint function, then verifies `listing_key`
after the official history append. Unknown formats stay blank; missing interfaces
or write mismatches fail safely. The `daily-scan:<run>` ownership/status marker is
preserved. Upstream native cross-URL listing-token promotion currently only accepts
added/cooldown statuses, so do not claim this handoff enables native alias dedup.

## Usage accounting and comparison

Normal `daily-scan:baseline` starts `usage-context.json` before retention. This file
binds exact coordinator thread/root-turn segments and explicit worker agent ids;
it does not infer ownership from a model name, directory, or a worker result file.
Claude Code segments use the whole session (`CLAUDE_CODE_SESSION_ID`) as both thread and
root turn, read from `~/.claude/projects`, so keep one Daily Scan per session.
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
and worker settings, including mixed settings and unavailable evidence. Claude Code
transcripts do not record the coordinator's effort, so `unknown` there is expected. Token counts
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

## Claude scheduled runs

A Claude scheduled task reports `succeeded` when its first turn ends, which happens while
sources or workers are still running in the background. That status is not run evidence:
only `receipt.json` proves completion. Nobody is present to answer during a scheduled run,
so recover with `--resume` rather than asking when a source task stops early. A scheduled coordinator sends one push notification
with the run id and outcome once the run reaches `COMPLETE` or a blocker.

### Lost coordinators

The coordinator's turn ends while sources run, and one completion event starts the next
turn. If the host is asleep then, that turn has no network; the app pauses the idle session
and drops the turn, and nothing wakes it again. The session stays `succeeded` with its last
line promising to continue, and the run has no receipt. A closed lid on battery always
sleeps the host. The runner's `caffeinate` hold covers idle sleep only.

`npm run -s daily-scan:pending` is the read-only check. It reports runs from the last 48
hours that have a baseline and no receipt: `ACTIVE` when an adapter or runner is alive or an
artifact changed in the last 45 minutes, otherwise `PENDING` with a stage and next action.
Recovery runs in a new session, resumes each `PENDING` run through the table below and needs
no confirmation, because the original request already authorized the run.

A source that failed during an attempt in which `pmset` logged a host sleep has
`host_sleeps` in its summary and `retryable: true`, whatever the adapter reported, so it gets
the normal single retry. Its original `failure_class` stays.

## Resume and verification

Inspect existing artifacts before choosing a command:

| Existing state | Next action |
|---|---|
| `receipt.json` exists | Read the terminal outcome and requested evidence. Do not rerun commit. |
| `rendered-reports.json` exists without a receipt, or a commit was interrupted | Inspect exact Career-Ops writes and commit diagnostics before recovery. Do not assume rollback completed or blindly start a new run. |
| `assignments.json` exists and commit has not started | Verify locked sources and existing parts; reuse valid batches and resume incomplete work with its original owner within the remaining retry budget. Keep terminal `FAILED` items; resuming does not reset attempts. Use the existing merger for final files. |
| Canonical URL ledger exists but assignments do not | Repair the planner input, run the standalone planner and validate the run. Repeat resolution only when needed with explicit resolver `--force`; preserve the superseded ledger. |
| Baseline exists and a source has no terminal summary | Run the sources command with `--resume`, then continue as after normal acquisition. Do not repeat destructive preflight. |
| Baseline/source/combined artifacts exist without a canonical URL ledger | Reuse the baseline and captured sources; use the runner's bounded eligible retry where needed, then run `daily-scan:prepare`. Do not repeat destructive preflight. |

The baseline freezes source selection/config and location policy; the planner later
freezes worker runtime, candidate-source snapshots, and separate rule-source snapshots
for Career-Ops `_shared.md`, optional `_custom.md`, and the three worker config
references. Planner reuse, merger and commit reject changed sources. Validator code
snapshots remain observational usage metadata; report an unverifiable code boundary. Do not
rewrite an old snapshot to match live settings. Reinvoking the planner with existing
assignments compares its runtime to live config and can reject a mismatch; it is not
needed merely to resume valid existing assignments.

Skill edits and green contract tests alone do not establish production quality or
authorize a fresh scan. Use the read-only acceptance procedure below to assess a run.

## Read-only acceptance

Distinguish persistence integrity, source coverage and semantic quality. Read receipt,
source summaries, assigned parts/finals and the relevant saved JDs/reports; use read-only
library validators when needed, never commit or writing repair helpers.
State exactly which records and conditions were reviewed and what remains unverified.
For reported duplicate candidates compare saved official URLs and exact requisitions,
not only titles or context snapshots. A parser gap is an identity defect: preserve assigned
keys and record it for the identity owner; do not invent worker-side merging. Different
application IDs and format-only JD variants are not proof of one ATS requisition.
Review network applications and metadata/body employment conflicts under the shared
[scoring judgment](../../../../config/worker-scoring.md). Preserve historical receipts;
record confirmed defects and evidence without relabeling the original run as clean.

## Job issues and savepoints

### Official PERM history references

PERM history is optional and disabled by default. Set `perm_history.enabled: true`
in `config/daily-scan-runtime.json` before starting a new baseline to opt in.
Absent or false means no PERM snapshot, local lookup, company research/questions,
reference artifacts or report additions. Original Work Authorization remains required.
The frozen baseline controls the run: changing the live switch affects only new runs.
The independent PERM employer allowlist and explicit standalone queries are unchanged.

Enabled new baselines freeze `baseline.perm_history`: the local disclosure revision/manifest,
verified name mappings and quoted evidence text. Commit queries that revision offline
after scoring, writing `perm-history.json` and `perm-history.md` for every scored key,
including below-threshold and hard-excluded results. New snapshots freeze
`report_layout: work-authorization-v1`. Candidate reports append a nested PERM reference
inside Work Authorization, after its unchanged original conclusion/quote. Annual outcomes,
duration quantiles/n/exclusions, recent dates, dimension summaries and official sources are
self-contained; full source rows/dimensions remain in local run files, not web downloads.
Machine Summary and worker results stay unchanged. Receipt audits validate exact
key/URL/company coverage, section placement, unique reference and frozen content.

These references never change assignments, scoring, eligibility, work authorization,
source liveness or report gates. They are separate from the optional PERM employer
allowlist. Reuse only verified mapping scopes; a new posting cannot inherit a mapping
verified solely for a different key/URL. No match or ambiguous identity is unavailable
information, not zero applications or a new job exclusion. Missing local data/Python
at baseline records `unavailable` and continues. Initialization/refresh is explicit via
the README; no scan-time disclosure download/refresh is performed. Company identity
research follows the separate coordinator phase below, after scoring and before commit.
Frozen-source/artifact/report inconsistency is a system integrity error before commit,
with normal rollback if detected at closeout; do not turn it into a job filter or publish
silently changed numbers. Keep referenced run evidence and local source versions.
Expansion retains original authorization and the frozen reference exactly once in Work
Authorization, outside the original-evidence appendix. Legacy PERM snapshots with no
layout marker keep their metadata format; runs with no PERM snapshot keep the old contract.
Existing reports/receipts are never backfilled by this feature. No Career-Ops code changes.

An evidence-backed `company_history_reference` uses company scope and can be reused
across postings as historical context only. It never identifies the current posting's
contracting employer. Show its reviewed exclusions and the selected historical legal
entities/locations; do not infer group totals or globally bind a publisher to a client.
An exact legal name with no local records can retain a verified identity and empty
locations, without counts. If new data adds records, review explicit locations before
republishing. Enabled new baselines mark `company_review: company-review-v1`; the initial
snapshot remains unchanged and a separate reviewed supplement is frozen before reports.
Older baselines keep their original behavior. Completed runs/reports are not reinterpreted.

### Automatic PERM company review

Only for runs with `baseline.perm_history`, after merged worker results and before
commit, the coordinator runs (skip the entire phase when the snapshot is absent):

```bash
node src/review-perm-companies.mjs prepare --run runs/$RUN_ID
```

The saved `perm-company-review-request.json` lists unmatched scored companies with exact
posting keys/URLs. Already exact or verified identities, including verified identities
without disclosure records, need no repeat search. Missing local data returns
`not_required`; keep the baseline's unavailable state and continue the scan.

For every requested company, automatically research the brand/legal-entity relationship
using available internet research tools (use `agent-reach` when installed). Read actual
primary sources: official legal/privacy terms, company or recruiting pages, registry or
corporate filings. Search snippets and DOL name candidates are discovery leads, not
identity proof. Save fetched source text, URL, dated check, capture method and an exact
short quote under a new `.local/perm-history/company-reviews/$RUN_ID/` evidence path.
Do not overwrite evidence already frozen by another run.

Clear identity evidence authorizes publication without another approval. Import only the
confirmed entries using the existing registry schema, `company_history_reference` and
company scope; keep explicit historical legal names/locations and reviewed exclusions.
Use the canonical merge writer so unrelated and concurrently saved entries remain:

```bash
python3 src/perm-history.py aliases-import --merge --file .local/perm-history/company-reviews/$RUN_ID/confirmed-aliases.json
```

Do not map a publisher/recruiter globally to a customer found in one JD, silently equate
Inc./LLC, pool subsidiaries, or infer a current posting's employer/sponsorship. For
material identity ambiguity, ask the user a concise question and continue independent
work. Before asking, consult prior run `perm-company-review.json` decisions and saved
question answers in `.local/perm-history/company-reviews/`. If the user does not know,
retain pending; do not repeat that question unless new evidence changes it. Those answers
are question history, not proof of legal identity. Inaccessible sources or insufficient evidence
also stay pending, without excluding a job or inventing zero applications.

Save one decision for every requested company in a run-local JSON file. Outcomes are
`verified`, `ambiguous`, `not_found`, `source_unavailable` or `publisher`; each needs a
bounded research `note` summarizing the evidence or failed attempts. For `ambiguous`,
also record the exact `question` and `question_state` (`asked`, `answered` or
`answered_unknown`). `asked` permits other jobs and the scan to finish with that
identity pending; it never authorizes a speculative mapping. Example:

```json
{"companies":[
  {"company":"Confirmed Brand","outcome":"verified","note":"Official terms confirm Legal Name, Inc.; other affiliates excluded."},
  {"company":"Unclear Brand","outcome":"ambiguous","note":"Two different legal entities remain possible.","question":"Which official company page belongs to this role?","question_state":"answered_unknown"}
]}
```

Freeze the decisions and only the approved matching updates, using the original
disclosure revision and preserving unrelated baseline aliases/evidence:

```bash
node src/review-perm-companies.mjs freeze --run runs/$RUN_ID --decisions runs/$RUN_ID/perm-company-decisions.json
```

`perm-company-review.json` is create-only and includes the exact scored bindings and
self-contained evidence. Resume reuses it without reading live aliases again. A
partial review, unapproved mapping, missing recorded ambiguity question or unrelated
snapshot change is rejected. Source failures are valid recorded outcomes, so complete
that review and continue normal persistence; do not bypass the phase. Commit/audit
consume the supplement deterministically and show the research status inside the PERM
reference, while retaining original scores, candidate sets and authorization conclusions.
There is no network research in the commit lock. Later user answers or mapping updates
apply to future reports; old reports are not backfilled.

Every error attributable to one acquired `posting_key` is a job issue after its configured retry is exhausted or the evidence-preserving no-repair helper terminalizes it. Stable examples include `WORKER_FAILED`, `HISTORY_DUPLICATE`, `JD_CONTRACT_ERROR`, `REPORT_CONTRACT_ERROR`, `REPORT_RENDER_FAILED`, `JD_PERSIST_FAILED`, `TRACKER_MERGE_FAILED`, `TRACKER_EXISTING_ROW_CHANGED`, `TRACKER_APPEND_COUNT_INVALID`, `TRACKER_REPORT_MISMATCH`, `TRACKER_IDENTITY_MISMATCH`, and `TRACKER_URL_MISMATCH`.

The committer prepares each report and isolated tracker addition in a temporary
tracker copy, with PDF/batch reconciliation disabled. Before official publication it
proves exactly one appended row, unchanged parsed cells for every existing row, and
agreement between report/tracker URL, posting key and report link. Failed proofs remove
that candidate's report without changing the live tracker. The key appears only in
`receipt.json.job_issues`, never in persisted JD/history or a placeholder/recovery queue.
Concurrent tracker changes stop commit; there is no automatic rebase. The derived SQLite
index synchronizes once on the normal successful path after the canonical Markdown
set succeeds. If compensation removes owned rows or follows an attempted index
sync, the committer runs official `tracker.mjs sync` again against the compensated
Markdown. It never restores a whole SQLite snapshot over other writers' changes.
An unsuccessful compensating sync remains a system error even when the later
pipeline health check passes; health alone does not verify SQLite contents.

On a handled commit failure, `commit-failure.json` preserves the original failed
closeout audit before compensation, its exact warnings and identity evidence,
each compensation stage and index-sync result, and the post-compensation audit.
The FAILED receipt links that artifact and retains pre-rollback health; if saving
the artifact fails, available evidence is embedded in the emergency receipt.
Inspect these records before recovering an interrupted or failed run. A killed
process may still require manual recovery; an absent record is not rollback proof.

At baseline and closeout, Job Discovery checks Career-Ops health. Its title-only
duplicate warnings are resolved only when every reported member has a distinct
saved posting identity; the raw count and member evidence remain in the health
result. This checks distinct recorded postings, not whether cross-source listings
belong to the same application. Shared posting identities, missing/conflicting
identity evidence, other warning types, and incomplete health summaries block
completion. Do not suppress warning categories or edit historical receipts.
For a read-only health audit, run
`node src/career-ops-health.mjs --career-ops ../career-ops`.
The wrapper executes the installed official verifier with copied code and data
inputs in a temporary snapshot; Node permits writes only inside that snapshot.
Source reservations, plugin locks, directories and linked interview records stay
unchanged. A stale-reservation cleanup warning describes the snapshot only and
remains blocking until the original state is separately resolved. The audit
retains raw verifier output and exact warning-member evidence. Git-blame timestamps
are unavailable in isolation, but lifecycle disagreement still produces a warning.
Missing interfaces, unsupported Node permission flags and incomplete summaries fail
closed. This guard supports trusted installed code, not untrusted plugin execution.

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
location_scope.accepted = blacklist_holds ⊎ exact_history_duplicates ⊎ same_context_semantic_aliases ⊎ assignment_keys
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

Every report must contain its authoritative primary URL and posting key; exactly one tracker row links it, and its note contains the exact posting key. CV/profile consistency belongs to the preflight check. The commit path has no writer for `cv.md` or `output/` and does not invoke any resume, PDF, or application workflow; it therefore does not snapshot, inventory, snapshot, or restore those unowned surfaces.

Receipt schema version 4 retains top-level `status: COMPLETE|FAILED` and includes `job_issues`, `job_issue_keys`, informational `job_issue_ratio`, `persistence_decision`, `eligible_evaluated_keys`, `committed_evaluated_keys`, and `terminal_equation`. Receipt closeout is a pure audit followed by one create-only write; retries never create provisional receipts, and an existing receipt is never overwritten. `persistence_decision.allowed` depends only on a non-empty eligible set and the terminal set equation, never on the issue ratio. Each job issue contains `posting_key`, `stage`, stable `code`, `reason`, exact `evidence`, and `existing_report` when known.

Career-Ops pipeline verification runs before and after through the read-only wrapper above. Daily Scan retains its raw warning count, parsed warning messages and exact identity resolutions; every unresolved warning or incomplete summary blocks completion. A nonzero verifier exit, pipeline error, unresolved warning, database/tracker sync failure, missing canonical writer, or set non-conservation is system-level and removes only this run's exact writes.

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
- For marked new PERM runs, the receipt's `perm_history.company_review` outcomes and
  pending companies; ask only material unanswered identity questions, not permission
  to publish clear official evidence.
- Receipt/status and both terminal/evaluation-bucket equations; report counts mean
  generated reports, not independently verified unique openings.
- Source successes out of enabled sources, failed/partial sources with retained counts
  and retry outcome. `COMPLETE` never means every source succeeded.
- Semantic review scope and confirmed issues, or "not reviewed". Do not infer quality
  from zero terminal failures or claim a known duplicate is a separate opportunity.
- Retention cleaned/protected counts and audit link; exclusion/dedup counts, not key lists.
- PERM reference coverage from `receipt.perm_history`, with the run's `perm-history.md`
  link for all scored postings. Summarize confirmed/unavailable states independently;
  never present historical certification as current sponsorship or scoring evidence.
- Top 10 generated reports by score with company/role/link, any decision-useful caveat,
  and the number of additional reports in Career-Ops.
- One usage line: coordinator/worker/total tokens, observed model/effort, wall time,
  coverage and `usage.json`; mark an active-turn observation provisional.

Keep full evidence in artifacts, omit pipeline warnings, and compress workflow boundaries
into one line. An explicitly requested audit may expand evidence; routine completion
does not require another model scoring pass or a full content audit.

Content snapshots are compared directly; no file digest is generated or required. Preparations made before content snapshots must be regenerated before writing. Semantic keys use normalized JSON fields (normalizer v2); historical semantic deduplication rebuilds them from committed JDs without rewriting history.
