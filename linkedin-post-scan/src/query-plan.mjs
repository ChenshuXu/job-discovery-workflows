const quote = value => `"${String(value).replaceAll('"', '\\"')}"`;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function buildQueryPlan(config, { strategy = config.search.default_strategy, lastSuccess = {} } = {}) {
  const p1 = new Set(config.search.p1_phrase_groups);
  const queries = [];
  for (const [phraseGroup, phrases] of Object.entries(config.phrase_groups)) {
    const phraseSets = strategy === 'combined' ? [phrases.map(quote).join(' OR ')] : phrases.map(quote);
    for (const phrase of phraseSets) for (const [roleGroup, roles] of Object.entries(config.role_groups)) {
      const role = roles.length === 1 ? quote(roles[0]) : `(${roles.map(quote).join(' OR ')})`;
      for (const [locationGroup, location] of Object.entries(config.location_groups)) {
        const variant = strategy === 'combined' ? 'combined' : phrase.replaceAll(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
        const queryKey = [phraseGroup, roleGroup, locationGroup, variant].join(':');
        queries.push({ query_key: queryKey, priority: p1.has(phraseGroup) ? 'P1' : 'P2', phrase_group: phraseGroup,
          role_group: roleGroup, location_group: locationGroup, query_text: `(${phrase}) AND ${role} AND (${location.query})`,
          last_success_at: lastSuccess[queryKey] ?? null });
      }
    }
  }
  return queries.sort((a, b) => a.priority.localeCompare(b.priority)
    || String(a.last_success_at ?? '').localeCompare(String(b.last_success_at ?? '')) || a.query_key.localeCompare(b.query_key));
}

export function calibrationQueries(config) {
  return config.search.representative_calibration.flatMap(sample => Object.entries(config.phrase_groups).map(([phraseGroup, phrases]) => {
    const roles = config.role_groups[sample.role_group];
    const location = config.location_groups[sample.location_group];
    const stem = `${phraseGroup}:${sample.role_group}:${sample.location_group}`;
    return {
      sample_key: stem,
      combined: { query_key: `${stem}:combined`, query_text: `(${phrases.map(quote).join(' OR ')}) AND (${roles.map(quote).join(' OR ')}) AND (${location.query})` },
      split: phrases.map((phrase, index) => ({ query_key: `${stem}:split-${index + 1}`, query_text: `${quote(phrase)} AND (${roles.map(quote).join(' OR ')}) AND (${location.query})` })),
    };
  }));
}

function scheduledGaps(config, strategy, queriesPerRun) {
  if (!Number.isInteger(queriesPerRun) || queriesPerRun < 1) return { p1_max_gap_hours: null, p2_max_gap_hours: null, schedule_coverage_complete: false };
  const plan = buildQueryPlan(config, { strategy });
  if (queriesPerRun < plan.length) return { p1_max_gap_hours: null, p2_max_gap_hours: null, schedule_coverage_complete: false };
  const times = config.schedule_reference.times.map(value => {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }).sort((a, b) => a - b);
  if (!times.length) return { p1_max_gap_hours: null, p2_max_gap_hours: null, schedule_coverage_complete: false };
  const maxGap = Math.max(...times.map((time, index) => ((times[index + 1] ?? times[0] + 1440) - time) / 60));
  return { p1_max_gap_hours: plan.some(item => item.priority === 'P1') ? maxGap : 0,
    p2_max_gap_hours: plan.some(item => item.priority === 'P2') ? maxGap : 0,
    schedule_coverage_complete: true };
}

export function summarizeCalibration(config, captures, { timingSamples = [] } = {}) {
  const groups = new Map();
  for (const item of captures) {
    const key = item.sample_key;
    if (!groups.has(key)) groups.set(key, { combined: [], split: [] });
    groups.get(key)[item.variant].push(item);
  }
  let meaningfulLoss = false;
  const comparisons = [];
  for (const [sampleKey, variants] of groups) {
    const combined = new Set(variants.combined.flatMap(item => item.post_ids ?? []));
    const split = new Set(variants.split.flatMap(item => item.post_ids ?? []));
    const combinedActionable = new Set(variants.combined.flatMap(item => item.actionable_post_ids ?? []));
    const splitActionable = new Set(variants.split.flatMap(item => item.actionable_post_ids ?? []));
    const missedActionable = [...splitActionable].filter(id => !combinedActionable.has(id));
    meaningfulLoss ||= missedActionable.length > 0;
    comparisons.push({ sample_key: sampleKey, combined_post_ids: [...combined].sort(), split_post_ids: [...split].sort(),
      combined_actionable_ids: [...combinedActionable].sort(), split_actionable_ids: [...splitActionable].sort(), missed_actionable: missedActionable.sort() });
  }
  const strategy = meaningfulLoss ? 'split' : 'combined';
  const selected = captures.filter(item => item.variant === strategy);
  const supplemental = timingSamples.filter(item => item.mode === 'scan'
    && config.search.default_strategy === strategy
    && Object.hasOwn(item, 'deep_check_elapsed_ms_total'));
  const timing = [...selected, ...supplemental];
  const averageQuickMs = mean(timing.map(item => Number(item.elapsed_ms ?? 0)).filter(value => value > 0));
  const deepCheckCount = timing.reduce((sum, item) => sum + Number(item.deep_check_count ?? 0), 0);
  const deepCheckElapsedMs = timing.reduce((sum, item) => sum + Number(item.deep_check_elapsed_ms_total ?? 0), 0);
  const timedDeepCheckCount = timing.filter(item => Number(item.deep_check_elapsed_ms_total ?? 0) > 0)
    .reduce((sum, item) => sum + Number(item.deep_check_count ?? 0), 0);
  const averageDeepChecksPerQuery = timing.length ? deepCheckCount / timing.length : 0;
  const averageDeepCheckMs = timedDeepCheckCount > 0 ? deepCheckElapsedMs / timedDeepCheckCount : 0;
  const effectiveQueryMs = averageQuickMs > 0 && averageDeepCheckMs > 0
    ? averageQuickMs + averageDeepChecksPerQuery * averageDeepCheckMs : null;
  const queriesPerRun = effectiveQueryMs ? Math.floor(config.search.run_limit_minutes * 60000 / effectiveQueryMs) : 0;
  const planCount = buildQueryPlan(config, { strategy }).length;
  const runsPerDay = config.schedule_reference.times.length;
  const dailyCapacity = queriesPerRun * runsPerDay;
  const p1Count = buildQueryPlan(config, { strategy }).filter(item => item.priority === 'P1').length;
  const p2Count = planCount - p1Count;
  const gaps = scheduledGaps(config, strategy, queriesPerRun);
  const budgetComplete = averageDeepCheckMs > 0 && gaps.schedule_coverage_complete
    && gaps.p1_max_gap_hours <= Number(config.search.priority_hours.P1)
    && gaps.p2_max_gap_hours <= Number(config.search.priority_hours.P2);
  return { strategy, meaningful_actionable_recall_loss: meaningfulLoss, comparisons,
    average_quick_query_ms: Math.round(averageQuickMs), average_deep_checks_per_query: Math.round(averageDeepChecksPerQuery * 100) / 100,
    average_deep_check_ms: Math.round(averageDeepCheckMs), effective_query_ms: effectiveQueryMs ? Math.round(effectiveQueryMs) : null,
    deep_check_rate: timing.length ? deepCheckCount / Math.max(1, timing.reduce((sum, item) => sum + Number(item.result_count ?? 0), 0)) : 0,
    timing_scope: 'FILTER_SCROLL_QUICK_SCREEN_PLUS_REAL_DEEP_CHECK', budget_complete: budgetComplete,
    queries_per_run: queriesPerRun, daily_query_capacity: dailyCapacity, total_queries: planCount, p1_queries: p1Count, p2_queries: p2Count,
    ...gaps };
}
