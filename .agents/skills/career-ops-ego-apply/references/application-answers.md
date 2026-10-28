# Application answer protocol

Use only the current conversation, approved candidate sources, and the private Job Discovery memory at `.local/career-ops-ego-apply/application-memory.json`. Access that file only through `application-memory.mjs`; do not inspect or alter it with `jq`, `rg`, or direct JSON reads.

Run `resolve` for every visible question before attempting an answer. It first applies the built-in human/AI challenge, CAPTCHA, and one-time-code matchers, so a legacy stored answer can never override a verification boundary. `human_only` means leave the control untouched and hand it to the user. For an ordinary question, identify the canonical intent and independently state its `topic`, `relation`, `timeframe`, and `qualifier`; employer names are qualifiers, not new facts:

```bash
node .agents/skills/career-ops-ego-apply/scripts/application-memory.mjs resolve \
  --memory .local/career-ops-ego-apply/application-memory.json \
  --label "<exact ATS question>" --intent "<canonical intent>" \
  --meaning-confirmed true --topic "<topic>" --relation "<relation>" \
  --timeframe "<timeframe>" --qualifier "<qualifier>" \
  --company "<company>" --role "<role>"
```

A semantic rule resolves only when all four dimensions match exactly and its answer key produces an `exact` applicable record. Never use a rule merely because the wording, company name, or answer value looks similar. Keep current employment, prior employment, knowing an employee, employee referral, prior application, prior rejection, authorization, and sponsorship as distinct intents. Never infer citizenship, visa class, immigration history, compensation, relocation, or another legal/personal fact from indirect evidence.

When no approved semantic rule resolves the question and the canonical key is not already known, search with the smallest set of fact-defining keywords. Preserve distinctions such as current versus prior employment, employee versus contractor, and identity credential versus employment history:

```bash
node .agents/skills/career-ops-ego-apply/scripts/application-memory.mjs search \
  --memory .local/career-ops-ego-apply/application-memory.json \
  --query "<fact keywords>" --company "<company>" --role "<role>"
```

Search is discovery only: it may identify candidate canonical keys but never authorizes an answer. Compare the candidate's subject, domain, time range, qualifiers, and scope before selecting a key. If there is no single semantically equivalent candidate, keep the field unresolved rather than choosing by score.

Then pass the ATS question verbatim as `--label`. This lookup path remains the authority for exact wording, reviewed aliases, and the narrow numeric deduction:

```bash
node .agents/skills/career-ops-ego-apply/scripts/application-memory.mjs lookup \
  --memory .local/career-ops-ego-apply/application-memory.json \
  --key "<canonical-key>" --label "<exact ATS question>" \
  --company "<company>" --role "<role>"
```

For a numeric same-domain threshold question, also pass `--subject`, `--domain`, `--threshold`, `--comparison at_least`, `--logic atomic`, and `--qualifiers none`. Any compound condition, changed operator, time range, degree requirement, AND/OR clause, scope conflict, or same/more-specific counterevidence must fail closed instead of being deduced. Lookup results mean:

- `exact`: same canonical question or reviewed alias at the most specific applicable scope;
- `deduced`: a permitted, explicit same-domain threshold deduction;
- `key_review`: the key exists but the wording is not approved as equivalent;
- `conflict` or `unresolved`: no answer may be entered without new evidence.

Only `exact` or `deduced` resolves an important field. A field in `waiting_for_answer` remains blocked until the user answers or new evidence produces one of those two results. Finish the wave's accessible preparation, then ask once; each item must include report ID, role, verbatim ATS question, options, and why it is unresolved. Do not repeat the same question group during automatic continuation.

Legacy Ego Apply callers without an Application Assist selection retain company/role `job` scope. These records never become exact-posting records automatically. Every durable mutation now requires a reviewed target revision or explicit expected absence:

