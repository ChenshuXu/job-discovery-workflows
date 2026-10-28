import { validateChecks } from './validation-diagnostics.mjs';
import { validateResearchCitation, renderResearch } from './scoring-research.mjs';

export const MAX_COMPACT_REPORT_CHARS = 12000;
export const RESULT_SCHEMA_VERSION = 8;
export const HIRING_MANAGER_REVIEW_HEADING = '## Hiring Manager Resume Review';
export const PERM_REPORT_LAYOUT = 'work-authorization-v1';
export const PERM_REFERENCE_HEADING = '### PERM 历史参考（仅供参考）';
const PERM_START = `[perm-history:${PERM_REPORT_LAYOUT}]: #`;
const PERM_END = `[perm-history-end:${PERM_REPORT_LAYOUT}]: #`;
export const MAX_PERM_REFERENCE_CHARS = 20000;
const LEGACY_MAX_COMPACT_REPORT_CHARS = 6000;
const IMPORTANCE_BANDS = ['critical', 'high', 'meaningful', 'preferred', 'low_signal'];

const LEGACY_COMPACT_HEADINGS = ['## Machine Summary', '## Verdict', '## Evidence', '## Gaps', '## Work Authorization'];
const COMPACT_HEADINGS = [...LEGACY_COMPACT_HEADINGS, '## Score Evidence'];
const KEYWORD_COMPACT_HEADINGS = [...COMPACT_HEADINGS, '## Keywords extracted'];
export const SCORE_DIMENSIONS = ['cv_match', 'north_star', 'compensation', 'culture', 'red_flags'];
const DIMENSION_LABELS = ['CV match', 'North Star alignment', 'Compensation', 'Cultural signals', 'Red flags'];
const EVIDENCE_STATUSES = ['supported', 'partial', 'unknown'];
const RISK_VALUES = {
  classification: ['clear', 'flagged', 'not_evaluated'],
  culture: ['pass', 'caution', 'fail', 'not_evaluated'],
  interview_redflags: ['none', 'caution', 'warning', 'not_evaluated'],
  ai_infra: ['consistent', 'mismatch', 'not_evaluated'],
};
const LEGACY_REPORT_FIELDS = ['archetype', 'reason', 'evidence', 'gaps', 'risk_level', 'confidence', 'risk_summary', 'advertised_comp', 'company_confidential_evidence'];
const REPORT_FIELDS = [...LEGACY_REPORT_FIELDS, 'score_evidence', 'confidence_gaps'];
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

function quote(value, jdText, label, source = 'JD') {
  text(value, label, 240, true);
  if (!jdText.includes(value)) throw new Error(`${label}: ${source} quote is not an exact substring; copy one continuous passage without added wrappers, prefixes or joined fragments (score_evidence source keeps only its required JD: prefix).`);
}

function locator(value, label) {
  text(value, label, 100);
  const prefix = CANDIDATE_LOCATORS.find(prefix => value.startsWith(prefix));
  if (!prefix || !value.slice(prefix.length).trim() || /(?:\.\.\/|[\r\n:])/.test(value)
      || CANDIDATE_LOCATORS.some(other => value.slice(prefix.length).includes(other))) throw new Error(`${label}: unsupported source locator`);
}

export function deriveEvidenceConfidence(statuses, { questions = [], eligibilityStatus = 'eligible' } = {}) {
  const values = SCORE_DIMENSIONS.map(key => statuses[key]);
  if (statuses.cv_match === 'unknown' || statuses.north_star === 'unknown'
      || values.filter(value => value === 'unknown').length >= 2 || eligibilityStatus === 'needs_verification') return 'Low';
  return values.some(value => value !== 'supported') || questions.length ? 'Medium' : 'High';
}

function validateConfidenceGaps(gaps, label) {
  if (!Array.isArray(gaps) || gaps.length > 3) throw new Error(`${label} must contain 0-3 concrete checks`);
  for (const gap of gaps) text(gap, label, 160);
  if (new Set(gaps).size !== gaps.length) throw new Error(`${label} contains duplicate checks`);
}

