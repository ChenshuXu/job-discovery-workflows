import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempDisposableSync, mkdtempSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  analyzeDocumentXml, markedParagraphText, readDocxEntry, renderDocx, renderDocumentXml,
} from '../src/resume/render-docx.mjs';

const source = {
  summary: 'Synthetic summary.',
  roles: [{ id: 'acme', heading: 'Engineer, Acme | Remote', bullets: [
    { id: 'acme-01', text: 'Built service one.' }, { id: 'acme-02', text: 'Built service two.' },
  ] }],
  skills: [{ label: 'Languages', items: ['Go'] }, { label: 'Systems', items: ['APIs'] }],
};

const p = (text, options = {}) => `<w:p>${options.pPr ?? '<w:pPr><w:spacing w:after="4"/><w:rPr><w:sz w:val="21"/></w:rPr></w:pPr>'}<w:r><w:rPr>${options.bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="21"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const bullet = (text) => p(text, { pPr: '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="32"/><w:ind w:left="360"/><w:rPr><w:sz w:val="21"/></w:rPr></w:pPr>' });
const documentXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${p('SYNTHETIC PERSON', { bold: true })}${p('PROFESSIONAL SUMMARY')}${p('Synthetic summary.')}${p('PROFESSIONAL EXPERIENCE')}${p('Engineer, Acme | RemoteJan 2020 - Present')}${bullet('Built service one.')}${bullet('Built service two.')}${p('TECHNICAL SKILLS')}${p('Languages: Go')}${p('Systems: APIs')}${p('EDUCATION')}${p('Synthetic University')}<w:sectPr><w:pgSz w:w="12225" w:h="15810"/><w:pgMar w:top="738" w:right="719" w:bottom="719" w:left="719"/></w:sectPr></w:body></w:document>`;

function writeTestDocx(outputPath, entries) {
  using work = mkdtempDisposableSync(resolve(tmpdir(), 'resume-docx-fixture-'));
  for (const [name, data] of entries) {
    const path = resolve(work.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  execFileSync('/usr/bin/zip', ['-q', resolve(outputPath), ...entries.map(([name]) => name)], { cwd: work.path });
}

function docxEntryNames(path) {
  return execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
}

test('synthetic renderer preserves static paragraphs, sectPr, and all non-document entries', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'resume-render-test-'));
  const template = resolve(dir, 'template.docx');
  const output = resolve(dir, 'output.docx');
  writeTestDocx(template, [['word/document.xml', documentXml], ['word/styles.xml', '<styles/>'], ['custom/item.bin', 'same']]);
  const plan = {
    report: 'synthetic', summary: '**Synthetic** summary.',
    experience: [{ role_id: 'acme', bullets: [{ id: 'acme-02', text: 'Built **service two**.' }] }],
    skills: [{ label: 'Core', items: ['Go'] }, { label: 'Interfaces', items: ['APIs'] }], rationale: '', gaps: [],
  };
  const result = renderDocx({ templatePath: template, source, plan, outputPath: output });
  assert.deepEqual(docxEntryNames(output).sort(), docxEntryNames(template).sort());
  for (const name of docxEntryNames(template).filter((entry) => entry !== 'word/document.xml')) {
    assert.ok(readDocxEntry(template, name).equals(readDocxEntry(output, name)));
  }
  const oldStructure = analyzeDocumentXml(documentXml, source);
  const newStructure = analyzeDocumentXml(result.renderedXml, source);
  assert.equal(oldStructure.paragraphs[0].raw, newStructure.paragraphs[0].raw);
  assert.equal(oldStructure.roleGroups[0].headerIndex, newStructure.roleGroups[0].headerIndex);
  assert.equal(oldStructure.paragraphs[oldStructure.roleGroups[0].headerIndex].raw, newStructure.paragraphs[newStructure.roleGroups[0].headerIndex].raw);
  assert.equal(oldStructure.sectPr, newStructure.sectPr);
  assert.equal(newStructure.paragraphs[newStructure.roleGroups[0].bulletIndexes[0]].markedText, 'Built **service two**.');
});

test('template drift is a hard error', () => {
  assert.throws(() => analyzeDocumentXml(documentXml.replace('EDUCATION', 'OTHER'), source), /TEMPLATE_DRIFT section EDUCATION/);
});

test('replacement-like dollar sequences survive DOCX rendering verbatim', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'resume-dollar-test-'));
  const template = resolve(dir, 'template.docx');
  const output = resolve(dir, 'output.docx');
  writeTestDocx(template, [['word/document.xml', documentXml]]);
  const special = "Built $' and $& and $` and $15M without corruption.";
  const plan = {
    report: 'synthetic', summary: 'Synthetic summary.',
    experience: [{ role_id: 'acme', bullets: [{ id: 'acme-01', text: special }] }],
    skills: source.skills, rationale: '', gaps: [],
  };
  renderDocx({ templatePath: template, source, plan, outputPath: output });
  const renderedXml = readDocxEntry(output, 'word/document.xml').toString('utf8');
  const structure = analyzeDocumentXml(renderedXml, source);
  assert.equal(structure.paragraphs[structure.roleGroups[0].bulletIndexes[0]].text, special);
});

test('bCs-only runs are not interpreted as Latin bold', () => {
  assert.equal(markedParagraphText('<w:p><w:r><w:rPr><w:bCs/></w:rPr><w:t>Latin</w:t></w:r></w:p>'), 'Latin');
});

test('explicit false bold values preserve plain text and select the plain run formatting', () => {
  for (const value of ['0', 'false', 'off']) {
    const paragraph = `<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Bold </w:t></w:r><w:r><w:rPr><w:b w:val="${value}"/><w:u w:val="single"/></w:rPr><w:t>plain</w:t></w:r></w:p>`;
    assert.equal(markedParagraphText(paragraph), '**Bold **plain');
    const result = renderDocumentXml(documentXml.replace(p('Synthetic summary.'), paragraph), source, {
      summary: 'Plain summary.', experience: [{ bullets: [{ id: 'acme-01' }] }], skills: source.skills,
    });
    const structure = analyzeDocumentXml(result.xml, source);
    const rendered = structure.paragraphs[structure.summaryIndex];
    assert.equal(rendered.markedText, 'Plain summary.');
    assert.match(rendered.raw, /<w:u w:val="single"\/>/);
    assert.doesNotMatch(rendered.raw, /<w:i\/>/);
  }
});

test('unsupported nested paragraph constructs fail before writing output', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'resume-nested-test-'));
  const template = resolve(dir, 'template.docx');
  const output = resolve(dir, 'output.docx');
  const nested = documentXml.replace('<w:sectPr>', '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr>');
  writeTestDocx(template, [['word/document.xml', nested]]);
  assert.throws(() => renderDocx({
    templatePath: template,
    source,
    plan: { report: 'synthetic', summary: source.summary, experience: [{ role_id: 'acme', bullets: [{ id: 'acme-01' }] }], skills: source.skills, rationale: '', gaps: [] },
    outputPath: output,
  }), /TEMPLATE_DRIFT unsupported construct: <w:tbl>/);
  assert.equal(existsSync(output), false);
});
