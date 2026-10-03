# Job Discovery

[中文](README.zh-CN.md)

Local release candidate for [Job Discovery Workflows](https://github.com/ChenshuXu/job-discovery-workflows).
All existing workflows are included. Licensed under [MIT](LICENSE), with
[third-party notices](THIRD_PARTY_NOTICES.md). Bounded installation, host, account and
Word checks are recorded below, together with the remaining release limitations.

## Built with

Job Discovery builds on these open-source projects. Thanks to their maintainers and
contributors for the tools that make these workflows possible.

| Project | Role in Job Discovery |
| --- | --- |
| [Career-Ops](https://github.com/career-ops-hq/career-ops) | Manages candidate profiles, evaluations, reports and application status; provides the data and writer interfaces used by our workflows. |
| [JobSpy](https://github.com/speedyapply/JobSpy) | Provides job-board scraping for the JobSpy acquisition source. |
| [Ego Lite](https://github.com/citrolabs/ego-lite) | Provides the browser and `ego-browser` integration for authenticated job discovery, research and application workflows. |

These dependencies are installed separately. See [dependency setup](#external-dependencies)
and [third-party notices](THIRD_PARTY_NOTICES.md) for installation details and licenses.

## Features

| Workflow | Dependencies |
| --- | --- |
| Daily Scan: JobSpy, LinkedIn search/recommendations, Jobright; scoring, deduplication, reports, retention, recovery and usage | Career-Ops, candidate profile, agent host; tools for each enabled source |
| Expand compact reports | Career-Ops |
| Single/batch applications and private answer management | Career-Ops, Ego Lite browser, interview register |
| Report-bound Word resumes | Career-Ops, your compatible DOCX template, zip/unzip; Word on macOS for page verification |
| Gmail review and interview register transactions | Career-Ops, Career Docs, connected Gmail app for primary and host native Chrome access for secondary |
| Interview research, evidence and incremental updates | Career Docs, Ego Lite browser, external research access, obsidian-markdown |
| Application and interview process charts | Career-Ops, Career Docs, Node.js, Python 3 with Pillow, a font covering the chart text |
| Recruiting-post scan and outreach preparation | Career-Ops, Ego Lite browser, Node SQLite; stops before Send |
| Standalone Google ATS search | SerpAPI key; separate from Daily Scan |
| Report and excluded-posting repairs | Career-Ops, completed run, explicit reviewed manifest and plan hash |

## Set up with your agent

Give your agent this README and the following request:

```text
Set up Job Discovery using this README. Inspect my existing workspace first, ask for
missing CV/search/account information, install missing dependencies and create only
missing setup files. Preserve my existing data. Run setup-check and the documented
checks, then report what is ready and exactly what I still need to provide or change.
Do not start a scan, retention cleanup, schedule, application or message during setup.
```

### Agent setup procedure

1. **Locate before writing.** Resolve Job Discovery, Career-Ops, JobSpy and Career Docs;
   prefer the sibling layout but reuse the user's existing installations/register.
   Read each existing workspace's AGENTS.md. Run `node src/setup-check.mjs --json`
   from Job Discovery and use its `checks` and `action` fields as the initial inventory.
   Exit 1 means missing/invalid setup items, not a reason to discard existing files.
   Alternative dependency locations can be passed with `--career-ops PATH`,
   `--career-docs PATH`, `--jobspy PATH` for setup-check. For resume commands, export
   `CAREER_OPS_ROOT=/absolute/path/to/career-ops` in the same shell; setup-check also
   uses it unless `--career-ops` overrides it. Other workflows take their existing
   path flags/config fields; these setup-check flags do not configure them automatically.
2. **Collect missing facts in one short exchange.** Ask for the user's CV or its local
   path, which workflows/sources to enable, target role terms and seniority, desired
   work locations/remote scope and employment types, employer exclusions, timezone,
   work-authorization/sponsorship facts relevant to matching, and any existing interview
   register. Ask which Gmail accounts/browser profiles to use only for selected workflows.
   Ask about active interviews before initializing an empty register; absence of a file
   does not mean no interviews. Do not request passwords, cookies or one-time codes.
   Reuse explicit answers already supplied and complete independent setup while waiting.
3. **Install missing tools.** Follow the dependency instructions below. Use JobSpy main.
   Install Career-Ops and Ego Lite only if missing, make the eight bundled Skills available
   and load required external Skills. Setup permission does not authorize upgrading,
   resetting or replacing an existing installation. The user handles login/verification
   through the browser's normal flow. Never put credentials in setup reports or Git.
4. **Onboard Career-Ops.** In that checkout, read its own Skill and setup instructions,
   then use its `interview` mode (profile/CV onboarding) with the user's real CV and answers.
   Create or update `cv.md`, `config/profile.yml` and `modes/_profile.md` consistently through
   that workflow. Do not fabricate titles, dates, experience, metrics or work authorization.
   Run `node doctor.mjs --json --cli codex` (use your actual CLI) and inspect `missing`
   and `unpersonalized` even when it exits 0. Doctor can copy missing templates; personalize
   the new upstream `modes/_brief.md` from the same CV and confirmed choices as well.
   An automatically copied template is not completed onboarding.
   Keep all unrelated profile fields and documents. The resume parser needs the headings
   `## PROFESSIONAL EXPERIENCE` / `### Role, Company | Location` with `-` bullets and
   `## TECHNICAL SKILLS` with `**Category:** item, item` rows; preserve the user's facts when
   adapting formatting. An unavailable CV or unresolved fact remains a named blocker.
5. **Configure search and Career Docs.** Use the mappings and structure below. Copy example
   configs only into missing files; merge explicit user choices into existing files after
   inspecting them. Do not replace an existing configuration with an example. Keep source
   search settings and the profile's location policy consistent. Create only the missing
   Career Docs skeleton; existing register changes use the Gmail Skill's canonical writer.
6. **Check, correct, repeat.** Run the checks below, fix routine setup errors and rerun
   affected checks. Ask the user only for unavailable facts, accounts or material choices.
   Do not silently change their target region or disable requested functionality to make
   checks pass. Record unsupported capabilities as blocked for that workflow.
7. **Hand off a per-workflow result.** Report `ready for first run`, `needs user input`,
   `unsupported` or `validation failed`, with file/setting, next action and observed check
   result. List files created/changed and unresolved questions. Never call a workflow ready
   merely because files exist. Setup ends here; an actual run is a separate user action.

### Career-Ops and search configuration map

| User information | Where the agent configures it |
| --- | --- |
| CV, experience, education, skills and matching facts | Career-Ops onboarding → `cv.md`, `config/profile.yml`, `modes/_profile.md`; keep all three consistent |
| Local cities / US remote eligibility | Career-Ops `config/profile.yml` → `location.scan_policy` (format below) |
| Job search keywords and search location | Job Discovery `config/jobspy-ego.json` → `queries`, `location`; search parameters do not override eligibility |
| Enabled sources | `config/discovery-adapters.v1.json` → each `enabled`, plus `minimum_successful_adapters` |
| Employer exclusions | Source configs' `employer_exclusions`; use explicit user choices, `[]` when none, preserve each adapter's rule schema |
| Jobright role, location, seniority, work model and experience filters | User-accepted browser filters → `config/jobright.json` `filter_snapshot` values/codes/visible_controls; capture them, never invent them |
| Standalone Google ATS search | `config/google-ats-direct.json` → role/location/negative terms and official_scope; run its validator after editing |
| Recruiting-post search | `linkedin-post-scan/config/post-scan.json` → role/location/phrase groups and paths |
| Worker model, concurrency, report threshold, retention TTL | `config/daily-scan-runtime.json`; choose a host-supported model and explain retention before a real run |
| Mailbox identity, login and timezone | Private `.local/gmail-job-reply-review/accounts.json` with `primary` and `secondary` email-address strings; primary uses the connected Gmail app, secondary uses authenticated Chrome through the host's native browser tool. The Gmail Skill currently uses America/Los_Angeles for primary register dates |

`location.scan_policy` currently requires **inline JSON indented by two spaces**. Merge
this [illustrative fragment](examples/location-scan-policy.fragment.yml) into the existing
`location` mapping; do not overwrite the full profile:

```yaml
location:
  scan_policy: {"local_metros":["Seattle","Bellevue"],"remote_country":"United States","require_structured_remote":true,"ambiguous_action":"exclude"}
```

The cities above are examples requiring user confirmation. Current local matching has
Washington-state assumptions, requires a nonempty city list, and supports US remote only.
The scoring policy currently supports Mid-level through Senior permanent full-time
roles, including a fixed Staff-equivalent score cap. Other target levels or employment
types require policy/code changes; changing profile text alone does not add support.
A different country, non-Washington local market or remote-only empty city list is not
fully supported by changing this JSON alone. Report that limitation instead of claiming
setup success or silently retaining the example cities.

### Career Docs structure

Career Docs is the user's private document workspace, not another package to download:

```text
career-docs/
  .git/                                  local private history for register transactions
  AGENTS.md                              ownership and editing instructions
  context/
    00 Knowledge Base Hub.md             index of available candidate/interview material
    .obsidian/                           optional; created when opening context as a vault
    Interview/
      active-interviews.md               sole process register and interview TODOs
      <company>/                         created only for a real, identified interview
        process-summary.md              identity and dated communications; linked from Notes
        <company>-<role>-interview-prep-<date>.md
        <company>-<role>-interview-evidence-<date>.md
        research-<date>/                 captured research evidence when needed
```

Use [the skeleton instructions](examples/career-docs/AGENTS.md),
[hub template](examples/career-docs/context/00%20Knowledge%20Base%20Hub.md) and
[empty register](examples/career-docs/context/Interview/active-interviews.md) only for
missing files. Do not create fictitious company records, rounds or TODOs. If the user has
an existing register elsewhere, resolve its ownership/path instead of making a second copy.
For a genuinely new workspace, initialize local Git and make an initial commit of the
new skeleton so the register writer has a HEAD; do not configure a public remote or stage
unrelated files. Existing private repositories/history are preserved. Interview TODOs stay
in `active-interviews.md`; no second process tracker is required. Obsidian is optional for
file creation, but its vault root is `career-docs/context/` when used.

Process charts read application totals from Career-Ops and interview processes from Career Docs. See [source paths and layout adaptation](.agents/skills/process-infographic/references/interview-records.md) for `--career-ops`, `--career-docs`, `--interviews-file` and nonstandard register formats. Follow the [rendering setup](.agents/skills/process-infographic/references/rendering.md) to prepare Python 3 with Pillow and a font covering your chart text, including CJK when needed. Keep the entire output directory private: even an anonymous render retains private JSON snapshots. Share only reviewed PNG/SVG files.

### Setup checks and completion criteria

`node src/setup-check.mjs --json` is read-only and reports paths, missing items and actions;
it does not output CV text or confirm factual correctness. Its `scope` fields identify
which workflow a missing item affects. It checks basic files, CV/register structure,
location/runtime config and some source fields, not every adapter invariant or login.
Even exit 0 retains manual checks; it is not a production-ready signal.

After creating/configuring files, the agent must also:

- Run Career-Ops's own health and CV consistency checks from its root; doctor may bootstrap
  missing files, so run it only as part of authorized setup. Check required writer interfaces.
- Run JobSpy runtime and import checks, confirm Ego Lite and external Skills, and let the
  user complete login. Confirm actual account identity without printing secrets.
- Run adapter configuration validation/dry-run for selected sources and inspect the JSON
  results. Use `npm run daily-scan:sources -- --run runs/installation-preview --dry-run`
  only as a command preview, not proof of source readiness.
- For resumes, verify the supplied template matches the CV and inspect rendered pages.
  Follow [personal template setup](assets/README.md), run `npm run resume:template`,
  and retain any remaining user-input or visual-review requirements.
- Preserve the candidate release's known failing tests/limitations in the handoff. Setup
  instructions do not resolve implementation defects. Do not run real scans, retention,
  scheduled jobs or applications as a setup test.

## Included Skills

This repository contains **8 Skills**, each under `.agents/skills/<name>/`. The links
below open their actual instructions. Skill files are included in the checkout; cloning
alone does not prove that your agent has loaded or globally installed them.

| Skill name | What it does |
| --- | --- |
| [career-ops-daily-linkedin-scan](.agents/skills/career-ops-daily-linkedin-scan/SKILL.md) | Run or verify configured job sources, score jobs and save reports; supports recovery, usage comparison and scheduling. Does not submit applications. |
| [career-ops-expand-report](.agents/skills/career-ops-expand-report/SKILL.md) | Expand one selected compact report into a complete Career-Ops report. |
| [career-ops-tailored-resume](.agents/skills/career-ops-tailored-resume/SKILL.md) | Create a truthful one-page Word resume for one existing report; checks evidence, JD coverage and page fit. |
| [career-ops-ego-apply](.agents/skills/career-ops-ego-apply/SKILL.md) | Prepare and submit a selected application or frozen batch, resolve answers from approved facts and verify the outcome. Can submit applications. |
| [gmail-job-reply-review](.agents/skills/gmail-job-reply-review/SKILL.md) | Review job-related Gmail replies or apply a direct process update; coordinate the canonical interview register, TODOs and linked company process summaries. |
| [linkedin-post-scan](.agents/skills/linkedin-post-scan/SKILL.md) | Find recruiting posts, hand exact jobs to Career-Ops and prepare outreach; stops before Send. |
| [technical-interview-prepare](.agents/skills/technical-interview-prepare/SKILL.md) | Research scheduled interview rounds and recent questions; maintain prep documents and a separate evidence record. |
| [process-infographic](.agents/skills/process-infographic/SKILL.md) | Read Career-Ops application counts and Career Docs interview records; dynamically generate process charts with configurable source paths. |

Open this repository in your agent and check its available Skill list against the eight
names above. Use your host's Skill loader if any are missing; you can also explicitly
ask the agent to read the linked `SKILL.md` for the task. With a host that supports
`$skill-name` invocation, for example:

```text
Use $career-ops-tailored-resume for the Career-Ops report I selected.
```

If multiple checkouts provide the same Skill name, give the agent the intended
checkout's absolute `.agents/skills/<name>/SKILL.md` path and verify the path it actually
loads. A matching name alone does not confirm the checkout. Host name selection and
desktop reload/cache behavior require separate checks; setup does not deduplicate them.

The other Skills use the same naming pattern; include the exact report, application scope
or interview target required by that Skill. Loading a Skill does not start its workflow.
Standalone Google ATS and repair commands are CLI utilities, not additional Skills.

### External Skills (installed separately)

| Skill | Supplied by / purpose |
| --- | --- |
| `ego-browser` | [Ego Lite](https://github.com/citrolabs/ego-lite); lets the agent operate the browser. Required for browser workflows. |
| `career-ops` | [Career-Ops](https://github.com/career-ops-hq/career-ops); its own job-management/onboarding workflow. Distinct from the eight Job Discovery Skills. |
| `obsidian-markdown` | Install this external Skill through your host's Skill catalog; the interview-prep Skill uses its Obsidian Markdown conventions. |

These external Skills are not copied into this repository. Installing a Skill does not
replace installing its application or preparing the accounts/data that it needs.

## External dependencies

**[Career-Ops](https://github.com/career-ops-hq/career-ops)** is an open-source job-search
management system. It maintains your candidate profile, job evaluations, reports and
application status. Job Discovery adds posting acquisition and workflow automation, then
uses Career-Ops's existing data and writer interfaces. Install its repository beside
Job Discovery as `../career-ops/` and follow its
[setup and onboarding guide](https://github.com/career-ops-hq/career-ops/blob/main/docs/SETUP.md)
to prepare your own profile. Career-Ops is not installed automatically with Job Discovery.

**[Ego Lite](https://github.com/citrolabs/ego-lite)** is a Chromium-based browser designed
for people and AI agents to use together. Job Discovery uses it to read authenticated
LinkedIn and Jobright pages, research interview sources, and interact with application
forms. **`ego-browser` is the command and agent Skill used to control the Ego Lite browser.**
Install the browser app using the [official installation guide](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md),
then make its Skill available to your agent and sign in to the sites you need.
The browser is installed as an application, not as a sibling source checkout like Career-Ops.
See the [Ego Lite website](https://lite.ego.app/) for downloads; its current app targets macOS.

**[JobSpy](https://github.com/speedyapply/JobSpy)** is the Python job-board scraping library
used by the JobSpy source. It runs from `../JobSpy/.venv/` and does not require Ego Lite.
Install only the source dependencies you intend to enable; all workflows remain included.

## Install

Use sibling repositories under any local workspace:

```text
workspace/
  job-discovery/       this candidate (you may rename job-discovery-public)
  career-ops/          code and your private profile/data
  JobSpy/.venv/        dedicated Python environment
  career-docs/           private interview workspace
```

From this repository root, install missing dependencies only:

```bash
git clone https://github.com/career-ops-hq/career-ops.git ../career-ops
(cd ../career-ops && npm install)
git clone --branch main https://github.com/speedyapply/JobSpy.git ../JobSpy
python3.12 -m venv ../JobSpy/.venv
../JobSpy/.venv/bin/python -m pip install --upgrade "pip>=21.3"
../JobSpy/.venv/bin/python -m pip install -e ../JobSpy
```

Career-Ops and Ego Lite are externally installed open-source dependencies. Follow Career-Ops
onboarding for your own `cv.md`, `config/profile.yml` and `modes/_profile.md`. Install Ego Lite
so `ego-browser` is on PATH and load its Skill in your agent. Use your own authenticated
browser/Gmail accounts. External tools, credentials and personal data are not bundled.
Use Python >=3.10,<4 for JobSpy; macOS system Python 3.9 is unsupported.
Setup defaults to `python3`; select another interpreter with `--python /path/to/python3.12`.
The offline suite uses Node 26.0.0 on macOS; other versions/platforms remain unverified.

The canonical agent Skills are in `.agents/skills/`; open this repository in your agent
and use its Skill discovery/installation mechanism. External Skills are resolved from
the host catalog. Commands below are relative to this repository root.

## Configure

For source settings, copy each required `.example.json` to the same filename without `.example` only if that
local file does not exist. Review all settings before running; actual configuration files
are ignored. Example configs contain no maintainer search exclusions or account data.

```bash
cp -n config/discovery-adapters.v1.example.json config/discovery-adapters.v1.json
cp -n config/daily-scan-runtime.example.json config/daily-scan-runtime.json
cp -n config/jobspy-ego.example.json config/jobspy-ego.json
```

For Gmail, run `npm run setup -- --workflows gmail --apply` to create the missing
`.local/gmail-job-reply-review/accounts.json` from the blank `config/gmail-accounts.example.json`.
Set its `primary` and `secondary` fields to the user's confirmed account addresses;
existing settings are preserved. The agent must also confirm the connected Gmail app's
primary identity and the live secondary Google Account in Chrome before reading mail.
A missing account blocks that mailbox only. Account addresses stay in the ignored local
file; login, passwords and verification codes stay in the normal authentication flow.

Only JobSpy is enabled in the example registry. For LinkedIn/Jobright, enable sources
only after installing Ego and logging in. Jobright's empty example filter snapshot must
be filled with your actual accepted filters; it deliberately cannot authorize a scan.
Disabled adapters do not require local config files. Google ATS and Post Scan have
their own example configs. An empty Google `title_exclusions` means no title exclusion
rules; required location rules remain validated. Set the worker model to one
available in your agent host. Review retention TTL: real Daily Scan can remove eligible
old `Evaluated`, `SKIP` (including `Skipped`) and `Discarded` records based on the
tracker date, while protecting application/interview/manual activity. Status history
is retained.

[Examples](examples/README.md) include fictional CV content and an empty interview register.
Use the register only for a new workspace; never overwrite an existing one. Candidate
examples are not application answers. Keep actual data in Career-Ops/Career Docs and `.local/`.
The resume builder requires your own compatible `assets/cv-template.docx`. Follow
[personal template setup](assets/README.md), run `npm run resume:template`, and inspect
the rendered page. Missing templates remain explicit setup requirements, not empty
placeholder DOCX files. Run `mkdir -p .tmp` before authoring a tailoring plan.

For standalone Google ATS, initialize its config and optional credential file without
replacing existing files:

```bash
cp -n config/google-ats-direct.example.json config/google-ats-direct.json
cp -n .env.example .env
npm run google-ats:scan -- --dry-run
```

For an actual Google scan, set `SERPAPI_API_KEY` in the ignored `.env` or process
environment. Do not put a real key in `.env.example`. Missing `.env` is allowed;
missing credentials still stop an actual scan. Dry-run makes no paid request.

Runtime writers create `runs/`, `.local/` and Post Scan data/report directories.
`assets/README.md` preserves the input directory; use `mkdir -p .tmp` for hand-authored
resume plans. `docs/`, `audits/` and `drafts/` are not required in a public checkout.

## Check and run

```bash
python3 adapters/jobspy_linkedin_scan.py --runtime-check
../JobSpy/.venv/bin/python -c "from jobspy import scrape_jobs; assert callable(scrape_jobs)"
node --input-type=module -e "import { loadCareerInterfaces } from './src/commit-scan.mjs'; await loadCareerInterfaces('../career-ops'); console.log('interfaces OK')"
npm run daily-scan:sources -- --run runs/installation-preview --dry-run
npm test
```

Runtime/import/interface/preview checks do not establish online source coverage or
end-to-end compatibility. `npm test` uses disposable synthetic fixtures and does not
need a private Career-Ops checkout. Production use requires Career-Ops, your profile and
source configuration. Career-Ops `doctor.mjs` may bootstrap missing files.

For the first real scan, invoke `$career-ops-daily-linkedin-scan` in your agent and ask it
to run enabled sources with your configured profile. It owns phase order and verification;
a successful run returns reports and `runs/<run-id>/receipt.json`. A scan writes evaluations
and runs retention but does not apply to jobs. Invoke `$career-ops-ego-apply` separately
for an explicitly selected application scope. Other workflows use their named Skills.

Repair tools now require `--manifest FILE`. Preview first; applying report repair also
requires `--plan-sha256 HASH`, and excluded-posting repair requires `--expected-plan-hash HASH`.
Original run evidence remains immutable. Manifest examples are in `examples/` and must
be replaced with the exact reviewed run/posting identities, never guessed by title.

## Release validation and limitations

The initial code snapshot is published. Validation covers the checks listed here;
it does not establish complete online workflow coverage.
The 2026-10-02 update passed **303/303** isolated public tests and **306/306**
development tests; the Daily Scan suite passed **197/197**. This update covers
posting-identity health checks, retention and interview-research guidance. Online
workflows were not rerun.

The following first-use checks passed on macOS as of 2026-09-26:
- A fresh Career-Ops installation, including Chromium, succeeded. Onboarding with a
  fictional CV/profile, full doctor, profile/CV consistency, pipeline, writer-interface,
  statistics/collector and canonical-register checks passed; empty inputs produced zero counts.
  Upstream warnings remained for automatic Codex Playwright MCP detection and a default
  Vinted portal without a provider. These are not Job Discovery source-readiness checks.
- Codex CLI read all eight bundled Skills and resolved the public checkout both locally
  and through Skill links in a separate Career Docs workspace. Explicit Skill paths
  distinguished the candidate from other checkouts with the same names.
- Gmail primary connector and secondary Chrome account identities matched and read-only
  searches succeeded. Logged-in LinkedIn and Jobright reads succeeded. The public JobSpy
  adapter, using the current package, collected one live posting with its JD and zero errors.
- Microsoft Word **16.73** rendered the tested DOCX as **one page**, with visual review passed.

These checks cover the tested environment, accounts and template. Fictional onboarding
material is not user-confirmed data, and the scoring example is not production calibration.
Other systems, templates and accounts still require their own checks. Complete account-backed
workflow transactions, GUI Skill selection, automatic same-name resolution and desktop cache
reload were not verified. No real application, message or production retention was performed
for testing; a one-posting acquisition does not establish source coverage.
Private golden tests, original captured JD fixtures, logs, reports, historical manifests,
credentials, browser state, private templates and development documents are not distributed.
MIT and third-party notices are included.


## Repeatable local setup and updates

```bash
npm run setup
npm run setup -- --workflows daily-scan --sources jobspy
npm run setup -- --workflows daily-scan --sources jobspy --apply
# Add --install --python /path/to/python3.12 for selected missing dependencies.
# For cross-project use, add --links /absolute/actual/host/skills
```

Workflows: `daily-scan,expand,resume,apply,gmail,interview,post-scan,google-ats,process-infographic`.
No arguments displays choices; default mode previews. `--apply` creates missing files only,
preserves existing values and links, and stops on link conflicts. `--install` can clone
missing Career-Ops and JobSpy main and prepare/verify JobSpy's venv. `CAREER_OPS_ROOT`
also selects the Career-Ops installation target. Run `npm install` in a newly cloned
Career-Ops checkout, then complete its onboarding, Ego/host connections, the unique
Career Docs register and your template using the instructions above.
Examples and file presence never count as confirmed candidate facts or workflow readiness.
Only Node 26.0.0 on macOS has been tested for this increment; other versions/platforms remain unverified.

When invoking from Career Docs, resolve the host Skill link with `realpath`, then walk up
three directories from the containing `.agents/skills/<name>/` directory to locate the checkout. Verify with
that checkout's `node src/setup.mjs --skill-root /absolute/Skill/SKILL.md`, and change to
the returned root. Pass Ego Apply an absolute `--memory` path under that root:
`.local/career-ops-ego-apply/application-memory.json`. Do not create a second answer store
relative to Career Docs. All eight Skills were read and resolved to the intended public
checkout in Codex CLI, including cross-project links. Use explicit paths when names overlap;
GUI selection, automatic duplicate-name resolution and desktop cache reload remain unverified.

After active workflows/writers finish, preserve any local source edits and read release notes:

```bash
git pull --ff-only
npm run setup -- --workflows google-ats
```

Pull updates code, Skills and examples; actual configuration, templates, private state and
Career Docs stay local. Reuse your selected workflows/sources for checks. Explicit `--apply`
can fill missing files; owning validators report invalid existing settings. Follow release
notes to add new required fields instead of replacing entire files. Back up necessary private
data separately; reverting Git does not reverse database migrations. `setup-check` inventories
all workflows and can report unselected sources; `setup` filters checks by selection.

`npm test` builds a disposable checkout with fixed test policies and independent Git history.
It does not read runtime configuration or adjacent private repositories. The suite alone
does not prove account access, live acquisition, Word rendering or application acceptance;
the separately observed checks and their limits are listed above.
