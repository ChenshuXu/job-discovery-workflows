# Set up a user's workspace

This is the current setup procedure for a user's AI agent. Run Job Discovery commands
from the resolved checkout root. The English and Chinese READMEs describe the available
workflows and configuration fields; this guide fixes the order of setup and verification.

**Application Assist is under development and is not part of the released setup.**
Do not install, enable or refresh Application Assist, load its browser extension,
register its native host/MCP service, or run its development setup commands during
workspace setup. It is not required for any released workflow. A separate explicit
request to work on that development component is required. Existing local development
installations are not evidence of a release and must not be copied to another user.

## 1. Inspect and collect the missing inputs

Reuse existing Job Discovery, Career-Ops, JobSpy and Career Docs locations. Read their
AGENTS.md files and identify the user's sole interview register before creating files.
Ask once for the missing CV/path, selected workflows and sources, role/seniority and
location preferences, employment types, exclusions, timezone, matching-related work
authorization facts, and any existing interview processes. Ask about accounts only for
selected workflows. Reuse facts already supplied; do not infer eligibility or credentials.

For a new checkout, choose a workspace directory and clone into a missing destination:

```bash
git clone https://github.com/ChenshuXu/job-discovery-workflows.git job-discovery
cd job-discovery
node --version
git --version
npm run setup
node src/setup-check.mjs --json
```

Use Node 26, the tested Job Discovery runtime, and Git. JobSpy additionally needs
Python >=3.10,<4 in its dedicated venv. Check the actual interpreter before using it;
macOS system Python 3.9 is not suitable. Install a missing runtime through the user's
normal platform package manager, preserving working installations. Job Discovery has
no Node package dependencies to install. A first setup-check exit of 1 is expected:
read its missing-item actions and continue setup; do not delete files to silence them.

## 2. Choose only the required dependencies

| Selected workflow | `--workflows` value | Additional setup |
| --- | --- | --- |
| Daily Scan / PERM employer-filter scan | `daily-scan` | Career-Ops, confirmed candidate profile, Career Docs register; choose `--sources jobspy`, `ego-browser`, `jobright`, or `official-ats` (comma-separated) |
| Expand a report | `expand` | Career-Ops and an existing report for the later run |
| Apply with the released browser workflow | `apply` | Career-Ops, Career Docs register, Ego Lite and user login; Application Assist is not required |
| Word resumes | `resume` | Career-Ops, a reviewed personal DOCX template, zip/unzip; macOS Word for authoritative page checks |
| Mail review | `gmail` | Career-Ops, private Career Docs Git history, only the selected mailbox connections |
| Interview research | `interview` | Career Docs, Ego Lite/research tools and the external Skills listed in the README |
| Recruiting-post scan | `post-scan` | Career-Ops, Ego Lite, its config and shared runtime; preserve the README's v1 database upgrade restriction |
| Standalone Google ATS | `google-ats` | Its config; SerpAPI credential only for a separately requested real scan |
| Process charts | `process-infographic` | Career-Ops statistics interface, Career Docs, Python/Pillow and an appropriate font |

The PERM employer-filter Skill uses Daily Scan setup, then its own explicit tracker
refresh before a later scan. Optional PERM disclosure history is separate and disabled
by default. Download/import it only if selected, following the README initialization
instructions. Missing optional PERM data must not trigger a download during base setup.

The recommended layout is:

```text
workspace/
  job-discovery/       this checkout
  career-ops/          upstream code; private candidate data may live separately
  JobSpy/.venv/        only when the JobSpy source is selected
  career-docs/         the user's private documents and sole interview register
```

For an existing non-sibling Career-Ops installation, set `CAREER_OPS_CODE_ROOT` to its
absolute **code** checkout. `CAREER_OPS_ROOT` / `CAREER_OPS_DATA_DIR`, or the upstream
`.career-ops-data` marker, select private **data**. Preserve that separation. Persist
confirmed paths in the host's local environment/configuration; ordinary CLI commands
do not universally load `.env`. `setup-check --career-ops PATH --career-docs PATH
--jobspy PATH` changes that inventory invocation only. Configure each workflow's own
path options as documented in its Skill; use `CAREER_OPS_ACTIVE_INTERVIEWS` for a
non-default register used by Daily Scan retention and `--active-interviews` for Apply.

Post Scan additionally persists paths in `config/linkedin-post-scan.json`: set
`paths.career_ops_root` to the actual **code** checkout and `paths.cv` / `paths.profile`
to the actual private CV/profile. Keep `paths.employer_exclusions` and
`paths.daily_scan_runtime` pointed at the selected Job Discovery files. Resolve these
from confirmed locations after configuration creation; the installer preserves examples
and does not infer non-sibling paths. Its runtime still uses the upstream data resolver,
so keep the same data-root environment/marker active when validating or running it.

## 3. Preview and create the selected configuration

For example, after the user selects JobSpy Daily Scan:

```bash
npm run setup -- --workflows daily-scan --sources jobspy
npm run setup -- --workflows daily-scan --sources jobspy --apply
```

To install its missing source dependencies, add `--install --python` with an existing,
verified compatible interpreter, for example `/absolute/path/to/python3.12`. The installer
can clone missing Career-Ops and JobSpy main and prepare JobSpy's venv. It does not
install Career-Ops npm dependencies, onboard the candidate, install Ego Lite, create
Career Docs, log into accounts, install Application Assist or perform a production run.
Finish those selected steps below. Inspect `results[].errors` even when setup exits 0.

Use the same selection on subsequent checks. `--apply` creates only missing configuration
and explicitly requested Skill links. Existing values remain unchanged; reconcile an
existing source registry with the user's choices rather than replacing it. The installer
never marks a workflow ready from file presence. If an install fails after configuration
creation, preserve those files and resume the failed dependency step.

