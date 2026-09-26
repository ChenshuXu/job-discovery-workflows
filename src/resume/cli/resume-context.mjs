import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCvSource } from '../cv-source.mjs';
import { tailoringReportSections } from '../jd-keywords.mjs';
import { resolveReport } from '../resolve-report.mjs';
import { buildTemplateBaseline } from '../template-baseline.mjs';

const query = process.argv.slice(2).join(' ').trim();
if (!query) throw new Error('Usage: npm run resume:context -- <report query>');
const resolved = resolveReport(query);
const source = loadCvSource();
const baseline = buildTemplateBaseline({ templatePath: resolve('assets/cv-template.docx'), source });
const report = readFileSync(resolved.reportPath, 'utf8');
const sections = tailoringReportSections(report);
const baselineIds = new Set(baseline.experience.flatMap((role) => role.bullets.map((bullet) => bullet.id)));

const lines = [
  `BUNDLE ${resolved.bundle}`,
  `NEXT_VERSION ${resolved.version}`,
  `JD ${resolved.jdPath}`,
  `REPORT ${resolved.reportPath}`,
  '',
  '## TEMPLATE BASELINE — source-matched; validate page fit with resume:template',
  baseline.summary,
  '',
];
for (const rolePlan of baseline.experience) {
  const role = source.roles.find((candidate) => candidate.id === rolePlan.role_id);
  lines.push(`[${role.id}] ${role.heading}`);
  for (const bullet of rolePlan.bullets) lines.push(`${bullet.id}  ${bullet.text}`);
}
lines.push('');
for (const row of baseline.skills) lines.push(`${row.label}: ${row.items.join(', ')}`);
lines.push(
  '',
  'Start here. Keep this structure; swap, reorder, and rewrite only what this JD demands.',
  '',
  '## BULLET POOL (cv.md)',
);
for (const role of source.roles) {
  lines.push(`[${role.id}] ${role.heading}`);
  for (const bullet of role.bullets) {
    lines.push(`${bullet.id}${baselineIds.has(bullet.id) ? ' [in baseline]' : ''}  ${bullet.text}`);
  }
}
lines.push('', '## SKILLS (items must come from these exact source items)');
for (const row of source.skills) lines.push(`${row.label}: ${row.items.join(', ')}`);
for (const [title, body] of Object.entries(sections)) lines.push('', `## REPORT ${title}`, body);
process.stdout.write(`${lines.join('\n')}\n`);
