import assert from 'node:assert/strict';
import test from 'node:test';
import { enforcePageResult } from '../src/resume/cli/resume-build.mjs';
import { estimateXmlPageFit } from '../src/resume/page-fit.mjs';

const sect = '<w:sectPr><w:pgSz w:w="10000" w:h="10000"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr>';
const para = (text, extra = '') => `<w:p><w:pPr>${extra}<w:rPr><w:sz w:val="20"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;

test('constant-width estimator reports overflow', () => {
  const documentXml = `<w:document><w:body>${Array.from({ length: 50 }, () => para('wide text')).join('')}${sect}</w:body></w:document>`;
  const fit = estimateXmlPageFit({ documentXml });
  assert.ok(fit.overflow_lines > 0);
});

test('build page gate uses Word when available and the estimate otherwise', () => {
  assert.throws(() => enforcePageResult({
    pageCount: { status: 'PASS', pages: 2 }, fit: { overflow_lines: 3 },
  }), /PAGE_COUNT/);
  assert.doesNotThrow(() => enforcePageResult({
    pageCount: { status: 'PASS', pages: 1 }, fit: { overflow_lines: 3 },
  }));
  assert.throws(() => enforcePageResult({
    pageCount: { status: 'NOT RUN', reason: 'disabled' }, fit: { overflow_lines: 2 },
  }), /PAGE_FIT/);
});
