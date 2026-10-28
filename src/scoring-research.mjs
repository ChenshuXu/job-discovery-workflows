import { validateChecks } from './validation-diagnostics.mjs';
// Research is public employer evidence, never candidate facts or application answers.
const DIMENSIONS = ['compensation', 'culture', 'company'];
const STATUSES = ['complete', 'limited', 'unavailable'];
const KINDS = ['official', 'market', 'review', 'news'];
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label}: required fields are ${keys.join(', ')}`);
}
function text(value, label, limit = 240) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label}: non-empty text required (max ${limit})`);
}
function time(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}: invalid time`);
  return Date.parse(value);
}
export function validateResearch(research, { postingKey, company, notBefore, report, label = `${postingKey}: research` }) {
  object(research, ['version', 'posting_key', 'company', 'checked_at', 'sources', 'checks'], label);
  if (research.version !== 1 || research.posting_key !== postingKey || research.company !== company) throw new Error(`${label}: research identity/version mismatch`);
  const checked = time(research.checked_at, `${label}.checked_at`);
  const start = notBefore === undefined ? checked - 7 * 86400000 : time(notBefore, `${label}.not_before`);
  if (checked < start || checked > Date.now() + 300000) throw new Error(`${label}: research time precedes planning or is in the future`);
  if (!Array.isArray(research.sources) || research.sources.length > 8) throw new Error(`${label}.sources: expected 0-8 opened sources`);
  const sources = new Map();
  for (const source of research.sources) {
    const name = `${label}.source`;
    object(source, ['id', 'url', 'title', 'kind', 'scope', 'published_at', 'retrieved_at', 'reference', 'content'], name);
    if (typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(source.id) || sources.has(source.id)) throw new Error(`${name}: invalid or duplicate source id`);
    text(source.url, `${name}.url`, 2048);
    let url;
    try { url = new URL(source.url); } catch { throw new Error(`${name}.url: invalid URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /[\s<>]/.test(source.url)) throw new Error(`${name}.url: expected public HTTPS URL`);
    if (!KINDS.includes(source.kind)) throw new Error(`${name}.kind: unsupported source kind`);
    for (const field of ['title', 'scope', 'reference']) text(source[field], `${name}.${field}`);
    text(source.content, `${name}.content`, 6000);
    const retrieved = time(source.retrieved_at, `${name}.retrieved_at`);
    if (retrieved < start || retrieved > checked) throw new Error(`${name}: source time outside this research run`);
    if (source.published_at !== null && time(source.published_at, `${name}.published_at`) > retrieved) throw new Error(`${name}: publication time follows retrieval`);
    sources.set(source.id, source);
  }
  object(research.checks, DIMENSIONS, `${label}.checks`);
  const used = new Set();
  validateChecks(Object.fromEntries(DIMENSIONS.map(dimension => [dimension, () => {
    const check = research.checks[dimension], name = `${label}.checks.${dimension}`;
    object(check, ['status', 'queries', 'source_ids', 'finding', 'question'], name);
    if (!STATUSES.includes(check.status)) throw new Error(`${name}: invalid status`);
    text(check.finding, `${name}.finding`);
    if (check.question !== null) text(check.question, `${name}.question`, 160);
    if (check.status !== 'complete' && check.question === null) throw new Error(`${name}: limited/unavailable research requires a question`);
    if (!Array.isArray(check.queries) || check.queries.length < 1 || check.queries.length > 3) throw new Error(`${name}.queries: expected 1-3 observed searches`);
    for (const query of check.queries) {
      object(query, ['query', 'tool', 'reference', 'outcome'], `${name}.query`);
      for (const field of ['query', 'tool', 'reference']) text(query[field], `${name}.query.${field}`);
      if (!['found', 'no_results', 'blocked', 'error'].includes(query.outcome)) throw new Error(`${name}.query: invalid outcome`);
    }
    if (!Array.isArray(check.source_ids) || new Set(check.source_ids).size !== check.source_ids.length
        || check.source_ids.some(id => !sources.has(id))) throw new Error(`${name}: invalid source ids`);
    for (const id of check.source_ids) used.add(id);
    if (check.source_ids.length && !check.queries.some(query => query.outcome === 'found')) throw new Error(`${name}: opened sources require a successful search`);
    if (check.status === 'complete' && !check.source_ids.length) throw new Error(`${name}: complete research requires sources`);
    if (dimension === 'compensation' && check.status === 'complete'
        && !check.source_ids.some(id => sources.get(id).kind === 'market')) throw new Error(`${name}: complete compensation requires a market benchmark`);
    const evidence = report?.score_evidence?.[dimension === 'company' ? 'red_flags' : dimension];
    if (evidence && check.status !== 'complete' && evidence.status === 'supported') throw new Error(`${name}: incomplete research cannot be supported evidence`);
    if (report && check.question !== null && (!Array.isArray(report.confidence_gaps) || !report.confidence_gaps.includes(check.question))) throw new Error(`${name}: research question must remain in confidence_gaps`);
  }])), `${label}.checks.`);
  if (used.size !== sources.size) throw new Error(`${label}: unbound source`);
  return research;
}
export function validateResearchCitation(value, research, dimension, label) {
  const match = typeof value === 'string' && value.match(/^Research: ([a-z][a-z0-9-]{0,31}): ([\s\S]+)$/);
  const source = match && Array.isArray(research?.sources) && research.sources.find(source => source.id === match[1]);
  if (!source) throw new Error(`${label}: unknown research source`);
  const check = research.checks?.[dimension === 'red_flags' ? 'company' : dimension];
  if (!Array.isArray(check?.source_ids) || !check.source_ids.includes(source.id)) throw new Error(`${label}: research source is not bound to this dimension`);
  text(match[2], label, 240);
  if (!source.content.includes(match[2])) throw new Error(`${label}: research quote is not an exact source substring`);
}
const inline = value => String(value).replace(/[\\`*_{}[\]<>#!|~]/g, '\\$&').replace(/[\r\n\u2028\u2029]/g, ' ');
export function renderResearch(research) {
  if (!research) return '';
  return `\n\n### External research\n\nChecked: ${inline(research.checked_at)}\n\n${DIMENSIONS.map(dimension => {
    const check = research.checks[dimension];
    return `- ${dimension} (${check.status}): ${inline(check.finding)}${check.question === null ? '' : ` Verify: ${inline(check.question)}`}\n${check.queries.map(query => `  - ${inline(query.query)} — ${inline(query.tool)} / ${query.outcome} (${inline(query.reference)})`).join('\n')}`;
  }).join('\n')}\n\n${research.sources.map(source => `- [${inline(source.id + ': ' + source.title)}](<${source.url}>) — ${source.kind}; ${inline(source.scope)}; published: ${source.published_at ?? 'unknown'}; read: ${inline(source.retrieved_at)}; capture: ${inline(source.reference)}`).join('\n')}`;
}
