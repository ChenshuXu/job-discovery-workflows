function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function compile(pattern) {
  return new RegExp(pattern, 'im');
}

export function validateEmployerExclusionRules(rules) {
  if (!Array.isArray(rules)) throw new Error('employer_exclusions must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!clean(rule?.id) || !clean(rule?.reason) || !clean(rule?.company_pattern)
      || !clean(rule?.attribution_line_pattern) || !Array.isArray(rule?.jd_signal_patterns)
      || !rule.jd_signal_patterns.length || !Number.isInteger(rule?.required_jd_signal_count)
      || rule.required_jd_signal_count < 1 || rule.required_jd_signal_count > rule.jd_signal_patterns.length) {
      throw new Error('employer exclusion rules require id, reason, company/attribution patterns, signals, and a valid required signal count');
    }
    if (ids.has(rule.id)) throw new Error(`duplicate employer exclusion id: ${rule.id}`);
    ids.add(rule.id);
    compile(rule.company_pattern);
    compile(rule.attribution_line_pattern);
    for (const pattern of rule.jd_signal_patterns) compile(pattern);
  }
  return rules;
}

export function matchExcludedEmployer({ company = '', description = '' }, rules) {
  validateEmployerExclusionRules(rules);
  const companyText = clean(company);
  const jd = String(description ?? '').replace(/\r/g, '');
  const lines = jd.split('\n').map(clean).filter(Boolean);

  for (const rule of rules) {
    if (compile(rule.company_pattern).test(companyText)) {
      return { id: rule.id, reason: rule.reason, source: 'company', evidence: `Company: ${companyText}` };
    }

    const attribution = lines.find(line => compile(rule.attribution_line_pattern).test(line));
    if (attribution) {
      return { id: rule.id, reason: rule.reason, source: 'jd_attribution', evidence: `JD attribution: ${attribution}` };
    }

    const signals = rule.jd_signal_patterns
      .map(pattern => jd.match(compile(pattern))?.[0])
      .filter(Boolean)
      .map(clean);
    if (signals.length >= rule.required_jd_signal_count) {
      return {
        id: rule.id,
        reason: rule.reason,
        source: 'jd_boilerplate',
        evidence: `JD employer signals: ${signals.slice(0, rule.required_jd_signal_count).join(' | ')}`,
      };
    }
  }
  return null;
}
