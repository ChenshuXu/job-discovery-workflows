# Workflow contract

## Shared invariants

Load `linkedin-post-scan/config/post-scan.json`. Writing modes initialize the local SQLite database, purge expired tombstones, and acquire the single-run lock. `status` branches before all three operations, opens the existing database as immutable, and never renders a report. Runtime state belongs only in the ignored database and temporary run directory. Reports are stable Markdown views of that state.

The operational boundary is observation and pre-Send preparation only, with no automatic external submission.

## Live capture contract

For every query, use a fresh Ego Lite observation and capture one JSON object with:

- `query_key`, `query_text`, `priority`, `started_at`, `finished_at`, and `elapsed_ms`;
- `filters.posts === true`, `filters.past_week === true`, plus `filters.latest` and an optional `sort_note`;
- `truncated`, `visible_result_count`, and up to the configured number of unique `posts`;
- each post's quick navigation clue, preview, author/company display, visible time, visible links, and quick signals.

If `Posts` or `Past week` is not proven, stop the whole run as `LINKEDIN_FILTER_UNVERIFIED`. If access or account restriction is visible, preserve only the minimum diagnostic state and stop without retry.

Deep-check only quick-screen survivors. A processed post object must include current body evidence and a small semantic `decision` object. The deterministic processor accepts only the fields needed by the route:

- every retained exact/outreach/review item first resolves to `urn:li:activity:<digits>` and a concrete `/feed/update/...` or `/posts/...activity-<same-id>` permalink;
- a search URL, profile activity URL, or `ui:` hash never enters `posts` or a downstream table; actionable unresolved identities stay only in the run receipt/report as `POST_IDENTITY_UNRESOLVED`, while unresolved exclusions increment the run count only;

- exact job: `route: "EXACT_JOB"`, exact `posting_key`, official URL, employer, title, location, post-to-job evidence, and complete JD text;
- outreach: `route: "AUTO_PREPARE_READY"`, Post Signal dimensions/total, verified member/profile identity, authority, and a draft grounded in the post and current CV;
- review: `route: "REVIEW"`, score in `[3.5, 4.0)` and exactly one material missing fact;
- exclusion: `route: "EXCLUDED"`, stable reason code only. The database retains only a salted Post-ID hash tombstone for eight days.

Unchanged body hashes update `last_seen_at` without another model call. Changed bodies update the existing Post and may be rerouted. Non-exact opportunity identity is the deterministic hash of Post URN, route kind, and normalized employer/title; rerouting supersedes the previous active non-exact route. Exact posting keys hand off once; a contact/opportunity pair has one active outreach action, and later scans never regress a prepared outreach to ready.

## Calibration

Run the three representative role/location combinations in combined and split form. Compare exact Post ID sets and actionable sets. Select combined only when it has no meaningful actionable recall loss. Require filter evidence on every capture. Compute effective query time from average quick-query wall time plus average deep checks per query times the measured average per-deep-check wall time. When every query fits one run, the maximum P1/P2 gap is the largest cyclic gap between 12:30, 17:00, and 21:00; otherwise `budget_complete` remains pending. Budget limits never change the recall decision or silently reduce query caps, role groups, or targets.

## Career-Ops handoff

For each new exact posting, create a `postscan-<UTC-epoch-ms>-<8-character-posting-key-hash>` run with the single `linkedin-post-scan` source summary, complete Markdown JD, and employer-exclusion audit. Set `JOB_DISCOVERY_ADAPTER_REGISTRY` only in child processes, pointing to the absolute Post Scan config.

Run in order: baseline capture, combine, contract validation, canonical URL resolution, evaluation planning, configured model workers only for non-empty assignments, deterministic empty merged results for empty assignments, commit, and receipt verification. If Career-Ops location policy changes after baseline, discard the run and start over. A location-gate exclusion is a completed `LOCATION_GATE_EXCLUDED` outcome, not a handoff failure.

Never substitute a model or reasoning effort. Never copy the scorer or Career-Ops writer. Never produce resume, PDF, application, or liveness artifacts. After commit, classify only the current posting key: `HANDED_OFF` requires its report object plus tracker and scan-history closeout; below-threshold, hard exclusion, location exclusion, job issue, and unresolved closeout retain their own outcomes. Top-level `COMPLETE` alone never means `HANDED_OFF`.

## AUTO_PREPARE

Choose one contact in this order: hiring manager/team lead/founder, internal recruiter, explicitly inviting team member. Reverify member/profile identity and live relationship state. Validate the draft against the live character limit and require a specific post/team/role reference, one verified CV hook, and a soft ask.

Fill only when `Add a note` or a free connected `Message` is visible. Stop at the final `Send` control and leave the task space open for the user. InMail, external actions, no-note flows, quota prompts, identity conflicts, and uncertain state are review/stop outcomes.

The narrow visible-state recorder allows only ready to prepared, ready/prepared to InMail review, no-note available, or external-action review, and prepared to send-uncertain. It never sends or infers an unlisted transition. Sent, pending, connected, and follow-up lifecycle management remain outside this pre-Send workflow.

## Reporting

Maintain one `YYYY-MM-DD.md` per Pacific date and a minimal `latest.md` link. Stable identities replace rows rather than append duplicates. Sections are Summary, Direct Apply, Worth Contacting, Review, Completed, and full Connect/DM drafts. Every retained detail row links its canonical `Source Post`; `POST_IDENTITY_UNRESOLVED` appears only in Review with an explicitly labeled navigation clue. Direct Apply requires the persisted report object and matching tracker identity. Excluded posts appear as counts only.
