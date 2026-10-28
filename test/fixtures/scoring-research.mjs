// Fictional opened-source captures; never used by live Daily Scan.
export function researchFixture(postingKey, company, checkedAt = new Date().toISOString()) {
  const source = (id, url, kind, content) => ({ id, url, title: `Fictional ${id} evidence`, kind,
    scope: `${company}; Senior Backend Engineer; Seattle; USD annual base; current fictional benchmark`,
    published_at: null, retrieved_at: checkedAt, reference: `fixture:opened-${id}`, content });
  return { version: 1, posting_key: postingKey, company, checked_at: checkedAt,
    sources: [source('market', 'https://market.example/salary', 'market', 'Published market base range is $170,000 to $200,000.'),
      source('company', 'https://company.example/team', 'official', 'The company reports a six-engineer platform team, direct ownership and current operations.')],
    checks: Object.fromEntries(['compensation', 'culture', 'company'].map(dimension => [dimension, {
      status: 'complete', queries: [{ query: `${company} ${dimension} Senior Backend Seattle`, tool: 'fixture-search', reference: `fixture:search-${dimension}`, outcome: 'found' }],
      source_ids: [dimension === 'compensation' ? 'market' : 'company'], finding: `Fictional ${dimension} evidence reviewed for ${company}.`, question: null,
    }])) };
}