function validateScoreEvidence(report, { jdText, research, eligibilityStatus, label }) {
  fields(report.score_evidence, SCORE_DIMENSIONS, `${label}.score_evidence`);
  const statuses = Object.fromEntries(SCORE_DIMENSIONS.map(key => [key, report.score_evidence[key]?.status]));
  const checks = Object.fromEntries(SCORE_DIMENSIONS.map(key => [key, () => {
    const detail = report.score_evidence[key], name = `${label}.score_evidence.${key}`;
    fields(detail, ['status', 'source', 'observation', 'question'], name);
    validateChecks({
      status: () => { if (!EVIDENCE_STATUSES.includes(detail.status)) throw new Error(`${name}.status is invalid`); },
      observation: () => text(detail.observation, `${name}.observation`, 160),
      source: () => {
        if (detail.source === null) {
          if (detail.status !== 'unknown') throw new Error(`${name}: supported or partial evidence requires a source`);
        } else if (typeof detail.source === 'string' && detail.source.startsWith('JD: ')) quote(detail.source.slice(4), jdText, `${name}.source`);
        else if (typeof detail.source === 'string' && detail.source.startsWith('Research: ')) validateResearchCitation(detail.source, research, key, `${name}.source`);
        else locator(detail.source, `${name}.source`);
      },
      question: () => {
        if (detail.question !== null) text(detail.question, `${name}.question`, 160);
        else if (detail.status !== 'supported') throw new Error(`${name}: partial or unknown evidence requires a concrete question`);
      },
    }, name + '.');
  }]));
  checks.confidence = () => {
    // Confidence depends on a well-shaped evidence set and gap list.
    if (!Array.isArray(report.confidence_gaps) || SCORE_DIMENSIONS.some(key => !report.score_evidence[key]
        || !EVIDENCE_STATUSES.includes(statuses[key]))) return;
    const questions = [...report.confidence_gaps, ...SCORE_DIMENSIONS.map(key => report.score_evidence[key].question).filter(q => q !== null)];
    if ((questions.length || eligibilityStatus === 'needs_verification') && !report.confidence_gaps.length) {
      throw new Error(`${label}.confidence_gaps must name checks for unresolved evidence or eligibility`);
    }
    const confidence = deriveEvidenceConfidence(statuses, { questions, eligibilityStatus });
    if (report.confidence !== confidence) throw new Error(`${label}.confidence must be ${confidence} for the supplied evidence and eligibility`);
  };
  validateChecks(checks, `${label}.score_evidence.`);
}

function validateDiscardReasons(reasons, decision, label) {
  if (!Array.isArray(reasons) || reasons.length > 3 || new Set(reasons).size !== reasons.length) throw new Error(`${label}.discard_reasons must contain 0-3 distinct reasons`);
  for (const reason of reasons) text(reason, `${label}.discard_reasons`);
  if (decision === 'Consider' && !reasons.length) throw new Error(`${label}.discard_reasons requires a reason for Consider`);
  if (['Apply', 'Research first'].includes(decision) && reasons.length) throw new Error(`${label}.discard_reasons must be empty for ${decision}`);
}

export function fixedTermEvidenceLine(evidence) {
  return evidence === null ? 'No fixed term disclosed in the supplied JD.' : `Fixed-term contract: ${inline(json(evidence))}`;
}

