#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveAcquisition } from './run-adapters.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUN_ID = /^(?:perm-)?\d{8}-\d{6}$/;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 48;
// Longer than any quiet stretch of a healthy coordinator or worker.
const QUIET_MS = 45 * 60 * 1000;

const STAGES = [
  ['commit', 'rendered-reports.json', 'Inspect Career-Ops writes and commit diagnostics before recovery; do not blindly recommit.'],
  ['workers', 'assignments.json', 'Reuse valid worker parts, resume incomplete assignments, then commit.'],
  ['planning', 'triage/canonical-url-resolutions.json', 'Repair the planner input and run the standalone planner.'],
  ['prepare', 'source-run.json', 'Inspect source failures, use eligible retries, then run npm run daily-scan:prepare.'],
];

function stageOf(runRoot) {
  const [stage, , nextAction] = STAGES.find(([, file]) => existsSync(path.join(runRoot, file)))
    ?? ['sources', '', 'Run npm run daily-scan:sources with --resume, then continue as after normal acquisition.'];
  return { stage, next_action: nextAction };
}

function newestChange(runRoot) {
  const entries = readdirSync(runRoot, { recursive: true }).map(name => path.join(runRoot, name));
  // An active run renames temporary files between the listing and the stat.
  return Math.max(...[runRoot, ...entries].map(entry => { try { return lstatSync(entry).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } }));
}

function activeReason(runRoot, now) {
  if (liveAcquisition(runRoot).length) return 'live_process';
  return now - newestChange(runRoot) < QUIET_MS ? 'recent_artifacts' : null;
}

export function pendingRuns({ runsRoot = path.join(PROJECT_ROOT, 'runs'), maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now() } = {}) {
  const runs = [];
  for (const runId of readdirSync(runsRoot).filter(name => RUN_ID.test(name)).sort()) {
    const runRoot = path.join(runsRoot, runId);
    const baseline = path.join(runRoot, 'baseline.json');
    if (!existsSync(baseline) || existsSync(path.join(runRoot, 'receipt.json'))) continue;
    if (now - lstatSync(baseline).mtimeMs > maxAgeHours * HOUR_MS) continue;
    const reason = activeReason(runRoot, now);
    runs.push({ run_id: runId, state: reason ? 'ACTIVE' : 'PENDING', ...stageOf(runRoot), ...(reason ? { active_reason: reason } : {}) });
  }
  const status = runs.some(run => run.state === 'PENDING') ? 'PENDING' : runs.length ? 'ACTIVE' : 'NONE';
  return { status, runs };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const runsRoot = option('--runs');
  const maxAgeHours = option('--max-age-hours');
  console.log(JSON.stringify(pendingRuns({ ...(runsRoot ? { runsRoot: path.resolve(runsRoot) } : {}), ...(maxAgeHours ? { maxAgeHours: Number(maxAgeHours) } : {}) }), null, 2));
}
