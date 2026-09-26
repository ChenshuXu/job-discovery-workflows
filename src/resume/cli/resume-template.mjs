import { resolve } from 'node:path';
import { loadCvSource } from '../cv-source.mjs';
import { buildTemplateBaseline } from '../template-baseline.mjs';
import { readDocxEntry } from '../render-docx.mjs';
import { estimateXmlPageFit } from '../page-fit.mjs';
import { countWordPages } from '../page-count.mjs';
import { enforcePageResult } from './resume-build.mjs';

export function checkTemplate(templatePath = resolve('assets/cv-template.docx'), { source = loadCvSource(), countPages = countWordPages } = {}) {
  const baseline = buildTemplateBaseline({ templatePath, source });
  const fit = estimateXmlPageFit({
    documentXml: readDocxEntry(templatePath, 'word/document.xml').toString('utf8'),
    stylesXml: readDocxEntry(templatePath, 'word/styles.xml', false)?.toString('utf8') ?? '',
  });
  const pageCount = countPages(templatePath);
  enforcePageResult({ pageCount, fit });
  return { template: resolve(templatePath), structure: 'PASS', roles: baseline.experience.length, pageCount, fit, visual_review: 'required' };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.length > 3) throw new Error('Usage: npm run resume:template -- [template.docx]');
  console.log(JSON.stringify(checkTemplate(process.argv[2]), null, 2));
}
