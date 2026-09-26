# Third-party notices

Job Discovery's original code and documentation are provided under the [MIT License](LICENSE).

## Included compatibility grammar

`test/daily-scan-rebuild.test.mjs` contains the requisition-note regular expression
from Career-Ops `merge-tracker.mjs`. The upstream source and license were checked at
[`9d9f5d5f5fe0`](https://github.com/career-ops-hq/career-ops/blob/9d9f5d5f5fe0c9076eb39fa15149153437d834bf/merge-tracker.mjs#L293).
The upstream license for that portion follows:

```text
MIT License

Copyright (c) 2026 Santiago Fernández de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Separately installed dependencies

These projects are installed separately and are not included in this export:

| Project | Purpose | Repository license |
| --- | --- | --- |
| [Career-Ops](https://github.com/career-ops-hq/career-ops) | Candidate profile, reports and application tracking | [MIT](https://github.com/career-ops-hq/career-ops/blob/main/LICENSE) |
| [JobSpy](https://github.com/speedyapply/JobSpy) | Job acquisition | [MIT](https://github.com/speedyapply/JobSpy/blob/main/LICENSE) |
| [Ego Lite](https://github.com/citrolabs/ego-lite) | Browser integration | [MIT repository materials](https://github.com/citrolabs/ego-lite/blob/main/LICENSE) |

Each dependency retains its own notices and any additional dependency licenses.
Agent hosts, external Skills, Microsoft Word, SerpAPI and job platforms are also
not bundled; their software and service terms apply separately.

Public ATS domains and the explicitly verified Elastic redirect in the identity parser
are compatibility data, not endorsements. Exported CVs, interview records and scoring
examples are fictional. Original job-search records and captured job descriptions
are not distributed.
