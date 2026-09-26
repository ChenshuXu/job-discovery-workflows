const unique = values => [...new Set((values ?? []).map(String))].sort();

export function jobIssue({ posting_key, stage, code, reason, evidence = null, existing_report = null }) {
  if (!String(posting_key ?? '').trim()) throw new Error('job issue posting_key is required');
  if (!/^[A-Z][A-Z0-9_]*$/.test(String(code ?? ''))) throw new Error(`${posting_key}: stable job issue code is required`);
  if (!String(stage ?? '').trim() || !String(reason ?? '').trim()) throw new Error(`${posting_key}: job issue stage and reason are required`);
  return {
    posting_key: String(posting_key),
    stage: String(stage),
    code: String(code),
    reason: String(reason).trim(),
    evidence,
    existing_report: existing_report ? String(existing_report) : null,
  };
}

export function normalizeJobIssues(values = []) {
  const byKey = new Map();
  for (const value of values) {
    const issue = jobIssue(value);
    if (!byKey.has(issue.posting_key)) byKey.set(issue.posting_key, issue);
  }
  return [...byKey.values()].sort((left, right) => left.posting_key.localeCompare(right.posting_key));
}

export function evaluatePersistence({ acquiredKeys, committedKeys, jobIssues }) {
  const acquired = unique(acquiredKeys);
  const committed = unique(committedKeys);
  const issues = normalizeJobIssues(jobIssues);
  const issueKeys = unique(issues.map(item => item.posting_key));
  const terminal = unique([...committed, ...issueKeys]);
  const overlap = committed.filter(key => issueKeys.includes(key));
  const ratio = acquired.length ? issueKeys.length / acquired.length : 1;
  const equationValid = overlap.length === 0 && JSON.stringify(terminal) === JSON.stringify(acquired);
  const successful = committed.length > 0;
  return {
    issue_count: issueKeys.length,
    acquired_count: acquired.length,
    ratio,
    has_successful_posting: successful,
    terminal_equation_valid: equationValid,
    allowed: equationValid && successful,
  };
}
