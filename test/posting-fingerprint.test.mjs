import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyPostingKey, matchesStoredPostingKey, postingFingerprint, postingKey, samePosting } from '../src/posting-identity.mjs';

// Synthetic format regression: report and JD record the same Workday requisition
// through different locale/location paths and a tracking parameter.
const WORKDAY_REPORT = 'https://example.wd5.myworkdayjobs.com/en-US/ExampleExternalCareerSite/job/Senior-Software-Engineer--Agentic-AI_JR1000001';
const WORKDAY_JD = 'https://example.wd5.myworkdayjobs.com/ExampleExternalCareerSite/job/US-WA-Redmond/Senior-Software-Engineer--Agentic-AI_JR1000001?source=jobboardlinkedin';

test('Ashby board query identifies the same exact tenant and job as its path URL', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const board = `https://jobs.ashbyhq.com/acmeco?ashby_jid=${id}&utm_source=linkedin`;
  const direct = `https://jobs.ashbyhq.com/acmeco/${id}/application`;
  assert.equal(postingKey(board), `ashby:acmeco:${id.toUpperCase()}`);
  assert.equal(samePosting(board, direct), true);
  assert.equal(samePosting(board, direct.replace('acmeco', 'other')), false);
  assert.equal(legacyPostingKey(board), null);
  for (const url of [
    'https://jobs.ashbyhq.com/acmeco?ashby_jid=',
    'https://jobs.ashbyhq.com/acmeco?ashby_jid=not-a-job',
    `${board}&ashby_jid=${id}`,
    `https://jobs.ashbyhq.com/acmeco/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?ashby_jid=${id}`,
    `https://jobs.ashbyhq.com/?ashby_jid=${id}`,
    `https://example.com/acmeco?ashby_jid=${id}`,
  ]) assert.equal(postingKey(url), null, url);
});

test('verified Elastic Ongig mirror shares identity and keeps immutable v2 artifacts readable', () => {
  const mirror = 'https://elastic.ongig.com/jobs/finance-it-operations/united-states/agentic-ai-engineer/8079636?gh_src=synthetic';
  const official = 'https://boards.greenhouse.io/embed/job_app?for=elastic&token=8079636';
  assert.equal(samePosting(mirror, official), true);
  assert.equal(postingKey(mirror), 'greenhouse:elastic:8079636');
  assert.equal(matchesStoredPostingKey(mirror, 'generic:elastic.ongig.com:8079636'), true);
  assert.equal(matchesStoredPostingKey(mirror, 'generic:other.ongig.com:8079636'), false);
  assert.equal(matchesStoredPostingKey(mirror, 'generic:elastic.ongig.com:8079637'), false);
  assert.equal(samePosting(mirror, official.replace('elastic', 'other')), false);
  assert.equal(samePosting(mirror.replace('elastic.ongig', 'other.ongig'), official), false);
  assert.equal(samePosting(mirror.replace('8079636', '8079637'), official.replace('8079636', '8079637')), false);
});

test('workday locale and location path variants share one fingerprint', () => {
  const report = postingFingerprint(WORKDAY_REPORT);
  assert.deepEqual(
    { ats: report.ats, tenant: report.tenant, requisitionId: report.requisitionId },
    { ats: 'workday', tenant: 'example/exampleexternalcareersite', requisitionId: 'JR1000001' },
  );
  assert.equal(samePosting(WORKDAY_REPORT, WORKDAY_JD), true);
});

test('Workday CXS identity uses the path tenant instead of the shared wd host', () => {
  const cxs = 'https://wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Seattle/Engineer_R12345';
  const standard = 'https://acme.wd5.myworkdayjobs.com/External/job/Seattle/Engineer_R12345';
  const otherTenant = cxs.replace('/acme/', '/other/');
  assert.equal(postingKey(cxs), 'workday:acme/external:R12345');
  assert.equal(samePosting(cxs, standard), true);
  assert.equal(samePosting(cxs, otherTenant), false);
});

