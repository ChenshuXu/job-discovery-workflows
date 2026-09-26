export const MAX_COMPACT_REPORT_CHARS = 2500;

const COMPACT_HEADINGS = ['## Machine Summary', '## Verdict', '## Evidence', '## Gaps', '## Work Authorization'];
const RISK_VALUES = {
  classification: ['clear', 'flagged', 'not_evaluated'],
  culture: ['pass', 'caution', 'fail', 'not_evaluated'],
  interview_redflags: ['none', 'caution', 'warning', 'not_evaluated'],
  ai_infra: ['consistent', 'mismatch', 'not_evaluated'],
};
const REPORT_FIELDS = ['archetype', 'reason', 'evidence', 'gaps', 'risk_level', 'confidence', 'risk_summary', 'advertised_comp', 'company_confidential_evidence'];
const MACHINE_FIELDS = ['run_id', 'posting_key', 'posting_url', 'company', 'role', 'score', 'legitimacy_tier', 'archetype', 'final_decision', 'hard_stops', 'soft_gaps', 'top_strengths', 'risk_level', 'confidence', 'next_action', 'work_auth', 'discard_reasons', 'via', 'company_confidential', 'advertised_comp', 'risk_summary'];
const CANDIDATE_LOCATORS = ['cv.md/', 'profile.yml/', 'modes/_profile.md/'];
const json = value => JSON.stringify(value).replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const inline = value => String(value).replace(/[\\`*_{}[\]<>#!|~]/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unsupported field ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
}

function text(value, label, limit = 160, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      || (!multiline && /[\r\n\u2028\u2029]/.test(value))) throw new Error(`${label} must be non-empty text of at most ${limit} characters${multiline ? '' : ' on one line'}`);
}

function quote(value, jdText, label) {
  text(value, label, 240, true);
  if (!jdText.includes(value)) throw new Error(`${label}: JD quote is not an exact substring`);
}

function locator(value, label) {
  text(value, label, 100);
  const prefix = CANDIDATE_LOCATORS.find(prefix => value.startsWith(prefix));
  if (!prefix || !value.slice(prefix.length).trim() || /(?:\.\.\/|[\r\n:])/.test(value)
      || CANDIDATE_LOCATORS.some(other => value.slice(prefix.length).includes(other))) throw new Error(`${label}: unsupported source locator`);
}

export function validateStructuredReport(report, { jdText, label = 'report' }) {
  fields(report, REPORT_FIELDS, label);
  if (report.archetype !== null) text(report.archetype, `${label}.archetype`, 80);
  text(report.reason, `${label}.reason`);
  for (const name of ['risk_level', 'confidence']) {
    if (!['Low', 'Medium', 'High'].includes(report[name])) throw new Error(`${label}.${name} must be Low, Medium or High`);
  }
  fields(report.risk_summary, Object.keys(RISK_VALUES), `${label}.risk_summary`);
  for (const [name, values] of Object.entries(RISK_VALUES)) {
    if (!values.includes(report.risk_summary[name])) throw new Error(`${label}.risk_summary.${name} is invalid`);
  }
  if (!Array.isArray(report.evidence) || report.evidence.length < 1 || report.evidence.length > 5) throw new Error(`${label}.evidence must contain 1-5 items`);
  for (const item of report.evidence) {
    if (item?.source === 'jd') {
      fields(item, ['source', 'quote', 'explanation'], `${label}.evidence`);
      quote(item.quote, jdText, `${label}.evidence.quote`);
    } else if (item?.source === 'candidate') {
      fields(item, ['source', 'locator', 'fact', 'explanation'], `${label}.evidence`);
      locator(item.locator, `${label}.evidence.locator`);
      text(item.fact, `${label}.evidence.fact`);
    } else throw new Error(`${label}.evidence has unsupported source`);
    text(item.explanation, `${label}.evidence.explanation`);
  }
  if (!Array.isArray(report.gaps) || report.gaps.length > 3) throw new Error(`${label}.gaps must contain 0-3 items`);
  for (const item of report.gaps) {
    fields(item, ['quote', 'locator', 'explanation'], `${label}.gaps`);
    quote(item.quote, jdText, `${label}.gaps.quote`);
    locator(item.locator, `${label}.gaps.locator`);
    text(item.explanation, `${label}.gaps.explanation`);
  }
  for (const name of ['advertised_comp', 'company_confidential_evidence']) {
    if (report[name] !== null) quote(report[name], jdText, `${label}.${name}`);
  }
  // This only checks source binding; the worker must establish what the quoted
  // passage means, including whether it actually conceals the employer's identity.
  return report;
}

export function discoveryVia(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('acquisition record sources are required for via');
  const names = new Map([['jobspy', 'LinkedIn'], ['ego-browser', 'LinkedIn'], ['jobright', 'Jobright'], ['google-ats-direct', 'Google ATS Direct']]);
  const channels = [...new Set(sources.map(source => names.get(source) ?? String(source).trim()).filter(Boolean))];
  if (!channels.length) throw new Error('acquisition record sources produced no discovery channel for via');
  return channels.join(' + ');
}

export function renderCompactReport({ result, record, runId }) {
  const report = result.report;
  const auth = result.work_authorization;
  for (const [name, value] of Object.entries({ run_id: runId, posting_key: record.primary_key, posting_url: record.primary_url, company: record.company, role: record.title })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${result.posting_key}: report ${name} is required from acquisition/assignment`);
  }
  if (result.posting_key !== record.primary_key) throw new Error(`${result.posting_key}: report identity must equal acquisition`);
  const skipped = result.report_decision === 'Skip';
  const discardReason = result.rationale || result.eligibility_evidence || report.reason;
  const nextAction = skipped ? `Do not apply: ${discardReason}` : result.report_decision === 'Research first'
    ? `Verify ${result.eligibility_category}: ${result.eligibility_evidence}`
    : result.report_decision === 'Consider' ? 'Review posting legitimacy before applying.'
      : 'Verify the official posting is open before applying.';
  const summary = {
    run_id: runId, posting_key: record.primary_key, posting_url: record.primary_url,
    company: record.company, role: record.title, score: result.score,
    legitimacy_tier: result.legitimacy_tier, archetype: report.archetype,
    final_decision: result.report_decision, hard_stops: result.hard_exclusion ? [result.eligibility_category + ': ' + result.eligibility_evidence] : [],
    soft_gaps: report.gaps.map(item => item.explanation),
    top_strengths: report.evidence.map(item => item.explanation),
    risk_level: report.risk_level, confidence: report.confidence, next_action: nextAction,
    work_auth: auth.value, discard_reasons: skipped ? [discardReason] : [], via: discoveryVia(record.sources),
    company_confidential: report.company_confidential_evidence !== null,
    advertised_comp: report.advertised_comp,
  };
  const yaml = Object.entries(summary).map(([key, value]) => `${key}: ${key === 'score' ? Number(value).toFixed(1) : json(value)}`);
  yaml.push('risk_summary:', `  legitimacy: ${json(result.legitimacy_tier.toLowerCase().replaceAll(' ', '_'))}`,
    ...Object.keys(RISK_VALUES).map(key => `  ${key}: ${json(report.risk_summary[key])}`));
  const evidence = report.evidence.map(item => item.source === 'jd'
    ? `- JD: ${inline(json(item.quote))} → ${inline(item.explanation)}`
    : `- ${inline(item.locator)}: ${inline(item.fact)} → ${inline(item.explanation)}`);
  const gaps = report.gaps.map(item => `- JD: ${inline(json(item.quote))}; ${inline(item.locator)} → ${inline(item.explanation)}`);
  const authText = auth.quote ? `JD: ${inline(json(auth.quote))}`
    : auth.value === 'not_needed' ? 'Locked candidate facts state sponsorship is not needed.'
      : 'No decisive sponsorship statement; this is neutral.';
  const markdown = [
    `## Machine Summary\n\n\`\`\`yaml\n${yaml.join('\n')}\n\`\`\``,
    `## Verdict\n\n${Number(result.score).toFixed(1)}/5 — ${result.report_decision}: ${inline(report.reason)}`,
    `## Evidence\n\n${evidence.join('\n')}`,
    `## Gaps\n\n${gaps.length ? gaps.join('\n') : 'No material gaps identified in the supplied evidence.'}`,
    `## Work Authorization\n\n${auth.label} — ${authText}`,
  ].join('\n\n');
  if ([...markdown].length > MAX_COMPACT_REPORT_CHARS) throw new Error(`${result.posting_key}: report exceeds ${MAX_COMPACT_REPORT_CHARS} characters after rendering; shorten semantic text without truncating quotes`);
  return markdown;
}
const FULL_SECTION_SPECS = [
  { canonical: '## Machine Summary', aliases: ['Machine Summary'] },
  { canonical: '## A) Role Summary', aliases: ['A) Role Summary'] },
  { canonical: '## B) Match with CV', aliases: ['B) Match with CV', 'B) CV Match'] },
  { canonical: '## C) Level and Strategy', aliases: ['C) Level and Strategy', 'C) Level and Positioning Strategy'] },
  { canonical: '## D) Comp and Demand', aliases: ['D) Comp and Demand', 'D) Compensation and Demand'] },
  { canonical: '## E) Customization Plan', aliases: ['E) Customization Plan', 'E) Personalization Plan'] },
  { canonical: '## F) Interview Plan', aliases: ['F) Interview Plan'] },
  { canonical: '## G) Posting Legitimacy', aliases: ['G) Posting Legitimacy'] },
  { canonical: '## Risk Summary', aliases: ['Risk Summary'] },
  { canonical: '## Keywords extracted', aliases: ['Keywords extracted', 'Extracted Keywords'] },
];

