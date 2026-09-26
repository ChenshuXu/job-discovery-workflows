import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { POST_SCAN_ROOT } from './config.mjs';

export const DEFAULT_DB = path.join(POST_SCAN_ROOT, 'data/linkedin-post-scan.db');
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value ?? {});
const parse = value => value ? JSON.parse(value) : null;

export function openDatabase(file = DEFAULT_DB) {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys = ON');
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version === 0) db.exec(readFileSync(path.join(POST_SCAN_ROOT, 'migrations/001-init.sql'), 'utf8'));
  else if (version !== 1) throw new Error(`unsupported Post Scan database version: ${version}`);
  return db;
}

export function openDatabaseReadOnly(file = DEFAULT_DB) {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return null;
  const uri = pathToFileURL(resolved);
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 1) { db.close(); throw new Error(`unsupported Post Scan database version: ${version}`); }
  return db;
}

export function beginRun(db, { runId, mode }) {
  try {
    db.prepare('INSERT INTO runs (run_id, mode, started_at, status) VALUES (?, ?, ?, ?)').run(runId, mode, now(), 'RUNNING');
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed: runs.status')) throw new Error('RUN_ALREADY_ACTIVE');
    throw error;
  }
  return runId;
}

export function finishRun(db, runId, { status = 'COMPLETE', stopCode = null, coverage = {}, receipt = {} } = {}) {
  db.prepare('UPDATE runs SET completed_at = ?, status = ?, stop_code = ?, coverage_json = ?, receipt_json = ? WHERE run_id = ?')
    .run(now(), status, stopCode, json(coverage), json(receipt), runId);
}

export function recordQuery(db, runId, item) {
  const { posts, ...queryEvidence } = item;
  if (Array.isArray(posts)) queryEvidence.captured_post_count = posts.length;
  db.prepare(`INSERT OR REPLACE INTO query_runs
    (run_id, query_key, priority, query_text, started_at, finished_at, elapsed_ms, posts_verified, past_week_verified, latest_selected, result_count, deep_check_count, truncated, status, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, item.query_key, item.priority, item.query_text, item.started_at ?? null, item.finished_at ?? null,
      Number(item.elapsed_ms ?? 0), item.filters?.posts === true ? 1 : 0, item.filters?.past_week === true ? 1 : 0,
      item.filters?.latest == null ? null : item.filters.latest === true ? 1 : 0, Number(item.visible_result_count ?? item.posts?.length ?? 0),
      Number(item.deep_check_count ?? 0), item.truncated === true ? 1 : 0, item.status ?? 'COMPLETE', json(queryEvidence));
}

export const postHash = body => createHash('sha256').update(String(body ?? '')).digest('hex');
export const tombstoneHash = urn => createHash('sha256').update(`linkedin-post-scan:${String(urn)}`).digest('hex');

export function canonicalPostIdentity(post) {
  const urn = String(post?.post_urn ?? '').trim();
  const urnMatch = urn.match(/^urn:li:activity:(\d+)$/);
  if (!urnMatch) throw new Error('POST_IDENTITY_UNRESOLVED');
  let url;
  try { url = new URL(String(post?.post_url ?? '').trim()); }
  catch { throw new Error('POST_IDENTITY_UNRESOLVED'); }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) throw new Error('POST_IDENTITY_UNRESOLVED');
  const pathname = decodeURIComponent(url.pathname);
  const urlMatch = pathname.match(/^\/feed\/update\/urn:li:activity:(\d+)\/?$/)
    ?? pathname.match(/^\/posts\/[^/]*activity-(\d+)(?:-|\/|$)/);
  if (!urlMatch || urlMatch[1] !== urnMatch[1]) throw new Error('POST_IDENTITY_UNRESOLVED');
  return { post_urn: `urn:li:activity:${urnMatch[1]}`, post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${urnMatch[1]}/` };
}

export function isCanonicalPostIdentity(post) {
  try { canonicalPostIdentity(post); return true; }
  catch { return false; }
}

export function hasActiveTombstone(db, urn) {
  return Boolean(db.prepare('SELECT 1 FROM exclusion_tombstones WHERE post_id_hash = ? AND expires_at > ?').get(tombstoneHash(urn), now()));
}