test('different requisitions on one tenant are different postings', () => {
  const other = WORKDAY_JD.replace('JR1000001', 'JR1000002');
  assert.equal(samePosting(WORKDAY_REPORT, other), false);
});

test('workday keeps opaque requisition suffixes and accepts an optional apply tail', () => {
  for (const [url, expected] of [
    ['https://exampleone.wd5.myworkdayjobs.com/en-US/External/job/Seattle-WA/Engineer_R10001/apply', 'R10001'],
    ['https://exampletwo.wd1.myworkdayjobs.com/en-US/external/job/Seattle-WA/Engineer_H100ABC10-1', 'H100ABC10-1'],
    ['https://exampletwo.wd1.myworkdayjobs.com/external/job/Seattle-WA/Engineer_R0000001-1', 'R0000001-1'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_JR1000004-1', 'JR1000004-1'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_JOBREQ12345', 'JOBREQ12345'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/123456', '123456'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_R26_0000000001-1', 'R26_0000000001-1'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_JR_10001', 'JR_10001'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_R_1000001', 'R_1000001'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_REQ_100000001-1', 'REQ_100000001-1'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Engineer_JR-010001-1', 'JR-010001-1'],
  ]) {
    assert.equal(postingFingerprint(url)?.requisitionId, expected, url);
  }
  assert.equal(samePosting(
    'https://exampleone.wd5.myworkdayjobs.com/en-US/External/job/Seattle-WA/Engineer_R10001',
    'https://exampleone.wd5.myworkdayjobs.com/External/job/Seattle-WA/Engineer_R10001/apply',
  ), true);
  assert.equal(samePosting(
    'https://exampletwo.wd1.myworkdayjobs.com/external/job/Engineer_R0000001-1',
    'https://exampletwo.wd1.myworkdayjobs.com/external/job/Engineer_R00000011',
  ), false);
});

test('major ATS hosts resolve to tenant and requisition', () => {
  for (const [url, expected] of [
    ['https://boards.greenhouse.io/acmeco/jobs/4567890', { ats: 'greenhouse', tenant: 'acmeco', requisitionId: '4567890' }],
    ['https://job-boards.greenhouse.io/acmeco/jobs/4567890?gh_src=abc', { ats: 'greenhouse', tenant: 'acmeco', requisitionId: '4567890' }],
    ['https://jobs.lever.co/acmeco/8f2a1c3d-0000-4a11-9b22-cc3344556677', { ats: 'lever', tenant: 'acmeco', requisitionId: '8F2A1C3D-0000-4A11-9B22-CC3344556677' }],
    ['https://jobs.ashbyhq.com/acmeco/11112222-3333-4444-5555-666677778888/application', { ats: 'ashby', tenant: 'acmeco', requisitionId: '11112222-3333-4444-5555-666677778888' }],
  ]) {
    const actual = postingFingerprint(url);
    assert.deepEqual(
      { ats: actual.ats, tenant: actual.tenant, requisitionId: actual.requisitionId },
      expected,
      url,
    );
  }
});

test('greenhouse tracking parameters do not change the fingerprint', () => {
  assert.equal(samePosting(
    'https://boards.greenhouse.io/acmeco/jobs/4567890',
    'https://boards.greenhouse.io/acmeco/jobs/4567890?gh_src=xyz&utm_source=linkedin',
  ), true);
});

test('greenhouse embed identity requires the official board tenant', () => {
  for (const [tenant, token] of [['examplepay', '1000001'], ['examplecredit', '1000002'], ['exampledev', '1000000003']]) {
    assert.equal(
      postingKey(`https://job-boards.greenhouse.io/embed/job_app?for=${tenant}&token=${token}`),
      `greenhouse:${tenant}:${token}`,
    );
  }
  assert.equal(
    postingKey('https://boards.greenhouse.io/embed/job_app?token=1000001'),
    'greenhouse:boards.greenhouse.io:1000001',
  );
  assert.equal(
    postingKey('https://boards.greenhouse.io/embed/job_app/?for=examplepay&token=1000001'),
    'greenhouse:examplepay:1000001',
  );
  assert.equal(
    postingKey('https://boards.greenhouse.io/embed/job_app?for=examplepay!&token=1000001'),
    'greenhouse:boards.greenhouse.io:1000001',
  );
  assert.equal(
    postingKey('https://boards.greenhouse.io/redirect?for=examplepay&token=1000001'),
    'greenhouse:boards.greenhouse.io:1000001',
  );
});

