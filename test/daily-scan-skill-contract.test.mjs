import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCalibrationPrompt } from '../src/check-worker-calibration.mjs';
import { fileURLToPath } from 'node:url';

const root = new URL('../.agents/skills/career-ops-daily-linkedin-scan/', import.meta.url);
const skill = readFileSync(new URL('SKILL.md', root), 'utf8');
const reference = readFileSync(new URL('references/workflow-contract.md', root), 'utf8');
const prompt = readFileSync(new URL('../config/worker-prompt.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const calibration = JSON.parse(readFileSync(new URL('fixtures/worker-calibration-cases.json', import.meta.url), 'utf8'));

function includesAll(source, tokens, label) {
  for (const token of tokens) assert.ok(source.includes(token), `${label} is missing ${token}`);
}

test('daily-scan entrypoints retain required commands and frozen runtime interfaces', () => {
  includesAll(skill + reference, [
    'daily-scan:sources', 'daily-scan:baseline', 'daily-scan:usage',
    'src/commit-scan.mjs', 'src/combine.mjs', 'src/run-contract.mjs',
    'src/resolve-canonical-urls.mjs', 'src/plan-scan-evaluations.mjs',
    'runtime.scheduler.max_active_workers', 'runtime.scheduler.batch_size',
    'runtime.reporting.full_report_threshold', 'runtime.failure.per_job_retry_limit',
    'receipt.json', 'assignments.json',
  ], 'workflow');
  includesAll(prompt, [
    "posting_key.replace(/[^A-Za-z0-9._-]/g, '-')",
    'runs/<run-id>/jobs/<safeKey>.md', 'assignments.json.location_policy',
    'runtime.scheduler.batch_size', 'runtime.reporting.full_report_threshold',
    'runtime.failure.per_job_retry_limit', 'result_schema_version',
    '--validate-through-part', '--fail-key', '--no-repair-reason',
  ], 'worker');
});

test('daily-scan scripts use the registry runner and retain Jobright coverage', () => {
  assert.equal(packageJson.scripts['daily-scan:baseline'], 'node src/prepare-daily-scan.mjs');
  assert.equal(packageJson.scripts['daily-scan:sources'], 'node src/run-adapters.mjs');
  assert.equal(packageJson.scripts['daily-scan:usage'], 'node src/scan-usage.mjs');
  assert.match(packageJson.scripts['test:daily-scan'], /(?:^|\s)test\/jobright-recommendations\.test\.mjs(?:\s|$)/);
});

test('workflow routes and local section links resolve without fixing the document layout', () => {
  const documents = [new URL('SKILL.md', root), new URL('references/workflow-contract.md', root),
    ...['worker-prompt.md', 'worker-scoring.md', 'report-contract.md'].map(name => new URL(`../config/${name}`, import.meta.url))];
  for (const document of documents) {
    const contents = readFileSync(document, 'utf8');
    for (const [, href] of contents.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(href)) continue;
      const target = new URL(href, document);
      assert.ok(existsSync(fileURLToPath(target)), `missing reference: ${href}`);
      if (target.hash) {
        const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)]
          .map(([, title]) => title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
        assert.ok(headings.includes(decodeURIComponent(target.hash.slice(1))), `missing section: ${href}`);
      }
    }
  }
});

test('scoring diagnostic uses shared judgment and supplied policy without worker I/O', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-diagnostic-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policy = { local_metros: ['Tacoma'], remote_country: 'United States', require_structured_remote: true, ambiguous_action: 'exclude' };
  const files = ['cv.md', 'profile.yml', '_profile.md'].map(name => path.join(dir, name));
  writeFileSync(files[0], '# Candidate\nBackend engineer.');
  writeFileSync(files[1], `location:\n  scan_policy: ${JSON.stringify(policy)}\n`);
  writeFileSync(files[2], '# Target\nPermanent employment.');
  const runtime = { worker: { model: 'test', reasoning_effort: 'medium' } };
  const output = buildCalibrationPrompt({ cases: [] }, runtime, files);
  assert.ok(output.includes(readFileSync(new URL('../config/worker-scoring.md', import.meta.url), 'utf8')));
  assert.ok(output.includes(JSON.stringify(policy)));
  assert.ok(output.includes('Backend engineer.'));
  assert.doesNotMatch(output, /assignments\.json|merge-worker-results|results\/<worker-id>|CODEX_THREAD_ID/);
});

test('worker calibration cases remain scoreable', () => {
  assert.equal(calibration.schema_version, 2);
  assert.ok(calibration.cases.length > 0);
  for (const item of calibration.cases) {
    assert.ok(existsSync(fileURLToPath(new URL(`fixtures/${item.jd_path}`, import.meta.url))), `missing JD ${item.jd_path}`);
    assert.equal(typeof item.expected.hard_exclusion, 'boolean');
    assert.ok(item.expected.score_min >= 1 && item.expected.score_max <= 5 && item.expected.score_min <= item.expected.score_max);
  }
});

test('compact report contract stays small and excludes downstream workflows', () => {
  const contract = readFileSync(new URL('../config/report-contract.md', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(contract) <= 4000, 'report contract must be at most 4KB');
  includesAll(contract, [
    '## Machine Summary', '## Verdict', '## Evidence', '## Gaps', '## Work Authorization',
    'Worker `report` is a JSON object', '"source":"jd"', '"source":"candidate"',
    'Evidence: **1–5**', 'Gaps: **0–3**',
    'continuous exact JD quote', 'SHA-256-locked files',
    'Code checks shape and quote occurrence, supplies labels, and never reclassifies JD meaning.',
    'The merger rejects v2/v3',
  ], 'report contract');
  assert.doesNotMatch(contract, /generate (?:a )?PDF|tracker TSV|write (?:the )?database|submit (?:an )?application/i);
});
