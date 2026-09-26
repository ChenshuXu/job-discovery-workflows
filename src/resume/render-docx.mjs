import {
  copyFileSync, mkdirSync, mkdtempDisposableSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeSpace } from './cv-source.mjs';

const SECTION_TITLES = ['PROFESSIONAL SUMMARY', 'PROFESSIONAL EXPERIENCE', 'TECHNICAL SKILLS', 'EDUCATION'];
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const DOCUMENT_ENTRY = 'word/document.xml';

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlUnescape(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function readDocxEntry(docxPath, entryName, required = true) {
  try {
    return execFileSync('/usr/bin/unzip', ['-p', resolve(docxPath), entryName], {
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (!required) return null;
    throw new Error(`DOCX entry unavailable: ${entryName}`, { cause: error });
  }
}

export function replaceDocumentXml(templatePath, outputPath, documentXml) {
  const output = resolve(outputPath);
  using work = mkdtempDisposableSync(resolve(dirname(output), '.resume-docx-'));
  const entryPath = resolve(work.path, DOCUMENT_ENTRY);
  const archivePath = resolve(work.path, basename(output));
  mkdirSync(dirname(entryPath), { recursive: true });
  execFileSync('/usr/bin/unzip', ['-qq', resolve(templatePath), DOCUMENT_ENTRY, '-d', work.path]);
  const { atime, mtime } = statSync(entryPath);
  writeFileSync(entryPath, documentXml);
  utimesSync(entryPath, atime, mtime);
  copyFileSync(resolve(templatePath), archivePath);
  execFileSync('/usr/bin/zip', ['-q', '-d', archivePath, DOCUMENT_ENTRY]);
  execFileSync('/usr/bin/zip', ['-q', archivePath, DOCUMENT_ENTRY], { cwd: work.path });
  renameSync(archivePath, output);
  return readFileSync(output);
}

function paragraphText(xml) {
  return xmlUnescape([...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join(''));
}

function isBoldRun(xml) {
  const bold = xml.match(/<w:b(?:\s[^>]*)?\/>/)?.[0];
  return Boolean(bold) && !/\bw:val\s*=\s*["'](?:0|false|off)["']/i.test(bold);
}

export function markedParagraphText(xml) {
  const pieces = [];
  for (const match of xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const text = paragraphText(match[0]);
    if (!text) continue;
    const bold = isBoldRun(match[1]);
    pieces.push(bold ? `**${text}**` : text);
  }
  return pieces.join('').replace(/\*\*\*\*/g, '');
}

function paragraphProperty(xml) {
  return xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '';
}

function runProperty(xml, preferBold = false) {
  const runs = [...xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)];
  const chosen = runs.find((match) => isBoldRun(match[1]) === preferBold) ?? runs[0];
  let property = chosen?.[1].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? '';
  property = property.replace(/<w:(?:b|bCs)(?:\s[^>]*)?\/>/g, '');
  if (preferBold) property = `<w:b/><w:bCs/>${property}`;
  return `<w:rPr>${property}</w:rPr>`;
}

function renderRuns(markedText, prototype) {
  const parts = String(markedText).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part) => {
    const bold = part.startsWith('**') && part.endsWith('**');
    const text = bold ? part.slice(2, -2) : part;
    const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
    return `<w:r>${runProperty(prototype, bold)}<w:t${preserve}>${xmlEscape(text)}</w:t></w:r>`;
  }).join('');
}

function renderParagraph(markedText, prototype) {
  return `<w:p>${paragraphProperty(prototype)}${renderRuns(markedText, prototype)}</w:p>`;
}

function renderSkill(row, prototype) {
  const labelText = `${row.label}: `;
  return `<w:p>${paragraphProperty(prototype)}<w:r>${runProperty(prototype, true)}<w:t xml:space="preserve">${xmlEscape(labelText)}</w:t></w:r><w:r>${runProperty(prototype, false)}<w:t>${xmlEscape(row.items.join(', '))}</w:t></w:r></w:p>`;
}

function headingWithoutDate(text) {
  return normalizeSpace(text.replace(new RegExp(`${MONTH}\\s+\\d{4}\\s*-.*$`), ''));
}

export function analyzeDocumentXml(xml, source) {
  const unsupported = ['w:tbl', 'w:txbxContent', 'w:sdt'].find((tag) => new RegExp(`<${tag}(?:\\s|>)`).test(xml));
  if (unsupported) throw new Error(`TEMPLATE_DRIFT unsupported construct: <${unsupported}> — this renderer supports flat-paragraph templates only`);
  const bodyMatch = xml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error('TEMPLATE_DRIFT missing w:body');
  const body = bodyMatch[1];
  const bodyStart = bodyMatch.index + '<w:body>'.length;
  const bodyEnd = bodyStart + body.length;
  const paragraphs = [...body.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((match) => ({
    raw: match[0], text: paragraphText(match[0]), markedText: markedParagraphText(match[0]),
    numbered: /<w:numPr>[\s\S]*?<w:numId\s+w:val="1"\s*\/>[\s\S]*?<\/w:numPr>/.test(match[0]),
    start: match.index, end: match.index + match[0].length,
  }));
  const sectionIndexes = SECTION_TITLES.map((title) => {
    const hits = paragraphs.map((p, index) => normalizeSpace(p.text) === title ? index : -1).filter((index) => index >= 0);
    if (hits.length !== 1) throw new Error(`TEMPLATE_DRIFT section ${title}: expected 1, found ${hits.length}`);
    return hits[0];
  });
  if (!sectionIndexes.every((value, index) => index === 0 || value > sectionIndexes[index - 1])) throw new Error('TEMPLATE_DRIFT section order');
  const [summaryTitle, experienceTitle, skillsTitle, educationTitle] = sectionIndexes;
  if (experienceTitle - summaryTitle !== 2) throw new Error(`TEMPLATE_DRIFT summary slots: expected 1, found ${experienceTitle - summaryTitle - 1}`);
  const roleGroups = [];
  let cursor = experienceTitle + 1;
  while (cursor < skillsTitle) {
    const headerIndex = cursor;
    if (paragraphs[headerIndex].numbered) throw new Error('TEMPLATE_DRIFT experience begins with bullet');
    cursor += 1;
    const bulletIndexes = [];
    while (cursor < skillsTitle && paragraphs[cursor].numbered) bulletIndexes.push(cursor++);
    if (!bulletIndexes.length) throw new Error(`TEMPLATE_DRIFT role has no bullets: ${paragraphs[headerIndex].text}`);
    roleGroups.push({ headerIndex, bulletIndexes });
  }
  if (roleGroups.length !== source.roles.length) throw new Error(`TEMPLATE_DRIFT roles: template ${roleGroups.length} ← cv ${source.roles.length}`);
  roleGroups.forEach((group, index) => {
    const templateHeading = headingWithoutDate(paragraphs[group.headerIndex].text);
    const cvHeading = normalizeSpace(source.roles[index].heading);
    if (templateHeading !== cvHeading) throw new Error(`TEMPLATE_DRIFT role header: ${templateHeading} ← ${cvHeading}`);
  });
  const skillIndexes = Array.from({ length: educationTitle - skillsTitle - 1 }, (_, index) => skillsTitle + 1 + index);
  if (skillIndexes.length < 2) throw new Error(`TEMPLATE_DRIFT skills: expected at least 2, found ${skillIndexes.length}`);
  const sectPr = body.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0];
  if (!sectPr) throw new Error('TEMPLATE_DRIFT missing sectPr');
  return { body, bodyStart, bodyEnd, paragraphs, sectionIndexes, summaryIndex: summaryTitle + 1, roleGroups, skillIndexes, sectPr };
}

export function renderDocumentXml(xml, source, plan) {
  const structure = analyzeDocumentXml(xml, source);
  const replacements = new Map();
  const skips = new Set();
  replacements.set(structure.summaryIndex, renderParagraph(plan.summary, structure.paragraphs[structure.summaryIndex].raw));
  structure.roleGroups.forEach((group, roleIndex) => {
    const rolePlan = plan.experience[roleIndex];
    const prototype = structure.paragraphs[group.bulletIndexes[0]].raw;
    const sourceById = new Map(source.roles[roleIndex].bullets.map((bullet) => [bullet.id, bullet.text]));
    replacements.set(group.bulletIndexes[0], rolePlan.bullets.map((bullet) => renderParagraph(bullet.text ?? sourceById.get(bullet.id), prototype)).join(''));
    group.bulletIndexes.slice(1).forEach((index) => skips.add(index));
  });
  const skillPrototype = structure.paragraphs[structure.skillIndexes[0]].raw;
  replacements.set(structure.skillIndexes[0], plan.skills.map((row) => renderSkill(row, skillPrototype)).join(''));
  structure.skillIndexes.slice(1).forEach((index) => skips.add(index));

  let renderedBody = '';
  let cursor = 0;
  structure.paragraphs.forEach((paragraph, index) => {
    renderedBody += structure.body.slice(cursor, paragraph.start);
    if (!skips.has(index)) renderedBody += replacements.get(index) ?? paragraph.raw;
    cursor = paragraph.end;
  });
  renderedBody += structure.body.slice(cursor);
  return {
    xml: xml.slice(0, structure.bodyStart) + renderedBody + xml.slice(structure.bodyEnd),
    structure,
  };
}

export function renderDocx({ templatePath, source, plan, outputPath }) {
  const documentXml = readDocxEntry(templatePath, DOCUMENT_ENTRY, false);
  if (!documentXml) throw new Error('TEMPLATE_DRIFT missing word/document.xml');
  const originalXml = documentXml.toString('utf8');
  const rendered = renderDocumentXml(originalXml, source, plan);
  const renderedXml = rendered.xml;
  const buffer = replaceDocumentXml(templatePath, outputPath, renderedXml);
  const stylesXml = readDocxEntry(templatePath, 'word/styles.xml', false)?.toString('utf8') ?? '';
  return { buffer, renderedXml, stylesXml };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  throw new Error('Use renderDocx() through the resume build CLI.');
}
