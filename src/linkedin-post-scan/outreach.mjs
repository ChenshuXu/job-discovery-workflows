import { canonicalPostIdentity } from './db.mjs';

const now = () => new Date().toISOString();
const parse = value => value ? JSON.parse(value) : {};

function outreachRow(db, candidate, readyOnly = false) {
  if (!candidate) throw new Error('outreach candidate is required');
  const matches = db.prepare(`SELECT o.*, c.member_id, c.profile_url, c.name, c.company, c.title AS contact_title, c.relationship_status,
      p.employer, p.title AS opportunity_title, p.evidence_json AS opportunity_evidence,
      s.post_urn AS source_post_urn, s.post_url AS source_post_url
    FROM outreach o JOIN contacts c ON c.contact_id=o.contact_id JOIN opportunities p ON p.opportunity_id=o.opportunity_id
    LEFT JOIN post_opportunities po ON po.opportunity_id=p.opportunity_id
    LEFT JOIN posts s ON s.post_urn=po.post_urn
    WHERE (o.outreach_id=? OR c.member_id=? OR c.profile_url=? OR c.name=?) ${readyOnly ? "AND o.status='AUTO_PREPARE_READY'" : ''}
    ORDER BY p.updated_at DESC`).all(candidate, candidate, candidate, candidate);
  if (!matches.length) throw new Error(readyOnly
    ? `AUTO_PREPARE candidate not found or not ready: ${candidate}`
    : `outreach candidate not found: ${candidate}`);
  const row = matches.find(item => {
    try { canonicalPostIdentity({ post_urn: item.source_post_urn, post_url: item.source_post_url }); return true; }
    catch { return false; }
  }) ?? matches[0];
  canonicalPostIdentity({ post_urn: row.source_post_urn, post_url: row.source_post_url });
  return row;
}

export function validateOutreachDraft({ draft, liveLimit, evidence }) {
  const text = String(draft ?? '').trim();
  const limit = Number(liveLimit);
  if (!text) throw new Error('outreach draft is empty');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('live UI character limit is required');
  if (Array.from(text).length > limit) throw new Error(`outreach draft exceeds live UI limit (${Array.from(text).length}/${limit})`);
  if (!evidence?.specific_reference) throw new Error('outreach draft lacks an exact post/team/role reference');
  if (!evidence?.cv_hook) throw new Error('outreach draft lacks a verified CV hook');
  if (!evidence?.soft_ask) throw new Error('outreach draft lacks a soft ask');
  return { text, character_count: Array.from(text).length, limit };
}

export function autoPreparePackage(db, candidate) {
  const row = outreachRow(db, candidate, true);
  return { outreach_id: row.outreach_id, opportunity_id: row.opportunity_id, member_id: row.member_id, profile_url: row.profile_url,
    name: row.name, company: row.company, contact_title: row.contact_title, relationship_status: row.relationship_status,
    opportunity: { employer: row.employer, title: row.opportunity_title, evidence: JSON.parse(row.opportunity_evidence) },
    source_post: { post_urn: row.source_post_urn, post_url: row.source_post_url },
    channel: row.channel, draft: row.draft, evidence: parse(row.evidence_json) };
}

export function recordPrepared(db, { outreachId, channel, visibleState, evidence }) {
  if (!['CONNECT_NOTE', 'DIRECT_MESSAGE'].includes(channel)) throw new Error(`unsupported prepared channel: ${channel}`);
  if (visibleState !== 'SEND_CONTROL_VISIBLE') throw new Error('preparation must be verified at the final Send control');
  const row = db.prepare("SELECT opportunity_id, status, evidence_json FROM outreach WHERE outreach_id=?").get(outreachId);
  if (!row) throw new Error(`outreach not found: ${outreachId}`);
  if (row.status !== 'AUTO_PREPARE_READY') throw new Error(`OUTREACH_TRANSITION_REVIEW: ${row.status} -> PREPARED`);
  const timestamp = now();
  const merged = { ...parse(row.evidence_json), ...(evidence ?? {}) };
  const updated = db.prepare("UPDATE outreach SET channel=?, status='PREPARED', prepared_at=?, last_checked_at=?, visible_result=?, evidence_json=? WHERE outreach_id=? AND status='AUTO_PREPARE_READY'")
    .run(channel, timestamp, timestamp, visibleState, JSON.stringify(merged), outreachId);
  if (Number(updated.changes) !== 1) throw new Error('OUTREACH_STATE_CHANGED');
  db.prepare("UPDATE opportunities SET status='PREPARED', reason_code=NULL, updated_at=? WHERE opportunity_id=?")
    .run(timestamp, row.opportunity_id);
}

export function recordOutreachObservation(db, { candidate, evidence }) {
  const row = outreachRow(db, candidate, false);
  const visibleState = String(evidence?.visible_state ?? '');
  const transitions = {
    INMAIL_ONLY: { from: ['AUTO_PREPARE_READY', 'PREPARED'], to: 'INMAIL_REVIEW' },
    NO_ADD_NOTE: { from: ['AUTO_PREPARE_READY', 'PREPARED'], to: 'NO_NOTE_AVAILABLE' },
    EXTERNAL_ACTION_ONLY: { from: ['AUTO_PREPARE_READY', 'PREPARED'], to: 'EXTERNAL_ACTION_REVIEW' },
    SEND_UNCERTAIN: { from: ['PREPARED'], to: 'SEND_UNCERTAIN' },
  };
  const transition = transitions[visibleState];
  if (!transition || !transition.from.includes(row.status)) {
    throw new Error(`OUTREACH_TRANSITION_REVIEW: ${row.status} + ${visibleState || 'UNKNOWN'}`);
  }
  const timestamp = now();
  const merged = { ...parse(row.evidence_json), ...(evidence ?? {}) };
  const next = transition.to;
  const reason = ['INMAIL_REVIEW', 'NO_NOTE_AVAILABLE', 'EXTERNAL_ACTION_REVIEW', 'SEND_UNCERTAIN'].includes(next) ? next : null;
  db.prepare('UPDATE outreach SET status=?, last_checked_at=?, visible_result=?, evidence_json=? WHERE outreach_id=?')
    .run(next, timestamp, visibleState, JSON.stringify(merged), row.outreach_id);
  db.prepare('UPDATE opportunities SET status=?, reason_code=?, updated_at=? WHERE opportunity_id=?')
    .run(next, reason, timestamp, row.opportunity_id);
  return { outreach_id: row.outreach_id, previous_status: row.status, status: next, visible_state: visibleState };
}