function headingText(line) {
  const match = String(line).match(/^#{2,4}\s+(.+?)\s*$/);
  return match ? match[1] : null;
}

function sections(markdown, headings, label) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const indexes = headings.map(heading => {
    const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
    if (matches.length === 0) throw new Error(`${label} is missing ${heading}`);
    if (matches.length > 1) throw new Error(`${label} contains duplicate section ${heading}`);
    return matches[0];
  });
  for (let index = 1; index < indexes.length; index += 1) if (indexes[index] <= indexes[index - 1]) throw new Error(`${label} has out-of-order section ${headings[index]}`);
  const extra = lines.filter(line => /^##\s+/.test(line) && !headings.includes(line));
  if (extra.length) throw new Error(`${label} contains unsupported section ${extra[0]}`);
  return Object.fromEntries(headings.map((heading, index) => [heading, lines.slice(indexes[index] + 1, indexes[index + 1] ?? lines.length).join('\n').trim()]));
}

// Expansion reads the renderer's fixed JSON-scalar YAML dialect, never worker prose.
export function readCompactReportSummary(markdown, label = 'compact report') {
  if (typeof markdown !== 'string' || [...markdown.trim()].length > MAX_COMPACT_REPORT_CHARS) throw new Error(`${label} exceeds ${MAX_COMPACT_REPORT_CHARS} characters`);
  const body = sections(markdown, COMPACT_HEADINGS, label);
  const match = body['## Machine Summary'].match(/^```yaml\n([\s\S]+)\n```$/);
  if (!match) throw new Error(`${label} Machine Summary must be one YAML fence`);
  const summary = {};
  for (const line of match[1].split('\n')) {
    if (line === 'risk_summary:') {
      if (summary.risk_summary) throw new Error(`${label} duplicate risk_summary`);
      summary.risk_summary = {};
      continue;
    }
    const field = line.match(/^( {2})?([a-z_]+): (.+)$/);
    const target = field?.[1] ? summary.risk_summary : summary;
    if (!field || !target || Object.hasOwn(target, field[2])) throw new Error(`${label} invalid or duplicate Machine Summary field`);
    target[field[2]] = JSON.parse(field[3]);
  }
  fields(summary, MACHINE_FIELDS, `${label} Machine Summary`);
  fields(summary.risk_summary, ['legitimacy', ...Object.keys(RISK_VALUES)], `${label} risk_summary`);
  for (const name of ['run_id', 'posting_key', 'posting_url', 'company', 'role', 'via']) {
    if (typeof summary[name] !== 'string' || !summary[name].trim()) throw new Error(`${label} missing ${name}`);
  }
  if (typeof summary.score !== 'number' || summary.score < 1 || summary.score > 5) throw new Error(`${label} invalid score`);
  if (summary.archetype !== null) text(summary.archetype, `${label}.archetype`, 80);
  for (const key of ['legitimacy', ...Object.keys(RISK_VALUES)]) if (typeof summary.risk_summary?.[key] !== 'string') throw new Error(`${label} missing risk_summary.${key}`);
  const evidenceCount = (body['## Evidence'].match(/^- /gm) ?? []).length;
  const gapCount = (body['## Gaps'].match(/^- /gm) ?? []).length;
  if (evidenceCount < 1 || evidenceCount > 5 || gapCount > 3) throw new Error(`${label} invalid evidence/gap count`);
  return summary;
}

export function replaceMachineSummaryVia(markdown, via, label = 'report') {
  const matches = String(markdown).match(/^via:\s*.*$/gm) ?? [];
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one top-level via field`);
  return String(markdown).replace(/^via:\s*.*$/m, `via: ${JSON.stringify(String(via))}`);
}

export function normalizeFullReportMarkdown(markdown, label = 'expanded report') {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error(`${label} is required`);
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let lastIndex = -1;
  for (const spec of FULL_SECTION_SPECS) {
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) if (spec.aliases.includes(headingText(lines[index]))) matches.push(index);
    if (matches.length === 0) throw new Error(`${label} is missing ${spec.canonical}`);
    if (matches.length > 1) throw new Error(`${label} contains duplicate section ${spec.canonical}`);
    if (matches[0] <= lastIndex) throw new Error(`${label} has out-of-order section ${spec.canonical}`);
    lines[matches[0]] = spec.canonical;
    lastIndex = matches[0];
  }
  return lines.join('\n').trim();
}

export function requiredScanReportHeadings() { return [...COMPACT_HEADINGS]; }
