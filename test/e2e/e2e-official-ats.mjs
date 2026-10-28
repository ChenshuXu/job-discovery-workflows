#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createCareerFixture, DISCOVERY_ROOT, PUBLIC_FIXTURE_ROOT, treeManifest } from './e2e-career-fixture.mjs';
import { seedCandidate, EVIDENCE_TEXT, writeScoreParts, mergeAll } from './e2e-scan-inputs.mjs';
import { postingKey } from '../../src/posting-identity.mjs';

const at = process.argv.indexOf('--out');
const fx = createCareerFixture({ name: 'official-ats', ...(at < 0 ? {} : { outRoot: process.argv[at + 1] }) });
const adapter = path.join(DISCOVERY_ROOT, 'src/adapters/career_ops_ats_scan.mjs');
const script = name => path.join(DISCOVERY_ROOT, 'src', name);
const parse = file => JSON.parse(readFileSync(file, 'utf8'));
const now = '2026-10-03T12:00:00Z', recent = '2026-10-03T06:00:00Z';
const url = id => `https://jobs.lever.co/fictional/${id}1111111-1111-4111-8111-111111111111`;
const body = Object.values(EVIDENCE_TEXT).join('\n') + '\nThis role requires backend service ownership and experience with distributed systems, APIs, data storage, testing, debugging and production incident response.';
try {
  seedCandidate(fx);
  const before = JSON.stringify(treeManifest(fx.dataRoot));
  const mockRoot = path.join(fx.root, 'scanner');
  const upstream = { sources: ['greenhouse', 'lever', 'ashby'], datasetStatus: { greenhouse: 'ok', lever: 'ok', ashby: 'ok' },
    companiesAvailable: 800, companiesScanned: 450, capHit: true, stoppedByOutage: false, unreachableBoards: 0, cappedBoards: 0,
    offers: ['a', 'b', 'c', 'd', 'e', 'g'].map(id => ({ company: 'Fictional', title: 'Senior Backend Engineer', url: url(id), source: 'lever-full' })) };
  fx.write(path.join(mockRoot, 'package.json'), '{"type":"module"}');
  const responseFile = fx.write(path.join(mockRoot, 'response.json'), upstream);
  fx.write(path.join(mockRoot, 'scan-ats-full.mjs'), `
import fs from 'node:fs';import assert from 'node:assert/strict';
assert.ok(process.argv.includes('--dry-run'));assert.ok(process.argv.includes('--json'));
assert.equal(process.env.NODE_OPTIONS,'');
assert.ok(process.env.CAREER_OPS_ROOT.includes('/sources/official-ats/upstream'));
assert.ok(process.env.CAREER_OPS_SCAN_HISTORY.startsWith(process.env.CAREER_OPS_ROOT));
assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(fx.dataRoot, 'data/pipeline.md'))},'corrupt'),/denied|Access/i);
const response=JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)},'utf8'));
if(response.exitCode)process.exit(response.exitCode);
console.log(response.raw ?? JSON.stringify(response));
`);
  const http = {};
  for (const id of ['a', 'b', 'c', 'd', 'e', 'g']) {
    const job = { id: url(id).split('/').at(-1), text: 'Senior Backend Engineer', hostedUrl: url(id), createdAt: Date.parse(recent),
      categories: { location: id === 'b' ? 'Remote, United States' : id === 'c' ? 'London, United Kingdom' : 'Seattle, WA', commitment: 'Full-time' },
      workplaceType: id === 'b' ? 'remote' : 'hybrid', descriptionPlain: body,
      lists: [{ text: 'Requirements', content: '<li>Backend APIs and observability</li>' }], additionalPlain: 'Permanent full-time position.' };
    if (id === 'd') job.createdAt = Date.parse('2026-09-29');
    if (id === 'e') job.hostedUrl = url('f');
    if (id === 'g') job.descriptionPlain = 'Why AWS\nAmazon is an equal opportunity employer\n' + body;
    http[`https://api.lever.co/v0/postings/fictional/${job.id}`] = { json: job };
  }
  const fixture = fx.write(path.join(fx.root, 'http.json'), { now, http });
  const config = fx.write(path.join(fx.root, 'official-ats.json'), { ...parse(path.join(DISCOVERY_ROOT, 'test/fixtures/config/official-ats.json')),
    employer_exclusions: parse(path.join(DISCOVERY_ROOT, 'test/fixtures/config/jobspy-ego.json')).employer_exclusions });
  const run = path.join(fx.root, 'runs', 'source-integration');
  const args = ['--discovery-root', fx.root, '--run-id', path.basename(run), '--career-ops', mockRoot, '--fixture', fixture, '--config', config];
  fx.run('capture-partial', adapter, args, { expect: 1 });
  const source = path.join(run, 'sources/official-ats');
  const summary = parse(path.join(source, 'summary.json'));
  fx.check('failed detail keeps validated JDs and reports partial failure', summary.status === 'FAILED' && summary.markdown_jobs === 3 && summary.errors === 1);
  fx.check('age and identity gates are audited', parse(path.join(source, 'candidate-audit.json')).results.some(row => row.status === 'SKIPPED_AGE'));
  fx.check('existing employer rules reject official legal attribution', parse(path.join(source, 'excluded-employers.json')).excluded_count === 1);
  fx.check('complete Lever body survives capture', readFileSync(path.join(source, 'jobs', postingKey(url('a')).replace(/[^A-Za-z0-9._-]/g, '-') + '.md'), 'utf8').includes('Backend APIs and observability'));
  fx.check('source never changes Career-Ops data', before === JSON.stringify(treeManifest(fx.dataRoot)));
  fx.run('reject-overwrite', adapter, args, { expect: 1 });
  for (const [label, payload, status] of [
    ['empty', { ...upstream, offers: [] }, 'EMPTY'],
    ['healthy', { ...upstream, offers: upstream.offers.slice(0, 3) }, 'SUCCESS'],
    ['unreachable', { ...upstream, unreachableBoards: 1, offers: upstream.offers.slice(0, 1) }, 'FAILED'],
    ['stale-directory', { ...upstream, datasetStatus: { ...upstream.datasetStatus, lever: 'stale' }, offers: upstream.offers.slice(0, 1) }, 'FAILED'],
    ['bad-json', { raw: 'not json' }, 'FAILED'],
    ['scanner-exit', { exitCode: 2 }, 'FAILED'],
  ]) {
    fx.write(responseFile, payload);
    fx.run(label, adapter, args.map(value => value === 'source-integration' ? label : value), { expect: status === 'FAILED' ? 1 : 0 });
    fx.check(`${label}: truthful source status`, parse(path.join(fx.root, 'runs', label, 'sources/official-ats/summary.json')).status === status);
  }
  const badConfig = fx.write(path.join(fx.root, 'bad-config.json'), { schema_version: 1 });
  fx.run('invalid-config', adapter, [...args.map(value => value === 'source-integration' ? 'invalid-config' : value), '--config', badConfig], { expect: 1 });
  fx.check('bootstrap failure remains an isolated source failure', parse(path.join(fx.root, 'runs/invalid-config/sources/official-ats/summary.json')).status === 'FAILED');
  fx.run('dry-run', adapter, ['--dry-run', '--career-ops', mockRoot]);
  fx.run('reject-unsafe-run', adapter, ['--run-id', '../escape'], { expect: 1 });
  // A second healthy source lets the partial ATS capture flow through normal liveness.
  const healthy = path.join(run, 'sources/jobspy');
  mkdirSync(path.join(healthy, 'jobs'), { recursive: true });
  const duplicate = readFileSync(path.join(source, 'jobs', postingKey(url('a')).replace(/[^A-Za-z0-9._-]/g, '-') + '.md'), 'utf8');
  fx.write(path.join(healthy, 'jobs/duplicate.md'), duplicate);
  fx.write(path.join(healthy, 'summary.json'), { schema_version: 1, run_id: path.basename(run), adapter: 'jobspy', status: 'SUCCESS', raw_rows: 1, unique_jobs: 1, markdown_jobs: 1, errors: 0 });
  fx.write(path.join(healthy, 'excluded-employers.json'), { schema_version: 1, run_id: path.basename(run), excluded_count: 0, results: [] });
  const definitions = parse(path.join(PUBLIC_FIXTURE_ROOT, 'config/discovery-adapters.v1.example.json')).adapters;
  const selected = ['jobspy', 'official-ats'];
  const registry = fx.write(path.join(fx.root, 'registry.json'), { schema_version: 1, registry_version: '1', contract_version: 2, identity_schema: 'posting-key-v1', minimum_successful_adapters: 1,
    adapters: Object.fromEntries(selected.map(id => [id, { ...definitions[id], enabled: true }])) });
  fx.run('baseline', script('verify-scan-receipt.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--capture-baseline'], { env: { JOB_DISCOVERY_ADAPTER_REGISTRY: registry } });
  // Keep source integration on the legacy review contract; dedicated PERM E2E covers company review.
  const baselineFile = path.join(run, 'baseline.json'), baseline = parse(baselineFile);
  if (baseline.perm_history) delete baseline.perm_history.company_review;
  fx.write(baselineFile, baseline);
  fx.run('combine', script('combine.mjs'), ['--run', run]);
  fx.check('existing exact-key merge removes cross-source duplicate', parse(path.join(run, 'acquisition.json')).duplicates_removed === 1);
  fx.run('contract', script('run-contract.mjs'), ['--run', run]);
  fx.run('resolve', script('resolve-canonical-urls.mjs'), ['--run', run]);
  fx.run('plan', script('plan-scan-evaluations.mjs'), ['--run', run, '--career-ops', fx.codeRoot]);
  const plan = writeScoreParts(fx, run);
  fx.check('existing location gate excludes London and admits structured US Remote', Object.values(plan.assignments).flat().length === 2);
  mergeAll(fx, run, plan);
  fx.run('commit', script('commit-scan.mjs'), ['--run', run, '--career-ops', fx.codeRoot, '--date', '2026-10-03']);
  fx.check('integrated receipt completes', parse(path.join(run, 'receipt.json')).status === 'COMPLETE');
  console.log(JSON.stringify(fx.finish({ scope: 'Deterministic upstream CLI and HTTP fixtures through real Daily Scan planner, merger and isolated canonical writers; no live model evaluation.' })));
} catch (error) {
  fx.write(path.join(fx.root, 'failure.json'), { error: error.stack ?? error.message });
  console.error(error.stack ?? error.message); process.exitCode = 1;
}
