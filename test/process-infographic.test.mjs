import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, chart } from '../.agents/skills/process-infographic/scripts/collect.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const header = '| Identity | Tracker | Company | Role / Requisition | Stage | Date / Deadline | Status | Last Updated | Notes |';
const divider = '|---|---|---|---|---|---|---|---|---|';
const doc = (active, archived = []) => ['## Active Processes', header, divider, ...active, '## Current TODO', '## Archived Processes', header, divider, ...archived].join('\n');
const row = (id, tracker, status) => `| ${id} | ${tracker} | Example Co | Engineer | Screen | | ${status} | 2000-01-02 | Source note |`;

// Stub only the Career-Ops interface; preset stage results avoid retesting its funnel algorithm.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'infographic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const careerOps = path.join(root, 'ops-code'), projects = path.join(root, 'private-docs');
  mkdirSync(careerOps); mkdirSync(projects);
  const tracker = path.join(root, 'custom-applications.json');
  const register = path.join(projects, 'custom-register.md');
  const put = (name, text) => writeFileSync(path.join(careerOps, name), text);
  put('path-resolver.mjs', `export const getCareerOpsRoot = () => ${JSON.stringify(root)}; export const resolveTrackerPath = () => ${JSON.stringify(tracker)};`);
  put('tracker-parse.mjs', `export const resolveColumns = () => ({}); export const parseTrackerRow = line => line.trim() ? JSON.parse(line) : null;`);
  put('stats.mjs', `
    export const trackerStatusByNum = text => new Map(text.trim().split('\\n').filter(Boolean).map(line => {const r=JSON.parse(line); return [r.num,r.status]}));
    export const parseStatusLogStages = JSON.parse;
    export function computeFunnelWithHistory(statuses, log) {
      return Object.fromEntries(['everApplied','everResponded','everInterview','everOffer'].map((key,i)=>[key,
        log.filter(entry=>statuses.has(entry.num) && entry.reached[i]).length]));
    }
  `);
  const setApps = rows => writeFileSync(tracker, rows.map(([num,status]) => JSON.stringify({num,status,company:'Example Co',role:'Engineer'})).join('\n'));
  setApps([[1,'Applied'],[2,'Evaluated'],[3,'Interview'],[4,'Discarded']]);
  writeFileSync(path.join(root,'status-log.tsv'), JSON.stringify([
    {num:1,reached:[1,0,0,0]}, {num:3,reached:[1,1,1,0]},
    {num:4,reached:[1,0,0,0]}, {num:5,reached:[1,0,0,0]},
  ]));
  writeFileSync(register, doc([row('tracker:#3','#3','Waiting'), row('action:direct','','Waiting')]));
  return {careerOps,projects,register,setApps,options:{careerOps,projects,interviewsFile:register}};
}

test('recollects counts, outcomes and graph paths; custom roots, history and exact IDs', async t => {
  const f=fixture(t);
  const before=await collect(f.options);
  assert.equal((await collect({...f.options,projects:undefined})).paths.projects,path.resolve('../career-docs'));
  assert.equal(before.applications.total,3); // Evaluated excluded; historically applied Discarded retained.
  assert.equal(before.interviews.total,2);
  assert.equal(before.interviews.unlinked,1);
  f.setApps([[1,'Applied'],[2,'Evaluated'],[3,'Rejected'],[4,'Discarded'],[5,'Applied']]);
  writeFileSync(f.register,doc([row('action:direct','','Waiting'),row('action:new','','Scheduled')],[row('tracker:#3','#3','Rejected')]));
  const after=await collect(f.options);
  assert.equal(after.applications.total,4);
  assert.equal(after.interviews.total,3);
  assert.equal(after.interviews.by_status.Rejected,1);
  assert.match(after.interviews.records.find(r=>r.id==='tracker:#3').path.at(-1),/Rejected/);
  assert(!after.charts.interviews.nodes.some(n=>/Example Co/.test(n.public_label)));
  // Regression: fractional band units previously produced a non-integer canvas, rejected by render.py.
  const large=chart(Array.from({length:597},(_,i)=>({id:String(i),path:['0:Start',i ? '1:Waiting' : '1:Other']})),'Large','now');
  assert(Number.isInteger(large.width) && Number.isInteger(large.height));
});

test('completed events come from hashed sources; changed evidence and unknown IDs fail', async t => {
  const f=fixture(t), file=path.join(f.projects,'debrief.md'), eventsFile=path.join(f.projects,'events.json');
  writeFileSync(file,'Completed debugging on 2000-01-01.');
  const event={id:'session-a',identity:'tracker:#3',date:'2000-01-01',kind:'debugging',sources:[{path:'debrief.md',sha256:sha(readFileSync(file))}]};
  writeFileSync(eventsFile,JSON.stringify({events:[event]}));
  const data=await collect({...f.options,eventsFile});
  assert.equal(data.interviews.records.find(r=>r.id==='tracker:#3').completed_hands_on,1);
  assert.equal(data.interviews.unclassified,1);
  writeFileSync(file,'Corrected evidence');
  await assert.rejects(collect({...f.options,eventsFile}),/Stale evidence/);
  event.identity='action:absent';
  writeFileSync(eventsFile,JSON.stringify({events:[event]}));
  await assert.rejects(collect({...f.options,eventsFile}),/Event process missing/);
});

test('alternate register format preserves identities and rejects ambiguous records', async t => {
  const f=fixture(t), registerJson=path.join(f.projects,'adapted.json'), original=path.join(f.projects,'original.csv');
  writeFileSync(original,'stable-id,waiting\n');
  const process={identity:'custom-stable-id',tracker:'',company:'Example',role:'Engineer',status:'Waiting',sources:[{path:'original.csv',sha256:sha(readFileSync(original))}]};
  const save=processes=>writeFileSync(registerJson,JSON.stringify({processes}));
  save([process]);
  const options={careerOps:f.careerOps,projects:f.projects,registerJson};
  assert.equal((await collect(options)).interviews.total,1);
  save([process,process]);
  await assert.rejects(collect(options),/duplicate process identity/);
  save([{...process,tracker:'#99'}]);
  await assert.rejects(collect(options),/Tracker link missing/);
});