```bash
node .agents/skills/career-ops-ego-apply/scripts/application-memory.mjs remember \
  --memory .local/career-ops-ego-apply/application-memory.json \
  --key "<canonical-key>" --label "<exact ATS question>" --value "<answer>" \
  --company "<company>" --role "<role>" --source current_conversation \
  --expected-absent true
```

Use `--scope company|global --reuse-authorized true` only when the user explicitly authorizes that reuse. When keyword discovery finds an existing key but lookup returns `key_review`, add the verbatim ATS wording with `--approve-alias true` only after checking the same subject, domain, time range, threshold, qualifiers, and scope. Re-run lookup and require `exact` before entering the answer. Alias approval may add only the wording alias; it must not replace the answer, domain, threshold, source, or other metadata. Verify every write with the script's `verify` command. Never store passwords, OTPs, CAPTCHA data, or unsupported narrative claims.


## Application Assist selected-source interface

Application Assist always supplies `answerSource: global | company | posting` to
`resolveQuestion`, `lookup`, and `search` (CLI: `--answer-source`). This is a strict
selector for both reads and the learning destination. It does not run the legacy
most-specific-scope fallback. `postingKey` is the exact verified ATS posting key;
same company/title with another requisition has a different target. `job` remains
the historical company/role scope for explicit review only.

Pass the reviewed meaning as `context`, with nonempty strings for `section`,
`intent`, `subject`, `domain`, `timeframe`, `qualifier`, `comparison`, and
`conditions`, plus `options: string[]`. Use explicit `none` for an inapplicable
dimension and `[]` when there are no choices. Question symbols and comparison
operators survive equality normalization. Context disagreement blocks even an
exact label match. Model confidence, keyword search and a repeated label alone
do not establish meaning. Semantic rules additionally require matching dimensions;
strict rules bind one `answerId` and its reviewed `answerRevision`.

The only shared records are global basic facts with `sharedBasic: true`,
`reviewedMeaning: true`, and a reviewed `profile.identity.*`, `profile.contact.*`,
`profile.education.*`, or `profile.history.*` intent. Do not classify salary,
relocation or company preferences as basic facts. Explicit reviewed `factual`
counterevidence at an applicable scope can block a conflicting selected answer;
it never supplies an answer from another preference layer.

A controller uses the existing module directly; it never parses the store itself:

```js
import { readMemoryChecked, answerTarget, resolveQuestion, mutateMemory }
  from './application-memory.mjs';
const query = {
  key: 'preferences.location', label: 'Where do you prefer to work?',
  answerSource: 'posting', company: 'Synthetic Acme',
  postingKey: 'fixture:acme:req-1',
  context: {
    section: 'Preferences', intent: 'preferences.location', subject: 'candidate',
    domain: 'work location', timeframe: 'current', qualifier: 'none',
    comparison: 'equal', conditions: 'none', options: ['Remote', 'Office'],
  },
};
const reviewed = answerTarget(readMemoryChecked(memoryPath), query);
// The controller sets this false on cancellation, navigation or source/review change.
let reviewStillCurrent = true;
// After deliberate final user confirmation, with the same source and target:
await mutateMemory(memoryPath, 'remember', {
  ...query, scope: query.answerSource, value: { type: 'text', value: 'Remote' },
  source: 'user_review', userConfirmed: true, reuseAuthorized: true,
  ...(reviewed.revision ? { expectedRevision: reviewed.revision } : { expectedAbsent: true }),
}, { assertCurrent: () => { if (!reviewStillCurrent) throw new Error('STALE_REVIEW'); } });
const fresh = resolveQuestion(readMemoryChecked(memoryPath), query);
```

