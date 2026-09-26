import { collectHistoricalPostingKeys } from './posting-history.mjs';

export function buildCanonicalFingerprintAudit({ records, careerRoot, runId }) {
  const history = collectHistoricalPostingKeys({ careerRoot, greenhouseKeys: records.flatMap(record => record.posting_keys) });
  const results = records.map(record => {
    const matched_keys = record.posting_keys.filter(key => history.has(key));
    const matches = matched_keys.map(key => ({ posting_key: key, prior_artifacts: [...new Set(history.get(key) ?? [])].sort() }));
    return { primary_key: record.primary_key, posting_keys: record.posting_keys, matched_keys, matches, duplicate: matched_keys.length > 0 };
  });
  return {
    schema_version: 1, run_id: runId, exact_set_verified: new Set(results.map(item => item.primary_key)).size === records.length,
    duplicate_count: results.filter(item => item.duplicate).length,
    duplicate_keys: results.filter(item => item.duplicate).map(item => item.primary_key), results,
  };
}
