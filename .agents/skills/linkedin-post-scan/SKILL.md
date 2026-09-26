---
name: linkedin-post-scan
description: Scan recent LinkedIn recruitment posts through Ego Lite, route exact jobs to Career-Ops, maintain a local outreach queue, or prepare one approved message without sending it. Use for LinkedIn post scan, calibration, status, or AUTO_PREPARE requests; do not use for LinkedIn Jobs Daily Scan or applications.
---

# LinkedIn Post Scan

For modes requiring live pages, use `ego-browser` for every observation or action. Keep browser automation in temporary heredocs; never add a reusable LinkedIn page script to the repository. `status` needs no browser.

Read the relevant mode in [references/workflow-contract.md](references/workflow-contract.md); `status` needs only Shared invariants. Use `linkedin-post-scan/config/post-scan.json` as the only Post Scan configuration and `linkedin-post-scan/src/cli.mjs` for deterministic state changes.

## Modes

- `scan`: prove `Posts` and `Past week` for each query, capture up to the configured limit, resolve canonical Post identity for every retained item, route exact jobs, and refresh the daily report. Preserve the failing query and stop the run on an unverified filter.
- `calibrate`: retain the existing recall decision, combine quick-query timing with actual deep-check wall time, and report the cyclic 12:30/17:00/21:00 Pacific gap when every query fits one run; otherwise keep the budget pending.
- `auto-prepare <candidate>`: reverify the live profile and visible relationship state, fill one eligible note or free message, verify the text, and stop before `Send`.
- `status`: read the existing SQLite/report state through the immutable connection only. Return `NOT_INITIALIZED` when the database is absent; do not initialize, purge, checkpoint, or render.

## Hard boundaries

- Never send Connect, Direct Message, follow-up, InMail, comment, email, form, or calendar action.
- Stop on unverified `Posts`/`Past week`, CAPTCHA, 403/429, access warning, restriction, quota, identity conflict, uncertain send state, user takeover, or inactive task space.
- Never retry an uncertain external action or use evasion, proxies, random interaction, another browser, web search, or LinkedIn Jobs as fallback.
- Persist a retained Post only when its identity is `urn:li:activity:<digits>` plus a concrete permalink containing the same activity ID. Search/profile/activity URLs and `ui:` hashes are navigation clues only.
- Only an exact employer, role, location scope, live official posting identity, and post-to-job evidence may enter Career-Ops.
- Post Scan and Daily Scan remain separate. Career-Ops history currently uses `daily-scan:<run-id>` for both; Post Scan run IDs must begin `postscan-`, and SQLite preserves Post Scan provenance.
- Do not generate a resume/PDF, prepare an application, submit anything, or create a schedule. Automation requires separate approval after the live pilot.

Completion of live capture, calibration, handoff, or preparation requires observable live evidence. If no real exact job or eligible outreach candidate appears, report the corresponding phase as pending instead of creating a fixture or synthetic candidate.
