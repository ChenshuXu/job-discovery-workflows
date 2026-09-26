# ATS Recipes

Read the selected recipe after `application-batch.mjs` freezes the report IDs. The hosted form remains authoritative; verify visible company, role, requisition, files, required controls, and saved values before submission.

## Simplify on every supported ATS

- Start Simplify at most once per page, and do not start it where a recipe forbids it.
- If it hangs or corrupts data, stop immediately and do not restart it on that page.
- Continue with trusted visible inputs, then re-check every affected field.
- A Simplify hang is not a submit attempt.

## Greenhouse

1. Confirm the exact requisition on the hosted page. A read-only questions API may help inspect labels, but it cannot replace visible identity or submission evidence.
2. Run Simplify once, wait for completion, and verify required values. Searchable text is not selected until the control commits and reads back the option.
3. Keep optional cover letters empty. Submit through the visible hosted control once.
4. If Greenhouse requests an emailed security code, leave it untouched and wait for the user to complete that one-time step manually.
5. If the final click is uncertain, do not retry; check one exact success or portal-history path.

## Ashby

1. Confirm company, role, and posting identity on the hosted `/application` page.
2. Run Simplify once. A visible value is not proof it was saved: after every manual correction, blur the control and read the value back.
3. Do not call Ashby submission endpoints. A possible-spam/security rejection without a concrete field error is terminal.
4. Require an explicit accepted state before Career-Ops reconciliation.

## iCIMS

1. Preserve the employer tenant hostname and `/jobs/<requisition>/` identity through login, OAuth, candidate-profile, questions, and nested form routes. After LinkedIn SSO, a new tab, or an iframe redirect, re-check the exact role and requisition before continuing.
2. Use Computer Use for the visible `Next`, LinkedIn sign-in, and saved-password-manager flow. Never read, copy, or retain credentials; after authentication returns to iCIMS, verify the tenant and requisition again before `Update Profile` or another profile action.
3. Distinguish Candidate Profile, global Candidate Questions, Job Specific Questions, and each Voluntary Self Identification form by title, URL, and headings. Their generic `Submit` controls usually save or advance one page; none proves application acceptance by its label alone.
4. For cascading source controls, select the broad source first, wait for the dependent selector to enable and populate, then select the exact source supported by the frozen posting's acquisition evidence. Do not hard-code values demonstrated in a prior application.
5. Treat consent, eligibility, sponsorship, employer-affiliation, and compound experience or degree questions as material. Read every saved value back and resolve it through the parent Skill; never accept a default, and never reduce an `OR` or degree-qualified question to an atomic years-of-experience deduction.
6. Voluntary veteran, disability, and similar self-identification forms may require both a choice and a separate signature checkbox. Use only a current approved answer, do not infer or retain sensitive values from a recording, and verify each form advanced before acting on the next one.
7. Require visible official success text, a confirmation number, or exact portal history before classifying `accepted`. A return to the job page, an iframe disappearance, or a URL such as `mode=submit_apply` without confirmation content is not sufficient evidence; do not retry an uncertain final action or mark the Career-Ops row `Applied`.

## Oracle

1. Do not use Simplify on repeated Experience or Education pages.
2. Inspect the number of entries and the saved values instead of assuming a repeated page is empty or duplicated.
3. Use visible navigation and final controls only; require Oracle's explicit submitted/received state.

## Microsoft

1. Reuse one authenticated candidate session for a consecutive Microsoft wave.
2. After every re-login, re-check the resume attachment, address, acknowledgements, and manually changed fields before continuing.
3. Preserve both the source Position ID and the portal Job ID; use the exact pair when reconciling duplicates or portal history.
4. Submit sequentially and require the official application-received state for each report ID.

## Workday

1. Each wave contains one exact tenant. Accounts and saved candidate data never carry across tenants by assumption.
2. Follow visible My Information, Experience, Application Questions, Voluntary Disclosures, and Review stages. Keep already-valid saved entries unchanged.
3. Login or verification blocks only the current tenant. Submit sequentially and require Application Submitted/Received evidence.

## LinkedIn

Choose exactly one channel: Easy Apply or an official recruiting email. Do not send email after Easy Apply, or Easy Apply after email, for the same exact requisition.

## Official email

Send once through the official employer address. Record `official email application sent`; do not claim the employer received, opened, or accepted it unless separate official evidence proves that.

## Google

When the account application cap blocks a role, keep it `Evaluated` with an exact `retry_on=YYYY-MM-DD`. Do not retry before that date.

## Generic fallback

Rippling, Lever, and other hosts use the base Skill workflow. A third-party wrapper is never the default: first complete one official employer ATS/email liveness and exact-identity preflight, and use the wrapper only when that official route is unavailable or unusable. Group by ATS and tenant/hostname, reuse an existing login only for that exact tenant, and do not invent a site-specific recipe without live evidence.
