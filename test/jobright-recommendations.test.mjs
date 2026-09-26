import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJobrightArtifacts, collectJobrightRecommendations, drainJobrightBatches, loadJobrightConfig, runJobrightRecommendations } from '../adapters/jobright_recommendations_scan.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(PROJECT_ROOT, 'config/jobright.json');
const COMBINE = path.join(PROJECT_ROOT, 'src/combine.mjs');
const VERIFY = path.join(PROJECT_ROOT, 'src/run-contract.mjs');
const CAPTURED_AT = '2026-08-30T21:45:00-07:00';
const TIMEZONE = 'America/Los_Angeles';
const LONG = 'Build and operate reliable distributed backend services, APIs, and cloud infrastructure. '.repeat(8);
const IDS = {
  first: 'aaaaaaaaaaaaaaaaaaaaaaa1',
  second: 'aaaaaaaaaaaaaaaaaaaaaaa2',
  excluded: 'aaaaaaaaaaaaaaaaaaaaaaa3',
  unresolved: 'aaaaaaaaaaaaaaaaaaaaaaa4',
};
const OFFICIAL_URL = 'https://jobs.ashbyhq.com/exampleco/22222222-3333-4444-8555-666666666666';
const OFFICIAL_KEY = 'ashby:exampleco:22222222-3333-4444-8555-666666666666';
const ZIPRECRUITER_REDIRECT = `https://www.ziprecruiter.com/kn/${'A'.repeat(280)}-synthetic-redirect-1234567890`;

