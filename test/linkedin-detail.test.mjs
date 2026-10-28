import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fetchLinkedInJobPosting } from '../src/adapters/egobrowser_linkedin_scan.mjs';

test('LinkedIn detail transport bounds recovery and never retries access restrictions', async () => {
  const valid = JSON.stringify({ data: { title: 'Engineer', description: { text: 'complete body' } } });
  for (const [responses, expected, count] of [
    [[{ status: 200, body: valid }], 'ok', 1],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer', entityUrn: 'urn:li:fs_normalized_jobPosting:123' } }) }], 'ok', 1],
    [[{ status: 200, body: '<html>temporary</html>' }, { status: 200, body: valid }], 'ok', 2],
    [[{ status: 200, body: '<html>SECRET</html>' }, { status: 200, body: '<html>SECRET</html>' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 200, body: '{}' }, { status: 200, body: '{}' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer' }, included: {} }) }, { status: 200, body: '{}' }], 'DETAIL_INVALID_RESPONSE', 2],
    [[{ status: 429, body: 'SECRET' }], 'DETAIL_HTTP_ERROR', 1],
    [[{ status: 403, body: 'SECRET' }], 'DETAIL_HTTP_ERROR', 1],
    [[{ status: 200, body: JSON.stringify({ data: { title: 'Engineer', description: { text: 'complete body' }, entityUrn: 'urn:li:jobPosting:999' } }) }], 'DETAIL_IDENTITY_MISMATCH', 1],
  ]) {
    let calls = 0;
    const context = vm.createContext({ document: { cookie: 'JSESSIONID="test"' }, fetch: async () => {
      const response = responses[calls++];
      assert.ok(response, 'retry budget exceeded');
      return { ok: response.status === 200, status: response.status, text: async () => response.body };
    } });
    const result = await vm.runInContext(`(${fetchLinkedInJobPosting.toString()})('123')`, context);
    assert.equal(result.ok ? 'ok' : result.failureCode, expected);
    assert.equal(calls, count);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
});
