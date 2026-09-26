import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoogleQueries, evaluateOfficialLocation, evaluateOfficialTitle, loadGoogleAtsConfig, runGoogleAtsDirect } from '../adapters/google_ats_direct_scan.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMBINE = path.join(PROJECT_ROOT, 'src/combine.mjs');
const VERIFY = path.join(PROJECT_ROOT, 'src/run-contract.mjs');
const NOW = '2026-08-07T08:00:00.000Z';
const RECENT = '2026-08-07T01:00:00.000Z';
const LONG = 'Build reliable distributed backend systems and APIs on cloud infrastructure. '.repeat(8);

function fixture() {
  const discoveryRoot = mkdtempSync(path.join(os.tmpdir(), 'google-ats-direct-'));
  const careerRoot = path.join(discoveryRoot, 'career-ops');
  mkdirSync(path.join(careerRoot, 'reports'), { recursive: true });
  const historical = 'https://jobs.lever.co/priorco/f7777777-7777-4777-8777-777777777777';
  writeFileSync(path.join(careerRoot, 'reports/001-prior.md'), `Official URL: ${historical}\n`);

  const ashby = 'https://jobs.ashbyhq.com/acme/a1111111-1111-4111-8111-111111111111';
  const lever = 'https://jobs.lever.co/leverco/b2222222-2222-4222-8222-222222222222';
  const greenhouse = 'https://job-boards.greenhouse.io/greenhouseco/jobs/1234567';
  const workday = 'https://example.wd5.myworkdayjobs.com/External/job/Seattle/Senior-Engineer_R12345';
  const smart = 'https://jobs.smartrecruiters.com/SmartCo/744000012345678-senior-engineer';
  const amazon = 'https://jobs.lever.co/amazon/c3333333-3333-4333-8333-333333333333';
  const old = 'https://jobs.lever.co/oldco/d4444444-4444-4444-8444-444444444444';
  const staff = 'https://jobs.lever.co/staffco/e5555555-5555-4555-8555-555555555555';
  const support = 'https://jobs.lever.co/supportco/e6666666-6666-4666-8666-666666666666';
  const foreign = 'https://jobs.lever.co/foreignco/e7777777-7777-4777-8777-777777777777';
  const result = link => ({ position: 1, title: 'Senior Backend Engineer', link, snippet: 'Official job posting', date: '3 hours ago' });

  const data = {
    serp: {
      'ashby:0': { search_metadata: { status: 'Success' }, organic_results: [result(ashby), result(ashby)] },
      'lever:0': { search_metadata: { status: 'Success' }, organic_results: [result(lever), result(amazon), result(historical), result(old), result(staff), result(support), result(foreign)] },
      'greenhouse:0': { search_metadata: { status: 'Success' }, organic_results: [result(greenhouse)] },
      'workday:0': { search_metadata: { status: 'Success' }, organic_results: [result(workday)] },
      'smartrecruiters:0': { search_metadata: { status: 'Success' }, organic_results: [result(smart)] },
    },
    http: {
      'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true': { json: { jobs: [{ title: 'Senior Backend Engineer', location: 'Seattle', descriptionPlain: LONG, publishedAt: RECENT, jobUrl: ashby, applyUrl: `${ashby}/application` }] } },
      'https://api.lever.co/v0/postings/leverco/b2222222-2222-4222-8222-222222222222': { json: { id: 'b2222222-2222-4222-8222-222222222222', text: 'Senior Platform Engineer', categories: { location: 'Remote, United States', commitment: 'Contract' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: lever, applyUrl: `${lever}/apply` } },
      'https://api.lever.co/v0/postings/amazon/c3333333-3333-4333-8333-333333333333': { json: { id: 'c3333333-3333-4333-8333-333333333333', text: 'Senior Software Engineer', categories: { location: 'Seattle' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: amazon, applyUrl: `${amazon}/apply` } },
      'https://api.lever.co/v0/postings/oldco/d4444444-4444-4444-8444-444444444444': { json: { id: 'd4444444-4444-4444-8444-444444444444', text: 'Senior Software Engineer', categories: { location: 'Remote' }, createdAt: Date.parse('2026-08-05T01:00:00.000Z'), descriptionPlain: LONG, hostedUrl: old, applyUrl: `${old}/apply` } },
      'https://api.lever.co/v0/postings/staffco/e5555555-5555-4555-8555-555555555555': { json: { id: 'e5555555-5555-4555-8555-555555555555', text: 'Staff Software Engineer', categories: { location: 'United States' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: staff, applyUrl: `${staff}/apply` } },
      'https://api.lever.co/v0/postings/supportco/e6666666-6666-4666-8666-666666666666': { json: { id: 'e6666666-6666-4666-8666-666666666666', text: 'Customer Support Representative', categories: { location: 'United States' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: support, applyUrl: `${support}/apply` } },
      'https://api.lever.co/v0/postings/foreignco/e7777777-7777-4777-8777-777777777777': { json: { id: 'e7777777-7777-4777-8777-777777777777', text: 'Senior Backend Engineer', categories: { location: 'Remote - EMEA' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: foreign, applyUrl: `${foreign}/apply` } },
      'https://boards-api.greenhouse.io/v1/boards/greenhouseco/jobs/1234567?content=true': { json: { id: 1234567, title: 'Senior Distributed Systems Engineer', company_name: 'Greenhouse Co', location: { name: 'Seattle' }, content: LONG, absolute_url: greenhouse } },
      [greenhouse]: { body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Senior Distributed Systems Engineer', datePosted: RECENT, description: LONG, hiringOrganization: { name: 'Greenhouse Co' }, jobLocation: { address: { addressLocality: 'Seattle', addressRegion: 'WA', addressCountry: 'US' } }, identifier: { value: '1234567' }, url: greenhouse })}</script>` },
      'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/job/Seattle/Senior-Engineer_R12345': { json: { jobPostingInfo: { title: 'Senior Infrastructure Engineer', company: 'Example', location: 'Bellevue, WA', startDate: RECENT, jobDescription: LONG, externalUrl: workday, jobReqId: 'R12345' } } },
      'https://api.smartrecruiters.com/v1/companies/SmartCo/postings/744000012345678': { json: { id: '744000012345678', name: 'Senior AI Infrastructure Engineer', releasedDate: RECENT, ref: smart, company: { name: 'Smart Co' }, location: { city: 'Seattle', region: 'WA', country: 'US' }, jobAd: { sections: { jobDescription: { text: LONG } } } } },
    },
  };
  const fixtureFile = path.join(discoveryRoot, 'fixture.json');
  writeFileSync(fixtureFile, JSON.stringify(data));
  return { discoveryRoot, careerRoot, fixtureFile };
}

test('Google ATS queries preserve configured roles, locations, exclusions and sites', () => {
  const config = { ...loadGoogleAtsConfig(), role_terms: ['Backend Engineer'], location_terms: ['US Remote'], negative_terms: ['intern'] };
  const queries = buildGoogleQueries(config);
  assert.deepEqual(queries.map(row => row.ats), config.ats_sites.map(site => site.id));
  for (const { query, domains } of queries) {
    for (const term of ['"Backend Engineer"', '"US Remote"', '-intern', ...domains.map(domain => `site:${domain}`)]) assert.ok(query.includes(term), term);
  }
});

test('one exhausted SERP query is audited but does not fail the adapter', async () => {
  const fx = fixture();
  const data = JSON.parse(readFileSync(fx.fixtureFile, 'utf8'));
  delete data.serp['smartrecruiters:0'];
  writeFileSync(fx.fixtureFile, JSON.stringify(data));
  const summary = await runGoogleAtsDirect({ ...fx, configFile: path.join(PROJECT_ROOT, 'config/google-ats-direct.json'), runId: 'partial-serp', now: NOW, dryRun: false });
  assert.equal(summary.status, 'SUCCESS');
  assert.equal(summary.query_errors, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.unique_jobs, 4);
  const audit = JSON.parse(readFileSync(path.join(fx.discoveryRoot, 'runs/partial-serp/sources/google-ats-direct/serp-audit.json')));
  assert.equal(audit.failures.length, 1);
  assert.equal(audit.failures[0].attempts, 4);
});

test('all exhausted SERP queries fail the adapter', async () => {
  const fx = fixture();
  const data = JSON.parse(readFileSync(fx.fixtureFile, 'utf8'));
  data.serp = {};
  writeFileSync(fx.fixtureFile, JSON.stringify(data));
  const summary = await runGoogleAtsDirect({ ...fx, configFile: path.join(PROJECT_ROOT, 'config/google-ats-direct.json'), runId: 'all-serp-failed', now: NOW, dryRun: false });
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.query_errors, 5);
  assert.equal(summary.errors, 5);
});

test('official title and location scope rejects Staff, unrelated roles, and non-US regions', () => {
  const config = loadGoogleAtsConfig();
  assert.equal(evaluateOfficialTitle('Staff Software Engineer', config).exclusion_id, 'title-staff');
  assert.equal(evaluateOfficialTitle('Customer Support Representative', config).exclusion_id, 'title-no-target-role-term');
  assert.equal(evaluateOfficialTitle('Senior Backend Engineer', config).allowed, true);
  assert.equal(evaluateOfficialLocation('Remote - EMEA', config).allowed, false);
  assert.equal(evaluateOfficialLocation('Toronto, ON, ca', config).allowed, false);
  assert.equal(evaluateOfficialLocation('Mountain View, CALIFORNIA, us', config).allowed, true);
  assert.equal(evaluateOfficialLocation('Remote', config).allowed, true);
});

test('Google ATS Direct captures five official ATS JDs and audits exclusions and exact duplicates', async () => {
  const fx = fixture();
  const failedRoot = path.join(fx.discoveryRoot, 'runs/google-fixture/sources/google-ats-direct');
  mkdirSync(path.join(failedRoot, 'jobs'), { recursive: true });
  writeFileSync(path.join(failedRoot, 'summary.json'), JSON.stringify({ schema_version: 1, run_id: 'google-fixture', adapter: 'google-ats-direct', status: 'FAILED', raw_rows: 0, unique_jobs: 0, markdown_jobs: 0, errors: 1 }));
  const summary = await runGoogleAtsDirect({ ...fx, configFile: path.join(PROJECT_ROOT, 'config/google-ats-direct.json'), runId: 'google-fixture', now: NOW, dryRun: false });
  assert.equal(summary.status, 'SUCCESS');
  assert.equal(summary.raw_rows, 12);
  assert.equal(summary.unique_jobs, 5);
  assert.equal(summary.same_run_duplicates, 1);
  assert.equal(summary.historical_duplicates, 1);
  assert.equal(summary.employer_exclusions, 1);
  assert.equal(summary.outside_24_hours, 1);
  assert.equal(summary.title_exclusions, 2);
  assert.equal(summary.location_exclusions, 1);

  const source = path.join(fx.discoveryRoot, 'runs/google-fixture/sources/google-ats-direct');
  assert.equal(readdirSync(path.join(fx.discoveryRoot, 'runs/google-fixture/adapter-attempts')).length, 1);
  const serpAudit = JSON.parse(readFileSync(path.join(source, 'serp-audit.json')));
  assert.equal(serpAudit.requests.length, 5);
  assert.ok(serpAudit.requests.every(row => row.parameters.tbs === 'qdr:d' && !('api_key' in row.parameters)));
  const dedup = JSON.parse(readFileSync(path.join(source, 'dedup-audit.json')));
  assert.equal(dedup.same_run_duplicate_count, 1);
  assert.equal(dedup.historical_duplicate_count, 1);
  const exclusions = JSON.parse(readFileSync(path.join(source, 'excluded-employers.json')));
  assert.equal(exclusions.results[0].reason, 'Amazon/AWS employer exclusion');
  const scopeExclusions = JSON.parse(readFileSync(path.join(source, 'scope-exclusions.json')));
  assert.equal(scopeExclusions.excluded_count, 3);
  assert.equal(scopeExclusions.title_excluded_count, 2);
  assert.equal(scopeExclusions.location_excluded_count, 1);
  assert.deepEqual(new Set(scopeExclusions.results.map(row => row.exclusion_id)), new Set(['title-staff', 'title-no-target-role-term', 'location-outside-us-scope']));

  const run = path.join(fx.discoveryRoot, 'runs/google-fixture');
  const registry = path.join(fx.discoveryRoot, 'google-ats-standalone-registry.json');
  writeFileSync(registry, JSON.stringify({
    schema_version: 1,
    registry_version: '1',
    profile_id: 'google-ats-standalone',
    contract_version: 2,
    identity_schema: 'posting-key-v1',
    minimum_successful_adapters: 1,
    max_post_age_hours: 24,
    adapters: {
      'google-ats-direct': {
        kind: 'google-ats',
        summary_path: 'sources/google-ats-direct/summary.json',
        config_path: 'config/google-ats-direct.json',
        employer_exclusions: true,
      },
    },
  }));
  const env = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: registry };
  execFileSync(process.execPath, [COMBINE, '--run', run], { env, stdio: 'pipe' });
  const acquisition = JSON.parse(readFileSync(path.join(run, 'acquisition.json'), 'utf8'));
  assert.equal(acquisition.acquired.length, 5);
  assert.ok(acquisition.keys.includes('ashby:acme:A1111111-1111-4111-8111-111111111111'));
  const officialRemote = acquisition.acquired.find(item => item.primary_key === 'lever:leverco:B2222222-2222-4222-8222-222222222222');
  assert.equal(officialRemote.workplace_type, 'remote');
  assert.equal(officialRemote.structured_remote_signal, true);
  assert.equal(officialRemote.employment_type, 'Contract');
  assert.deepEqual(officialRemote.employment_types, ['Contract']);
  assert.equal(officialRemote.employment_type_source, 'lever-api:categories.commitment');
  assert.match(readFileSync(path.join(run, officialRemote.jd_path), 'utf8'), /\*\*Employment Type:\*\* Contract/);
  const officialLocal = acquisition.acquired.find(item => item.primary_key === 'ashby:acme:A1111111-1111-4111-8111-111111111111');
  assert.equal(officialLocal.structured_remote_signal, false);
  const verification = JSON.parse(execFileSync(process.execPath, [VERIFY, '--run', run], { env, encoding: 'utf8' }));
  assert.equal(verification.ok, true);
  assert.equal(verification.acquired, 5);
});