test('a LinkedIn permalink is fingerprinted as linkedin, never as the employer ATS', () => {
  const linkedin = postingFingerprint('https://www.linkedin.com/jobs/view/1000000101');
  assert.equal(linkedin.ats, 'linkedin');
  assert.equal(samePosting('https://www.linkedin.com/jobs/view/1000000101', WORKDAY_JD), false);
});

test('LinkedIn title slugs reduce to the trailing numeric job id', () => {
  const id = '1000000102';
  const direct = `https://www.linkedin.com/jobs/view/${id}`;
  const slug = `https://ca.linkedin.com/jobs/view/full-time-remote-canada-at-exampleco-${id}`;
  const oldKey = `linkedin:linkedin.com:FULL-TIME-REMOTE-CANADA-AT-EXAMPLECO-${id}`;
  assert.equal(postingKey(slug), `linkedin:linkedin.com:${id}`);
  assert.equal(legacyPostingKey(slug), oldKey);
  assert.equal(samePosting(direct, slug), true);
  assert.equal(matchesStoredPostingKey(slug, oldKey, { identityParserVersion: 2 }), true);
  assert.equal(matchesStoredPostingKey(slug, oldKey.replace(id, '1000000103'), { identityParserVersion: 2 }), false);
});

test('a Jobright detail URL provides exact fallback identity', () => {
  assert.equal(
    postingKey('https://jobright.ai/jobs/info/bbbbbbbbbbbbbbbbbbbbbbb1'),
    'jobright:jobright.ai:BBBBBBBBBBBBBBBBBBBBBBB1',
  );
  assert.equal(postingFingerprint('https://jobright.ai/jobs/info/not-an-id'), null);
});

test('a URL without any requisition token yields no fingerprint', () => {
  assert.equal(postingFingerprint('https://example.test/careers'), null);
  assert.equal(postingFingerprint('not-a-url'), null);
  assert.equal(samePosting('https://example.test/careers', 'https://example.test/careers'), false);
});

test('generic identity never treats an API version path as an exact requisition', () => {
  const jometerA = 'https://tnl2.jometer.com/v2/job?jz=syntheticA1234567890123456789012345678901234567890';
  const jometerB = 'https://tnl2.jometer.com/v2/job?jz=syntheticB1234567890123456789012345678901234567890';
  const zipRecruiterRedirect = 'https://www.ziprecruiter.com/kn/synthetic-redirect-123456789012345678901234567890';
  const hirebridgeA = 'https://recruit.hirebridge.com/v3/careercenter/v2/details.aspx?jid=100001&cid=1001&locvalue=1000';
  const hirebridgeB = 'https://recruit.hirebridge.com/v3/careercenter/v2/details.aspx?jid=100002&cid=1002&locvalue=10000001';
  assert.equal(postingFingerprint(jometerA), null);
  assert.equal(postingFingerprint(zipRecruiterRedirect), null);
  assert.equal(postingKey(zipRecruiterRedirect), null);
  assert.equal(samePosting(jometerA, jometerB), false);
  assert.equal(samePosting(hirebridgeA, hirebridgeB), false);
  assert.equal(postingKey(hirebridgeA), 'hirebridge:recruit.hirebridge.com/1001:100001');
  assert.equal(samePosting(hirebridgeA, `${hirebridgeA}&src=LinkedIn`), true);
  assert.equal(postingFingerprint(hirebridgeA.replace('&cid=1001', '')), null);
});

