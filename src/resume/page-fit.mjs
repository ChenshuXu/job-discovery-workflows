const AVERAGE_ADVANCE_EM = 0.32;
const CAPACITY_FUDGE_LINES = -3;

// Calibrated 2026-08-10 against assets/cv-template.docx in Word: a comfortably
// fitting real draft, the one-page template baseline, and the baseline plus one
// bullet (two pages). Word remains authoritative whenever it is available.

function attr(xml, tag, name, fallback = undefined) {
  const element = xml.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0];
  const value = element?.match(new RegExp(`w:${name}="([^"]+)"`))?.[1];
  return value === undefined ? fallback : Number(value);
}

function textOf(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('');
}

function lineHeightTwips(paragraph, fontHalfPoints) {
  const spacing = paragraph.match(/<w:spacing\b[^>]*\/>/)?.[0] ?? '';
  const line = Number(spacing.match(/w:line="(\d+)"/)?.[1]);
  const rule = spacing.match(/w:lineRule="([^"]+)"/)?.[1];
  if (line) return rule === 'auto' ? (fontHalfPoints / 2) * 20 * (line / 240) : line;
  return (fontHalfPoints / 2) * 20 * 1.15;
}

export function estimateXmlPageFit({ documentXml, stylesXml = '' }) {
  const sectPr = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0];
  if (!sectPr) throw new Error('PAGE_FIT missing sectPr');
  const pageHeight = attr(sectPr, 'pgSz', 'h');
  const top = attr(sectPr, 'pgMar', 'top', 0);
  const bottom = attr(sectPr, 'pgMar', 'bottom', 0);
  const pageWidth = attr(sectPr, 'pgSz', 'w');
  const left = attr(sectPr, 'pgMar', 'left', 0);
  const right = attr(sectPr, 'pgMar', 'right', 0);
  const defaultSize = attr(stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? '', 'sz', 'val', 21);
  const baseLine = lineHeightTwips('', defaultSize === 24 ? 21 : defaultSize);
  let totalTwips = 0;
  let wrappedLines = 0;
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  for (const paragraph of paragraphs) {
    const fontHalfPoints = attr(paragraph, 'sz', 'val', defaultSize);
    const lineHeight = lineHeightTwips(paragraph, fontHalfPoints);
    const indent = attr(paragraph, 'ind', 'left', 0);
    const available = pageWidth - left - right - indent;
    const text = textOf(paragraph);
    const hasTab = /<w:tab\s*\/>/.test(paragraph);
    const measuredTwips = text.length * AVERAGE_ADVANCE_EM * (fontHalfPoints / 2) * 20;
    const lines = hasTab ? 1 : Math.max(1, Math.ceil(measuredTwips / available));
    const spacing = paragraph.match(/<w:spacing\b[^>]*\/>/)?.[0] ?? '';
    const before = Number(spacing.match(/w:before="(\d+)"/)?.[1] ?? 0);
    const after = Number(spacing.match(/w:after="(\d+)"/)?.[1] ?? 0);
    totalTwips += lines * lineHeight + before + after;
    wrappedLines += lines;
  }
  const capacity = Math.max(1, Math.floor((pageHeight - top - bottom) / baseLine) + CAPACITY_FUDGE_LINES);
  const estimatedLines = Math.ceil(totalTwips / baseLine);
  return {
    estimated_lines: estimatedLines,
    capacity,
    overflow_lines: Math.max(0, estimatedLines - capacity + 1),
    wrapped_lines: wrappedLines,
  };
}
