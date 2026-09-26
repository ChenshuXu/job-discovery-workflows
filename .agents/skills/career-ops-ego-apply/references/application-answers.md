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

New answers default to job scope:

```bash
node .agents/skills/career-ops-ego-apply/scripts/application-memory.mjs remember \
  --memory .local/career-ops-ego-apply/application-memory.json \
  --key "<canonical-key>" --label "<exact ATS question>" --value "<answer>" \
  --company "<company>" --role "<role>" --source current_conversation
```

Use `--scope company|global --reuse-authorized true` only when the user explicitly authorizes that reuse. When keyword discovery finds an existing key but lookup returns `key_review`, add the verbatim ATS wording with `--approve-alias true` only after checking the same subject, domain, time range, threshold, qualifiers, and scope. Re-run lookup and require `exact` before entering the answer. Alias approval may add only the wording alias; it must not replace the answer, domain, threshold, source, or other metadata. Verify every write with the script's `verify` command. Never store passwords, OTPs, CAPTCHA data, or unsupported narrative claims.
