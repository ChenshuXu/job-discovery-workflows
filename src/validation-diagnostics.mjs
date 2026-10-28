// Run independent checks once. Dependent checks stay inside their parent's guard.
export function validateChecks(checks, prefix = '') {
  const issues = [];
  for (const [field, check] of Object.entries(checks)) {
    try { check(); }
    catch (error) {
      if (error.issues) issues.push(...error.issues);
      else {
        const path = prefix + field;
        const suffix = error.message.startsWith(path) ? error.message.slice(path.length).match(/^(\.[a-z_][a-z0-9_.]*)/i)?.[1] ?? '' : '';
        issues.push({ field: path + suffix, code: 'INVALID_' + field.replace(/[^a-z0-9]+/gi, '_').toUpperCase(), message: error.message });
      }
    }
  }
  if (issues.length) {
    const error = new Error(issues.map(issue => issue.message).join('\n'));
    error.issues = issues;
    throw error;
  }
}
