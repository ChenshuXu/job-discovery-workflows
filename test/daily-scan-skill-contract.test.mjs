import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCalibrationPrompt } from '../src/check-worker-calibration.mjs';

test('scoring diagnostic uses shared judgment and supplied policy without worker I/O', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-diagnostic-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policy = { local_metros: ['Tacoma'], remote_country: 'United States', require_structured_remote: true, ambiguous_action: 'exclude' };
  const files = ['cv.md', 'config/profile.yml', 'modes/_profile.md'].map(name => path.join(dir, name));
  for (const file of files) mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(files[0], '# Candidate\nBackend engineer.');
  writeFileSync(files[1], `location:\n  scan_policy: ${JSON.stringify(policy)}\n`);
  writeFileSync(files[2], '# Target\nPermanent employment.');
  writeFileSync(path.join(dir, 'modes/_shared.md'), '# Canonical scoring guidance fixture\n');
  mkdirSync(path.join(dir, 'templates'));
  writeFileSync(path.join(dir, 'templates/discard-reasons.yml'), '{"reasons":[{"id":"tech_stack_mismatch","when":"Core stack does not fit."}]}');
  const runtime = { worker: { model: 'test', reasoning_effort: 'medium' } };
  const output = buildCalibrationPrompt({ cases: [] }, runtime, files, { careerRoot: dir });
  assert.ok(output.includes(readFileSync(new URL('../config/worker-scoring.md', import.meta.url), 'utf8')));
  assert.ok(output.includes(JSON.stringify(policy)));
  assert.ok(output.includes('Backend engineer.'));
  assert.doesNotMatch(output, /assignments\.json|merge-worker-results|results\/<worker-id>|CODEX_THREAD_ID/);
});