test('network diagnostics classify failures without retaining response values or parser/body errors', async t => {
  for (const name of ['drainEvents', 'cdp', 'wait']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    globalThis[name] = async () => {};
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  const counts = { jobs: 19, filter: 0 };
  const cases = [
    [200, { result: { jobList: [] } }, null],
    [200, { code: 401, result: { profile: 'SECRET' }, token: 'SECRET' }, 'unknown_structure'],
    [401, { errorCode: 'UNAUTHORIZED', message: 'SECRET' }, 'authentication'],
    [429, { code: 429, result: { jobList: [] } }, 'rate_limit'],
    [200, { code: 'UNAUTHORIZED', result: { jobList: [] } }, 'application_error'],
    [503, { code: 503 }, 'http_error'],
    [200, 'SECRET invalid JSON', 'invalid_response'],
    [200, null, 'body_unavailable'],
  ];
  for (const [status, payload, classification] of cases) {
    t.mock.method(globalThis, 'drainEvents', async () => [{ method: 'Network.responseReceived', params: { requestId: 'SECRET', response: { url: 'https://jobright.ai/swan/recommend/list/jobs', status } } }]);
    t.mock.method(globalThis, 'cdp', async () => {
      if (payload === null) throw new Error('SECRET');
      return { body: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    });
    const observed = await drainJobrightBatches(counts);
    if (!classification) assert.deepEqual(observed.batches, [[]]);
    else {
      assert.equal(observed.errors[0].classification, classification);
      assert.equal(observed.errors[0].http_status, status);
      assert.equal(observed.errors[0].batch_index, counts.jobs);
      assert.ok(!JSON.stringify(observed.errors).includes('SECRET'));
      const artifacts = buildJobrightArtifacts({ runId: 'diagnostic', config: loadJobrightConfig(), fixture: { filter_snapshot: acceptedFilter(), response_errors: observed.errors } });
      assert.equal(artifacts.summary.status, 'FAILED');
      assert.equal(artifacts.summary.retryable, false);
      assert.deepEqual(artifacts.summary.error_details, observed.errors);
    }
    t.mock.restoreAll();
  }
});

test('UI collection stops at a response error and preserves already validated jobs', async t => {
  const config = loadJobrightConfig();
  let drains = 0;
  let scrolls = 0;
  const navigation = [];
  let listening = false;
  const event = (id, endpoint, status = 200) => ({ method: 'Network.responseReceived', params: { requestId: id, response: { url: `https://jobright.ai/swan/${endpoint}`, status } } });
  const helpers = {
    useOrCreateTaskSpace: async () => {},
    openOrReuseTab: async url => { navigation.push(url); },
    gotoAndWait: async url => {
      assert.equal(listening, true);
      assert.equal(drains, 1, 'discard pre-navigation events before loading the feed');
      navigation.push(url);
    },
    waitForLoad: async () => {}, wait: async () => {},
    pageInfo: async () => ({ url: config.landing_url }),
    js: async script => {
      if (script.includes('querySelectorAll')) return config.filter_snapshot.visible_controls;
      if (script.includes('document.body')) return 'Jobs';
      if (script.includes('dispatchEvent')) scrolls++;
      return { found: true, height: 100, at_bottom: true };
    },
    drainEvents: async () => {
      drains++;
      if (drains === 1) return [event('stale', 'filter/get/filter')];
      return drains === 2 ? [event('filter', 'filter/get/filter'), event('jobs', 'recommend/list/jobs')] : [event('failed', 'recommend/list/jobs', 429)];
    },
    cdp: async (method, { requestId } = {}) => {
      if (method === 'Network.enable') { listening = true; return {}; }
      assert.notEqual(requestId, 'stale', 'must not read a body invalidated by navigation');
      const payload = requestId === 'filter' ? { result: config.filter_snapshot.codes } : requestId === 'failed' ? { code: 429, message: 'SECRET' } : { result: { jobList: Array.from({ length: 20 }, () => ({ companyResult: { companyName: 'Acme' }, jobResult: { jobId: IDS.first, jobTitle: 'Backend Engineer', jobLocation: 'Seattle, WA', employmentType: 'Full-time', publishTimeDesc: '2 hours ago', originalUrl: OFFICIAL_URL, jobSummary: LONG } })) } };
      return { body: JSON.stringify(payload) };
    },
  };
  for (const [name, fn] of Object.entries(helpers)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    globalThis[name] = fn;
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  const fixture = await collectJobrightRecommendations({ config, runId: 'partial' });
  assert.equal(scrolls, 1);
  assert.deepEqual(navigation, ['about:blank', config.landing_url]);
  assert.equal(drains, 3);
  assert.equal(fixture.termination_reason, 'response_error');
  assert.equal(fixture.response_errors[0].batch_index, 2);
  const artifacts = buildJobrightArtifacts({ runId: 'partial', config, fixture });
  assert.equal(artifacts.summary.status, 'FAILED');
  assert.equal(artifacts.summary.retryable, false);
  assert.equal(artifacts.jobs.length, 1);
  assert.equal(artifacts.summary.raw_rows, 20);
});

function acceptedFilter() {
  const config = loadJobrightConfig(CONFIG);
  return { landing_url: config.landing_url, ...config.filter_snapshot };
}

function workspace() {
  const discoveryRoot = mkdtempSync(path.join(os.tmpdir(), 'jobright-recommendations-'));
  const registry = path.join(discoveryRoot, 'jobright-standalone-registry.json');
  writeFileSync(registry, JSON.stringify({
    schema_version: 1,
    registry_version: '1',
    profile_id: 'jobright-standalone',
    contract_version: 2,
    identity_schema: 'posting-key-v1',
    minimum_successful_adapters: 1,
    adapters: { jobright: { employer_exclusions: true } },
  }));
  return { discoveryRoot, registry };
}

async function runFixture(runId, fixture) {
  const fx = workspace();
  const fixtureFile = path.join(fx.discoveryRoot, `${runId}.json`);
  writeFileSync(fixtureFile, JSON.stringify(fixture));
  const summary = await runJobrightRecommendations({
    discoveryRoot: fx.discoveryRoot,
    runId,
    configFile: CONFIG,
    fixtureFile,
    capturedAt: CAPTURED_AT,
    timezone: TIMEZONE,
  });
  return { ...fx, runId, runRoot: path.join(fx.discoveryRoot, 'runs', runId), summary };
}

test('accepted filters capture every unique ID across batches and satisfy the standalone source contract', async () => {
  const filter = acceptedFilter();
  assert.equal(filter.freshness, 'Past 24 hours');
  assert.equal(filter.sort, 'Recommended');
  assert.deepEqual(filter.codes.seniority, [3, 4]);
  assert.deepEqual(filter.codes.workModel, [1, 2, 3]);
  assert.deepEqual(filter.codes.locations, [{ type: 'city', city: 'Seattle, WA', radiusRange: 25 }]);
  assert.deepEqual(new Set(filter.values), new Set([
    'Seattle, WA', 'Backend Engineer', 'Mid Level', 'Senior Level', 'Full-time',
    'Onsite', 'Hybrid', 'Remote anywhere in the US', '0-4 Years',
  ]));

  const detail = {
    company: 'Example Company',
    title: 'Senior Backend Software Engineer',
    location: 'United States',
    employment_type: 'Full-time',
    workplace_type: 'Remote',
    publish_time_raw: '2026-08-30 18:30:00',
    publish_time_desc: 'Reposted 3 hours ago',
    repost: true,
    official_url: OFFICIAL_URL,
    description: LONG,
  };
  const fx = await runFixture('jobright-success', {
    filter_snapshot: filter,
    termination_reason: 'stable_bottom',
    batches: [
      [{ jobright_id: IDS.first }, { jobright_id: IDS.second }],
      [{ jobright_id: IDS.second }, { jobright_id: IDS.excluded }],
    ],
    details: {
      [IDS.first]: detail,
      [IDS.second]: { ...detail, publish_time_desc: '8 hours ago', repost: false },
      [IDS.excluded]: {
        ...detail,
        company: 'Amazon Web Services',
        official_url: 'https://jobs.lever.co/amazon/33333333-3333-4333-8333-333333333333',
        repost: false,
      },
    },
  });

  assert.equal(fx.summary.status, 'SUCCESS');
  assert.equal(fx.summary.filter_snapshot.landing_url, filter.landing_url);
  assert.equal(fx.summary.filter_snapshot.freshness, filter.freshness);
  assert.equal(fx.summary.filter_snapshot.sort, filter.sort);
  assert.deepEqual(fx.summary.filter_snapshot.values, filter.values);
  assert.equal(fx.summary.filter_snapshot.matched, true);
  assert.equal(fx.summary.raw_rows, 4);
  assert.equal(fx.summary.unique_jobs, 2);
  assert.equal(fx.summary.markdown_jobs, 2);
  assert.equal(fx.summary.errors, 0);
  assert.equal(fx.summary.list_capture.unique_list_jobs, 3);
  assert.equal(fx.summary.list_capture.duplicate_rows, 1);
  assert.equal(fx.summary.list_capture.termination_reason, 'stable_bottom');
  assert.equal(fx.summary.raw_rows - fx.summary.list_capture.duplicate_rows, fx.summary.list_capture.unique_list_jobs);
  assert.equal(fx.summary.list_capture.dispositions.length, 3);
  assert.deepEqual(fx.summary.list_capture.dispositions.map(row => row.jobright_id), [IDS.first, IDS.second, IDS.excluded]);
  assert.deepEqual(fx.summary.list_capture.dispositions.map(row => row.status), ['captured', 'captured', 'employer_excluded']);

  const sourceRoot = path.join(fx.runRoot, 'sources/jobright');
  assert.deepEqual(JSON.parse(readFileSync(path.join(sourceRoot, 'summary.json'), 'utf8')), fx.summary);
  assert.deepEqual(readdirSync(path.join(sourceRoot, 'jobs')).sort(), [`${IDS.first}.md`, `${IDS.second}.md`]);
  const firstJd = readFileSync(path.join(sourceRoot, `jobs/${IDS.first}.md`), 'utf8');
  assert.match(firstJd, new RegExp(`^\\*\\*Posting Key:\\*\\* ${OFFICIAL_KEY}$`, 'm'));
  assert.match(firstJd, new RegExp(`^\\*\\*URL:\\*\\* ${OFFICIAL_URL}$`, 'm'));
  assert.match(firstJd, new RegExp(`^\\*\\*Source Job ID:\\*\\* ${IDS.first}$`, 'm'));
  assert.match(firstJd, new RegExp(`^\\*\\*Jobright URL:\\*\\* https://jobright\\.ai/jobs/info/${IDS.first}$`, 'm'));
  assert.match(firstJd, /^\*\*Structured Remote Signal:\*\* true$/m);
  assert.match(firstJd, /^\*\*Posted:\*\*[ \t]*$/m);
  assert.match(firstJd, /^\*\*Jobright Publish Time Raw:\*\* 2026-08-30 18:30:00$/m);
  assert.match(firstJd, /^\*\*Card Posted Label:\*\* Reposted 3 hours ago$/m);
  assert.match(firstJd, /^\*\*Reposted:\*\* true$/m);
  assert.match(firstJd, /^\*\*Discovery Timezone:\*\* America\/Los_Angeles$/m);
  assert.match(firstJd, new RegExp(LONG.slice(0, 80)));

  const exclusions = JSON.parse(readFileSync(path.join(sourceRoot, 'excluded-employers.json'), 'utf8'));
  assert.equal(exclusions.run_id, fx.runId);
  assert.equal(exclusions.excluded_count, 1);
  assert.equal(exclusions.results[0].jobright_id, IDS.excluded);
  assert.match(exclusions.results[0].reason, /Amazon\/AWS employer exclusion/);

  const env = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: fx.registry };
  execFileSync(process.execPath, [COMBINE, '--run', fx.runRoot], { env, stdio: 'pipe' });
  const acquisition = JSON.parse(readFileSync(path.join(fx.runRoot, 'acquisition.json'), 'utf8'));
  assert.equal(acquisition.raw_source_jobs, 2);
  assert.equal(acquisition.duplicates_removed, 1);
  assert.deepEqual(acquisition.keys, [OFFICIAL_KEY]);
  assert.equal(acquisition.acquired[0].primary_url, OFFICIAL_URL);
  assert.deepEqual(acquisition.acquired[0].source_keys, { jobright: OFFICIAL_KEY });
  assert.equal(acquisition.acquired[0].structured_remote_signal, true);
  const verification = JSON.parse(execFileSync(process.execPath, [VERIFY, '--run', fx.runRoot], { env, encoding: 'utf8' }));
  assert.equal(verification.ok, true);
  assert.equal(verification.acquired, 1);
});

test('an unparseable original URL uses exact Jobright identity while filter mismatch fails closed', async () => {
  const fallback = await runFixture('jobright-fallback', {
    filter_snapshot: acceptedFilter(),
    batches: [[{ jobright_id: IDS.unresolved }]],
    details: {
      [IDS.unresolved]: {
        company: 'Acme', title: 'Backend Engineer', location: 'Seattle, WA',
        employment_type: 'Full-time', workplace_type: 'Hybrid',
        publish_time_raw: '2026-08-30 19:00:00', publish_time_desc: '2 hours ago', repost: false,
        official_url: ZIPRECRUITER_REDIRECT, description: LONG,
      },
    },
  });
  assert.equal(fallback.summary.status, 'SUCCESS');
  assert.equal(fallback.summary.errors, 0);
  assert.equal(fallback.summary.unique_jobs, 1);
  assert.equal(fallback.summary.list_capture.dispositions[0].status, 'captured');
  const fallbackKey = `jobright:jobright.ai:${IDS.unresolved.toUpperCase()}`;
  assert.equal(fallback.summary.list_capture.dispositions[0].posting_key, fallbackKey);
  const fallbackJd = readFileSync(path.join(fallback.runRoot, `sources/jobright/jobs/${IDS.unresolved}.md`), 'utf8');
  assert.match(fallbackJd, new RegExp(`^\\*\\*URL:\\*\\* https://jobright\\.ai/jobs/info/${IDS.unresolved}$`, 'm'));
  assert.match(fallbackJd, new RegExp(`^\\*\\*Posting Key:\\*\\* ${fallbackKey}$`, 'm'));
  assert.ok(fallbackJd.includes(`**Original Job URL:** ${ZIPRECRUITER_REDIRECT}`));

  const fallbackEnv = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: fallback.registry };
  execFileSync(process.execPath, [COMBINE, '--run', fallback.runRoot], { env: fallbackEnv, stdio: 'pipe' });
  const fallbackAcquisition = JSON.parse(readFileSync(path.join(fallback.runRoot, 'acquisition.json'), 'utf8'));
  assert.deepEqual(fallbackAcquisition.keys, [fallbackKey]);
  assert.equal(fallbackAcquisition.acquired[0].jd_path, `jobs/jobright-jobright.ai-${IDS.unresolved.toUpperCase()}.md`);
  const fallbackVerification = JSON.parse(execFileSync(process.execPath, [VERIFY, '--run', fallback.runRoot], { env: fallbackEnv, encoding: 'utf8' }));
  assert.equal(fallbackVerification.ok, true);

  const mismatchFilter = acceptedFilter();
  mismatchFilter.freshness = 'Past week';
  const mismatch = await runFixture('jobright-filter-mismatch', {
    filter_snapshot: mismatchFilter,
    batches: [[{ jobright_id: IDS.first }]],
    details: {},
  });
  assert.equal(mismatch.summary.status, 'FAILED');
  assert.ok(mismatch.summary.errors > 0);
  assert.equal(mismatch.summary.unique_jobs, 0);
  assert.equal(mismatch.summary.list_capture.dispositions[0].status, 'failed');
  assert.equal(mismatch.summary.list_capture.dispositions[0].reason, 'filter_mismatch');
  assert.deepEqual(readdirSync(path.join(mismatch.runRoot, 'sources/jobright/jobs')), []);
});

test('a complete empty traversal is a valid EMPTY source but cannot satisfy Jobright-only liveness', async () => {
  const fx = await runFixture('jobright-empty', {
    filter_snapshot: acceptedFilter(),
    termination_reason: 'stable_bottom',
    batches: [],
    details: {},
  });
  assert.equal(fx.summary.status, 'EMPTY');
  assert.equal(fx.summary.raw_rows, 0);
  assert.equal(fx.summary.unique_jobs, 0);
  assert.equal(fx.summary.markdown_jobs, 0);
  assert.equal(fx.summary.errors, 0);
  assert.deepEqual(fx.summary.list_capture.dispositions, []);

  const env = { ...process.env, JOB_DISCOVERY_ADAPTER_REGISTRY: fx.registry };
  assert.throws(
    () => execFileSync(process.execPath, [COMBINE, '--run', fx.runRoot], { env, stdio: 'pipe' }),
    error => {
      assert.match(String(error.stderr), /requires 1 successful adapter\(s\), got 0/);
      return true;
    },
  );
});
