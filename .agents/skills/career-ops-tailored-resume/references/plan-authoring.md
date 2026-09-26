# Tailored Resume Plan Authoring

## Swapping against the baseline

Treat the template baseline as a proven one-page budget, not as a generic example.

For each material JD requirement, find the strongest truthful evidence and classify it:

- **Direct:** the same kind of system, responsibility, or outcome.
- **Analogous:** a closely related problem with a clearly transferable technical pattern.
- **Transferable:** evidence of the underlying capability, without claiming domain equivalence.

Drop baseline bullets the JD makes low-value. Promote pool bullets it makes essential. Swap close to
one-for-one; adding bullets consumes the page budget. Order each role strongest-first. Before writing
the summary, state the single throughline the selected evidence supports.

## Writing rules

- Use short sentences with one main idea each.
- Do not use em dashes.
- Remove preamble clauses: write “Led …,” not “Leveraging deep expertise in X, led …”.
- Avoid stacked adjectives and long compound-noun piles.
- Remove filler such as “demonstrating ability to,” “with a track record of,” “spanning,”
  “leveraging,” and “utilizing.”
- Prefer a concrete action, system, scope, and outcome over self-description.
- Keep the summary to 2-3 sentences, each under 20 words.

## Not imported

- “Under two pages” does not apply; this workflow has a hard one-page target.
- Do not add work-history bullets outside `cv.md`; every experience item needs an existing ID.
- Do not mirror JD language unless it truthfully reframes existing evidence. Unsupported mirroring is
  exactly what `GAP_KEYWORD` prevents.

## Rewriting posture

Rewrite for concision and JD framing, while preserving the evidence itself.

- Never change a metric's value, unit, approximation, scope, or attribution.
- Never upgrade a technology, title, seniority, ownership, time window, causal claim, or production
  scope.
- Never merge evidence from two roles into one sentence.
- A rewrite introducing a number absent from that source bullet fails the `NUMBER` subset check.

## Emphasis

Keep an inherited baseline bullet's existing bold spans as-is; they are human-curated and exempt
from the three-span authoring cap only while its marked text remains unchanged. For a swapped-in or
rewritten bullet, author 1-3 short spans drawn from that bullet's supported wording. Never bold a
whole bullet or introduce a claim merely to emphasize it.

## Self-critique

Read the final `RENDERED TEXT` block, not just `plan.json`. Fix:

- bullets trying to carry multiple stories;
- prose that reads like a LinkedIn post;
- filler, stacked buzzwords, or trailing gerund clauses;
- a summary longer than three sentences;
- any summary capability not demonstrated by a bullet retained in this build;
- dangling backward references such as “the features,” “that pipeline,” or “it” after a source bullet
  was removed.

## Gate playbook

| Prefix | Meaning | Fix in the plan or input |
|---|---|---|
| `IDENTITY_BLOCKER` | Report or bound JD is missing or ambiguous. | Use the exact selected Career-Ops report slug; do not guess. |
| `TEMPLATE_DRIFT` | The DOCX structure no longer matches the renderer's contract. | Restore the expected template structure. A `baseline bullet` error means `cv.md` wording changed after the template was made; reconcile the two sources deliberately. |
| `STRUCTURE` | Required plan shape, order, IDs, keyword count, or emphasis balance is invalid. | Correct the named JSON location. |
| `NUMBER` | A rewrite added or changed a numeric token. | Restore the source bullet's exact numeric claim or remove it. |
| `SKILL` | A skill item is absent from the `cv.md` skill vocabulary. | Use an exact source item; labels alone may be rewritten. |
| `GAP_KEYWORD` | Resume text contains a selected JD phrase unsupported by `cv.md`. | Remove the phrase or replace it with supported evidence. The support check is token-wise, so treat ambiguous cross-context matches conservatively. |
| `PAGE_COUNT` | Word reports more than one page or an invalid count. | Remove the least relevant whole bullet. |
| `PAGE_FIT` | Word did not run and the calibrated estimate overflows. | Remove the least relevant whole bullet, then rerun. |
| `OUTPUT_EXISTS` | The resolved version path already exists. | Resolve the race and build the next unused version; never overwrite. |

## plan.json shape

```json
{
  "report": "<bundle slug from resume:context>",
  "summary": "Two or three concise sentences with limited **emphasis**.",
  "keywords": ["exact JD phrase 1", "exact JD phrase 2", "...8-20 total"],
  "experience": [
    {
      "role_id": "<first role id>",
      "bullets": [
        { "id": "<baseline or pool bullet id>", "text": "Supported wording with **focused emphasis**." }
      ]
    },
    {
      "role_id": "<second role id>",
      "bullets": [
        { "id": "<baseline or pool bullet id>", "text": "Supported wording with a **supported outcome**." }
      ]
    }
  ],
  "skills": [
    { "label": "AI Infrastructure", "items": ["AI agents", "RAG"] },
    { "label": "Languages", "items": ["Go", "Python"] }
  ],
  "rationale": "Why these swaps and this order fit the JD.",
  "gaps": ["What the CV does not establish."]
}
```

Every source role appears in `cv.md` order with at least one bullet. Bullet IDs and skill items must
come from the context output. Labels are free text. Omit a bullet's `text` only when retaining its
source wording and the baseline emphasis is not needed; normally keep the baseline's marked text.
