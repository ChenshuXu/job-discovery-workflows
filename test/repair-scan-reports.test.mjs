import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairScanReports } from '../src/repair-scan-reports.mjs';
import { renderScanReportDocument, scanReportStem, trackerIdentityNote } from '../src/render-scan-reports.mjs';
import { readCompactReportSummary } from '../src/scan-report-contract.mjs';
import { loadDailyScanRuntime } from '../src/daily-scan-runtime.mjs';
import { applyScoringSafety, deriveReportWorkAuthorization } from '../src/scoring-safety.mjs';
import { loadCareerTrackerParser, parseTracker } from '../src/daily-scan-state.mjs';
import { buildEvaluatedRetentionPlan } from '../src/evaluated-retention.mjs';

const REPORT_MANIFEST = {
  run_id: '20000102-030405',
  entries: [
    { posting_key: 'greenhouse:exampleone:1000000003', report_number: 101, decision: 'Skip' },
    { posting_key: 'greenhouse:exampletwo:1000000004', report_number: 102, decision: 'Research first' },
    { posting_key: 'greenhouse:exampledata:1000000005', report_number: 103, decision: 'Apply', remove_gap: {
      quote: 'You will become an expert at using the Example Data Data + AI tools',
      locator: 'cv.md/PROFESSIONAL EXPERIENCE', explanation: 'Full required depth is not documented.',
    } },
    { posting_key: 'generic:app.trinethire.com:1000008', report_number: null, decision: 'Apply' },
    { posting_key: 'ashby:examplethree:00000000-0000-4000-8000-000000000009', report_number: null, decision: 'Research first' },
    { posting_key: 'greenhouse:examplefour:1000000007', report_number: null, decision: 'Apply' },
    { posting_key: 'workday:examplefive/external_career_site:JR1000006', report_number: null, decision: 'Apply' },
  ],
};

const hash = text => createHash('sha256').update(text).digest('hex');
const read = file => readFileSync(file, 'utf8');
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath ?? item.path, item.name); return [path.relative(root, file), hash(readFileSync(file))]; }).sort(([a], [b]) => a.localeCompare(b)));
}