export function upsertPost(db, runId, queryKey, post) {
  const identity = canonicalPostIdentity(post);
  post = { ...post, ...identity };
  const timestamp = now();
  const hash = postHash(post.body);
  const existing = db.prepare('SELECT body_hash FROM posts WHERE post_urn = ?').get(post.post_urn);
  db.prepare(`INSERT INTO posts (post_urn, post_url, body, body_hash, author_json, published_at, first_seen_at, last_seen_at, route, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_urn) DO UPDATE SET post_url=excluded.post_url, body=excluded.body, body_hash=excluded.body_hash,
      author_json=excluded.author_json, published_at=excluded.published_at, last_seen_at=excluded.last_seen_at,
      route=excluded.route, evidence_json=excluded.evidence_json`)
    .run(post.post_urn, post.post_url, post.body, hash, json(post.author), post.published_at ?? null, timestamp, timestamp, post.decision.route, json(post));
  db.prepare('INSERT OR REPLACE INTO run_posts (run_id, query_key, post_urn, body_hash, observed_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, queryKey, post.post_urn, hash, timestamp);
  return { hash, changed: !existing || existing.body_hash !== hash, existing: Boolean(existing) };
}

export function addTombstone(db, urn, reasonCode, days) {
  const created = new Date();
  const expires = new Date(created.getTime() + Number(days) * 86400000);
  db.prepare('INSERT OR REPLACE INTO exclusion_tombstones (post_id_hash, reason_code, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tombstoneHash(urn), reasonCode, created.toISOString(), expires.toISOString());
  const linked = db.prepare('SELECT opportunity_id FROM post_opportunities WHERE post_urn=?').all(urn);
  for (const row of linked) {
    const otherSource = db.prepare('SELECT 1 FROM post_opportunities WHERE opportunity_id=? AND post_urn<>? LIMIT 1')
      .get(row.opportunity_id, urn);
    if (otherSource) continue;
    db.prepare("UPDATE opportunities SET status='SUPERSEDED', reason_code='POST_REROUTED', updated_at=? WHERE opportunity_id=?")
      .run(created.toISOString(), row.opportunity_id);
    db.prepare("UPDATE outreach SET status='SUPERSEDED', last_checked_at=? WHERE opportunity_id=?")
      .run(created.toISOString(), row.opportunity_id);
  }
  db.prepare('DELETE FROM post_opportunities WHERE post_urn=?').run(urn);
  db.prepare('DELETE FROM run_posts WHERE post_urn=?').run(urn);
  db.prepare('DELETE FROM posts WHERE post_urn = ?').run(urn);
}

export function purgeExpiredTombstones(db) {
  return Number(db.prepare('DELETE FROM exclusion_tombstones WHERE expires_at <= ?').run(now()).changes);
}

export function saveOpportunity(db, postUrn, opportunity) {
  const timestamp = now();
  const identityText = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  const stableKey = [postUrn, opportunity.kind, identityText(opportunity.employer), identityText(opportunity.title)].join('\0');
  const id = opportunity.opportunity_id || (opportunity.posting_key ? `job:${opportunity.posting_key}` : `opp:${createHash('sha256').update(stableKey).digest('hex')}`);
  const prior = db.prepare(`SELECT o.opportunity_id FROM opportunities o
    JOIN post_opportunities po ON po.opportunity_id=o.opportunity_id
    WHERE po.post_urn=? AND o.kind IN ('CONTACT','REVIEW') AND o.opportunity_id<>?`).all(postUrn, id);
  for (const row of prior) {
    db.prepare("UPDATE opportunities SET status='SUPERSEDED', reason_code='POST_REROUTED', updated_at=? WHERE opportunity_id=?")
      .run(timestamp, row.opportunity_id);
    db.prepare("UPDATE outreach SET status='SUPERSEDED', last_checked_at=? WHERE opportunity_id=?")
      .run(timestamp, row.opportunity_id);
  }
  db.prepare(`INSERT INTO opportunities (opportunity_id, kind, posting_key, employer, title, location, official_url, post_signal, status, reason_code, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(opportunity_id) DO UPDATE SET employer=excluded.employer, title=excluded.title, location=excluded.location,
      official_url=excluded.official_url, post_signal=excluded.post_signal,
      status=CASE
        WHEN opportunities.kind IN ('CONTACT','REVIEW') AND opportunities.status NOT IN ('AUTO_PREPARE_READY','REVIEW') THEN opportunities.status
        WHEN opportunities.kind='EXACT_JOB' AND opportunities.status NOT IN ('HANDOFF_READY','HANDOFF_FAILED','HANDOFF_RESULT_UNRESOLVED') THEN opportunities.status
        ELSE excluded.status END,
      reason_code=CASE
        WHEN opportunities.kind IN ('CONTACT','REVIEW') AND opportunities.status NOT IN ('AUTO_PREPARE_READY','REVIEW') THEN opportunities.reason_code
        WHEN opportunities.kind='EXACT_JOB' AND opportunities.status NOT IN ('HANDOFF_READY','HANDOFF_FAILED','HANDOFF_RESULT_UNRESOLVED') THEN opportunities.reason_code
        ELSE excluded.reason_code END,
      evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`)
    .run(id, opportunity.kind, opportunity.posting_key ?? null, opportunity.employer ?? null, opportunity.title ?? null,
      opportunity.location ?? null, opportunity.official_url ?? null, opportunity.post_signal ?? null, opportunity.status,
      opportunity.reason_code ?? null, json(opportunity.evidence), timestamp, timestamp);
  db.prepare('INSERT OR IGNORE INTO post_opportunities (post_urn, opportunity_id) VALUES (?, ?)').run(postUrn, id);
  return id;
}

export function saveContactOutreach(db, opportunityId, contact, outreach) {
  const timestamp = now();
  const contactId = contact.member_id ? `member:${contact.member_id}` : `profile:${createHash('sha256').update(contact.profile_url).digest('hex')}`;
  db.prepare(`INSERT INTO contacts (contact_id, member_id, profile_url, name, company, title, relationship_status, verified_at, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET name=excluded.name, company=excluded.company, title=excluded.title,
      relationship_status=CASE WHEN excluded.relationship_status='UNKNOWN' THEN contacts.relationship_status ELSE excluded.relationship_status END,
      verified_at=excluded.verified_at, evidence_json=excluded.evidence_json`)
    .run(contactId, contact.member_id ?? null, contact.profile_url ?? null, contact.name ?? null, contact.company ?? null,
      contact.title ?? null, contact.relationship_status ?? 'UNKNOWN', timestamp, json(contact));
  const outreachId = `outreach:${contactId}:${opportunityId}`;
  db.prepare(`INSERT INTO outreach (outreach_id, contact_id, opportunity_id, channel, status, draft, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, opportunity_id) DO UPDATE SET
      channel=CASE WHEN outreach.status='AUTO_PREPARE_READY' THEN excluded.channel ELSE outreach.channel END,
      status=outreach.status,
      draft=CASE WHEN outreach.status='AUTO_PREPARE_READY' THEN excluded.draft ELSE outreach.draft END,
      evidence_json=CASE WHEN outreach.status='AUTO_PREPARE_READY' THEN excluded.evidence_json ELSE outreach.evidence_json END`)
    .run(outreachId, contactId, opportunityId, outreach.channel ?? 'CONNECT_NOTE', outreach.status ?? 'AUTO_PREPARE_READY', outreach.draft, json(outreach));
  return outreachId;
}

export function dailySnapshot(db, date) {
  const pacificDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const opportunities = db.prepare('SELECT * FROM opportunities ORDER BY updated_at DESC').all().filter(row => pacificDay(row.updated_at) <= date);
  const outreach = db.prepare(`SELECT o.*, c.name, c.profile_url, c.relationship_status, p.employer, p.title, p.official_url, p.post_signal
    FROM outreach o JOIN contacts c ON c.contact_id=o.contact_id JOIN opportunities p ON p.opportunity_id=o.opportunity_id
    ORDER BY o.status, p.updated_at DESC`).all();
  const runs = db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all().filter(row => pacificDay(row.started_at) === date);
  const excludedRows = db.prepare('SELECT reason_code, created_at FROM exclusion_tombstones ORDER BY reason_code').all().filter(row => pacificDay(row.created_at) === date);
  const excluded = Object.entries(excludedRows.reduce((counts, row) => ({ ...counts, [row.reason_code]: (counts[row.reason_code] ?? 0) + 1 }), {}))
    .map(([reason_code, count]) => ({ reason_code, count }));
  const sourceRows = db.prepare(`SELECT po.opportunity_id, p.post_urn, p.post_url, p.last_seen_at
    FROM post_opportunities po JOIN posts p ON p.post_urn=po.post_urn ORDER BY p.last_seen_at DESC`).all();
  const sources = new Map();
  for (const row of sourceRows) {
    const items = sources.get(row.opportunity_id) ?? [];
    items.push({ ...row, identity_valid: isCanonicalPostIdentity(row) });
    sources.set(row.opportunity_id, items);
  }
  const handoffs = new Map(db.prepare('SELECT * FROM career_ops_handoffs').all().map(row => [row.posting_key, {
    ...row, report_identity: parse(row.report_identity), receipt: parse(row.receipt_json),
  }]));
  const enrich = row => {
    const linked = sources.get(row.opportunity_id) ?? [];
    const source = linked.find(item => item.identity_valid) ?? linked[0] ?? null;
    return { ...row, evidence: parse(row.evidence_json), sources: linked, source_post_urn: source?.post_urn ?? null,
      source_post_url: source?.identity_valid ? source.post_url : null, navigation_clue: source?.post_url ?? null,
      source_identity_valid: source?.identity_valid === true, handoff: row.posting_key ? handoffs.get(row.posting_key) ?? null : null };
  };
  const enrichedOpportunities = opportunities.map(enrich);
  const opportunityMap = new Map(enrichedOpportunities.map(row => [row.opportunity_id, row]));
  return {
    opportunities: enrichedOpportunities,
    outreach: outreach.map(row => ({ ...row, evidence: parse(row.evidence_json),
      source_post_urn: opportunityMap.get(row.opportunity_id)?.source_post_urn ?? null,
      source_post_url: opportunityMap.get(row.opportunity_id)?.source_post_url ?? null,
      navigation_clue: opportunityMap.get(row.opportunity_id)?.navigation_clue ?? null,
      source_identity_valid: opportunityMap.get(row.opportunity_id)?.source_identity_valid === true })),
    runs: runs.map(row => ({ ...row, receipt: parse(row.receipt_json), coverage: parse(row.coverage_json) })),
    excluded,
  };
}

export function statusSnapshot(db) {
  const opportunityRows = db.prepare(`SELECT o.opportunity_id, o.status, p.post_urn, p.post_url
    FROM opportunities o LEFT JOIN post_opportunities po ON po.opportunity_id=o.opportunity_id
    LEFT JOIN posts p ON p.post_urn=po.post_urn`).all();
  const grouped = new Map();
  for (const row of opportunityRows) {
    const item = grouped.get(row.opportunity_id) ?? { status: row.status, source_valid: false };
    item.source_valid ||= isCanonicalPostIdentity(row);
    grouped.set(row.opportunity_id, item);
  }
  const reviewStatuses = new Set(['REVIEW', 'HANDOFF_READY', 'HANDOFF_FAILED', 'HANDOFF_RESULT_UNRESOLVED',
    'INMAIL_REVIEW', 'NO_NOTE_AVAILABLE', 'EXTERNAL_ACTION_REVIEW', 'SEND_UNCERTAIN']);
  const readyRows = db.prepare(`SELECT o.outreach_id, p.post_urn, p.post_url FROM outreach o
    JOIN post_opportunities po ON po.opportunity_id=o.opportunity_id JOIN posts p ON p.post_urn=po.post_urn
    WHERE o.status='AUTO_PREPARE_READY'`).all();
  return {
    active_run: db.prepare("SELECT run_id, mode, started_at FROM runs WHERE status='RUNNING'").get() ?? null,
    latest_run: db.prepare("SELECT run_id, mode, status, stop_code, started_at, completed_at FROM runs WHERE status!='RUNNING' ORDER BY started_at DESC LIMIT 1").get() ?? null,
    ready_outreach: new Set(readyRows.filter(isCanonicalPostIdentity).map(row => row.outreach_id)).size,
    review: [...grouped.values()].filter(item => !item.source_valid || reviewStatuses.has(item.status)).length,
  };
}

export function queryCoverageState(db) {
  const lastSuccess = Object.fromEntries(db.prepare(`SELECT query_key, max(finished_at) AS finished_at
    FROM query_runs WHERE status='COMPLETE' AND finished_at IS NOT NULL GROUP BY query_key`).all()
    .map(row => [row.query_key, row.finished_at]));
  const latest = db.prepare("SELECT coverage_json FROM runs WHERE mode='scan' AND status IN ('COMPLETE','STOPPED') ORDER BY started_at DESC LIMIT 1").get();
  return { last_success: lastSuccess, next_cursor: latest ? parse(latest.coverage_json)?.cursor ?? null : null };
}

export function queryTimingSamples(db) {
  return db.prepare(`SELECT qr.run_id, r.mode, qr.query_key, qr.priority, qr.elapsed_ms, qr.result_count, qr.deep_check_count, qr.evidence_json
    FROM query_runs qr JOIN runs r ON r.run_id=qr.run_id
    WHERE qr.status='COMPLETE' AND qr.posts_verified=1 AND qr.past_week_verified=1`).all().map(row => ({
      ...parse(row.evidence_json), run_id: row.run_id, mode: row.mode, query_key: row.query_key, priority: row.priority,
      elapsed_ms: Number(row.elapsed_ms ?? 0), result_count: Number(row.result_count ?? 0), deep_check_count: Number(row.deep_check_count ?? 0),
    }));
}
