import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAREER_OPS_ROOT = resolve(process.env.CAREER_OPS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../career-ops'));
export const DEFAULT_CV_PATH = resolve(CAREER_OPS_ROOT, 'cv.md');

export function normalizeSpace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function stripEmphasis(value) {
  return String(value ?? '').replace(/\*\*/g, '');
}

export function extractNumberTokens(value) {
  const text = stripEmphasis(value);
  const range = /~?\d+(?:\.\d+)?(?:[KMB])?\s+to\s+~?\d+(?:\.\d+)?(?:[KMB])?(?:\s+(?:peak\s+)?QPS)?/gi;
  const scalar = /~?\d+(?:\.\d+)?(?:[KMB])?(?:\+|%|x)?(?:\s+(?:peak\s+)?QPS)?/gi;
  const tokens = [];
  const occupied = [];
  for (const match of text.matchAll(range)) {
    tokens.push(normalizeSpace(match[0]));
    occupied.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(scalar)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!occupied.some(([a, b]) => start >= a && end <= b)) tokens.push(normalizeSpace(match[0]));
  }
  return tokens;
}

function slugify(value) {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function companyFromHeading(heading) {
  const left = heading.split('|')[0].trim();
  return left.includes(',') ? left.slice(left.lastIndexOf(',') + 1).trim() : left;
}

function companySlug(company) {
  const words = company.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length >= 3) return words.map((word) => word[0]).join('').toLowerCase();
  return slugify(company);
}

function sectionBody(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`CV_SOURCE missing section: ${heading}`);
  const bodyStart = start + marker.length;
  const next = markdown.indexOf('\n## ', bodyStart);
  return markdown.slice(bodyStart, next < 0 ? markdown.length : next).trim();
}

function splitSkillItems(value) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth = Math.max(0, depth - 1);
    else if (value[index] === ',' && depth === 0) {
      items.push(normalizeSpace(value.slice(start, index)));
      start = index + 1;
    }
  }
  items.push(normalizeSpace(value.slice(start)));
  return items.filter(Boolean);
}

export function parseCvMarkdown(markdown) {
  const experience = sectionBody(markdown, 'PROFESSIONAL EXPERIENCE');
  const roleMatches = [...experience.matchAll(/^### (.+)$/gm)];
  if (!roleMatches.length) throw new Error('CV_SOURCE no experience roles found');
  const usedRoleIds = new Map();
  const roles = roleMatches.map((match, index) => {
    const heading = normalizeSpace(match[1]);
    const company = companyFromHeading(heading);
    const base = companySlug(company);
    const sequence = (usedRoleIds.get(base) ?? 0) + 1;
    usedRoleIds.set(base, sequence);
    const id = sequence === 1 ? base : `${base}-${sequence}`;
    const start = match.index + match[0].length;
    const end = roleMatches[index + 1]?.index ?? experience.length;
    const block = experience.slice(start, end);
    const bullets = [...block.matchAll(/^- (.+)$/gm)].map((bullet, bulletIndex) => ({
      id: `${id}-${String(bulletIndex + 1).padStart(2, '0')}`,
      text: normalizeSpace(bullet[1]),
    }));
    if (!bullets.length) throw new Error(`CV_SOURCE role has no bullets: ${heading}`);
    return { id, heading, bullets };
  });

  const skills = sectionBody(markdown, 'TECHNICAL SKILLS').split(/\n+/).filter(Boolean).map((line) => {
    const match = line.match(/^\*\*(.+?):\*\*\s*(.+?)(?:\s{2})?$/);
    if (!match) throw new Error(`CV_SOURCE invalid skill line: ${line}`);
    return { label: normalizeSpace(match[1]), items: splitSkillItems(match[2]) };
  });

  const numbersByBullet = Object.fromEntries(roles.flatMap((role) =>
    role.bullets.map((bullet) => [bullet.id, extractNumberTokens(bullet.text)])));
  return {
    roles,
    skills,
    vocabulary: {
      skill_items: [...new Set(skills.flatMap((row) => row.items))],
      numbers_by_bullet: numbersByBullet,
      numbers_all: [...new Set(extractNumberTokens(markdown))],
    },
  };
}

export function loadCvSource(path = DEFAULT_CV_PATH) {
  return parseCvMarkdown(readFileSync(path, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.stdout.write(`${JSON.stringify(loadCvSource(process.argv[2]), null, 2)}\n`);
}
