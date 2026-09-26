import { postingKey } from '../../src/posting-identity.mjs';
import { addTombstone, canonicalPostIdentity, hasActiveTombstone, saveContactOutreach, saveOpportunity, upsertPost } from './db.mjs';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};

function score(decision, config) {
  const dimensions = decision.post_signal?.dimensions;
  if (!dimensions || typeof dimensions !== 'object') throw new Error('post_signal.dimensions is required');
  let total = 0;
  for (const [name, maximum] of Object.entries(config.post_signal.dimensions)) {
    const value = Number(dimensions[name]);
    if (!Number.isFinite(value) || value < 0 || value > Number(maximum)) throw new Error(`invalid Post Signal dimension ${name}`);
    total += value;
  }
  total = Math.round(total * 100) / 100;
  if (decision.post_signal.total != null && Number(decision.post_signal.total) !== total) throw new Error('Post Signal total does not equal dimensions');
  return total;
}

function exactOpportunity(post) {
  const decision = post.decision;
  const officialUrl = required(decision.official_url, 'official_url');
  const exactKey = required(decision.posting_key, 'posting_key');
  if (postingKey(officialUrl) !== exactKey) throw new Error(`${post.post_urn}: official URL does not match posting_key`);
  const evidence = decision.exact_identity_evidence;
  if (!evidence || !required(evidence.post_to_job, 'exact_identity_evidence.post_to_job')) throw new Error(`${post.post_urn}: post-to-job evidence is required`);
  if (required(decision.jd_text, 'jd_text').replace(/\s+/g, ' ').length < 200) throw new Error(`${post.post_urn}: exact job JD is too short`);
  return {
    kind: 'EXACT_JOB', posting_key: exactKey, employer: required(decision.employer, 'employer'), title: required(decision.title, 'title'),
    location: required(decision.location, 'location'), official_url: officialUrl, status: 'HANDOFF_READY',
    evidence: { ...evidence, jd_text: decision.jd_text, post_urn: post.post_urn, post_url: post.post_url,
      published_at: post.published_at ?? null, employment_type: decision.employment_type ?? 'unknown',
      employment_type_source: decision.employment_type_source ?? 'linkedin-post-deep-check',
      workplace_type: decision.workplace_type ?? 'unknown', workplace_type_source: decision.workplace_type_source ?? 'linkedin-post-deep-check',
      structured_remote_signal: decision.structured_remote_signal === true },
  };
}

export function processCapturedPosts(db, { runId, queryKey, posts, config }) {
  const counts = { observed: 0, unchanged: 0, tombstoned: 0, exact_jobs: 0, outreach_ready: 0, review: 0, excluded: 0, identity_review: [], errors: [] };
  for (let post of posts ?? []) {
    try {
      const route = required(post.decision?.route, 'decision.route');
      counts.observed += 1;
      let identity;
      try { identity = canonicalPostIdentity(post); }
      catch {
        if (route === 'EXCLUDED') { counts.excluded += 1; continue; }
        counts.review += 1;
        counts.identity_review.push({ reason_code: 'POST_IDENTITY_UNRESOLVED', query_key: queryKey,
          navigation_clue: post.post_url ?? post.author?.profile_url ?? null, employer: post.decision?.employer ?? post.author?.company ?? null,
          title: post.decision?.title ?? null });
        continue;
      }
      post = { ...post, ...identity };
      required(post.body, 'body');
      if (route === 'EXCLUDED' && hasActiveTombstone(db, post.post_urn)) { counts.tombstoned += 1; continue; }
      const stored = upsertPost(db, runId, queryKey, post);
      if (stored.existing && !stored.changed) { counts.unchanged += 1; continue; }
      if (route === 'EXCLUDED') {
        addTombstone(db, post.post_urn, required(post.decision.reason_code, 'reason_code'), config.tombstone_days);
        counts.excluded += 1;
        continue;
      }
      if (route === 'EXACT_JOB') {
        saveOpportunity(db, post.post_urn, exactOpportunity(post));
        counts.exact_jobs += 1;
        continue;
      }
      const total = score(post.decision, config);
      if (route === 'AUTO_PREPARE_READY') {
        if (total < Number(config.post_signal.ready_threshold)) throw new Error('AUTO_PREPARE_READY is below threshold');
        const opportunityId = saveOpportunity(db, post.post_urn, {
          kind: 'CONTACT', employer: post.decision.employer ?? post.author?.company ?? null, title: post.decision.title ?? null,
          location: post.decision.location ?? null, post_signal: total, status: 'AUTO_PREPARE_READY',
          evidence: { ...post.decision.evidence, post_urn: post.post_urn, post_url: post.post_url },
        });
        saveContactOutreach(db, opportunityId, post.decision.contact, post.decision.outreach);
        counts.outreach_ready += 1;
        continue;
      }
      if (route === 'REVIEW') {
        if (total < Number(config.post_signal.review_minimum) || total >= Number(config.post_signal.ready_threshold)) throw new Error('REVIEW score is outside [3.5, 4.0)');
        if (!Array.isArray(post.decision.missing_facts) || post.decision.missing_facts.length !== 1) throw new Error('REVIEW requires exactly one material missing fact');
        saveOpportunity(db, post.post_urn, { kind: 'REVIEW', employer: post.decision.employer ?? null, title: post.decision.title ?? null,
          location: post.decision.location ?? null, post_signal: total, status: 'REVIEW', reason_code: 'MISSING_MATERIAL_FACT',
          evidence: { missing_fact: post.decision.missing_facts[0], post_urn: post.post_urn, post_url: post.post_url } });
        counts.review += 1;
        continue;
      }
      throw new Error(`unsupported route: ${route}`);
    } catch (error) {
      counts.errors.push({ post_urn: post?.post_urn ?? null, error: error.message, raw_decision: post?.decision ?? null });
    }
  }
  return counts;
}
