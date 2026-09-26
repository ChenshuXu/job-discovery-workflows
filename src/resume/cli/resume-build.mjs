import { mkdtempDisposableSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_CV_PATH, loadCvSource } from '../cv-source.mjs';
import { resolveReport } from '../resolve-report.mjs';
import { validateGapKeywords, validatePlan } from '../plan-contract.mjs';
import { analyzeDocumentXml, renderDocx } from '../render-docx.mjs';
import { estimateXmlPageFit } from '../page-fit.mjs';
import { countWordPages } from '../page-count.mjs';
import { writeBundle } from '../write-bundle.mjs';
import { classifyCoverage } from '../jd-keywords.mjs';
import { buildTemplateBaseline } from '../template-baseline.mjs';

export function enforcePageResult({ pageCount, fit }) {
  if (pageCount?.status === 'PASS') {
    if (!Number.isInteger(pageCount.pages) || pageCount.pages < 1) throw new Error('PAGE_COUNT invalid Word result');
    if (pageCount.pages > 1) {
      throw new Error(`PAGE_COUNT ${pageCount.pages} pages ← 1; remove at least ${Math.max(1, fit.overflow_lines)} estimated lines`);
    }
  } else if (pageCount?.status === 'NOT RUN') {
    if (fit.overflow_lines > 0) {
      throw new Error(`PAGE_FIT layout: ${fit.overflow_lines} overflow lines ← 0; Word page count NOT RUN — ${pageCount.reason}`);
    }
  } else {
    throw new Error(`PAGE_COUNT invalid result: ${JSON.stringify(pageCount)}`);
  }
}

function renderedTextBlock(renderedXml, source) {
  const structure = analyzeDocumentXml(renderedXml, source);
  const lines = [structure.paragraphs[structure.summaryIndex].markedText];
  structure.roleGroups.forEach((group, roleIndex) => {
    lines.push(`[${source.roles[roleIndex].id}]`);
    for (const paragraphIndex of group.bulletIndexes) {
      lines.push(`- ${structure.paragraphs[paragraphIndex].markedText}`);
    }
  });
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((value) => value !== '--dry-run');
  if (positional.length !== 2) throw new Error('Usage: npm run resume:build -- <report slug> <plan.json> [--dry-run]');
  const [query, planPath] = positional;
  const resolved = resolveReport(query);
  const source = loadCvSource();
  const templatePath = resolve('assets/cv-template.docx');
  const baseline = buildTemplateBaseline({ templatePath, source });
  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
  const jdText = readFileSync(resolved.jdPath, 'utf8');
  validatePlan(plan, source, resolved, baseline);

  using workPath = mkdtempDisposableSync(resolve(tmpdir(), 'career-ops-resume-'));
  const workDocx = resolve(workPath.path, 'cv.docx');
  const rendered = renderDocx({ templatePath, source, plan, outputPath: workDocx });
  const resumeText = [...rendered.renderedXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join(' ');
  const cvText = readFileSync(DEFAULT_CV_PATH, 'utf8');
  validateGapKeywords(resumeText, plan.keywords, cvText);
  const coverage = classifyCoverage(plan.keywords, { resumeText, cvText, jdText });
  const fit = estimateXmlPageFit({ documentXml: rendered.renderedXml, stylesXml: rendered.stylesXml });
  const pageCount = countWordPages(workDocx);
  enforcePageResult({ pageCount, fit });
  const output = dryRun
    ? { dryRun: true, nextTargetPath: resolved.targetPath }
    : writeBundle({ resolved, source, baseline, plan, docxBuffer: rendered.buffer, fit, pageCount, coverage });
  const keywordCount = coverage.hit.length + coverage.miss.length + coverage.gap.length + coverage.unverified.length;
  process.stdout.write(`${keywordCount} keywords · ${coverage.hit.length} hit · ${coverage.miss.length} miss · ${coverage.gap.length} gap · ${coverage.unverified.length} unverified\n`);
  process.stdout.write(`HIT: ${coverage.hit.join('; ') || 'None'}\nMISS: ${coverage.miss.join('; ') || 'None'}\nGAP: ${coverage.gap.join('; ') || 'None'}\nUNVERIFIED: ${coverage.unverified.join('; ') || 'None'}\n`);
  process.stdout.write(`RENDERED TEXT\n${renderedTextBlock(rendered.renderedXml, source)}\n`);
  process.stdout.write(`${JSON.stringify({ ...output, fit, pageCount, coverage }, null, 2)}\n`);
  return { ...output, fit, pageCount, coverage };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
