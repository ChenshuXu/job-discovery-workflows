import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractNumberTokens, normalizeSpace, stripEmphasis } from './cv-source.mjs';

function bulletMap(plan) {
  return new Map(plan.experience.flatMap((role) => role.bullets.map((bullet) => [bullet.id, bullet])));
}

export function generateChangesMarkdown({
  resolved, source, baseline, plan, fit, pageCount,
  coverage = { hit: [], miss: [], gap: [], unverified: [] },
}) {
  const selected = bulletMap(plan);
  const baselineSelected = bulletMap(baseline);
  const sourceById = new Map(source.roles.flatMap((role) => role.bullets.map((bullet) => [bullet.id, bullet])));
  const kept = [...baselineSelected.keys()].filter((id) => selected.has(id));
  const swappedOut = [...baselineSelected.keys()].filter((id) => !selected.has(id));
  const swappedIn = [...selected.keys()].filter((id) => !baselineSelected.has(id));
  const rewritten = [...selected.values()].filter((bullet) => bullet.text !== undefined
    && normalizeSpace(stripEmphasis(bullet.text)) !== normalizeSpace(sourceById.get(bullet.id)?.text));

  const lines = [`# Tailoring Notes — ${resolved.company} ${resolved.role}`, '', '## Selection vs template baseline', ''];
  lines.push(`Retained ${kept.length}/${baselineSelected.size} baseline bullets; selected ${selected.size} total.`);
  lines.push(`- Swapped out: ${swappedOut.join(', ') || 'None'}`);
  lines.push(`- Swapped in: ${swappedIn.join(', ') || 'None'}`);
  lines.push(`- Rewritten: ${rewritten.map((bullet) => bullet.id).join(', ') || 'None'}`);
  for (const rolePlan of plan.experience) {
    lines.push(`- ${rolePlan.role_id} order: ${rolePlan.bullets.map((bullet) => bullet.id).join(', ')}`);
  }

  lines.push('', '## Retained metrics', '');
  const metrics = [];
  for (const rolePlan of plan.experience) for (const bullet of rolePlan.bullets) {
    const sourceBullet = sourceById.get(bullet.id);
    const text = bullet.text ?? sourceBullet.text;
    for (const token of extractNumberTokens(text)) metrics.push(`- ${token} — ${bullet.id}`);
  }
  lines.push(...(metrics.length ? metrics : ['- None']));

  lines.push('', '## Skills', '');
  const originalItems = baseline.skills.flatMap((row) => row.items);
  const currentItems = plan.skills.flatMap((row) => row.items);
  lines.push(`- Labels: ${plan.skills.map((row) => row.label).join(' | ')}`);
  lines.push(`- Removed items: ${originalItems.filter((item) => !currentItems.includes(item)).join(', ') || 'None'}`);
  lines.push(`- Added items: ${currentItems.filter((item) => !originalItems.includes(item)).join(', ') || 'None'}`);
  lines.push(`- Ordered items: ${currentItems.join(', ')}`);

  lines.push('', '## Why', '', normalizeSpace(plan.rationale) || 'Not provided.');
  lines.push('', '## Honest gaps', '');
  lines.push(...(plan.gaps?.length ? plan.gaps.map((gap) => `- ${normalizeSpace(gap)}`) : ['- None identified.']));
  lines.push('', '## JD keyword coverage', '');
  const keywordCount = coverage.hit.length + coverage.miss.length + coverage.gap.length + coverage.unverified.length;
  lines.push(`${keywordCount} keywords · ${coverage.hit.length} hit · ${coverage.miss.length} miss · ${coverage.gap.length} gap · ${coverage.unverified.length} unverified`);
  lines.push('', `- HIT        (in resume)                  : ${coverage.hit.join('; ') || 'None'}`);
  lines.push(`- MISS       (in cv.md, not in this resume): ${coverage.miss.join('; ') || 'None'}`);
  lines.push(`- GAP        (not in cv.md)               : ${coverage.gap.join('; ') || 'None'}`);
  lines.push(`- UNVERIFIED (not a literal JD phrase)     : ${coverage.unverified.join('; ') || 'None'}`);
  lines.push('', '## Layout', '');
  lines.push(`- Estimated lines: ${fit.estimated_lines}/${fit.capacity}; overflow ${fit.overflow_lines}.`);
  lines.push(pageCount.status === 'PASS' ? `- PAGE_COUNT: ${pageCount.pages}` : `- PAGE_COUNT: NOT RUN — ${pageCount.reason}`);
  lines.push('');
  return lines.join('\n');
}

export function writeBundle({ resolved, source, baseline, plan, docxBuffer, fit, pageCount, coverage }) {
  if (existsSync(resolved.targetPath)) throw new Error(`OUTPUT_EXISTS ${resolved.targetPath}`);
  const changes = generateChangesMarkdown({ resolved, source, baseline, plan, fit, pageCount, coverage });
  mkdirSync(dirname(resolved.targetPath), { recursive: true });
  mkdirSync(resolved.targetPath, { recursive: false });
  writeFileSync(resolve(resolved.targetPath, 'cv.docx'), docxBuffer);
  writeFileSync(resolve(resolved.targetPath, 'changes.md'), changes);
  return { targetPath: resolved.targetPath, changes };
}
