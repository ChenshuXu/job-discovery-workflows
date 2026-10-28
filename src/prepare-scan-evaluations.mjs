#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { combineRun } from './combine.mjs';
import { validateRun } from './run-contract.mjs';
import { resolveCanonicalUrls } from './resolve-canonical-urls.mjs';
import { planEvaluations } from './plan-scan-evaluations.mjs';
import { compactSummary } from './scan-summary.mjs';

try {
  const { values, tokens } = parseArgs({ options: {
    run: { type: 'string' }, 'career-ops': { type: 'string' },
    'runtime-config': { type: 'string' }, 'allow-blacklisted': { type: 'string' },
    force: { type: 'boolean', default: false },
  }, tokens: true });
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate CLI options are not allowed');
  if (!values.run || !values['career-ops']) throw new Error('Usage: npm run daily-scan:prepare -- --run runs/<run-id> --career-ops <dir> [--runtime-config <file>] [--allow-blacklisted key1,key2] [--force]');
  const allowBlacklisted = (values['allow-blacklisted'] ?? '').split(',').filter(Boolean);
  if ('allow-blacklisted' in values && !allowBlacklisted.length) throw new Error('--allow-blacklisted requires exact posting keys authorized by the user');
  const root = path.resolve(values.run);
  // Recombining would replace the scoped acquisition used by existing work.
  for (const file of ['receipt.json', 'rendered-reports.json', 'assignments.json']) {
    if (existsSync(path.join(root, file))) throw new Error(`${file} exists; inspect the run and use the standalone recovery commands instead of prepare`);
  }
  const resolutionFile = path.join(root, 'triage/canonical-url-resolutions.json');
  if (existsSync(resolutionFile) && !values.force) throw new Error(`resolution ledger exists; recover with the standalone planner or explicitly use --force: ${resolutionFile}`);

  const combined = combineRun(root);
  const beforeResolution = validateRun(root);
  if (beforeResolution.errors.length) throw new Error(`run contract failed: ${beforeResolution.errors.join('; ')}`);
  const resolved = await resolveCanonicalUrls(root, { force: values.force });
  const { output, file } = planEvaluations(root, values['runtime-config'], values['career-ops'], { allowBlacklisted });
  const afterPlanning = validateRun(root);
  if (afterPlanning.errors.length) throw new Error(`run contract failed after planning: ${afterPlanning.errors.join('; ')}`);

  console.log(JSON.stringify({ ...compactSummary({ stage: 'prepare', status: 'READY', artifact: file,
    counts: { acquired: combined.acquired.length, duplicates_removed: combined.duplicates_removed,
      cross_source_merges: combined.cross_source_merges,
      resolved: resolved.results.filter(item => item.status === 'RESOLVED').length,
      unresolved: resolved.results.filter(item => item.status === 'UNRESOLVED').length,
      assigned: Object.values(output.assignments).reduce((count, keys) => count + keys.length, 0),
      workers: Object.fromEntries(Object.entries(output.assignments).map(([worker, keys]) => [worker, keys.length])) },
  }), next_action: 'See acquisition.json and triage/canonical-url-resolutions.json.' }));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
