---
name: career-ops-perm-scan
description: Refresh the supplied PERM tracker employer list or run a separate Daily Scan that retains only named employers currently labeled 正常办理 by that tracker. Use for PERM company job discovery; excludes applications and legal eligibility advice.
---

# PERM company scan

Use the existing [Daily Scan](../career-ops-daily-linkedin-scan/SKILL.md) for
acquisition, location/history/blacklist gates, worker scoring, official persistence,
recovery and usage. This variant adds one frozen employer allowlist before location
triage and scoring. The ordinary Daily Scan keeps its existing scope.

The source is [Perm Tracker 2](https://muse.ai/s/perm-tracker-2-gh65gxaxqvxfxyu).
Its **current company group label**, exactly `正常办理`, controls inclusion. Do not
promote a company from an older positive source inside a paused/restricted group.
The tracker is a dated, user-generated public snapshot, not an official employer
policy. Keep conflicting historical sources and date labels. A company label never
supplies a candidate/application answer or proves this job sponsors PERM.

## Refresh the list

Before a new run, refresh once using the installed `ego-browser` Skill. Open the
source in one task space, clear any company/platform filter, select `正常办理`,
and capture a **full-page** snapshot to a fresh file under
`.local/perm-workflow/source/`. The iframe content can take time to load: require
the company overview and current displayed count before capturing. Do not include
the page's separate AI background panel as company evidence.

```bash
node .agents/skills/career-ops-perm-scan/scripts/import-tracker.mjs \
  --snapshot .local/perm-workflow/source/<capture>.snapshot.txt \
  --out config/perm-employers.json
```

The importer proves displayed-group and per-group source counts, keeps named
normal-status groups in `companies`, and puts unnamed/multi-company groups in
`unresolved_groups`. It preserves platform, source date label, URL and conflicting
source statuses; missing source links stay null. Schema/layout/count failure stops
the refresh without replacing the catalog. If the source cannot be read, report
the blocker; use an older catalog only when the user explicitly requests that
dated snapshot.

Read the catalog and source boundary in [the collected list](references/companies.md).
That document records the initial dated collection; `config/perm-employers.json`
is the current operational list. Match names exactly after case, whitespace,
punctuation and common legal-suffix normalization. Do not infer parent,
subsidiary or brand aliases: the source currently gives conflicting labels to
Snap/Snapchat and ByteDance/TikTok. An additional alias needs explicit identity
evidence and must not conflict with another tracker group. Initial aliases are empty.

## Run

Follow the parent Skill's procedure and its relevant contract sections. Use a
separate `runs/perm-YYYYMMDD-HHMMSS` directory and change **only** its baseline
command to:

```bash
npm run daily-scan:baseline -- \
  --run runs/perm-YYYYMMDD-HHMMSS --career-ops ../career-ops \
  --perm-employers config/perm-employers.json
```

Use the actual resolved Career-Ops path. This command validates the catalog before
retention and freezes its full contents in `baseline.json.perm_employers`.
Keep the current enabled adapters, source settings, runtime and candidate policy;
do not replace their configs or expand geographic/role scope.

Sources still capture their normal configured searches and retain raw evidence.
After combine and canonical URL resolution, the standard planner applies the
PERM gate. Only matching employers remain in combined `jobs/`, `acquisition.json`,
assignments and persisted evaluations. `triage/perm-employer-scope.json` records
every pre-gate posting, inclusion/exclusion and catalog snapshot; raw `sources/` JDs
remain for audit. This is filtered discovery over the configured sources, not
exhaustive company-careers crawling. PERM inclusion cannot bypass the blacklist,
location, employment, identity or scoring rules.

Worker delegation uses the parent Skill's frozen `assignments.json.runtime` and
ownership rules. Resume an active run with its original catalog; catalog changes
block planning, worker merge and commit. Start a new run for a refreshed list.
An empty eligible set is a valid no-match discovery result; retain its audit,
use the existing merger for empty assignments, and report no eligible jobs without
calling commit or claiming a `COMPLETE` persistence receipt.

## Verify and report

For a named run, use the parent Skill's read-only acceptance path. Completed runs
use their frozen employer snapshot even after a later refresh. Report separately:
source coverage; tracker cutoff/capture dates; named and unresolved group counts;
PERM pre-gate/accepted/excluded counts; downstream persisted results. Include
conflicting source statuses where material and do not call a public label a
verified sponsorship guarantee.

Workflow edits require `npm run test:daily-scan` and `npm run test:perm-scan --
--out <fresh-directory>`; the latter preserves a reproducible fictional E2E
artifact using actual pipeline commands and official Career-Ops writers.
