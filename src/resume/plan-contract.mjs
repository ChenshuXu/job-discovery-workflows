import { extractNumberTokens, normalizeSpace } from './cv-source.mjs';
import { classifyCoverage } from './jd-keywords.mjs';

const normalizeToken = (value) => normalizeSpace(value).toLowerCase();

function violation(list, gate, locator, actual, expected) {
  list.push(`${gate} ${locator}: ${actual} ← ${expected}`);
}

export function emphasisCount(value) {
  const markers = String(value ?? '').match(/\*\*/g)?.length ?? 0;
  return { paired: markers % 2 === 0, segments: Math.floor(markers / 2) };
}

function validateEmphasis(violations, locator, value, limit = undefined) {
  const count = emphasisCount(value);
  if (!count.paired) violation(violations, 'STRUCTURE', locator, 'unpaired **', 'paired emphasis markers');
  if (limit !== undefined && count.segments > limit) {
    violation(violations, 'STRUCTURE', locator, `${count.segments} emphasis segments`, `at most ${limit}`);
  }
}

function multisetSubset(actual, expected) {
  const counts = new Map();
  expected.forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
  return actual.filter((token) => {
    const count = counts.get(token) ?? 0;
    if (!count) return true;
    counts.set(token, count - 1);
    return false;
  });
}

function validateNumbers(violations, locator, value, allowedNumbers) {
  const actual = extractNumberTokens(value);
  for (const token of multisetSubset(actual, allowedNumbers)) {
    violation(violations, 'NUMBER', locator, token, `subset of [${allowedNumbers.join(', ')}]`);
  }
}

export function validatePlan(plan, source, resolved = undefined, baseline = undefined) {
  const violations = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('STRUCTURE plan: invalid ← JSON object');
  if (resolved && plan.report !== resolved.bundle) violation(violations, 'STRUCTURE', 'report', plan.report, resolved.bundle);
  if (typeof plan.report !== 'string' || !plan.report) violation(violations, 'STRUCTURE', 'report', plan.report, 'non-empty report slug');
  if (typeof plan.summary !== 'string' || !plan.summary.trim()) violation(violations, 'STRUCTURE', 'summary', plan.summary, 'non-empty string');
  else {
    validateEmphasis(violations, 'summary', plan.summary, 4);
    validateNumbers(violations, 'summary', plan.summary, source.vocabulary.numbers_all);
  }

  if (!Array.isArray(plan.keywords)) {
    violation(violations, 'STRUCTURE', 'keywords', typeof plan.keywords, 'array of 8-20 exact JD phrases');
  } else {
    if (plan.keywords.length < 8 || plan.keywords.length > 20) {
      violation(violations, 'STRUCTURE', 'keywords.length', plan.keywords.length, '8-20 exact JD phrases');
    }
    const seenKeywords = new Set();
    plan.keywords.forEach((keyword, keywordIndex) => {
      const locator = `keywords[${keywordIndex}]`;
      if (typeof keyword !== 'string' || !keyword.trim()) {
        violation(violations, 'STRUCTURE', locator, keyword, 'non-empty string');
        return;
      }
      const normalized = normalizeToken(keyword);
      if (seenKeywords.has(normalized)) violation(violations, 'STRUCTURE', locator, keyword, 'unique keyword');
      seenKeywords.add(normalized);
    });
  }

  if (!Array.isArray(plan.experience)) violation(violations, 'STRUCTURE', 'experience', typeof plan.experience, 'array');
  const experience = Array.isArray(plan.experience) ? plan.experience : [];
  if (experience.length !== source.roles.length) violation(violations, 'STRUCTURE', 'experience.length', experience.length, source.roles.length);
  const baselineText = new Map((baseline?.experience ?? []).flatMap((role) =>
    role.bullets.map((bullet) => [bullet.id, normalizeSpace(bullet.text ?? '')])));
  const seenRoles = new Set();
  const seenBullets = new Set();
  source.roles.forEach((role, roleIndex) => {
    const rolePlan = experience[roleIndex];
    if (!rolePlan) return;
    if (rolePlan.role_id !== role.id) violation(violations, 'STRUCTURE', `experience[${roleIndex}].role_id`, rolePlan.role_id, role.id);
    if (seenRoles.has(rolePlan.role_id)) violation(violations, 'STRUCTURE', `experience[${roleIndex}].role_id`, rolePlan.role_id, 'unique role_id');
    seenRoles.add(rolePlan.role_id);
    if (!Array.isArray(rolePlan.bullets) || rolePlan.bullets.length < 1) {
      violation(violations, 'STRUCTURE', `experience[${roleIndex}].bullets`, rolePlan.bullets?.length ?? typeof rolePlan.bullets, 'at least 1 bullet');
      return;
    }
    const sourceById = new Map(role.bullets.map((bullet) => [bullet.id, bullet]));
    rolePlan.bullets.forEach((bullet, bulletIndex) => {
      const locator = `experience[${roleIndex}].bullets[${bulletIndex}]`;
      const original = sourceById.get(bullet?.id);
      if (!original) violation(violations, 'STRUCTURE', `${locator}.id`, bullet?.id, `bullet id from role ${role.id}`);
      if (seenBullets.has(bullet?.id)) violation(violations, 'STRUCTURE', `${locator}.id`, bullet?.id, 'unique bullet id');
      seenBullets.add(bullet?.id);
      if (bullet?.text !== undefined && typeof bullet.text !== 'string') violation(violations, 'STRUCTURE', `${locator}.text`, typeof bullet.text, 'string or omitted');
      if (typeof bullet?.text === 'string' && original) {
        const inherited = baselineText.get(bullet.id) === normalizeSpace(bullet.text);
        validateEmphasis(violations, `${locator}.text`, bullet.text, inherited ? undefined : 3);
        validateNumbers(violations, `${locator}.text`, bullet.text, source.vocabulary.numbers_by_bullet[original.id] ?? []);
      }
    });
  });

  if (!Array.isArray(plan.skills) || plan.skills.length < 2) violation(violations, 'STRUCTURE', 'skills', plan.skills?.length ?? typeof plan.skills, 'at least 2 rows');
  const skillVocabulary = new Set(source.vocabulary.skill_items.map(normalizeToken));
  (Array.isArray(plan.skills) ? plan.skills : []).forEach((row, rowIndex) => {
    if (typeof row?.label !== 'string' || !row.label.trim()) violation(violations, 'STRUCTURE', `skills[${rowIndex}].label`, row?.label, 'non-empty string');
    if (!Array.isArray(row?.items) || row.items.length < 1) {
      violation(violations, 'STRUCTURE', `skills[${rowIndex}].items`, row?.items?.length ?? typeof row?.items, 'at least 1 item');
      return;
    }
    row.items.forEach((item, itemIndex) => {
      if (!skillVocabulary.has(normalizeToken(item))) violation(violations, 'SKILL', `skills[${rowIndex}].items[${itemIndex}]`, item, 'exact item from cv.md skills');
    });
  });
  if (violations.length) throw new Error(violations.join('\n'));
  return plan;
}

export function validateGapKeywords(resumeText, keywords, cvText) {
  const unsupported = classifyCoverage(keywords, { resumeText: '', cvText }).gap;
  const violations = unsupported.filter((keyword) =>
    classifyCoverage([keyword], { resumeText, cvText: '' }).hit.length > 0
  ).map((keyword) => `GAP_KEYWORD resume text: ${keyword} ← keyword named by the JD but unsupported by cv.md`);
  if (violations.length) throw new Error(violations.join('\n'));
}
