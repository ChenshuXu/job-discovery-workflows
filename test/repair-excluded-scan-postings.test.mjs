import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairExcludedScanPostings } from '../src/repair-excluded-scan-postings.mjs';

const EXCLUSION_MANIFEST = {
  run_id: '20000102-030405',
  posting_keys: ['linkedin:linkedin.com:1000000001', 'linkedin:linkedin.com:1000000002'],
};

const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = file => readFileSync(file, 'utf8');
const tree = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const file = path.join(entry.parentPath, entry.name); return [path.relative(root, file), hash(readFileSync(file))];
}));

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'excluded-scan-repair-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = EXCLUSION_MANIFEST.run_id, runRoot = path.join(root, 'runs', runId), careerRoot = path.join(root, 'career-ops');
  const keys = EXCLUSION_MANIFEST.posting_keys, acquired = keys.map((key, index) => ({ primary_key: key, primary_url: `https://www.linkedin.com/jobs/view/${key.split(':').at(-1)}`,
    posting_keys: [key], company: 'Example Publisher', title: 'Engineer', jd_path: `jobs/${index}.md` }));
  const jdFiles = acquired.map(record => path.join(careerRoot, `jds/discovery-${runId}-${record.primary_key.replace(/[^A-Za-z0-9._-]/g, '-')}.md`));
  for (const [index, record] of acquired.entries()) {
    const text = `**URL:** ${record.primary_url}\n**Posting Key:** ${record.primary_key}\n**Discovery Run:** ${runId}\n\n## Job Description\n\nAs ${index ? 'an Applied Scientist' : 'a SDE – II'} at Amazon, you will build production systems.\n`;
    write(path.join(runRoot, record.jd_path), text); write(jdFiles[index], text);
  }
  write(path.join(runRoot, 'receipt.json'), { status: 'COMPLETE', run_id: runId, committed_evaluated_keys: keys, job_issue_keys: [], reports: [], terminal_equation: { valid: true } });
  write(path.join(runRoot, 'acquisition.json'), { run_id: runId, acquired });
  write(path.join(runRoot, 'assignments.json'), { run_id: runId, career_ops_root: careerRoot, assignments: { 'worker-1': keys } });
  write(path.join(runRoot, 'results/worker-1.json'), { results: keys.map(posting_key => ({ posting_key, status: 'EVALUATED', score: 3.9, report: null, hard_exclusion: false })) });
  const trackerFile = path.join(careerRoot, 'data/applications.md'), historyFile = path.join(careerRoot, 'data/scan-history.tsv');
  const unrelated = 'https://www.linkedin.com/jobs/view/12345678\t2026-09-06\tjobspy\tOther\tOther\tdaily-scan:other\tSeattle, WA\r\n';
  const header = 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\r\n';
  write(historyFile, header + acquired.map(record => `${record.primary_url}\t2026-09-07\tego-browser\tEngineer\tExample Publisher\tdaily-scan:${runId}\tSeattle, WA\tfingerprint\t2026-09-07\t\t\texample-publisher\r\n`).join('') + unrelated);
  write(trackerFile, '# Applications\n'); write(path.join(careerRoot, 'reports/123-other.md'), '# Other report\n');
  write(path.join(careerRoot, 'jds/other.md'), '# Other JD\n');
  const events = [], interfaces = {
    trackerUtils: { resolveTrackerPath: () => trackerFile, writeFileAtomic: write,
      openTrackerTransaction: async () => { events.push('tracker'); return { read: () => read(trackerFile), close: () => events.push('tracker-close') }; } },
    pipelineLock: { acquirePipelineLock: async file => { assert.equal(file, path.join(careerRoot, '.daily-scan-commit')); events.push('commit'); return { release: () => events.push('commit-close') }; },
      withPipelineLock: async (file, fn) => { assert.equal(file, historyFile); events.push('history'); try { return await fn(); } finally { events.push('history-close'); } } },
  };
  return { root, runRoot, careerRoot, historyFile, trackerFile, jdFiles, keys, acquired, events, remainingHistory: header + unrelated,
    options: { runRoot, careerRoot, interfaces, manifest: EXCLUSION_MANIFEST }, archiveRoot: path.join(careerRoot, 'data/daily-scan-corrections', runId, 'excluded-employers') };
}