test('Taleo identity comes from org, cws, and rid rather than the v2 path segment', () => {
  const first = 'https://phh.tbe.taleo.net/phh01/ats/careers/v2/viewRequisition?org=EXAMPLE12&cws=40&rid=101&source=LinkedIn';
  const tracked = `${first}&utm_campaign=jobs`;
  const other = first.replace('rid=101', 'rid=102');
  assert.equal(postingKey(first), 'taleo:phh.tbe.taleo.net/example12/40:101');
  assert.equal(samePosting(first, tracked), true);
  assert.equal(samePosting(first, other), false);
  assert.equal(postingFingerprint(first.replace('&rid=101', '')), null);
});

test('Adobe and Google title slugs do not participate in posting identity', () => {
  const adobe = 'https://careers.adobe.com/us/en/job/ADOBUSR100001EXTERNALENUS/Example-Engineer-5';
  const adobeRenamed = adobe.replace('Example-Engineer-5', 'Renamed-Role');
  const google = 'https://careers.google.com/jobs/results/10000000000000001-software-engineer';
  const googleRenamed = google.replace('software-engineer', 'senior-platform-engineer');
  assert.equal(postingKey(adobe), 'phenom:adobe:ADOBUSR100001EXTERNALENUS');
  assert.equal(samePosting(adobe, adobeRenamed), true);
  assert.equal(postingKey(google), 'google-careers:google:10000000000000001');
  assert.equal(samePosting(google, googleRenamed), true);
});

test('Google official URL generations share one requisition identity', () => {
  const requisition = '10000000000000002';
  const legacyHost = `https://careers.google.com/jobs/results/${requisition}-software-engineer-iii/`;
  const currentHost = `https://www.google.com/about/careers/applications/jobs/results/${requisition}-software-engineer-iii?page=166`;
  assert.equal(postingKey(currentHost), `google-careers:google:${requisition}`);
  assert.equal(samePosting(legacyHost, currentHost), true);
});

test('parser-v2 validation accepts only the superseded Google generic key shape', () => {
  const url = 'https://www.google.com/about/careers/applications/jobs/results/10000000000000003-software-engineer-iii?page=40';
  assert.equal(matchesStoredPostingKey(url, 'generic:google.com:10000000000000003', { identityParserVersion: 2 }), true);
  assert.equal(matchesStoredPostingKey(url, 'generic:google.com:10000000000000002', { identityParserVersion: 2 }), false);
  assert.equal(matchesStoredPostingKey(
    'https://careers.google.com/jobs/results/10000000000000003-software-engineer-iii',
    'generic:google.com:10000000000000003',
    { identityParserVersion: 2 },
  ), false);
});

test('an exact CareerPuck Greenhouse mirror shares the native Greenhouse identity', () => {
  const mirror = 'https://app.careerpuck.com/job-board/acmeco/job/1000000004?gh_jid=1000000004';
  assert.equal(postingKey(mirror), 'greenhouse:acmeco:1000000004');
  assert.equal(samePosting(mirror, 'https://job-boards.greenhouse.io/acmeco/jobs/1000000004'), true);
  assert.equal(postingFingerprint(mirror.replace('gh_jid=1000000004', 'gh_jid=999')), null);
  assert.equal(postingFingerprint(mirror.replace('?gh_jid=1000000004', '')), null);
});

test('legacy generic keys remain valid only when validating immutable parser-v1 artifacts', () => {
  const adobe = 'https://careers.adobe.com/us/en/job/ADOBUSR100001EXTERNALENUS/Example-Engineer-5';
  const legacy = 'generic:careers.adobe.com:EXAMPLE-ENGINEER-5';
  assert.equal(legacyPostingKey(adobe), legacy);
  assert.equal(matchesStoredPostingKey(adobe, legacy, { identityParserVersion: 1 }), true);
  assert.equal(matchesStoredPostingKey(adobe, legacy, { identityParserVersion: 2 }), false);
});