function careerWriters(career) {
  write(path.join(career, 'tracker.mjs'), `
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
if(process.argv[2]!=='sync')throw new Error('canonical sync expected');
if(existsSync('FAIL_SYNC_ONCE')) {unlinkSync('FAIL_SYNC_ONCE');throw new Error('injected tracker sync failure');}
appendFileSync('data/sync-calls.log','sync\\n');
writeFileSync('data/synced-tracker.md',readFileSync(process.env.CAREER_OPS_TRACKER));
`);
  write(path.join(career, 'verify-pipeline.mjs'), `
import { existsSync, readFileSync } from 'node:fs';
const tracker=readFileSync(process.env.CAREER_OPS_TRACKER,'utf8');
const post=tracker.includes('| SKIP |');
const nonzero=existsSync('PIPELINE_NONZERO_EXIT') || post && existsSync('POST_PIPELINE_NONZERO_EXIT');
const errors=existsSync('PIPELINE_ERRORS') || post && existsSync('POST_PIPELINE_ERRORS');
console.log('Pipeline Health: '+(errors?1:0)+' errors, 12 warnings');
if(nonzero)process.exitCode=1;
`);
  write(path.join(career, 'tracker-parse.mjs'), `
const aliases = { '#':'num', date:'date', company:'company', role:'role', score:'score', status:'status', pdf:'pdf', report:'report', notes:'notes', url:'url' };
export function resolveColumns(lines) {
  for (const line of lines) { const columns = {}; line.split('|').forEach((cell, index) => { if (aliases[cell.trim().toLowerCase()]) columns[aliases[cell.trim().toLowerCase()]] = index; }); if (columns.num && columns.status) return columns; }
  throw new Error('tracker header missing');
}
export function parseTrackerRow(line, columns) {
  const cells = line.split('|').map(cell => cell.trim()); const num = Number(cells[columns.num]); if (!num) return null;
  return { ...Object.fromEntries(Object.entries(columns).map(([name, index]) => [name, cells[index]])), num, raw:line };
}
`);
  write(path.join(career, 'tracker-utils.mjs'), `
import { readFileSync, writeFileSync, renameSync } from 'node:fs'; import path from 'node:path';
export const resolveTrackerPath = root => path.resolve(root, process.env.CAREER_OPS_TRACKER || 'data/applications.md');
export const writeFileAtomic = (file, text) => { writeFileSync(file + '.tmp', text); renameSync(file + '.tmp', file); };
export const rebuildRow = parts => '| ' + parts.slice(1, parts.at(-1) === '' ? -1 : undefined).join(' | ') + ' |';
export async function openTrackerTransaction(file) { return { read:()=>readFileSync(file,'utf8'), replace:text=>writeFileAtomic(file,text), close:()=>{} }; }
`);
  write(path.join(career, 'pipeline-lock.mjs'), `
import { mkdirSync, rmSync } from 'node:fs';
export async function acquirePipelineLock(file) { mkdirSync(file + '.lock'); return { release:()=>rmSync(file + '.lock', {recursive:true}) }; }
export async function withPipelineLock(file, fn) { const lock = await acquirePipelineLock(file); try { return await fn(); } finally { lock.release(); } }
`);
  write(path.join(career, 'reserve-report-num.mjs'), `
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const release = process.argv.indexOf('--release');
if (release >= 0) { const [first, last=first] = process.argv[release+1].split('-').map(Number); for(let n=first;n<=last;n++) {const file='reports/'+String(n).padStart(3,'0')+'-RESERVED.md';if(existsSync(file))unlinkSync(file);} process.exit(0); }
const count = Number(process.argv[process.argv.indexOf('--count')+1]);
const occupied = readdirSync('reports').map(name=>Number(name.match(/^(\\d+)-/)?.[1])).filter(Number.isFinite);
for (const match of readFileSync('data/applications.md','utf8').matchAll(/^\\|\\s*(\\d+)\\s*\\|/gm)) occupied.push(Number(match[1]));
const first = Math.max(0,...occupied)+1; for(let n=first;n<first+count;n++)writeFileSync('reports/'+String(n).padStart(3,'0')+'-RESERVED.md','reserved',{flag:'wx'});
console.log(count===1 ? first : first+'-'+(first+count-1));
`);
  write(path.join(career, 'merge-tracker.mjs'), `
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const tracker = process.env.CAREER_OPS_TRACKER; const additions = process.env.CAREER_OPS_ADDITIONS;
let text = readFileSync(tracker,'utf8').trimEnd();
for(const name of readdirSync(additions)) {
 const [header,line] = readFileSync(additions+'/'+name,'utf8').trim().split('\\n');
 if(header!=='num\\tdate\\tcompany\\trole\\tstatus\\tscore\\tpdf\\treport\\tnotes') throw new Error('headed TSV required');
 const values=line.split('\\t'); const fields=Object.fromEntries(header.split('\\t').map((name,index)=>[name,values[index]]));
 if(existsSync('FAIL_MERGE') && fields.notes.includes(readFileSync('FAIL_MERGE','utf8'))) {
   if(existsSync('INJECT_REPORT_RACE')) { const target=readFileSync('INJECT_REPORT_RACE','utf8');writeFileSync(target,readFileSync(target,'utf8')+'\\nConcurrent user report edit.\\n'); }
   throw new Error('injected exact-key merge failure');
 }
 const cells=[fields.num,fields.date,fields.company,fields.role,fields.score,fields.status,fields.pdf,fields.report.replace('(reports/','(../reports/'),fields.notes];
 text+='\\n| '+cells.join(' | ')+' |';
}
writeFileSync(tracker,text+'\\n');
`);
  write(path.join(career, 'set-status.mjs'), `
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'; import path from 'node:path';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs'; import { rebuildRow } from './tracker-utils.mjs';
const file=process.env.CAREER_OPS_TRACKER; const at=process.argv.indexOf('--report'); const report=Number(process.argv[at+1]); const status=process.argv[at+2];
const note=process.argv[process.argv.indexOf('--note')+1];
const lines=readFileSync(file,'utf8').split('\\n');const columns=resolveColumns(lines);
const indexes=lines.flatMap((line,index)=>{const row=parseTrackerRow(line,columns);return row?.report?.includes('['+report+'](')?[index]:[];});if(indexes.length!==1)throw new Error('ambiguous report');
const index=indexes[0];const cells=lines[index].split('|').map(cell=>cell.trim());const previous=cells[columns.status];cells[columns.status]=status;
if(!cells[columns.notes].includes(note))cells[columns.notes]+='; '+note;
lines[index]=rebuildRow(cells);writeFileSync(file,lines.join('\\n'));
if(previous!==status)appendFileSync(path.join(path.dirname(file),'status-log.tsv'),cells[columns.num]+'\\t2026-09-07\\t'+previous+'\\t'+status+'\\tset-status\\t\\n');
if(existsSync('INJECT_RACE')) { const target='data/applications.md';const prior=readFileSync(target,'utf8');writeFileSync(target,prior.replace('preserve unrelated','external unrelated update').replace('| 101 | 2026-09-07 |', '| 101 | 2026-09-06 |'));unlinkSync('INJECT_RACE'); }
`);
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'report-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runRoot = path.join(root, 'runs', REPORT_MANIFEST.run_id);
  const careerRoot = path.join(root, 'career-ops');
  const manifest = structuredClone(REPORT_MANIFEST);
  for (const directory of ['reports', 'data', 'batch/tracker-additions']) mkdirSync(path.join(careerRoot, directory), { recursive: true });
  careerWriters(careerRoot);
  const candidateFiles = { 'cv.md': 'Master of Science in Computer Science\nBachelor of Science in Computer Science\n', 'config/profile.yml': 'visa_status: "H-1B"\nneeds_sponsorship: true\n', 'modes/_profile.md': '# Profile\n' };
  const candidateSources = Object.entries(candidateFiles).map(([label, text]) => { const file = path.join(careerRoot, label); write(file, text); return { label, path: file, sha256: hash(text) }; });
  const candidateText = Object.entries(candidateFiles).map(([label, text]) => `\n--- ${label} ---\n${text}`).join('');
  const runtime = loadDailyScanRuntime(); runtime.scheduler = { ...runtime.scheduler, batch_size: 7, max_active_workers: 1 };
  const locationPolicy = { local_metros: ['Seattle'], remote_country: 'United States', require_structured_remote: true, ambiguous_action: 'exclude' };
  const acquisition = { run_id: manifest.run_id, acquired: [] };
  const raw = []; const final = []; const mappings = [];
  let tracker = '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 100 | 2026-01-01 | Unrelated | Backend | 3.0/5 | Applied | ❌ | [100](../reports/100-unrelated.md) | preserve unrelated |\n';
  for (const [index, entry] of manifest.entries.entries()) {
    const title = index === 5 ? 'Staff + Sr. Software Engineer' : index === 6 ? 'Senior / Lead / Principal Software Engineer' : 'Senior Backend Engineer';
    const key = entry.posting_key;
    const record = { primary_key: key, company: `Company ${index}`, title, primary_url: `https://jobs.example/${index}`, sources: ['google-ats-direct'],
      location: 'Seattle, WA', workplace_type: 'remote', structured_remote_signal: true, employment_type: 'Full-time',
      jd_path: `jobs/${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`, location_scope: { allowed: true, decision: 'ALLOW_LOCAL' },
      semantic_job_key: `semantic:${key}`, posting_context_key: `context:${key}` };
    const extra = index === 0 ? 'We are unable to offer sponsorship at this time.' : index === 1 ? '- On-site in Hillsboro, OR, and eligible for hybrid and remote work'
      : index === 2 ? entry.remove_gap.quote : index === 4 ? 'Non-engineering roles cannot receive sponsorship. Sponsorship for engineering and product roles is not guaranteed; approval depends on the individual role.' : '';
    const jdText = `**URL:** ${record.primary_url}\n**Discovery Run:** ${manifest.run_id}\n**Role:** ${title}\n**Company:** ${record.company}\n**Location:** Seattle, WA\n**Employment Type:** Full-time\n\n## Job Description\nBuild backend systems.\n${extra}\n`;
    write(path.join(runRoot, record.jd_path), jdText);
    write(path.join(careerRoot, `jds/discovery-${manifest.run_id}-${key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`), jdText);
    const report = { archetype: 'Backend', reason: 'Backend scope aligns.', evidence: [{ source: 'jd', quote: 'Build backend systems.', explanation: 'Relevant platform ownership.' }],
      gaps: entry.remove_gap ? [entry.remove_gap] : [], risk_level: 'Low', confidence: 'High',
      risk_summary: { classification: 'clear', culture: 'not_evaluated', interview_redflags: 'not_evaluated', ai_infra: 'consistent' }, advertised_comp: null, company_confidential_evidence: null };
    const item = { posting_key: key, work_authorization: { value: 'unstated', quote: null }, fit_score: index === 2 ? 4.4 : 4.2, level_signal: 'target', level_evidence: `JD: "**Role:** ${title}"`,
      eligibility_status: 'eligible', eligibility_category: null, eligibility_evidence: null, legitimacy_tier: 'High Confidence', rationale: 'Original baseline rationale.', report };
    if ([0, 1, 4].includes(index)) {
      item.eligibility_status = index === 0 ? 'ineligible' : 'needs_verification';
      item.eligibility_category = index === 1 ? 'mandatory_unacceptable_location' : 'no_sponsorship';
      const quote = index === 4 ? 'Sponsorship for engineering and product roles is not guaranteed' : extra;
      item.eligibility_evidence = `JD: "${quote}"`;
      if (index !== 1) item.work_authorization = { value: index === 0 ? 'no_sponsorship' : 'needs_verification', quote };
      if (index === 0) item.report = null;
    }
    const old = { ...applyScoringSafety({ item, record, jdText, candidateText, threshold: 4, locationPolicy }), semantic_job_key: record.semantic_job_key, posting_context_key: record.posting_context_key };
    if (index < 3) {
      Object.assign(old, { fit_score: item.fit_score, score: item.fit_score, hard_exclusion: false, report_allowed: true, report, report_decision: index === 0 ? 'Research first' : 'Apply',
        work_authorization: { value: 'unstated', label: 'Unstated', quote: null } });
      const reportPath = `reports/${scanReportStem(record, entry.report_number)}-2026-09-07.md`;
      write(path.join(careerRoot, reportPath), renderScanReportDocument({ result: old, record, number: String(entry.report_number), date: '2026-09-07', runId: manifest.run_id }));
      mappings.push({ posting_key: key, report_number: entry.report_number, report_path: reportPath });
      tracker += `| ${entry.report_number} | 2026-09-07 | ${record.company} | ${title} | ${old.score.toFixed(1)}/5 | Evaluated | ❌ | [${entry.report_number}](../${reportPath}) | ${trackerIdentityNote(record)} |\n`;
    } else Object.assign(old, { fit_score: 3.5, score: 3.5, report_allowed: false, report_decision: 'Skip', report: null });
    acquisition.acquired.push(record); raw.push(item); final.push(old);
  }
  write(path.join(runRoot, 'acquisition.json'), acquisition);
  write(path.join(runRoot, 'assignments.json'), { run_id: manifest.run_id, result_schema_version: 4, career_ops_root: careerRoot, candidate_sources: candidateSources, runtime, location_policy: locationPolicy,
    assignments: { 'worker-1': raw.map(item => item.posting_key) }, primary_urls: Object.fromEntries(acquisition.acquired.map(record => [record.primary_key, record.primary_url])),
    semantic_identities: Object.fromEntries(acquisition.acquired.map(record => [record.primary_key, { semantic_job_key: record.semantic_job_key, posting_context_key: record.posting_context_key }])) });
  write(path.join(runRoot, 'results/worker-1.part-1.json'), { result_schema_version: 4, worker: 'worker-1', part: 1, results: raw });
  write(path.join(runRoot, 'results/worker-1.json'), { result_schema_version: 4, worker: 'worker-1', results: final });
  write(path.join(runRoot, 'receipt.json'), { status: 'COMPLETE', run_id: manifest.run_id, terminal_equation: { valid: true }, committed_evaluated_keys: raw.map(item => item.posting_key) });
  write(path.join(runRoot, 'rendered-reports.json'), { run_id: manifest.run_id, reports: mappings });
  write(path.join(careerRoot, 'data/applications.md'), tracker);
  write(path.join(careerRoot, 'data/status-log.tsv'), '100\t2026-01-01\tEvaluated\tApplied\tset-status\t\n');
  write(path.join(careerRoot, 'data/scan-history.tsv'), 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n' + acquisition.acquired.map(record => `${record.primary_url}\t2026-09-07\tjob-discovery:google-ats-direct\t${record.title}\t${record.company}\tdaily-scan:${manifest.run_id}\tSeattle, WA`).join('\n') + '\n');
  write(path.join(careerRoot, 'batch/tracker-additions/unrelated.tsv'), 'unrelated queue is not consumed\n');
  return { root, runRoot, careerRoot, manifest, mappings, acquisition, raw };
}

const invoke = (fx, options = {}) => repairScanReports({ runRoot: fx.runRoot, careerRoot: fx.careerRoot, manifest: fx.manifest, ...options });
const trackerRows = async fx => parseTracker(read(path.join(fx.careerRoot, 'data/applications.md')), await loadCareerTrackerParser(fx.careerRoot));

test('report correction dry run has seven exact effects and makes no filesystem changes', async t => {
  const fx = fixture(t); const before = snapshot(fx.root);
  const { status, plan } = await invoke(fx);
  assert.equal(status, 'DRY_RUN'); assert.deepEqual(snapshot(fx.root), before);
  assert.equal(plan.effects.length, 7); assert.deepEqual(plan.effects.map(effect => effect.operation), ['correct', 'correct', 'correct', 'restore', 'restore', 'restore', 'restore']);
  assert.deepEqual(plan.effects.map(effect => effect.new_decision), ['Skip', 'Research first', 'Apply', 'Apply', 'Research first', 'Apply', 'Apply']);
  assert.equal(plan.effects[0].report_allowed, false); assert.equal(plan.effects[0].hard_exclusion, true); assert.equal(plan.effects[0].tracker.status, 'SKIP');
  assert.equal(plan.effects[2].old_score, 4.4); assert.equal(plan.effects[2].new_score, 4.4);
  for (const effect of plan.effects.slice(3)) { assert.equal(effect.old_score, 3.5); assert.equal(effect.new_score, effect.original_raw_fit_score); }
  for (const effect of plan.effects) assert.match(effect.new_report_sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(invoke(fx, { apply: true }), /reviewed --plan-sha256/);
});

test('apply uses headed additions, preserves report IDs/source run/unrelated state, and is idempotent', async t => {
  const fx = fixture(t); const originalRun = snapshot(fx.runRoot); const oldReports = fx.mappings.map(mapping => read(path.join(fx.careerRoot, mapping.report_path)));
  const unrelatedRow = (await trackerRows(fx))[0].raw;
  const { plan } = await invoke(fx);
  const result = await invoke(fx, { apply: true, expectedPlanHash: plan.plan_sha256 });
  assert.equal(result.status, 'COMPLETE'); assert.deepEqual(snapshot(fx.runRoot), originalRun);
  assert.equal(result.tracker_synced,true);assert.deepEqual(result.pipeline_before,{errors:0,exit_code:0});assert.deepEqual(result.pipeline_after,{errors:0,exit_code:0});
  assert.equal(read(path.join(fx.careerRoot,'data/synced-tracker.md')),read(path.join(fx.careerRoot,'data/applications.md')));
  assert.equal(read(path.join(fx.careerRoot,'data/sync-calls.log')),'sync\n');
  assert.equal(read(path.join(fx.careerRoot, 'batch/tracker-additions/unrelated.tsv')), 'unrelated queue is not consumed\n');
  const rows = await trackerRows(fx); assert.equal(rows.length, 8); assert.equal(rows[0].raw, unrelatedRow);
  assert.equal(rows.find(row => row.number === 101).status, 'SKIP'); assert.equal(rows.find(row => row.number === 101).parsed.score, '3.5/5');
  for (const [index, mapping] of fx.mappings.entries()) {
    const backup = path.join(fx.careerRoot, 'data/daily-scan-repairs', fx.manifest.run_id, 'report-backups', path.basename(mapping.report_path));
    assert.equal(read(backup), oldReports[index]);
  }
  const retired = read(path.join(fx.careerRoot, fx.mappings[0].report_path));
  const summary = readCompactReportSummary(retired.split('\n---\n\n')[1].trim());
  assert.equal(summary.final_decision, 'Skip'); assert.equal(summary.hard_stops.length, 1); assert.equal(summary.discard_reasons.length, 1); assert.match(summary.next_action, /^Do not apply:/);
  assert.match(retired, /Build backend systems/); assert.match(retired, /No sponsorship/);
  assert.equal(read(path.join(fx.careerRoot, 'data/status-log.tsv')).split('\n').filter(Boolean).length, 2);
  assert.equal(result.completed[0].ledger.appended_lines, 1);
  for (const row of rows.filter(row => row.status === 'Evaluated')) assert.equal(row.notes, trackerIdentityNote({ primary_key: result.completed.find(item => item.report_path === row.report_path).posting_key }));
  const retention = buildEvaluatedRetentionPlan({ trackerText: read(path.join(fx.careerRoot,'data/applications.md')), scanHistoryText: read(path.join(fx.careerRoot,'data/scan-history.tsv')),
    careerRoot: fx.careerRoot, parser: await loadCareerTrackerParser(fx.careerRoot), asOfDate: '2026-09-15', ttlDays: 7, statusLogText: read(path.join(fx.careerRoot,'data/status-log.tsv')) });
  assert.equal(retention.cleaned.length, 6); assert.deepEqual(retention.protected, []);
  assert.equal(existsSync(path.join(fx.careerRoot,'reports/.repair-backups')),false);
  const applied = snapshot(fx.root); assert.equal((await invoke(fx, { apply: true, expectedPlanHash: plan.plan_sha256 })).status, 'ALREADY_APPLIED'); assert.deepEqual(snapshot(fx.root), applied);
});

test('report correction refuses wrong identity, user edits, protected rows, and preexisting restore rows', async t => {
  for (const [label, mutate, pattern] of [
    ['identity', fx => { const file=path.join(fx.careerRoot,fx.mappings[0].report_path);write(file,read(file).replace('**Posting Key:** greenhouse:exampleone:1000000003','**Posting Key:** greenhouse:other:1')); }, /identity/],
    ['report edit', fx => {const file=path.join(fx.careerRoot,fx.mappings[0].report_path);write(file,read(file).replace('Backend scope aligns.','User-reviewed alternative wording.'));}, /changed from original/],
    ['protected status', fx => {const file=path.join(fx.careerRoot,'data/applications.md');write(file,read(file).replace('| 4.2/5 | Evaluated |','| 4.2/5 | Applied |'));}, /protected user-interacted/],
    ['protected manual score', fx => {const file=path.join(fx.careerRoot,'data/applications.md');write(file,read(file).replace('| 4.2/5 | Evaluated |','| 4.0/5 | Evaluated |'));}, /protected user-interacted/],
    ['existing restore row', fx => {const file=path.join(fx.careerRoot,'data/applications.md');write(file,read(file).replace('preserve unrelated',trackerIdentityNote(fx.acquisition.acquired[3])));}, /already has a report or tracker row/],
  ]) {
    const fx=fixture(t);mutate(fx);const before=snapshot(fx.root);await assert.rejects(invoke(fx),pattern,label);assert.deepEqual(snapshot(fx.root),before,label);
  }
});

test('candidate hash changes, mutated source after planning, occupied numbers, and prior backup fail closed', async t => {
  {
    const fx=fixture(t);write(path.join(fx.careerRoot,'cv.md'),'changed');await assert.rejects(invoke(fx),/candidate source hash changed/);
  }
  for (const mutate of [
    fx=>{const file=path.join(fx.runRoot,fx.acquisition.acquired[3].jd_path);write(file,read(file)+'\nAdditional source text.\n');},
    fx=>write(path.join(fx.careerRoot,'reports/2817-RESERVED.md'),'other writer owns this reservation'),
  ]) {
    const fx=fixture(t);const {plan}=await invoke(fx);mutate(fx);const before=snapshot(fx.root);await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/repair plan changed|persisted source JD differs/);assert.deepEqual(snapshot(fx.root),before);
  }
  const fx=fixture(t);write(path.join(fx.careerRoot,'data/daily-scan-repairs',fx.manifest.run_id,'report-backups',path.basename(fx.mappings[0].report_path)),'preexisting');await assert.rejects(invoke(fx),/preexisting repair backup/);
});

test('failed restore compensates only owned rows/reports and retains exact backups and audit notes', async t => {
  const fx=fixture(t);write(path.join(fx.careerRoot,'FAIL_MERGE'),fx.manifest.entries[5].posting_key);
  const beforeRun=snapshot(fx.runRoot);const beforeReports=fx.mappings.map(mapping=>read(path.join(fx.careerRoot,mapping.report_path)));const unrelated=(await trackerRows(fx))[0].raw;
  const {plan}=await invoke(fx);await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/owned changes compensated/);
  assert.deepEqual(snapshot(fx.runRoot),beforeRun);assert.equal((await trackerRows(fx)).length,4);assert.equal((await trackerRows(fx))[0].raw,unrelated);
  for(const [index,mapping] of fx.mappings.entries())assert.equal(read(path.join(fx.careerRoot,mapping.report_path)),beforeReports[index]);
  assert.match(read(path.join(fx.careerRoot,'data/applications.md')),/repair rolled back after failure/);
  assert.equal(read(path.join(fx.careerRoot,'data/status-log.tsv')).split('\n').filter(Boolean).length,3);
  const journal=JSON.parse(read(path.join(fx.careerRoot,'data/daily-scan-repairs',`${fx.manifest.run_id}-reports.json`)));
  assert.equal(journal.status,'FAILED');assert.deepEqual(journal.rollback_errors,[]);
  assert.equal(journal.rollback_tracker_synced,true);assert.deepEqual(journal.rollback_pipeline,{errors:0,exit_code:0});
  await assert.rejects(invoke(fx),/journal needs review/);
});

