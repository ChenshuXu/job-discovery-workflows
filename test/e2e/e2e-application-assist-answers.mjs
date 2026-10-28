#!/usr/bin/env node
// Failure model: semantic collisions, cross-scope leaks, lost writes, stale aliases/rules,
// typed-value loss, unsafe migration, verification traps and lock recovery guesses.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const script = resolve('.agents/skills/career-ops-ego-apply/scripts/application-memory.mjs');
const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'assist-answer-e2e-'));
const resultDir = resolve('.local/application-assist-tests/answers', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(resultDir, { recursive: true });
const results = [];
const context = { section: 'Preferences', intent: 'preferences.location', subject: 'candidate', domain: 'work location', timeframe: 'current', qualifier: 'none', comparison: 'equal', conditions: 'none', options: ['Remote', 'Office'] };
const base = { key: 'preferences.location', label: 'Where do you prefer to work?', value: 'Remote', scope: 'global', answerSource: 'global', company: 'Synthetic Acme', role: 'Engineer', postingKey: 'fixture:acme:req-1', context, reuseAuthorized: true, userConfirmed: true, expectedAbsent: true, source: 'user_review' };
function args(command, path, data = {}) {
  return [script, command, '--memory', path, ...Object.entries(data).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, typeof value === 'object' ? JSON.stringify(value) : String(value)])];
}
async function cli(command, path, data) {
  const { stdout } = await run(process.execPath, args(command, path, data));
  return JSON.parse(stdout);
}
async function check(name, task) {
  const path = join(root, `${results.length}.json`);
  try { await task(path); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, reason: String(error.message).slice(0, 1800) }); }
  console.log(`${results.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function revision(path, data = base) { return (await cli('target', path, data)).revision; }
async function reject(command, path, data, pattern) { await assert.rejects(cli(command, path, data), pattern); }
await check('queued library mutation checks live authority inside lock before commit', async path => {
  await cli('remember',path,base);
  const before=readFileSync(path,'utf8');
  const library=await import(pathToFileURL(script));
  const expectedRevision=await revision(path);
  mkdirSync(`${path}.lock`,{mode:0o700});
  let valid=true,assertions=0;
  const queued=library.mutateMemory(path,'remember',{...base,value:'Office',correct:true,expectedAbsent:false,expectedRevision},{assertCurrent:()=>{assertions++;if(!valid)throw Error('SOURCE_CHANGED');}});
  await delay(50);valid=false;rmSync(`${path}.lock`,{recursive:true});
  await assert.rejects(queued,/SOURCE_CHANGED/);
  assert.equal(assertions,1);assert.equal(readFileSync(path,'utf8'),before);
});
await check('all durable mutations require expected absence or reviewed target revision', async path => {
  const { expectedAbsent, ...noPrecondition } = base;
  await reject('remember', path, noPrecondition, /precondition|expected/i);
  await cli('remember', path, base);
  await reject('remember', path, base, /conflict/i);
});
await check('strict source isolation and exact posting separate same title requisitions', async path => {
  await cli('remember', path, base);
  for (const source of ['company', 'posting']) {
    assert.equal((await cli('resolve', path, { ...base, answerSource: source })).status, 'unresolved');
    await cli('remember', path, { ...base, scope: source, answerSource: source, value: source });
    assert.equal((await cli('resolve', path, { ...base, answerSource: source })).selected.value, source);
  }
  assert.equal((await cli('resolve', path, { ...base, answerSource: 'posting', postingKey: 'fixture:acme:req-2' })).status, 'unresolved');
  assert.equal((await cli('resolve', path, base)).selected.value, 'Remote');
});
await check('reviewed shared basics work in every source without sharing preferences', async path => {
  const profile = { ...base, key: 'profile.contact.email', label: 'Email address', value: 'synthetic@example.invalid', sharedBasic: true, reviewedMeaning: true, context: { ...context, intent: 'profile.contact.email', domain: 'contact', options: [] } };
  await cli('remember', path, profile);
  for (const answerSource of ['global', 'company', 'posting']) assert.equal((await cli('resolve', path, { ...profile, answerSource })).status, 'exact');
  await reject('remember', path, { ...base, sharedBasic: true, reviewedMeaning: true }, /basic|profile/i);
});
await check('question equality preserves C++ C# and opposite comparison operators', async path => {
  const question = { ...base, key: 'skills.cpp', label: 'Do you know C++?', value: 'Yes' };
  await cli('remember', path, question);
  assert.equal((await cli('resolve', path, { ...question, label: 'Do you know C#?' })).status, 'key_review');
  const numeric = { ...base, key: 'numeric', label: 'Experience >= 3 years?', value: 'Yes' };
  await cli('remember', path, numeric);
  assert.notEqual((await cli('resolve', path, { ...numeric, label: 'Experience <= 3 years?' })).status, 'exact');
});
await check('semantic context normalization is idempotent across underscores and whitespace',async path=>{
  const unusual={...base,key:'context.underscores',context:{...context,section:' Home__address ',intent:'profile__contact.country',domain:'work__location',options:[' Remote__only ',' Office ']}};
  await cli('remember',path,unusual);
  assert.equal((await cli('resolve',path,unusual)).status,'exact');
  const normalized={...unusual,context:{...unusual.context,section:'home address',intent:'profile contact.country',domain:'work location',options:['remote only','office']}};
  assert.equal((await cli('resolve',path,normalized)).status,'exact');
});
await check('same-label sections and contradictory supplied intent cannot bypass semantics', async path => {
  const home = { ...base, key: 'profile.country', label: 'Country', value: 'Exampleland', context: { ...context, section: 'Home address', intent: 'profile.contact.country' } };
  await cli('remember', path, home);
  assert.equal((await cli('resolve', path, { ...home, context: { ...home.context, section: 'Citizenship', intent: 'citizenship.country' } })).status, 'conflict');
  assert.equal((await cli('resolve', path, { ...home, intent: 'citizenship.country', meaningConfirmed: true })).status, 'conflict');
});
await check('validated alias teaches once and correction through alias invalidates old wording', async path => {
  await cli('remember', path, base);
  const alias = { ...base, label: 'Which work location do you prefer?', approveAlias: true, expectedAbsent: false, expectedRevision: await revision(path) };
  await cli('remember', path, alias);
  assert.equal((await cli('resolve', path, alias)).status, 'exact');
  await reject('remember', path, { ...alias, label: 'Where have you worked?', context: { ...context, timeframe: 'past' }, expectedRevision: await revision(path) }, /context|meaning|metadata/i);
  await cli('remember', path, { ...alias, approveAlias: false, correct: true, value: 'Office', expectedRevision: await revision(path) });
  assert.equal((await cli('resolve', path, base)).selected.value, 'Office');
  assert.equal((await cli('resolve', path, alias)).status, 'key_review');
});
await check('typed false multiselect date and intentional blank survive writer and readback', async path => {
  for (const [i, value] of [{type:'boolean', value:false}, {type:'multi', value:['A','B']}, {type:'date',value:'2026-10-22'}, {type:'blank',value:null}].entries()) {
    const field = { ...base, key: `typed.${i}`, label: `Synthetic typed field ${i}`, value };
    await cli('remember', path, field);
    assert.deepEqual((await cli('resolve', path, field)).selected.value, value);
  }
  await reject('remember', path, { ...base, value: {type:'date',value:'2026-02-31'} }, /date/i);
});
await check('numeric deduction remains narrow and human verification is never learned', async path => {
  const numeric = { ...base, key: 'experience.backend', label: 'At least 6 backend years?', value: 'Yes', subject: 'years of experience', domain: 'backend', threshold: 6, comparison: 'at_least', logic: 'atomic', qualifiers: 'none' };
  await cli('remember', path, numeric);
  assert.equal((await cli('resolve', path, { ...numeric, label: 'At least 4 backend years?', threshold:4 })).status, 'deduced');
  assert.notEqual((await cli('resolve', path, { ...numeric, label:'At most 4 backend years?', threshold:4, comparison:'at_most' })).status, 'deduced');
  await reject('remember', path, { ...base, label:'Enter the verification code sent to your email' }, /human|verification/i);
  assert.equal((await cli('resolve', path, { ...base, label:'I am not a robot' })).status, 'human_only');
});
await check('different-target processes preserve both writes; competing creates have one winner', async path => {
  await Promise.all([cli('remember', path, base), cli('remember', path, {...base,key:'other',label:'Other preference?'})]);
  assert.equal((await cli('verify', path)).recordCount, 2);
  const attempts = await Promise.allSettled([cli('remember', path,{...base,key:'race',label:'Race?'}),cli('remember',path,{...base,key:'race',label:'Race?'})]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
});
await check('stale same-target alias and rule changes conflict without retrying', async path => {
  await cli('remember', path, base);
  const old = await revision(path);
  await cli('remember', path, {...base, expectedAbsent:false,expectedRevision:old,correct:true,value:'Office'});
  await reject('remember',path,{...base,expectedAbsent:false,expectedRevision:old,approveAlias:true,label:'Another location wording?'},/conflict/i);
  const rule = {...base,id:'rule.location',kind:'answer',intent:'preference location',meaning:'Candidate work location preference',answerKey:base.key,topic:'location',relation:'preference',timeframe:'current',qualifier:'none',answerId:(await cli('target',path,base)).id, answerRevision:await revision(path)};
  await cli('remember-rule',path,rule);
  const before = await revision(path,{id:rule.id,targetType:'rule'});
  await cli('remember-rule',path,{...rule,expectedAbsent:false,expectedRevision:before,meaning:'Confirmed candidate work location preference'});
  await reject('forget-rule',path,{id:rule.id,expectedRevision:before},/conflict/i);
});
await check('ordinary canonical corrections invalidate aliases and stale rule binding is rejected', async path => {
  await cli('remember',path,base);
  const alias = {...base,label:'Which location works best?',approveAlias:true,expectedAbsent:false,expectedRevision:await revision(path)};
  await cli('remember',path,alias);
  const old = await revision(path);
  await cli('remember',path,{...base,value:'Office',expectedAbsent:false,expectedRevision:old});
  assert.equal((await cli('resolve',path,alias)).status,'key_review');
  await reject('remember-rule',path,{...base,id:'stale',answerId:(await cli('target',path,base)).id,answerRevision:old,kind:'answer',intent:'preference location',meaning:'location preference',answerKey:base.key,topic:'location',relation:'preference',timeframe:'current',qualifier:'none'},/revision|stale/i);
});
await check('forget removes dependent authority and fresh lookup invalidates cached revision', async path => {
  await cli('remember', path, base);
  const old = await cli('resolve', path,base);
  await cli('forget',path,{...base,expectedAbsent:false,expectedRevision:await revision(path)});
  assert.equal((await cli('resolve',path,base)).status,'unresolved');
  await reject('remember',path,{...base,expectedAbsent:false,expectedRevision:old.selected.revision},/conflict/i);
});
await check('legacy migration backs up IDs and job meaning without inventing posting scope', async path => {
  const legacy = { version:3,records:[{id:'legacy::job:synthetic_acme/engineer',key:'legacy',label:'Legacy question?',value:'Yes',scope:'job',scopeKey:'synthetic_acme/engineer'}],rules:[] };
  writeFileSync(path, JSON.stringify(legacy), {mode:0o600});
  await cli('remember',path,base);
  const disk = JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(disk.records[0],legacy.records[0]);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.v3-backup`,'utf8')),legacy);
  assert.equal((await cli('resolve',path,{...base,key:'legacy',label:'Legacy question?',answerSource:'posting'})).status,'unresolved');
  assert.equal(statSync(path).mode & 0o777,0o600);
});
await check('factual counterevidence blocks a global default without leaking a preference layer', async path => {
  await cli('remember', path, base);
  await cli('remember', path, { ...base, scope:'company', answerSource:'company', value:'Office', factual:true, reviewedMeaning:true });
  assert.equal((await cli('resolve', path, base)).status,'conflict');
});
await check('incomplete meaning and password labels cannot enter strict memory', async path => {
  await reject('remember',path,{...base,context:{}},/context|meaning/i);
  await reject('remember',path,{...base,label:'Create password',key:'auth.value'},/credential|password/i);
});
await check('strict reads reject insecure corrupt and symlinked stores instead of treating them empty',async path=>{
  await cli('remember',path,base);
  chmodSync(path,0o644);
  await reject('resolve',path,base,/owner|permission|private/i);
  chmodSync(path,0o600);writeFileSync(path,'{corrupt');
  await reject('resolve',path,base,/JSON|parse|corrupt/i);
  rmSync(path);symlinkSync(`${path}.missing`,path);
  await reject('resolve',path,base,/ELOOP|symbolic|symlink/i);
});
await check('a live or unverifiable writer lock times out without deleting ownership', async path => {
  mkdirSync(`${path}.lock`);
  writeFileSync(`${path}.lock/owner.json`,JSON.stringify({pid:process.pid,hostname:'unverified'}));
  await reject('remember',path,{...base,lockTimeoutMs:30},/busy|lock/i);
  assert.ok(statSync(`${path}.lock`).isDirectory());
});
const report = {schema:1,command:'node test/e2e/e2e-application-assist-answers.mjs',fixture:'synthetic candidate and temporary isolated stores',node:process.version,platform:process.platform,backend:'canonical CLI subprocess',browser:'not exercised; controller and Ego integration gate is separate',sourceSha256:createHash('sha256').update(readFileSync(script)).digest('hex'),testSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),results,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length};
writeFileSync(join(resultDir,'result.json'),JSON.stringify(report,null,2)+'\n');
rmSync(root,{recursive:true,force:true});
console.log(`Evidence: ${join(resultDir,'result.json')}`);
process.exitCode = report.failed ? 1 : 0;
