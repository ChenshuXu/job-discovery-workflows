import { normalizeSpace, stripEmphasis } from './cv-source.mjs';
import { analyzeDocumentXml, readDocxEntry } from './render-docx.mjs';

function matchKey(value) {
  return normalizeSpace(stripEmphasis(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')).toLowerCase();
}

export function resolveBaselineBullet(markedText, role, bulletNumber) {
  const key = matchKey(markedText);
  const matches = role.bullets.filter((bullet) => matchKey(bullet.text) === key);
  if (matches.length !== 1) {
    const preview = normalizeSpace(stripEmphasis(markedText)).slice(0, 60);
    throw new Error(`TEMPLATE_DRIFT baseline bullet ${role.id}#${bulletNumber}: ${preview} ← no unique cv.md match`);
  }
  return matches[0];
}

function parseSkillRow(paragraph, rowNumber, source) {
  const text = normalizeSpace(paragraph.text);
  const split = text.indexOf(':');
  if (split < 1) throw new Error(`TEMPLATE_DRIFT skill row ${rowNumber}: ${text.slice(0, 60)} ← Label: items`);
  const vocabulary = [...source.vocabulary.skill_items].sort((a, b) => b.length - a.length);
  const items = [];
  let rest = text.slice(split + 1).trim();
  while (rest.length) {
    const hit = vocabulary.find((item) => rest.toLowerCase().startsWith(item.toLowerCase()));
    if (!hit) {
      throw new Error(`TEMPLATE_DRIFT skill row ${rowNumber}: ${rest.slice(0, 40)} ← exact item from cv.md skills`);
    }
    items.push(hit);
    rest = rest.slice(hit.length).replace(/^\s*,\s*/, '');
  }
  return { label: normalizeSpace(text.slice(0, split)), items };
}

export function templateBaselineFromStructure(structure, source, report = 'template-baseline') {
  return {
    report,
    summary: structure.paragraphs[structure.summaryIndex].markedText,
    keywords: [],
    experience: structure.roleGroups.map((group, roleIndex) => {
      const role = source.roles[roleIndex];
      return {
        role_id: role.id,
        bullets: group.bulletIndexes.map((paragraphIndex, bulletIndex) => {
          const text = structure.paragraphs[paragraphIndex].markedText;
          return { id: resolveBaselineBullet(text, role, bulletIndex + 1).id, text };
        }),
      };
    }),
    skills: structure.skillIndexes.map((paragraphIndex, rowIndex) =>
      parseSkillRow(structure.paragraphs[paragraphIndex], rowIndex + 1, source)),
    rationale: 'Template baseline.',
    gaps: [],
  };
}

export function buildTemplateBaseline({ templatePath, source }) {
  const documentXml = readDocxEntry(templatePath, 'word/document.xml', false);
  if (!documentXml) throw new Error('TEMPLATE_DRIFT missing word/document.xml');
  const structure = analyzeDocumentXml(documentXml.toString('utf8'), source);
  return templateBaselineFromStructure(structure, source);
}