For manual recovery, the README provides the upstream clone, venv and pip commands.
Run them only for missing selected dependencies. In a newly cloned Career-Ops checkout,
run `npm install` from **that checkout**, then read its own setup/onboarding instructions.
Use the README's linked official Ego Lite installation instructions and load its
external `ego-browser` Skill for browser workflows. User login and human verification
remain manual; do not request or record passwords, cookies or one-time codes.

## 4. Onboard real candidate facts and configure sources

Use Career-Ops's own first-run/profile onboarding with the user's actual CV and confirmed
answers. Keep `cv.md`, `config/profile.yml`, `modes/_profile.md` and any required current
upstream `modes/_brief.md` consistent. Run `node doctor.mjs --json --cli codex` from
Career-Ops, replacing `codex` with the actual host, and inspect both `missing` and
`unpersonalized`. Where missing templates must be initialized, use its documented
`--init-templates` option, then personalize them; a copied template is not onboarding.
Run `node cv-sync-check.mjs` and resolve factual/format discrepancies without inventing
experience. Keep private data out of public remotes.

Follow the README's configuration map: merge the two-space-indented inline JSON
`location.scan_policy` into the existing profile; align source queries and locations;
set enabled sources, exclusions, model/effort and retention choices. Current location
matching supports the documented Washington local-city / US-remote scope. Unsupported
geography or host capabilities remain explicit blockers rather than changed preferences.
Do not use the fictional CV or sample Seattle choices as another user's facts.

For Jobright, capture the user's accepted visible filters and structured codes in
`filter_snapshot`; its blank example intentionally fails validation. Configure only
requested mailbox identities in `.local/gmail-job-reply-review/accounts.json`; leave
unselected accounts untouched and report readiness per selected mailbox. Set a Google
credential only in ignored `.env` or the process environment, never in an example file.

For the separate Post Scan configuration, resolve the `paths` fields described above
before validation. Selecting a custom Career-Ops code root does not rewrite those JSON
fields automatically. Keep the referenced source exclusions and shared runtime available
even when Daily Scan itself is not selected.

## 5. Prepare Career Docs and host Skills

For workflows requiring the register, first confirm whether it exists elsewhere and
whether the user has active interviews. Reuse/reconcile the real register through its
canonical writer. Only for a confirmed new workspace with no existing records:

```bash
mkdir -p ../career-docs/context/Interview
cp -n examples/career-docs/AGENTS.md ../career-docs/AGENTS.md
cp -n 'examples/career-docs/context/00 Knowledge Base Hub.md' '../career-docs/context/00 Knowledge Base Hub.md'
cp -n examples/career-docs/context/Interview/active-interviews.md ../career-docs/context/Interview/active-interviews.md
git -C ../career-docs init
git -C ../career-docs add -- AGENTS.md 'context/00 Knowledge Base Hub.md' context/Interview/active-interviews.md
git -C ../career-docs commit -m 'Initialize private interview workspace'
```

Use confirmed alternate paths when the workspace is elsewhere. Git needs the user's
configured author identity; ask if missing rather than inventing it. Do not add a public
remote or include unrelated files. Existing registers use the Gmail Skill's canonical
writer and preserve identity/history. Obsidian is optional; its vault is `career-docs/context/`.

Ask the actual agent host to discover the nine bundled `.agents/skills/` directories.
If cross-project links are needed, identify the host's real Skill directory first,
preview with `--links /absolute/host/skills`, then apply the same selected setup command.
Preserve existing links; resolve conflicts without overwriting them. Verify each loaded
Skill's real path using `node src/setup.mjs --skill-root /absolute/Skill/SKILL.md` and
run its commands from the returned Job Discovery root. Keep the Apply answer store
under that root's `.local/career-ops-ego-apply/`, not relative to Career Docs.

## 6. Verify without starting work

Read the selected checks and manual actions, rather than requiring every optional
workflow to pass the global inventory:

```bash
node src/setup-check.mjs --json
npm run setup -- --workflows daily-scan --sources jobspy
node --input-type=module -e "import { loadCareerInterfaces } from './src/commit-scan.mjs'; await loadCareerInterfaces(process.env.CAREER_OPS_CODE_ROOT || '../career-ops'); console.log('Career-Ops interfaces OK')"
npm run daily-scan:sources -- --run runs/installation-preview --dry-run
```

Replace the example workflow/source selection with the actual choices. For JobSpy also
run the README's `--runtime-check` and venv `scrape_jobs` import. For official ATS and
Jobright, validate their actual config with the exported `loadCareerAtsConfig` and
`loadJobrightConfig` functions. Post Scan's `loadConfig` validates referenced paths and
runtime without opening its database. Google `--dry-run` needs no credential and makes
no paid request. Run `npm test` when verifying the checkout itself; it uses disposable
fictional fixtures and does not configure the user's facts or accounts.

For resumes only, follow [personal template setup](../assets/README.md), run
`npm run resume:template`, and inspect the actual rendered pages. For charts, follow
the process-infographic Skill's Python/font check. Confirm selected browser/Gmail
account identities through their normal tools; do not read mail or fill applications
just to demonstrate setup. Capability gaps remain visible.

## 7. Hand off the workspace

Report each selected workflow as `ready for first run`, `needs user input`, `unsupported`
or `validation failed`, with its actual paths, checks and next action. List created or
changed files and the exact owner of each missing fact/account/template. Unselected
workflow warnings do not invalidate a configured selection. Application Assist stays
listed as unfinished and excluded; it must never be installed to clear a warning.

Setup ends without a live scan, retention cleanup, schedule, application or message.
A separately requested real run follows its owning Skill. Use the README update section
for existing installations, especially the Post Scan v1-to-v2 migration restriction.