function validateKeywords(keywords, jdText, label) {
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 20) throw new Error(`${label} must contain 1-20 JD keywords`);
  const seen = new Set();
  for (const keyword of keywords) {
    text(keyword, label, 80);
    const normalized = keyword.toLowerCase().replace(/\s+/g, ' ');
    if (keyword !== keyword.trim() || /[,\\`*<>\[\]|]/.test(keyword) || keyword.endsWith('.') || seen.has(normalized)) {
      throw new Error(`${label} requires distinct plain-text keywords readable without Markdown escaping or comma splitting`);
    }
    seen.add(normalized);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (jdText !== undefined && !new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(jdText)) {
      throw new Error(`${label}: keyword is not a complete term in the supplied JD: ${keyword}`);
    }
  }
}

function validateRequirementImportance(rows, jdText, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  let previousRank = -1, previousMet = false;
  for (const row of rows) {
    fields(row, ['requirement', 'jd_signal', 'evidence', 'importance', 'match'], label);
    text(row.requirement, `${label}.requirement`, 160, true);
    const key = row.requirement.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) throw new Error(`${label} contains duplicate requirements`);
    seen.add(key);
    if (jdText !== undefined && !jdText.includes(row.requirement)) throw new Error(`${label}.requirement must be an exact JD substring`);
    if (!['stated', 'structural', 'inferred'].includes(row.evidence)
        || !IMPORTANCE_BANDS.includes(row.importance) || !['strong', 'partial', 'missing', 'na'].includes(row.match)) throw new Error(`${label} has invalid evidence, importance or match`);
    if (row.evidence === 'inferred') {
      if (row.jd_signal !== null || ['critical', 'high'].includes(row.importance)) throw new Error(`${label}: inferred requires null jd_signal and importance below high`);
    } else {
      text(row.jd_signal, `${label}.jd_signal`, 240, true);
      if (jdText !== undefined && !jdText.includes(row.jd_signal)) throw new Error(`${label}.jd_signal must be one exact JD substring`);
    }
    const rank = IMPORTANCE_BANDS.indexOf(row.importance), met = ['strong', 'na'].includes(row.match);
    if (rank < previousRank || (rank === previousRank && previousMet && !met)) throw new Error(`${label} must sort by importance, then unmet before met`);
    previousRank = rank; previousMet = met;
  }
  const highCount = rows.filter(row => ['critical', 'high'].includes(row.importance)).length;
  if (rows.length > Math.max(12, highCount)) throw new Error(`${label} exceeds 12 rows except retained critical/high requirements`);
}

function validateHiringManagerReview(review, jdText, resumeText, label) {
  fields(review, ['summary', 'concerns'], label);
  text(review.summary, `${label}.summary`, 240);
  if (!Array.isArray(review.concerns) || review.concerns.length > 3) throw new Error(`${label}.concerns must contain 0-3 concerns`);
  const seen = new Set();
  for (const concern of review.concerns) {
    fields(concern, ['reason', 'jd_quote', 'resume_locator', 'resume_quote', 'evidence_type', 'explanation'], `${label}.concerns`);
    text(concern.reason, `${label}.reason`);
    const key = concern.reason.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) throw new Error(`${label} contains duplicate concerns`);
    seen.add(key);
    quote(concern.jd_quote, jdText, `${label}.jd_quote`);
    locator(concern.resume_locator, `${label}.resume_locator`);
    if (!concern.resume_locator.startsWith('cv.md/')) throw new Error(`${label}.resume_locator must use cv.md/<section>`);
    if (!['documented', 'not_demonstrated'].includes(concern.evidence_type)) throw new Error(`${label}.evidence_type must be documented or not_demonstrated`);
    if (concern.resume_quote === null) {
      if (concern.evidence_type !== 'not_demonstrated') throw new Error(`${label}.resume_quote is required for a documented concern`);
    } else {
      if (typeof resumeText !== 'string') throw new Error(`${label}: locked cv.md content is required`);
      quote(concern.resume_quote, resumeText, `${label}.resume_quote`, 'cv.md');
    }
    text(concern.explanation, `${label}.explanation`, 240);
  }
}

function renderHiringManagerReview(review) {
  const reasons = review.concerns.map((concern, index) => `${index + 1}. ${inline(concern.reason)}`).join('\n');
  const evidence = review.concerns.map((concern, index) => `${index + 1}. **JD 要求：** ${inline(json(concern.jd_quote))}\n`
    + `   - **简历位置：** ${inline(concern.resume_locator)}\n`
    + `   - **简历原文：** ${concern.resume_quote === null ? '未找到可引用的相关表述。' : inline(json(concern.resume_quote))}\n`
    + `   - **证据性质：** ${concern.evidence_type === 'documented' ? '简历明确记载' : '简历未展示（不等于候选人不会）'}\n`
    + `   - **结论依据：** ${inline(concern.explanation)}`).join('\n');
  return `${HIRING_MANAGER_REVIEW_HEADING}\n\n模拟筛选意见，仅基于本次 JD 和简历，不代表公司的真实决定。\n\n`
    + `### 假设你现在是这个岗位的 hiring manager，这是你收到的一份简历。请列出你为什么不会给这个 candidate 面试。\n\n`
    + `${inline(review.summary)}${reasons ? '\n\n' + reasons : ''}\n\n`
    + `### 你为什么会得出这个结论？从我的简历里找依据。\n\n`
    + (evidence || '当前简历与 JD 没有支持明确拒面的证据；不编造拒面理由。');
}

export function validateStructuredReport(report, { jdText, resumeText, requireHiringManagerReview = false, research, eligibilityStatus = 'eligible', legacy = false, schemaVersion = legacy ? 4 : RESULT_SCHEMA_VERSION, decision, label = 'report' }) {
  const hasReview = schemaVersion >= 8 && (requireHiringManagerReview || Object.hasOwn(report ?? {}, 'hiring_manager_review'));
  fields(report, schemaVersion === 4 ? LEGACY_REPORT_FIELDS : schemaVersion === 5 ? REPORT_FIELDS : [...REPORT_FIELDS, 'discard_reasons', 'fixed_term_evidence', ...(schemaVersion >= 7 ? ['keywords'] : []), ...(schemaVersion >= 8 ? ['requirement_importance'] : []), ...(hasReview ? ['hiring_manager_review'] : [])], label);
  const checks = {
    hiring_manager_review: () => { if (hasReview) validateHiringManagerReview(report.hiring_manager_review, jdText, resumeText, `${label}.hiring_manager_review`); },
    discard_reasons: () => { if (schemaVersion >= 6) validateDiscardReasons(report.discard_reasons, decision, label); },
    fixed_term_evidence: () => { if (schemaVersion >= 6 && report.fixed_term_evidence !== null) quote(report.fixed_term_evidence, jdText, `${label}.fixed_term_evidence`); },
    keywords: () => { if (schemaVersion >= 7) validateKeywords(report.keywords, jdText, `${label}.keywords`); },
    requirement_importance: () => { if (schemaVersion >= 8) validateRequirementImportance(report.requirement_importance, jdText, `${label}.requirement_importance`); },
    archetype: () => { if (report.archetype !== null) text(report.archetype, `${label}.archetype`, 80); },
    reason: () => text(report.reason, `${label}.reason`),
    risk_level: () => { if (!['Low', 'Medium', 'High'].includes(report.risk_level)) throw new Error(`${label}.risk_level must be Low, Medium or High`); },
    confidence: () => { if (!['Low', 'Medium', 'High'].includes(report.confidence)) throw new Error(`${label}.confidence must be Low, Medium or High`); },
    risk_summary: () => {
      fields(report.risk_summary, Object.keys(RISK_VALUES), `${label}.risk_summary`);
      for (const [name, values] of Object.entries(RISK_VALUES)) {
        if (!values.includes(report.risk_summary[name])) throw new Error(`${label}.risk_summary.${name} is invalid`);
      }
    },
    evidence: () => {
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
    },
    gaps: () => {
      if (!Array.isArray(report.gaps) || report.gaps.length > 3) throw new Error(`${label}.gaps must contain 0-3 items`);
      for (const item of report.gaps) {
        fields(item, ['quote', 'locator', 'explanation'], `${label}.gaps`);
        quote(item.quote, jdText, `${label}.gaps.quote`);
        locator(item.locator, `${label}.gaps.locator`);
        text(item.explanation, `${label}.gaps.explanation`);
      }
    },
    advertised_comp: () => { if (report.advertised_comp !== null) quote(report.advertised_comp, jdText, `${label}.advertised_comp`); },
    company_confidential_evidence: () => { if (report.company_confidential_evidence !== null) quote(report.company_confidential_evidence, jdText, `${label}.company_confidential_evidence`); },
    confidence_gaps: () => { if (schemaVersion !== 4) validateConfidenceGaps(report.confidence_gaps, `${label}.confidence_gaps`); },
    score_evidence: () => { if (schemaVersion !== 4) validateScoreEvidence(report, { jdText, research, eligibilityStatus, label }); },
  };
  validateChecks(checks, label + '.');
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
  const current = Object.hasOwn(report, 'fixed_term_evidence');
  const skipped = result.report_decision === 'Skip';
  const discardReason = result.rationale || result.eligibility_evidence || report.reason;
  const nextAction = skipped ? `Do not apply: ${discardReason}` : result.report_decision === 'Research first'
    ? `Verify ${result.eligibility_category}: ${result.eligibility_evidence}`
    : result.report_decision === 'Consider' ? 'Review posting legitimacy before applying.'
      : 'Verify the official posting is open before applying.';
  const summary = {
    ...(current ? { result_schema_version: Object.hasOwn(report, 'requirement_importance') ? RESULT_SCHEMA_VERSION : Object.hasOwn(report, 'keywords') ? 7 : 6 } : {}),
    run_id: runId, posting_key: record.primary_key, posting_url: record.primary_url,
    company: record.company, role: record.title, score: result.score,
    legitimacy_tier: result.legitimacy_tier, archetype: report.archetype,
    final_decision: result.report_decision, hard_stops: result.hard_exclusion ? [result.eligibility_category + ': ' + result.eligibility_evidence] : [],
    soft_gaps: report.gaps.map(item => item.explanation),
    top_strengths: report.evidence.map(item => item.explanation),
    risk_level: report.risk_level, confidence: report.confidence, next_action: nextAction,
    work_auth: auth.value, discard_reasons: current ? report.discard_reasons : skipped ? [discardReason] : [], via: discoveryVia(record.sources),
    company_confidential: report.company_confidential_evidence !== null,
    advertised_comp: report.advertised_comp,
    ...(Object.hasOwn(report, 'requirement_importance') ? { requirement_importance: report.requirement_importance } : {}),
    ...(report.score_evidence ? {
      score_evidence: Object.fromEntries(SCORE_DIMENSIONS.map(key => [key, report.score_evidence[key].status])),
      confidence_gaps: report.confidence_gaps,
    } : {}),
  };
  const yaml = Object.entries(summary).map(([key, value]) => `${key}: ${key === 'score' ? Number(value).toFixed(1) : json(value)}`);
  yaml.push('risk_summary:', `  legitimacy: ${json(result.legitimacy_tier.toLowerCase().replaceAll(' ', '_'))}`,
    ...Object.keys(RISK_VALUES).map(key => `  ${key}: ${json(report.risk_summary[key])}`));
  if (current) yaml.push(`  fixed_term: ${json(report.fixed_term_evidence === null ? 'not_detected' : 'detected')}`);
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
    `## Evidence\n\n${evidence.join('\n')}${current ? '\n\n' + fixedTermEvidenceLine(report.fixed_term_evidence) : ''}`,
    `## Gaps\n\n${gaps.length ? gaps.join('\n') : 'No material gaps identified in the supplied evidence.'}`,
    ...(report.hiring_manager_review ? [renderHiringManagerReview(report.hiring_manager_review)] : []),
    `## Work Authorization\n\n${auth.label} — ${authText}`,
    ...(report.score_evidence ? [`## Score Evidence\n\n| Dimension | Status | Source / observation | Unresolved question |\n| --- | --- | --- | --- |\n${SCORE_DIMENSIONS.map((key, index) => {
      const detail = report.score_evidence[key];
      return `| ${DIMENSION_LABELS[index]} | ${detail.status} | ${detail.source === null ? 'No supporting source' : inline(detail.source)}; ${inline(detail.observation)} | ${detail.question === null ? 'None' : inline(detail.question)} |`;
    }).join('\n')}\n\n**Evidence confidence:** ${report.confidence}\n${report.confidence_gaps.map(gap => `- ${inline(gap)}`).join('\n')}${renderResearch(result.research)}`] : []),
    ...(Object.hasOwn(report, 'keywords') ? [`## Keywords extracted\n\n${report.keywords.map(keyword => `- ${keyword}`).join('\n')}`] : []),
  ].join('\n\n');
  const budget = Object.hasOwn(report, 'requirement_importance') ? MAX_COMPACT_REPORT_CHARS : LEGACY_MAX_COMPACT_REPORT_CHARS;
  if ([...markdown].length > budget) throw new Error(`${result.posting_key}: report exceeds ${budget} characters after rendering; shorten semantic text without truncating quotes`);
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

// Expansion reads only the fixed JSON-scalar YAML dialect, never worker prose.
export function readMachineSummary(markdown, label = 'report') {
  if (typeof markdown !== 'string') throw new Error(`${label} is required`);
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((line, index) => line === '## Machine Summary' ? [index] : []);
  if (starts.length !== 1) throw new Error(`${label} must contain exactly one Machine Summary`);
  const end = lines.findIndex((line, index) => index > starts[0] && /^##\s+/.test(line));
  const body = lines.slice(starts[0] + 1, end < 0 ? lines.length : end).join('\n').trim();
  const match = body.match(/^```yaml\n([\s\S]+)\n```$/);
  if (!match) throw new Error(`${label} Machine Summary must be one YAML fence`);
  const summary = {};
  let nested = null;
  for (const line of match[1].split('\n')) {
    const map = line.match(/^(risk_summary|score_evidence):$/);
    if (map) {
      if (Object.hasOwn(summary, map[1])) throw new Error(`${label} duplicate ${map[1]}`);
      nested = map[1];
      summary[nested] = {};
      continue;
    }
    const field = line.match(/^( {2})?([a-z_]+): (.+)$/);
    const target = field?.[1] ? summary[nested] : summary;
    if (!field || !target || Object.hasOwn(target, field[2])) throw new Error(`${label} invalid or duplicate Machine Summary field`);
    const value = JSON.parse(field[3]);
    if (value && typeof value === 'object' && !Array.isArray(value) && json(value) !== field[3]) {
      throw new Error(`${label} object fields must use canonical JSON without duplicate keys`);
    }
    target[field[2]] = value;
    if (!field[1]) nested = null;
  }
  const current = Object.hasOwn(summary, 'score_evidence') || Object.hasOwn(summary, 'confidence_gaps');
  const v6 = Object.hasOwn(summary, 'result_schema_version');
  if (v6 && ![6, 7, RESULT_SCHEMA_VERSION].includes(summary.result_schema_version)) throw new Error(`${label} unsupported result_schema_version`);
  fields(summary, current ? [...MACHINE_FIELDS, 'score_evidence', 'confidence_gaps', ...(v6 ? ['result_schema_version'] : []), ...(summary.result_schema_version >= 8 ? ['requirement_importance'] : [])] : MACHINE_FIELDS, `${label} Machine Summary`);
  if (summary.result_schema_version >= 8) validateRequirementImportance(summary.requirement_importance, undefined, `${label}.requirement_importance`);
  fields(summary.risk_summary, ['legitimacy', ...Object.keys(RISK_VALUES), ...(v6 ? ['fixed_term'] : [])], `${label} risk_summary`);
  for (const name of ['run_id', 'posting_key', 'posting_url', 'company', 'role', 'via']) {
    if (typeof summary[name] !== 'string' || !summary[name].trim()) throw new Error(`${label} missing ${name}`);
  }
  if (typeof summary.score !== 'number' || summary.score < 1 || summary.score > 5) throw new Error(`${label} invalid score`);
  for (const [field, values] of Object.entries({
    legitimacy_tier: ['High Confidence', 'Proceed with Caution', 'Suspicious'],
    final_decision: ['Apply', 'Consider', 'Research first', 'Skip'],
    risk_level: ['Low', 'Medium', 'High'], confidence: ['Low', 'Medium', 'High'],
    work_auth: ['sponsors', 'no_sponsorship', 'unstated', 'needs_verification', 'not_needed'],
  })) if (!values.includes(summary[field])) throw new Error(`${label} invalid ${field}`);
  for (const field of ['hard_stops', 'soft_gaps', 'top_strengths', 'discard_reasons']) {
    if (!Array.isArray(summary[field]) || summary[field].some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${label} invalid ${field}`);
  }
  if (typeof summary.next_action !== 'string' || !summary.next_action.trim()
      || typeof summary.company_confidential !== 'boolean'
      || (summary.advertised_comp !== null && (typeof summary.advertised_comp !== 'string' || !summary.advertised_comp.trim()))) throw new Error(`${label} invalid action or report metadata`);
  if (summary.archetype !== null) text(summary.archetype, `${label}.archetype`, 80);
  if (summary.risk_summary.legitimacy !== summary.legitimacy_tier.toLowerCase().replaceAll(' ', '_')) throw new Error(`${label} risk_summary legitimacy conflicts with tier`);
  for (const [key, values] of Object.entries(RISK_VALUES)) if (!values.includes(summary.risk_summary[key])) throw new Error(`${label} invalid risk_summary.${key}`);
  if (v6) {
    if (!['detected', 'not_detected', 'not_evaluated'].includes(summary.risk_summary.fixed_term)) throw new Error(`${label} invalid risk_summary.fixed_term`);
    validateDiscardReasons(summary.discard_reasons, summary.final_decision, label);
  }
  if (current) {
    fields(summary.score_evidence, SCORE_DIMENSIONS, `${label}.score_evidence`);
    for (const status of Object.values(summary.score_evidence)) if (!EVIDENCE_STATUSES.includes(status)) throw new Error(`${label} invalid score_evidence status`);
    validateConfidenceGaps(summary.confidence_gaps, `${label}.confidence_gaps`);
    const confidence = deriveEvidenceConfidence(summary.score_evidence, { questions: summary.confidence_gaps,
      eligibilityStatus: summary.final_decision === 'Research first' ? 'needs_verification' : 'eligible' });
    if (summary.confidence !== confidence) throw new Error(`${label} confidence contradicts score evidence`);
  }
  return summary;
}

// Only the bounded, delimited suffix inside Work Authorization is separate from scored prose.
export function splitPermHistoryReference(markdown) {
  const headingCount = String(markdown).split(PERM_REFERENCE_HEADING).length - 1;
  if (!headingCount && !String(markdown).includes('[perm-history:') && !String(markdown).includes('[perm-history-end:')) return { markdown, reference: '' };
  const start = markdown.indexOf(`\n\n${PERM_REFERENCE_HEADING}\n\n${PERM_START}\n`);
  const end = markdown.indexOf(PERM_END, start) + PERM_END.length;
  const reference = markdown.slice(start + 2, end);
  const before = markdown.slice(0, start);
  const after = markdown.slice(end);
  const section = before.slice(before.lastIndexOf('\n## ') + 1);
  if (headingCount !== 1 || start < 0 || !reference.endsWith(PERM_END)
      || markdown.split(PERM_START).length !== 2 || markdown.split(PERM_END).length !== 2
      || [...reference].length > MAX_PERM_REFERENCE_CHARS
      || !section.startsWith('## Work Authorization\n\n') || !section.slice('## Work Authorization\n\n'.length).trim()
      || (after.trim() && !after.startsWith('\n\n## '))
      || /^(?:#{1,6}\s|```|---\s*$|<!--)/m.test(reference.split('\n').slice(3, -1).join('\n'))) {
    throw new Error('Invalid PERM reference location, structure, duplication or length');
  }
  return { markdown: before + after, reference };
}

export function appendPermHistoryReference(markdown, reference) {
  if (!reference) return markdown;
  if (splitPermHistoryReference(markdown).reference) throw new Error('Duplicate PERM reference');
  const start = markdown.indexOf('## Work Authorization\n\n');
  if (start < 0) throw new Error('Missing Work Authorization for PERM reference');
  const next = markdown.indexOf('\n\n## ', start);
  const end = next < 0 ? markdown.trimEnd().length : next;
  const output = markdown.slice(0, end) + '\n\n' + reference.trim() + markdown.slice(end);
  if (splitPermHistoryReference(output).reference !== reference.trim()) throw new Error('Invalid PERM reference');
  return output;
}

export function readCompactReportSummary(markdown, label = 'compact report') {
  if (typeof markdown === 'string') markdown = splitPermHistoryReference(markdown).markdown;
  if (typeof markdown !== 'string' || [...markdown.trim()].length > MAX_COMPACT_REPORT_CHARS) throw new Error(`${label} exceeds ${MAX_COMPACT_REPORT_CHARS} characters`);
  const summary = readMachineSummary(markdown, label);
  if (summary.result_schema_version < 8 || !summary.result_schema_version) {
    if ([...markdown.trim()].length > LEGACY_MAX_COMPACT_REPORT_CHARS) throw new Error(`${label} exceeds ${LEGACY_MAX_COMPACT_REPORT_CHARS} characters`);
  }
  const headings = [...(summary.result_schema_version >= 7 ? KEYWORD_COMPACT_HEADINGS : summary.score_evidence ? COMPACT_HEADINGS : LEGACY_COMPACT_HEADINGS)];
  if (markdown.split('\n').includes(HIRING_MANAGER_REVIEW_HEADING)) headings.splice(headings.indexOf('## Gaps') + 1, 0, HIRING_MANAGER_REVIEW_HEADING);
  const body = sections(markdown, headings, label);
  if (summary.result_schema_version >= 7) {
    const lines = body['## Keywords extracted'].split('\n');
    if (lines.some(line => !line.startsWith('- '))) throw new Error(`${label} keywords must be plain bullet entries`);
    validateKeywords(lines.map(line => line.slice(2)), undefined, `${label}.keywords`);
  }
  const evidenceCount = (body['## Evidence'].match(/^- /gm) ?? []).length;
  const gapCount = (body['## Gaps'].match(/^- /gm) ?? []).length;
  if (evidenceCount < 1 || evidenceCount > 5 || gapCount > 3) throw new Error(`${label} invalid evidence/gap count`);
  if (summary.result_schema_version >= 6) {
    const signals = body['## Evidence'].split('\n').filter(line => line.startsWith('Fixed-term contract: ') || line === fixedTermEvidenceLine(null));
    const state = summary.risk_summary.fixed_term;
    if ((state === 'not_evaluated' && signals.length) || (state !== 'not_evaluated' && (signals.length !== 1
        || (state === 'not_detected' ? signals[0] !== fixedTermEvidenceLine(null) : !signals[0].startsWith('Fixed-term contract: '))))) {
      throw new Error(`${label} fixed-term state conflicts with evidence`);
    }
  }
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

export function requiredScanReportHeadings() { return [...KEYWORD_COMPACT_HEADINGS]; }