test('excluded employer correction is dry-run by default and removes only two hash-bound owned records with recoverable backups', async t => {
  const fx = fixture(t), originalRun = tree(fx.runRoot), originalCareer = tree(fx.careerRoot);
  const plan = await repairExcludedScanPostings(fx.options);
  assert.equal(plan.applied, false); assert.equal(plan.effects.length, 2); assert.equal(plan.history_rows_before, 3); assert.equal(plan.history_rows_after, 1);
  assert.deepEqual(tree(fx.runRoot), originalRun); assert.deepEqual(tree(fx.careerRoot), originalCareer); assert.deepEqual(fx.events, []);
  const applied = await repairExcludedScanPostings({ ...fx.options, apply: true, expectedPlanHash: plan.plan_sha256 });
  assert.equal(applied.outcome.status, 'COMPLETE'); assert.deepEqual(tree(fx.runRoot), originalRun);
  assert.equal(read(fx.historyFile), fx.remainingHistory); assert.ok(fx.jdFiles.every(file => !existsSync(file)));
  assert.deepEqual(fx.events, ['commit', 'tracker', 'history', 'history-close', 'tracker-close', 'commit-close']);
  for (const effect of applied.effects) assert.equal(hash(read(effect.archive_jd)), effect.jd_sha256);
  for (const file of ['data/applications.md', 'reports/123-other.md', 'jds/other.md']) assert.equal(hash(read(path.join(fx.careerRoot, file))), originalCareer[file]);
  assert.equal(read(path.join(fx.archiveRoot, 'scan-history.removed.tsv')), plan.effects.map(effect => effect.history_raw).join(''));
  await assert.rejects(repairExcludedScanPostings(fx.options), /preexisting correction archive/);
});

test('excluded employer correction fails closed on ambiguity, protected references, drift and unsupported employer evidence', async t => {
  const cases = [
    [fx => write(fx.historyFile, read(fx.historyFile) + read(fx.historyFile).split('\r\n')[1] + '\r\n'), /scan-history identity/],
    [fx => write(fx.jdFiles[0], read(fx.jdFiles[0]) + 'user note\n'), /JD identity or bytes changed/],
    [fx => write(fx.trackerFile, `posting key ${fx.keys[0]}\n`), /protected reference/],
    [fx => write(path.join(fx.careerRoot, 'reports/123-other.md'), `**URL:** ${fx.acquired[0].primary_url}?tracking=1\n`), /protected reference/],
    [fx => write(path.join(fx.root, 'career-docs/context/Interview/active-interviews.md'), fx.keys[0]), /protected reference/],
    [fx => { const file = path.join(fx.runRoot, fx.acquired[0].jd_path), text = read(file).replace('As a SDE – II at Amazon, you will', 'Our engineers use AWS to'); write(file, text); write(fx.jdFiles[0], text); }, /explicit JD employer attribution/],
    [fx => { const file = path.join(fx.runRoot, 'receipt.json'), value = JSON.parse(read(file)); value.committed_evaluated_keys.shift(); write(file, value); }, /not an unreported committed posting/],
    [fx => { const file = path.join(fx.careerRoot, 'reports/link.md'); symlinkSync(fx.jdFiles[0], file); }, /unsafe reference symlink/],
  ];
  for (const [change, expected] of cases) {
    const fx = fixture(t); change(fx); const before = tree(fx.runRoot);
    await assert.rejects(repairExcludedScanPostings(fx.options), expected);
    assert.deepEqual(tree(fx.runRoot), before); assert.equal(existsSync(fx.archiveRoot), false);
  }
  const fx = fixture(t), plan = await repairExcludedScanPostings(fx.options);
  await assert.rejects(repairExcludedScanPostings({ ...fx.options, apply: true }), /expected-plan-hash/);
  write(fx.historyFile, read(fx.historyFile) + '# concurrent note\n');
  const before = tree(fx.careerRoot);
  await assert.rejects(repairExcludedScanPostings({ ...fx.options, apply: true, expectedPlanHash: plan.plan_sha256 }), /plan hash changed/);
  assert.deepEqual(tree(fx.careerRoot), before); assert.equal(existsSync(fx.archiveRoot), false);
});

test('excluded employer correction narrowly rolls back a failed history write and retains its recovery evidence', async t => {
  const fx = fixture(t), originalRun = tree(fx.runRoot), originalHistory = read(fx.historyFile), jdBefore = fx.jdFiles.map(read);
  const plan = await repairExcludedScanPostings(fx.options);
  let written = false;
  fx.options.interfaces.trackerUtils.writeFileAtomic = (file, text) => { write(file, text); if (!written) { written = true; throw new Error('injected after-write failure'); } };
  await assert.rejects(repairExcludedScanPostings({ ...fx.options, apply: true, expectedPlanHash: plan.plan_sha256 }), /owned changes rolled back/);
  assert.equal(read(fx.historyFile), originalHistory); assert.deepEqual(fx.jdFiles.map(read), jdBefore); assert.deepEqual(tree(fx.runRoot), originalRun);
  assert.equal(JSON.parse(read(path.join(fx.archiveRoot, 'outcome.json'))).status, 'ROLLED_BACK');
});
