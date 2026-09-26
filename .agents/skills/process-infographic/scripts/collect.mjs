#!/usr/bin/env node
// Read-only source collection. Personal records belong in the caller's private output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCareerTrackerParser, parseTracker } from '../../../../src/daily-scan-state.mjs';
import { validateActiveInterviews } from '../../gmail-job-reply-review/scripts/active-interviews.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tally = values => values.reduce((counts, key) => (counts[key] = (counts[key] || 0) + 1, counts), {});
const EVENTS = {
  screen: 'Screen completed', coding: 'Hands-on completed', debugging: 'Hands-on completed',
  integration: 'Hands-on completed', oa: 'OA completed', 'ai-screening': 'AI screening completed',
  design: 'Design completed', hm: 'HM completed', bq: 'Behavioral completed',
  loop: 'Full loop completed', 'verbal-offer': 'Verbal offer',
  'verbal-accepted': 'Verbal offer accepted', 'written-offer': 'Written offer', 'signed-offer': 'Offer signed',
};

// Coordinates and band widths come from records; no user-specific counts or outcomes.
export function chart(records, title, asOf) {
  if (!records.length) return null;
  const counts = new Map(), columns = new Map();
  for (const record of records) record.path.forEach((id, depth) => {
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!columns.has(depth)) columns.set(depth, new Set());
    columns.get(depth).add(id);
  });
  const unit = Math.min(24, 900 / records.length), nodes = [];
  let height = 0;
  for (const [depth, ids] of columns) {
    let y = 200;
    for (const id of [...ids].sort((a, b) => Number(a.includes(':Current:')) - Number(b.includes(':Current:')) || a.localeCompare(b))) {
      const label = id.slice(id.indexOf(':') + 1);
      nodes.push({ id, x: 60 + depth * 480, y, label, public_label: label, placement: 'above',
        color: /Rejected/.test(label) ? '#d66b69' : /Withdrawn|Cancelled|Discarded/.test(label) ? '#8b969e' : '#16a9b6' });
      y += Math.max(counts.get(id) * unit, 40) + 65;
    }
    height = Math.max(height, Math.ceil(y + 80));
  }
  const width = columns.size * 480 + 60;
  assert(width <= 10000 && height <= 10000 && width * height <= 20000000,
    'Chart too large: split into explicitly labelled cohorts; do not drop records');
  const footnotes = title === 'Career-Ops applications'
    ? ['Counts follow Career-Ops stage history; missing history gives lower bounds.', 'Unit: tracker rows. Do not add the recruiting-process total.']
    : ['Completed rounds require reviewed evidence; unclassified does not mean no interviews.', 'Unit: independent recruiting processes. Current status comes from the register.'];
  return { width, height, unit, font_size: 20, title, public_title: title, footnotes, public_footnotes: footnotes,
    subtitle: `${asOf} | ${records.length} records`, public_subtitle: `${asOf} | ${records.length} records`,
    nodes, records };
}