test('concurrent row mutation is rejected by CAS and unrelated writes survive compensation', async t => {
  const fx=fixture(t);write(path.join(fx.careerRoot,'INJECT_RACE'),'once');const old=read(path.join(fx.careerRoot,fx.mappings[0].report_path));
  const {plan}=await invoke(fx);await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/tracker concurrent row precondition/);
  assert.equal(read(path.join(fx.careerRoot,fx.mappings[0].report_path)),old);
  const tracker=read(path.join(fx.careerRoot,'data/applications.md'));assert.match(tracker,/external unrelated update/);assert.match(tracker,/\| 101 \| 2026-09-06 \|/);assert.doesNotMatch(tracker,/\| SKIP \|/);
});

test('compensation refuses an externally edited report before reverting its owned tracker row', async t => {
  const fx=fixture(t);write(path.join(fx.careerRoot,'FAIL_MERGE'),fx.manifest.entries[3].posting_key);
  write(path.join(fx.careerRoot,'INJECT_REPORT_RACE'),fx.mappings[0].report_path);
  const {plan}=await invoke(fx);await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/rollback needs attention:.*report changed after repair/);
  assert.match(read(path.join(fx.careerRoot,fx.mappings[0].report_path)),/Concurrent user report edit/);
  assert.equal((await trackerRows(fx)).find(row=>row.number===101).status,'SKIP');
});