The `memoryPath` is host configuration, never a page-supplied path.
The optional library-only `assertCurrent` callback must be synchronous. It runs
inside the shared writer lock after target revision checks and immediately before
the synchronous reducer/write, so a cancelled review or changed source cannot
commit while its operation was waiting for another writer. It is not a CLI/JSON
argument; the controller supplies the live assertion.
`readMemoryChecked` opens without following a final symlink, validates the opened
descriptor as an owner-only regular file, and rejects insecure or corrupt stores.
Only a genuinely absent file is an empty fresh store. Strict CLI reads use the
same check. The legacy `readMemory` export remains for older local callers. Read the target
when it is reviewed, not immediately before replaying an old confirmation. On
`REVISION_CONFLICT`, preserve the page answer, show the current target and obtain
a fresh decision; never refresh the revision and retry automatically. The
`target` CLI returns the same ID/revision. For rules use `--id <rule-id>
--target-type rule`. `remember-rule` uses that rule revision/absence, and strict
rules also carry `--answer-id` and `--answer-revision` from the selected answer.

`remember --approve-alias true` adds equivalent wording only; its value and
context must match the reviewed target. It cannot change the fact. A correction
entered under an existing alias uses `--correct true`; canonical value changes
also count as corrections. Corrections clear dependent aliases and rules.
`forget` and `forget-rule` use the same expected-revision contract and remove
dependent authority. Forgetting does not alter prior application results.

Typed values are `{type:'text',value:string}`, `{type:'boolean',value:boolean}`,
`{type:'multi',value:string[]}`, `{type:'date',value:'YYYY-MM-DD'}`, or
`{type:'blank',value:null}`. A blank is an intentionally empty optional answer,
not a missing value; checkbox false and an empty multi-selection remain typed.
Legacy nonempty strings retain their meaning. The CLI accepts the object as JSON
in `--value` and the meaning object as JSON in `--context`.

Automatic learning requires `userConfirmed: true` from the controller's bound
page review. Defaults, other extensions, generated prose, blur events and a
content script's assertion are not confirmation. The controller must establish
that provenance before calling this writer. Human-only verification and password
labels/credential keys are rejected. AI-derived prose remains outside reusable
factual memory.

Every disk mutation takes the same canonical-path writer lock before reading,
checks the target precondition under the lock, validates, atomically replaces the
owner-only file, and verifies the committed content. The bounded wait returns a
busy error without deleting a live or unverifiable lock. An abandoned lock needs
explicit ownership investigation; age alone does not authorize removal. The
pure `remember`/`rememberRule` exports are reducers for legacy in-memory callers,
not disk writers. No caller should write their returned objects directly.

On the first authorized mutation of a legacy store, the writer saves an
owner-only `.v<version>-backup` and moves the schema to version 4 while preserving
record IDs and legacy scopes. No production migration is performed by tests or
installation. Unreviewed legacy contexts remain unavailable for strict filling.

For Global basic identity/contact text fields, Application Assist can show an
unambiguous legacy global value as a review suggestion after deterministic
meaning validation. It remains `needs_answer`, with no fill permit or store
mutation. **Use saved basic details** confirms only those displayed suggestions
through the normal reviewed writer; later fills use the new canonical record.
Conflicting, company/job/posting-scoped, educational and option-based legacy
answers are not imported by this path.

Freshly resolve immediately before every field write and after every source
switch, correction or removal. Revisions cover the complete target, including
aliases and metadata, but a record revision alone cannot detect newly added
counterevidence; perform the full resolver call. Never hold the store lock across
browser or AI work. Source switching, user-edit protection, single-use delivery
permits and UI provenance checks are controller responsibilities.

## Verification

Run `node test/e2e/e2e-application-assist-answers.mjs`. Each run uses temporary
synthetic stores and separate CLI processes, retains sanitized results and
source/test hashes under `.local/application-assist-tests/answers/`, and deletes
the temporary stores. It covers selector isolation, exact posting identity,
context/symbol collisions, equivalence/corrections, typed values, traps,
concurrent writes, stale target/rule revisions, migration and lock refusal.
`node --test test/application-memory.test.mjs` verifies legacy resolver callers.
These are canonical-interface E2E checks; actual extension/controller/Ego Lite
acceptance is a separate mandatory product gate.
