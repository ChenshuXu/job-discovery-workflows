import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCvMarkdown } from '../src/resume/cv-source.mjs';
import { analyzeDocumentXml, renderDocumentXml } from '../src/resume/render-docx.mjs';
import { templateBaselineFromStructure } from '../src/resume/template-baseline.mjs';

// Synthetic paragraphs exercise the baseline without loading any private DOCX or CV.
const source = parseCvMarkdown(`## PROFESSIONAL EXPERIENCE
### Engineer, Acme | Remote
- Built a Python API serving 200 clients.
- Added monitoring.
## TECHNICAL SKILLS
**Languages:** Python
**Systems:** APIs, monitoring`);
const p = (text, bullet = false) => `<w:p>${bullet ? '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>' : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const xml = `<w:document><w:body>${p('PROFESSIONAL SUMMARY')}${p('Backend engineer.')}${p('PROFESSIONAL EXPERIENCE')}${p('Engineer, Acme | Remote')}${p('Built a Python API serving 200 clients.', true)}${p('Added monitoring.', true)}${p('TECHNICAL SKILLS')}${p('Languages: Python')}${p('Systems: APIs, monitoring')}${p('EDUCATION')}${p('Example University')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;

test('synthetic baseline maps exact source IDs and rejects changed template evidence', () => {
  const baseline = templateBaselineFromStructure(analyzeDocumentXml(xml, source), source);
  assert.deepEqual(baseline.experience[0].bullets.map(b => b.id), ['acme-01', 'acme-02']);
  assert.deepEqual(baseline.skills[1].items, ['APIs', 'monitoring']);
  assert.match(renderDocumentXml(xml, source, baseline).xml, /200 clients/);
  const changed = xml.replace('200 clients', '201 clients');
  assert.throws(() => templateBaselineFromStructure(analyzeDocumentXml(changed, source), source), /TEMPLATE_DRIFT/);
});