test('manifest gap rewrite is exact, bound to the exact reviewed finding, and never guesses', async t => {
  const fx=fixture(t);fx.manifest.entries[2].remove_gap.explanation='Different unsupported rewrite';await assert.rejects(invoke(fx),/approved raw gap no longer matches exactly/);
  fx.manifest=structuredClone(REPORT_MANIFEST);const file=path.join(fx.runRoot,'results/worker-1.part-1.json');const artifact=JSON.parse(read(file));artifact.results[2].report.gaps[0].explanation='Changed original evidence';write(file,artifact);
  await assert.rejects(invoke(fx),/approved raw gap no longer matches exactly/);
});

test('preflight pipeline rejects nonzero exit or reported errors before any report writes', async t => {
  for(const flag of ['PIPELINE_NONZERO_EXIT','PIPELINE_ERRORS']) {
    const fx=fixture(t);write(path.join(fx.careerRoot,flag),'enabled');const {plan}=await invoke(fx);const before=snapshot(fx.root);
    await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/preflight pipeline failed/);assert.deepEqual(snapshot(fx.root),before);
  }
});

test('tracker sync and post-write pipeline failures compensate owned changes and synchronize restored state', async t => {
  for(const flag of ['FAIL_SYNC_ONCE','POST_PIPELINE_NONZERO_EXIT','POST_PIPELINE_ERRORS']) {
    const fx=fixture(t);write(path.join(fx.careerRoot,flag),'enabled');const originals=fx.mappings.map(mapping=>read(path.join(fx.careerRoot,mapping.report_path)));
    const {plan}=await invoke(fx);await assert.rejects(invoke(fx,{apply:true,expectedPlanHash:plan.plan_sha256}),/report repair failed:.*(?:tracker\.mjs failed|post-write pipeline failed)/);
    assert.equal((await trackerRows(fx)).length,4);assert.equal((await trackerRows(fx)).find(row=>row.number===101).status,'Evaluated');
    for(const [index,mapping] of fx.mappings.entries())assert.equal(read(path.join(fx.careerRoot,mapping.report_path)),originals[index]);
    const journal=JSON.parse(read(path.join(fx.careerRoot,'data/daily-scan-repairs',`${fx.manifest.run_id}-reports.json`)));
    assert.equal(journal.status,'FAILED');assert.equal(journal.rollback_tracker_synced,true);assert.deepEqual(journal.rollback_pipeline,{errors:0,exit_code:0});assert.deepEqual(journal.rollback_errors,[]);
    assert.equal(read(path.join(fx.careerRoot,'data/synced-tracker.md')),read(path.join(fx.careerRoot,'data/applications.md')));
    assert.equal(read(path.join(fx.careerRoot,'data/status-log.tsv')).split('\n').filter(Boolean).length,3);
  }
});
