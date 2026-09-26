import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { countWordPages } from '../src/resume/page-count.mjs';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'resume-page-count-test-'));
  const countDir = resolve(root, 'container-documents');
  const docxPath = resolve(root, 'cv.docx');
  writeFileSync(docxPath, 'byte-identical-docx-fixture');
  return { root, countDir, docxPath };
}

test('missing Word container directory returns NOT RUN', () => {
  const { countDir, docxPath } = fixture();
  const result = countWordPages(docxPath, { countDir, runScript: () => assert.fail('runScript must not run') });
  assert.equal(result.status, 'NOT RUN');
});

test('successful injected page count removes the container copy', () => {
  const { countDir, docxPath } = fixture();
  mkdirSync(countDir);
  const result = countWordPages(docxPath, {
    countDir,
    runScript(args) {
      const stagedPath = args.at(-2);
      assert.equal(readFileSync(stagedPath, 'utf8'), readFileSync(docxPath, 'utf8'));
      writeFileSync(
        resolve(countDir, `~$${basename(stagedPath).slice(2)}`),
        'simulated Word owner file',
      );
      return '1';
    },
  });
  assert.deepEqual(result, { status: 'PASS', pages: 1 });
  assert.deepEqual(readdirSync(countDir), []);
});

test('injected script failure returns NOT RUN and removes the container copy', () => {
  const { countDir, docxPath } = fixture();
  mkdirSync(countDir);
  const result = countWordPages(docxPath, {
    countDir,
    runScript(args) {
      const stagedPath = args.at(-2);
      writeFileSync(
        resolve(countDir, `~$${basename(stagedPath).slice(2)}`),
        'simulated Word owner file',
      );
      throw new Error('injected failure');
    },
  });
  assert.deepEqual(result, { status: 'NOT RUN', reason: 'injected failure' });
  assert.deepEqual(readdirSync(countDir), []);
});

test('disabled environment never copies or runs a script', () => {
  const { countDir, docxPath } = fixture();
  mkdirSync(countDir);
  let calls = 0;
  const runScript = () => { calls += 1; return '1'; };
  const previous = process.env.RESUME_DISABLE_WORD;
  process.env.RESUME_DISABLE_WORD = '1';
  try {
    assert.equal(countWordPages(docxPath, { countDir, runScript }).status, 'NOT RUN');
  } finally {
    if (previous === undefined) delete process.env.RESUME_DISABLE_WORD;
    else process.env.RESUME_DISABLE_WORD = previous;
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(countDir), []);
});
