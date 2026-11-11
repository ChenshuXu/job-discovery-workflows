#!/usr/bin/env node
// Failure inventory predates implementation in docs/scan-rollback-recovery-2026-10-04.md.
// Real Career-Ops CLIs run against copied code and fictional data. A Node preload
// injects faults at the parent process boundary; upstream source stays unchanged.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCareerFixture, DISCOVERY_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { SCAN_DATE, seedCandidate, seedScan, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';

const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const indexState = (dbFile, trackerFile) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return { rows: db.prepare('SELECT * FROM applications ORDER BY id').all(),
      // The index is derived state: a rebuild renumbers event ids, so compare event content only.
      events: db.prepare('SELECT app_id, status, date, source FROM status_events ORDER BY id').all(),
      tracker_content: readFileSync(trackerFile, 'utf8') };
  } finally { db.close(); }
};

const PRELOAD = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const plan = JSON.parse(readFileSync(process.env.SCAN_ROLLBACK_FAULT, 'utf8'));
if (path.resolve(process.argv[1]) === plan.committer) {
  const original = childProcess.spawnSync;
  const copy = fs.copyFileSync;
  fs.copyFileSync = function(source, destination, ...rest) {
    if (plan.mode === 'interrupted-jd-compensation' && String(destination).startsWith(plan.jdsRoot + path.sep)
        && String(source).includes('88110003')) throw new Error('Injected second JD copy failure');
    return copy(source, destination, ...rest);
  };
  let calls = 0;
  childProcess.spawnSync = function(command, args, options) {
    if (args[0] !== 'tracker.mjs' || args[1] !== 'sync') return original(command, args, options);
    calls++;
    if (calls === 2 && plan.mode === 'rollback-sync-failure') {
      writeFileSync(plan.faultLog, JSON.stringify({ calls, rollback_sync_blocked: true }));
      return { status: 73, stdout: '', stderr: 'Injected compensating sync failure' };
    }
    const result = original(command, args, options);
    if (calls === 1 && result.status === 0) {
      const db = new DatabaseSync(plan.dbFile, { readOnly: true });
      const rows = db.prepare('SELECT * FROM applications ORDER BY id').all(); db.close();
      writeFileSync(plan.indexBeforeRollback, JSON.stringify({ rows, calls }));
      if (plan.mode === 'partial-initial-sync' || plan.mode === 'interrupted-jd-compensation') {
        writeFileSync(plan.faultLog, JSON.stringify({ calls, initial_sync_completed_then_failed: true }));
        return { ...result, status: 72, stderr: 'Injected failure after canonical initial sync completed' };
      }
      for (const name of readdirSync(plan.jdsRoot)) {
        if (name.startsWith('discovery-' + plan.runId + '-')) unlinkSync(path.join(plan.jdsRoot, name));
      }
      writeFileSync(plan.faultLog, JSON.stringify({ calls, new_jd_archives_removed: true }));
    }
    return result;
  };
  syncBuiltinESMExports();
}
`;

export function runRollbackE2E({ outRoot, sourceRoot } = {}) {
  const all = [];
  for (const mode of ['transient-health-warning', 'partial-initial-sync', 'rollback-sync-failure', 'interrupted-jd-compensation']) {
    const fx = createCareerFixture({ name: mode, outRoot, sourceRoot });
    try {
      seedCandidate(fx);
      const prepare = (name, jobs) => {
        const run = seedScan(fx, { name, jobs });
        fx.run(`${name}-plan`, script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
        mergeAll(fx, run, writeScoreParts(fx, run));
        return run;
      };
      const prior = prepare('preexisting', [{ id: '88110001', company: 'Fictional Existing Co' }]);
      fx.run('preexisting-commit', script('commit-scan.mjs'), ['--run', prior, '--career-ops', fx.codeRoot, '--date', SCAN_DATE]);
      const trackerFile = path.join(fx.dataRoot, 'data/applications.md');
      const dbFile = path.join(fx.dataRoot, 'data/applications.db');
      const beforeIndex = indexState(dbFile, trackerFile);
      const beforeTracker = readFileSync(trackerFile, 'utf8');
      const beforeHistory = readFileSync(path.join(fx.dataRoot, 'data/scan-history.tsv'), 'utf8');
      const beforeRunSummary = readFileSync(path.join(fx.dataRoot, 'data/scan-runs.tsv'), 'utf8');
      const beforeReports = treeManifest(path.join(fx.dataRoot, 'reports'));
      const beforeJds = treeManifest(path.join(fx.dataRoot, 'jds'));
      fx.write(path.join(fx.root, 'index-baseline.json'), beforeIndex);
      const run = prepare('failed-scan', [{ id: '88110002', company: 'Fictional New One Co' },
        { id: '88110003', company: 'Fictional New Two Co' }]);
      const plan = { mode, committer: script('commit-scan.mjs'), dbFile, jdsRoot: path.join(fx.dataRoot, 'jds'),
        runId: path.basename(run), faultLog: path.join(fx.root, 'fault-injected.json'),
        indexBeforeRollback: path.join(fx.root, 'index-before-rollback.json') };
      const faultFile = fx.write(path.join(fx.root, 'fault-plan.json'), plan);
      const preload = fx.write(path.join(fx.root, 'inject-fault.mjs'), PRELOAD);
      fx.run('commit-with-fault', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', SCAN_DATE],
        { expect: 1, env: { SCAN_ROLLBACK_FAULT: faultFile, NODE_OPTIONS: `--import=${JSON.stringify(preload)}` } });
      const receipt = parse(path.join(run, 'receipt.json'));
      const evidence = parse(path.join(run, 'commit-failure.json'));
      const afterIndex = indexState(dbFile, trackerFile);
      fx.write(path.join(fx.root, 'index-after-rollback.json'), afterIndex);
      fx.check('fault is reached after expected canonical index write', existsSync(plan.faultLog)
        && parse(plan.indexBeforeRollback).rows.length === (mode === 'interrupted-jd-compensation' ? 1 : 3));
      fx.check('failed receipt is explicit and has no committed evaluations', receipt.status === 'FAILED'
        && receipt.committed_evaluated_keys.length === 0 && receipt.commit_failure.artifact === 'commit-failure.json');
      fx.check('canonical Markdown and unrelated history remain byte-identical', readFileSync(trackerFile, 'utf8') === beforeTracker
        && readFileSync(path.join(fx.dataRoot, 'data/scan-history.tsv'), 'utf8') === beforeHistory);
      fx.check('existing report and JD files survive; owned files and mapping are gone',
        JSON.stringify(treeManifest(path.join(fx.dataRoot, 'reports'))) === JSON.stringify(beforeReports)
        && JSON.stringify(treeManifest(path.join(fx.dataRoot, 'jds'))) === JSON.stringify(beforeJds)
        && !existsSync(path.join(run, 'rendered-reports.json')));
      fx.check('failed scan appends no completed-run summary', readFileSync(path.join(fx.dataRoot, 'data/scan-runs.tsv'), 'utf8') === beforeRunSummary);
      const rollback = evidence.rollback_attempts.at(-1);
      if (mode !== 'partial-initial-sync' && mode !== 'interrupted-jd-compensation') {
        const original = evidence.before_rollback.career_ops_pipeline.after;
        fx.check('original transient raw warnings and full verifier output survive', original.raw_warnings >= 2
          && original.unresolved.length === 2 && original.unresolved.every(message => message.includes('no jds/ capture found'))
          && original.verifier_output.includes('no jds/ capture found')
          && original.resolved.some(item => item.reason === 'exact_discovery_jd_archive')
          && JSON.stringify(receipt.career_ops_pipeline.before_rollback) === JSON.stringify(original));
        fx.check('post-rollback health is separately retained and clean', evidence.after_rollback.career_ops_pipeline.after.warnings === 0
          && receipt.career_ops_pipeline.after.warnings === 0);
      } else {
        fx.check('initial sync failure retained as trigger', evidence.trigger_errors.some(value => value.includes('initial sync completed')));
      }
      if (mode === 'interrupted-jd-compensation') {
        fx.check('failed early compensation sync is retried despite cleared owned rows', evidence.rollback_attempts.length === 2
          && evidence.rollback_attempts[0].tracker_rows === 2 && evidence.rollback_attempts[0].tracker_index_sync === 'FAILED'
          && rollback.tracker_rows === 0 && rollback.tracker_index_sync === 'COMPLETE');
        fx.check('original compensation error remains after successful second compensation', receipt.system_errors.some(value => value.includes('rollback tracker index sync failed')));
      }
      if (mode === 'rollback-sync-failure') {
        fx.check('compensating sync failure remains explicit despite clean health', rollback.status === 'FAILED'
          && rollback.tracker_index_sync === 'FAILED'
          && receipt.system_errors.some(value => value.includes('Injected compensating sync failure'))
          && receipt.career_ops_pipeline.after.warnings === 0);
        fx.check('fault demonstrates detectable stale index with three rows', afterIndex.rows.length === 3
          && JSON.stringify(afterIndex.rows) !== JSON.stringify(beforeIndex.rows));
        // The fixture demonstrates the documented operator action, never a live recovery.
        fx.run('fixture-operator-index-recovery', path.join(fx.codeRoot, 'tracker.mjs'), ['sync'], { cwd: fx.codeRoot });
        const repaired = indexState(dbFile, trackerFile);
        fx.write(path.join(fx.root, 'index-after-operator-recovery.json'), repaired);
        fx.check('official sync alone repairs fixture index without rewriting failed receipt', JSON.stringify(repaired.rows) === JSON.stringify(beforeIndex.rows)
          && repaired.tracker_content === beforeIndex.tracker_content && readFileSync(path.join(run, 'receipt.json'), 'utf8') === `${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        fx.check('compensating official sync completes', rollback.status === 'COMPLETE' && rollback.tracker_index_sync === 'COMPLETE');
        fx.check('all indexed fields and status history equal baseline', JSON.stringify(afterIndex.rows) === JSON.stringify(beforeIndex.rows)
          && JSON.stringify(afterIndex.events) === JSON.stringify(beforeIndex.events));
        fx.check('compensated tracker bytes equal baseline', afterIndex.tracker_content === beforeIndex.tracker_content);
      }
      all.push(fx.finish({ run, mode, receipt: path.join(run, 'receipt.json'), failure_evidence: path.join(run, 'commit-failure.json') }));
    } catch (error) {
      fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
      throw error;
    }
  }
  return { passed: all.every(item => item.passed), scenarios: all, assertions: all.reduce((sum, item) => sum + item.assertions.length, 0),
    commands: all.reduce((sum, item) => sum + item.commands, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const outRoot = at >= 0 ? path.resolve(process.argv[at + 1]) : path.join(DISCOVERY_ROOT, '.local/scan-rollback', new Date().toISOString().replace(/[:.]/g, '-'));
  try { console.log(JSON.stringify(runRollbackE2E({ outRoot }), null, 2)); }
  catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
