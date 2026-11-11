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

// Rules come from a loaded config object; validate and compile each array once.
const compiledRules = new WeakMap();

function compiledFor(rules) {
  if (Array.isArray(rules) && compiledRules.has(rules)) return compiledRules.get(rules);
  validateEmployerExclusionRules(rules);
  const compiled = rules.map(rule => ({
    rule,
    company: compile(rule.company_pattern),
    attribution: compile(rule.attribution_line_pattern),
    employer: compile(`^(?:${rule.company_pattern})(?:\\s*\\([^)]*\\))?$`),
    signals: rule.jd_signal_patterns.map(compile),
  }));
  compiledRules.set(rules, compiled);
  return compiled;
}

function statedEmployer(line) {
  return line.match(/^(.{1,100}?) is building a (?:central )?pipeline of .{1,120}?\btalent\b/i)?.[1]
    || line.match(/^(.{1,100}?) is hiring an? (?:(?!(?:to|for|with|using|not)\b)[A-Za-z0-9.+/#-]+ ){0,8}(?:engineer|developer|scientist|architect|manager|specialist|analyst|designer)\b/i)?.[1];
}

export function matchExcludedEmployer({ company = '', description = '' }, rules) {
  const compiled = compiledFor(rules);
  const companyText = clean(company);
  const jd = String(description ?? '').replace(/\r/g, '');
  const lines = jd.split('\n').map(clean).filter(Boolean).map(line => ({ line, employer: statedEmployer(line) }));

  for (const { rule, company: companyPattern, attribution: attributionPattern, employer: employerPattern, signals: signalPatterns } of compiled) {
    if (companyPattern.test(companyText)) {
      return { id: rule.id, reason: rule.reason, source: 'company', evidence: `Company: ${companyText}` };
    }

    const attribution = lines.find(({ line, employer }) => attributionPattern.test(line) || (employer && employerPattern.test(employer)))?.line;
    if (attribution) {
      return { id: rule.id, reason: rule.reason, source: 'jd_attribution', evidence: `JD attribution: ${attribution}` };
    }

    const signals = signalPatterns
      .map(pattern => jd.match(pattern)?.[0])
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
