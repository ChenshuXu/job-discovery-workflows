import test from 'node:test';
import assert from 'node:assert/strict';
import { officialOfferUrl } from '../src/adapters/career_ops_ats_scan.mjs';
import { fetchOfficialPosting, HttpClient } from '../src/adapters/official_ats_posting.mjs';
import { postingKey } from '../src/posting-identity.mjs';

const NOW = '2026-08-07T08:00:00.000Z';
const RECENT = '2026-08-07T01:00:00.000Z';
const LONG = 'Build reliable distributed backend systems and APIs on cloud infrastructure. '.repeat(8);
const SITES = [
  { id: 'ashby', domains: ['jobs.ashbyhq.com'] }, { id: 'lever', domains: ['jobs.lever.co'] },
  { id: 'greenhouse', domains: ['boards.greenhouse.io', 'job-boards.greenhouse.io'] },
  { id: 'workday', domains: ['myworkdayjobs.com'] }, { id: 'smartrecruiters', domains: ['jobs.smartrecruiters.com'] },
];

test('each supported ATS yields one complete official posting with its exact identity', async () => {
  const ashby = 'https://jobs.ashbyhq.com/acme/a1111111-1111-4111-8111-111111111111';
  const lever = 'https://jobs.lever.co/leverco/b2222222-2222-4222-8222-222222222222';
  const greenhouse = 'https://job-boards.greenhouse.io/greenhouseco/jobs/1234567';
  const workday = 'https://example.wd5.myworkdayjobs.com/External/job/Seattle/Senior-Engineer_R12345';
  const smart = 'https://jobs.smartrecruiters.com/SmartCo/744000012345678-senior-engineer';
  const http = new HttpClient({ http: {
      'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true': { json: { jobs: [{ title: 'Senior Backend Engineer', location: 'Seattle', descriptionPlain: LONG, publishedAt: RECENT, jobUrl: ashby, applyUrl: `${ashby}/application` }] } },
      'https://api.lever.co/v0/postings/leverco/b2222222-2222-4222-8222-222222222222': { json: { id: 'b2222222-2222-4222-8222-222222222222', text: 'Senior Platform Engineer', categories: { location: 'Remote, United States', commitment: 'Contract' }, createdAt: Date.parse(RECENT), descriptionPlain: LONG, hostedUrl: lever, applyUrl: `${lever}/apply` } },
      'https://boards-api.greenhouse.io/v1/boards/greenhouseco/jobs/1234567?content=true': { json: { id: 1234567, title: 'Senior Distributed Systems Engineer', company_name: 'Greenhouse Co', location: { name: 'Seattle' }, content: LONG, absolute_url: greenhouse } },
      [greenhouse]: { body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Senior Distributed Systems Engineer', datePosted: RECENT, description: LONG, hiringOrganization: { name: 'Greenhouse Co' }, jobLocation: { address: { addressLocality: 'Seattle', addressRegion: 'WA', addressCountry: 'US' } }, identifier: { value: '1234567' }, url: greenhouse })}</script>` },
      'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/job/Seattle/Senior-Engineer_R12345': { json: { jobPostingInfo: { title: 'Senior Infrastructure Engineer', company: 'Example', location: 'Bellevue, WA', startDate: RECENT, jobDescription: LONG, externalUrl: workday, jobReqId: 'R12345' } } },
      'https://api.smartrecruiters.com/v1/companies/SmartCo/postings/744000012345678': { json: { id: '744000012345678', name: 'Senior AI Infrastructure Engineer', releasedDate: RECENT, ref: smart, company: { name: 'Smart Co' }, location: { city: 'Seattle', region: 'WA', country: 'US' }, jobAd: { sections: { jobDescription: { text: LONG } } } } },
  } });
  for (const link of [ashby, lever, greenhouse, workday, smart]) {
    const posting = await fetchOfficialPosting({ link }, { ats_sites: SITES }, http, new Date(NOW));
    assert.equal(posting.posting_key, postingKey(posting.canonical_url), link);
    assert.ok(posting.company && posting.title, link);
    assert.ok(posting.description.length >= 200, link);
    assert.ok(Number.isFinite(Date.parse(posting.posted_at)), link);
  }
  const remote = await fetchOfficialPosting({ link: lever }, { ats_sites: SITES }, http, new Date(NOW));
  // Remote comes only from the location text here, so it is not a structured signal.
  assert.deepEqual([remote.workplace_type, remote.structured_remote_signal, remote.employment_type, remote.employment_type_source],
    ['remote', false, 'Contract', 'lever-api:categories.commitment']);
});

test('only an ATS or schema.org workplace field counts as a structured remote signal', async () => {
  const link = 'https://jobs.lever.co/acme/C3333333-3333-4333-8333-333333333333';
  const http = workplaceType => ({
    json: async () => ({ text: 'Backend Engineer', hostedUrl: link, createdAt: Date.now(), categories: { location: 'Remote - UK', commitment: 'Full-time' },
      descriptionPlain: 'Build backend systems. '.repeat(40), ...(workplaceType ? { workplaceType } : {}) }),
    text: async () => '<html></html>',
  });
  const config = { ats_sites: [{ id: 'lever', domains: ['jobs.lever.co'] }] };
  const inferred = await fetchOfficialPosting({ link }, config, http(null), new Date());
  assert.equal(inferred.workplace_type, 'remote');
  assert.equal(inferred.structured_remote_signal, false);
  assert.equal(inferred.workplace_type_source, 'location-text-heuristic');
  const structured = await fetchOfficialPosting({ link }, config, http('remote'), new Date());
  assert.equal(structured.structured_remote_signal, true);
  assert.equal(structured.workplace_type_source, 'official-ats-api/schema.org');
});

test('an embedded Greenhouse offer resolves to its board posting URL', () => {
  assert.equal(officialOfferUrl({ company: 'abnormalsecurity', source: 'greenhouse-full', url: 'https://abnormal.ai/careers/jobs/8107873003?gh_jid=8107873003' }),
    'https://job-boards.greenhouse.io/abnormalsecurity/jobs/8107873003');
  assert.equal(postingKey(officialOfferUrl({ company: 'abnormalsecurity', source: 'greenhouse-full', url: 'https://a16z.com/about/jobs/?gh_jid=8043464003' })), 'greenhouse:abnormalsecurity:8043464003');
  const ashby = 'https://jobs.ashbyhq.com/alan/cb1d045d-6b64-4864-96f1-d28d753b7132';
  assert.equal(officialOfferUrl({ company: 'alan', source: 'ashby-full', url: ashby }), ashby);
  const noId = 'https://abnormal.ai/careers/jobs/8107873003';
  assert.equal(officialOfferUrl({ company: 'abnormalsecurity', source: 'greenhouse-full', url: noId }), noId);
});

test('a date-only posting date counts the whole day toward the age window', async () => {
  const { postedWithinWindow } = await import('../src/adapters/career_ops_ats_scan.mjs');
  const now = new Date('2026-11-10T20:00:00Z');
  assert.equal(postedWithinWindow('2026-11-09', now, 24), true, 'posted late on the 9th may still be within 24 hours');
  assert.equal(postedWithinWindow('2026-11-08', now, 24), false);
  assert.equal(postedWithinWindow('2026-11-10', now, 24), true, 'today is not in the future');
  assert.equal(postedWithinWindow('2026-11-09T19:00:00Z', now, 24), false);
  assert.equal(postedWithinWindow('2026-11-09T21:00:00Z', now, 24), true);
  assert.equal(postedWithinWindow('2026-11-11T00:00:00Z', now, 24), false, 'a future timestamp is rejected');
  assert.equal(postedWithinWindow('', now, 24), false);
});

test('concurrent requests for one URL share a single download, and a failure is not cached', async () => {
  const { HttpClient } = await import('../src/adapters/official_ats_posting.mjs');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10));
    if (calls === 1) return new Response('{}', { status: 503 }); return new Response(JSON.stringify({ jobs: [] }), { status: 200 }); };
  try {
    const http = new HttpClient(null);
    const board = 'https://api.ashbyhq.com/posting-api/job-board/acme';
    const first = await Promise.allSettled([http.json(board), http.json(board)]);
    assert.deepEqual(first.map(item => item.status), ['rejected', 'rejected']);
    assert.equal(calls, 1, 'two concurrent callers made one request');
    assert.deepEqual(await Promise.all([http.json(board), http.json(board)]), [{ jobs: [] }, { jobs: [] }]);
    assert.equal(calls, 2, 'the failed request was retried once, then shared');
  } finally { globalThis.fetch = originalFetch; }
});