export async function collect({ careerOps = path.resolve(ROOT, '../career-ops'), projects = path.resolve(ROOT, '../career-docs'),
  interviewsFile, registerJson, eventsFile } = {}) {
  careerOps = path.resolve(careerOps); projects = path.resolve(projects);
  assert(!(interviewsFile && registerJson), 'Choose --interviews-file or --register-json');
  const sources = new Map();
  const read = file => {
    file = path.resolve(file);
    const bytes = readFileSync(file), sha256 = hash(bytes);
    assert(!sources.has(file) || sources.get(file) === sha256, `Source changed during collection: ${file}`);
    sources.set(file, sha256);
    return bytes.toString('utf8');
  };
  const evidence = (items, base) => {
    assert(Array.isArray(items) && items.length, 'Evidence sources required');
    return items.map(item => {
      assert(typeof item.path === 'string' && item.path && /^[a-f0-9]{64}$/.test(item.sha256), 'Evidence needs path and sha256');
      const file = path.resolve(base, item.path);
      assert.equal(hash(read(file)), item.sha256, `Stale evidence: ${file}; review and re-extract`);
      return file;
    });
  };
  const load = name => import(pathToFileURL(path.join(careerOps, name)).href);
  const [resolver, stats, parser] = await Promise.all([
    load('path-resolver.mjs'), load('stats.mjs'), loadCareerTrackerParser(careerOps),
  ]);
  const trackerFile = resolver.resolveTrackerPath(resolver.getCareerOpsRoot());
  const trackerText = read(trackerFile), rows = parseTracker(trackerText, parser);
  const statusByNum = stats.trackerStatusByNum(trackerText);
  assert.equal(new Set(rows.map(row => row.number)).size, rows.length, 'Duplicate Career-Ops tracker IDs');
  assert.equal(statusByNum.size, rows.length, 'Career-Ops parser/statistics disagree');
  assert(![...statusByNum.values()].includes('Unknown'), 'Unknown Career-Ops status; resolve before counting');
  const logFile = path.join(path.dirname(trackerFile), 'status-log.tsv');
  const ledger = stats.parseStatusLogStages(existsSync(logFile) ? read(logFile) : '');
  const byNum = new Map();
  for (const entry of ledger) {
    if (!byNum.has(entry.num)) byNum.set(entry.num, []);
    byNum.get(entry.num).push(entry);
  }
  const funnel = stats.computeFunnelWithHistory(statusByNum, ledger);
  funnel.basis = ledger.length ? 'ledger' : 'snapshot';
  const applications = rows.flatMap(row => {
    const status = statusByNum.get(row.number);
    const reached = stats.computeFunnelWithHistory(new Map([[row.number, status]]), byNum.get(row.number) || []);
    if (!reached.everApplied) return [];
    const stages = ['Applications'];
    for (const [key, label] of [['everResponded', 'Responded'], ['everInterview', 'Interview reached'], ['everOffer', 'Offer reached']]) {
      if (reached[key]) stages.push(label);
    }
    stages.push(`Current: ${status}`);
    return [{ id: `tracker:#${row.number}`, company: row.parsed.company, role: row.parsed.role, status,
      path: stages.map((label, depth) => `${depth}:${label}`), sources: [trackerFile, ...(byNum.has(row.number) ? [logFile] : [])] }];
  });
  assert.equal(applications.length, funnel.everApplied);
  let processes, registerFile;
  if (registerJson) {
    registerFile = path.resolve(registerJson);
    processes = JSON.parse(read(registerFile)).processes;
    assert(Array.isArray(processes), 'Adapted register needs processes array');
    for (const row of processes) evidence(row.sources, path.dirname(registerFile));
  } else {
    registerFile = path.resolve(interviewsFile || path.join(projects, 'context/Interview/active-interviews.md'));
    const parsed = validateActiveInterviews(read(registerFile));
    processes = [...parsed.active, ...parsed.archived];
  }
  const identities = new Set(), trackers = new Set();
  for (const row of processes) {
    assert(typeof row.identity === 'string' && row.identity && !identities.has(row.identity), 'Missing/duplicate process identity');
    identities.add(row.identity);
    assert(['Action Required', 'Scheduled', 'Waiting', 'Rejected', 'Withdrawn', 'Cancelled', 'Hired'].includes(row.status), 'Unknown process status');
    assert(typeof row.company === 'string' && row.company && typeof row.role === 'string' && row.role, 'Process needs company and role');
    assert(row.tracker === '' || /^#\d+$/.test(row.tracker), 'Tracker must be empty or exact #N');
    if (row.tracker) {
      assert(statusByNum.has(Number(row.tracker.slice(1))), `Tracker link missing in Career-Ops: ${row.tracker}`);
      assert(!trackers.has(row.tracker), `Multiple processes linked to ${row.tracker}; resolve identity before counting`);
      trackers.add(row.tracker);
    }
  }
  const events = eventsFile ? JSON.parse(read(eventsFile)).events : [];
  assert(Array.isArray(events), 'Events must be an array');
  const eventIds = new Set(), processEvents = new Map();
  for (const event of events) {
    assert(identities.has(event.identity), `Event process missing: ${event.identity}`);
    assert(typeof event.id === 'string' && event.id && !eventIds.has(event.id), 'Missing/duplicate event ID');
    eventIds.add(event.id);
    assert(Object.hasOwn(EVENTS, event.kind) && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
      && !Number.isNaN(Date.parse(event.date)) && new Date(event.date).toISOString().slice(0, 10) === event.date,
    'Invalid completed event kind/date');
    const files = evidence(event.sources, path.dirname(path.resolve(eventsFile)));
    if (!processEvents.has(event.identity)) processEvents.set(event.identity, []);
    processEvents.get(event.identity).push({ ...event, files });
  }
  const interviews = processes.map(row => {
    const completed = (processEvents.get(row.identity) || []).sort((a, b) => a.date.localeCompare(b.date));
    let handsOn = 0;
    const stages = ['Recruiting processes', ...completed.map(event => {
      const label = EVENTS[event.kind];
      return label === 'Hands-on completed' ? `Hands-on ${++handsOn} completed` : label;
    })];
    if (!completed.length) stages.push('Completion unclassified');
    stages.push(`Current: ${row.status}`);
    return { ...row, id: row.identity, completed_hands_on: handsOn, events: completed,
      path: stages.map((label, depth) => `${depth}:${label}`),
      sources: [...new Set([registerFile, ...completed.flatMap(event => event.files)])] };
  });
  const asOf = new Date().toISOString();
  const warnings = [
    'Application unit = Career-Ops tracker row; interview unit = independent recruiting process. Do not add the two totals.',
    'Career-Ops cumulative stage reach is not evidence of completed interview rounds; missing history gives lower bounds.',
    'Completed events are reviewed evidence extracts, not inferred from schedules. Missing extracts remain unclassified.',
  ];
  const drifts = interviews.filter(row => row.tracker && !({
    'Action Required': ['Interview', 'Offer'], Scheduled: ['Interview', 'Offer'], Waiting: ['Interview', 'Offer'],
    Rejected: ['Rejected'], Withdrawn: ['Discarded'], Cancelled: ['Discarded'], Hired: ['Hired'],
  }[row.status].includes(statusByNum.get(Number(row.tracker.slice(1))))));
  if (drifts.length) warnings.push(`Status disagreement; sources preserved, no auto-repair: ${drifts.map(row => row.identity).join(', ')}`);
  // Check again after all reads: do not publish a snapshot mixed across a concurrent write.
  for (const [file, sha256] of sources) assert.equal(hash(readFileSync(file)), sha256, `Source changed: ${file}`);
  return { schema_version: 1, as_of: asOf, paths: { career_ops: careerOps, projects, tracker: trackerFile, register: registerFile },
    sources: [...sources].map(([file, sha256]) => ({ path: file, sha256 })), warnings,
    applications: { total: applications.length, funnel, by_status: tally(applications.map(row => row.status)), records: applications },
    interviews: { total: interviews.length, by_status: tally(interviews.map(row => row.status)),
      exact_tracker_links: trackers.size, unlinked: interviews.length - trackers.size,
      unclassified: interviews.filter(row => !row.events.length).length, records: interviews },
    charts: { applications: chart(applications, 'Career-Ops applications', asOf), interviews: chart(interviews, 'Recruiting processes', asOf) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['career-ops', 'projects', 'interviews-file', 'register-json', 'events', 'out'].map(key => [key, { type: 'string' }])) });
  assert(values.out, '--out NEW_PRIVATE_DIRECTORY is required');
  const snapshot = await collect({ careerOps: values['career-ops'], projects: values.projects,
    interviewsFile: values['interviews-file'], registerJson: values['register-json'], eventsFile: values.events });
  // Refuse to overwrite dated snapshots or authoritative records.
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  mkdirSync(path.resolve(values.out));
  writeFileSync(path.join(values.out, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
  for (const [name, data] of Object.entries(snapshot.charts)) {
    if (data) writeFileSync(path.join(values.out, `${name}-chart.json`), JSON.stringify(data, null, 2) + '\n');
  }
  console.log(JSON.stringify({ out: path.resolve(values.out), applications: snapshot.applications.total,
    interviews: snapshot.interviews.total, unclassified: snapshot.interviews.unclassified, warnings: snapshot.warnings }, null, 2));
}
