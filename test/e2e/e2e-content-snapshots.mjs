#!/usr/bin/env node
// Failure inventory: fresh schema is wrong, unsupported versions are rewritten, reopen loses data,
// prepared outreach duplicates, readonly status mutates bytes, or body changes route incorrectly.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderScanUsage } from '../../src/scan-usage.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, openDatabaseReadOnly, beginRun, upsertPost, saveOpportunity, saveContactOutreach, addTombstone, hasActiveTombstone, statusSnapshot } from '../../src/linkedin-post-scan/db.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, '.local/tmp/linkedin-post-scan-tests');
mkdirSync(out, { recursive: true });
const file = path.join(out, `fixture-${Date.now()}.sqlite`), checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const oldFile = file + '.v1';
let db = new DatabaseSync(oldFile); db.exec('PRAGMA user_version = 1'); db.close();
const oldBytes = readFileSync(oldFile);
check('unsupported v1 is rejected without rewriting it', () => {
 assert.throws(() => openDatabase(oldFile), /unsupported.*version: 1/);
 assert.throws(() => openDatabaseReadOnly(oldFile), /unsupported.*version: 1/);
 assert.deepEqual(readFileSync(oldFile), oldBytes);
});
db = openDatabase(file);
check('fresh database uses the current schema directly', () => {
 assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
 for (const table of ['posts','run_posts']) assert.ok(!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === 'body_hash'));
 assert.ok(db.prepare('PRAGMA table_info(exclusion_tombstones)').all().some(row => row.name === 'post_urn'));
});
db.exec(`INSERT INTO runs VALUES ('old','scan','2026-01-01',NULL,'COMPLETE',NULL,'{}','{}');
 INSERT INTO posts VALUES ('urn:li:activity:1','https://www.linkedin.com/feed/update/urn:li:activity:1/','original','{}',NULL,'2026-01-01','2026-01-01','AUTO_PREPARE_READY','{}');
 INSERT INTO opportunities VALUES ('legacy-opp','CONTACT',NULL,'Acme','Engineer',NULL,NULL,4,'AUTO_PREPARE_READY',NULL,'{}','2026-01-01','2026-01-01');
 INSERT INTO post_opportunities VALUES ('urn:li:activity:1','legacy-opp');
 INSERT INTO contacts VALUES ('legacy-contact',NULL,'https://www.linkedin.com/in/example','Example','Acme','Engineer','UNKNOWN','2026-01-01','{}');
 INSERT INTO outreach VALUES ('legacy-outreach','legacy-contact','legacy-opp','CONNECT_NOTE','PREPARED','reviewed draft','2026-01-01',NULL,NULL,'{}');
 INSERT INTO exclusion_tombstones VALUES ('urn:li:activity:999','EXCLUDED','2026-01-01','2099-01-01');`);
db.close();
const bytes = readFileSync(file); db = openDatabaseReadOnly(file); statusSnapshot(db); db.close();
check('current read-only status leaves all bytes unchanged', () => assert.deepEqual(readFileSync(file), bytes));
db = openDatabase(file);
check('reopen preserves exclusion records', () => assert.equal(hasActiveTombstone(db,'urn:li:activity:999'),true));
beginRun(db, { runId: 'new', mode: 'scan' });
const post = { post_urn: 'urn:li:activity:1', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', body: 'original', decision: { route: 'AUTO_PREPARE_READY' } };
check('unchanged bodies compare directly', () => assert.equal(upsertPost(db,'new','q',post).changed, false));
check('changed body detected', () => assert.equal(upsertPost(db,'new','q',{...post,body:'updated'}).changed,true));
const id = saveOpportunity(db,post.post_urn,{kind:'CONTACT',employer:' ACME ',title:'Engineer',status:'AUTO_PREPARE_READY'});
check('existing opportunity identity reused', () => assert.equal(id,'legacy-opp'));
saveContactOutreach(db,id,{profile_url:'https://www.linkedin.com/in/example',name:'Example'},{draft:'new draft'});
check('prepared outreach is neither duplicated nor overwritten', () => {
 assert.equal(db.prepare('SELECT count(*) n FROM outreach').get().n,1);
 assert.equal(db.prepare('SELECT draft FROM outreach').get().draft,'reviewed draft');
});
addTombstone(db,'urn:li:activity:2','EXCLUDED',8);
check('new tombstones use exact post identities', () => assert.equal(hasActiveTombstone(db,'urn:li:activity:2'),true));
check('exact jobs never merge because an edited post has the same title', () => {
 const a=saveOpportunity(db,post.post_urn,{kind:'EXACT_JOB',posting_key:'lever:example:a',employer:'Acme',title:'Engineer',status:'HANDOFF_READY'});
 const b=saveOpportunity(db,post.post_urn,{kind:'EXACT_JOB',posting_key:'lever:example:b',employer:'Acme',title:'Engineer',status:'HANDOFF_READY'});
 assert.notEqual(a,b);
});
check('missing contact identity is rejected before writes', () => assert.throws(()=>saveContactOutreach(db,id,{}, {draft:'invalid'}),/identity/));
db.close(); db=openDatabase(file); db.close();
const after=readFileSync(file);db=openDatabaseReadOnly(file);statusSnapshot(db);db.close();
check('reopen and readonly status preserve bytes',()=>assert.deepEqual(readFileSync(file),after));
check('usage JSON never exports private candidate snapshots', () => {
 const output = renderScanUsage({runs:[{fingerprints:{candidate:'PRIVATE_CANDIDATE'},implementation:{files:{'code.mjs':'PRIVATE_CODE'},git_head:'revision'}}]},'json');
 assert.ok(!output.includes('PRIVATE_CANDIDATE') && !output.includes('PRIVATE_CODE'));
});
writeFileSync(path.join(out,'receipt.json'),JSON.stringify({status:'COMPLETE',checks,fixture:file},null,2)+'\n');
console.log(JSON.stringify({status:'COMPLETE',checks:checks.length,artifact:path.join(out,'receipt.json')}));
