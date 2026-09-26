import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { POST_SCAN_ROOT } from './config.mjs';
import { dailySnapshot } from './db.mjs';

const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').trim() || '—';
const link = (label, url) => {
  if (!url) return cell(label);
  const target = String(url).includes(' ') ? `<${url}>` : url;
  return `[${cell(label)}](${target})`;
};
const rows = (items, render, empty = '_None._') => items.length ? items.map(render).join('\n') : empty;
const opportunityLabel = item => cell([item.employer, item.title].filter(Boolean).join(' — '));
const sourceLink = item => item.source_identity_valid && item.source_post_url
  ? link('Source Post', item.source_post_url)
  : item.navigation_clue ? link('Navigation clue', item.navigation_clue) : 'POST_IDENTITY_UNRESOLVED';

function reviewReason(item) {
  if (!item.source_identity_valid) return 'POST_IDENTITY_UNRESOLVED';
  if (item.reason_code) return item.reason_code;
  if (item.status === 'HANDOFF_READY') return 'CAREER_OPS_HANDOFF_PENDING';
  return item.evidence?.missing_fact ?? item.status;
}

function reportState(item) {
  const identity = item.handoff?.report_identity;
  if (!identity) return cell(item.status);
  const label = identity.report_number ? `Report ${identity.report_number}` : 'Career-Ops report';
  return `${link(label, identity.report_path)} — ${cell(item.status)}`;
}

export function renderDailyReport(db, date, outputRoot = path.join(POST_SCAN_ROOT, 'reports/daily')) {
  const snapshot = dailySnapshot(db, date);
  const reviewStatuses = ['REVIEW', 'HANDOFF_READY', 'HANDOFF_FAILED', 'HANDOFF_RESULT_UNRESOLVED',
    'INMAIL_REVIEW', 'NO_NOTE_AVAILABLE', 'EXTERNAL_ACTION_REVIEW', 'SEND_UNCERTAIN'];
  const direct = snapshot.opportunities.filter(item => item.kind === 'EXACT_JOB' && item.status === 'HANDED_OFF'
    && item.source_identity_valid && item.handoff?.report_identity && item.handoff?.tracker_identity === item.posting_key);
  const ready = snapshot.outreach.filter(item => item.status === 'AUTO_PREPARE_READY' && item.source_identity_valid);
  const persistedReview = snapshot.opportunities.filter(item => !item.source_identity_valid
    || reviewStatuses.includes(item.status));
  const receiptReview = snapshot.runs.flatMap(run => (run.receipt?.identity_review ?? []).map(item => ({
    ...item, opportunity_id: `identity:${item.query_key}:${item.navigation_clue ?? item.employer ?? item.title ?? ''}`,
    status: 'REVIEW', reason_code: 'POST_IDENTITY_UNRESOLVED', post_signal: null, source_identity_valid: false,
  })));
  const seenReview = new Set();
  const review = [...persistedReview, ...receiptReview].filter(item => {
    const key = item.opportunity_id;
    if (seenReview.has(key)) return false;
    seenReview.add(key);
    return true;
  });
  const completed = snapshot.opportunities.filter(item => item.source_identity_valid
    && !['AUTO_PREPARE_READY', ...reviewStatuses].includes(item.status));
  const activeOutreach = snapshot.outreach.filter(item => item.status !== 'SUPERSEDED');
  const exclusions = Object.fromEntries(snapshot.excluded.map(item => [item.reason_code, Number(item.count)]));
  const latest = snapshot.runs[0] ?? null;
  const latestScan = snapshot.runs.find(item => item.mode === 'scan') ?? null;
  const calibration = snapshot.runs.find(item => item.mode === 'calibrate')?.coverage ?? null;
  const coverage = latestScan?.coverage ?? {};
  const receipt = latestScan?.receipt ?? {};
  const markdown = `# LinkedIn Post Scan — ${date}\n\n` +
    `## Summary\n\n` +
    `- Latest run: ${latest ? `\`${latest.run_id}\` — ${latest.status}${latest.stop_code ? ` (${latest.stop_code})` : ''}` : 'none'}\n` +
    `- Scan coverage${latestScan ? ` (\`${latestScan.run_id}\`)` : ''}: ${cell(coverage.completed_queries ?? 0)}/${cell(coverage.planned_queries ?? 0)} queries; truncated ${cell(coverage.truncated_queries ?? 0)}\n` +
    `${calibration ? `- Calibration: ${calibration.strategy}; effective query ${cell(calibration.effective_query_ms)} ms; queries/run ${cell(calibration.queries_per_run)}; P1 max gap ${cell(calibration.p1_max_gap_hours)} h; P2 max gap ${cell(calibration.p2_max_gap_hours)} h; final deep-check budget ${calibration.budget_complete ? 'complete' : 'pending'}\n` : ''}` +
    `- Latest changes: exact jobs ${cell(receipt.exact_jobs ?? 0)}; outreach ready ${cell(receipt.outreach_ready ?? 0)}; review ${cell(receipt.review ?? 0)}; identity unresolved ${cell(receipt.identity_review?.length ?? 0)}; excluded ${cell(receipt.excluded ?? 0)}; unchanged ${cell(receipt.unchanged ?? 0)}; tombstoned ${cell(receipt.tombstoned ?? 0)}\n` +
    `- Current state: Direct Apply ${direct.length}; Post Signal ready ${ready.length}; review ${review.length}\n` +
    `- Exclusions (count only): ${Object.keys(exclusions).length ? Object.entries(exclusions).map(([reason, count]) => `${reason}=${count}`).join(', ') : 'none'}\n\n` +
    `## Direct Apply\n\n| Company | Role | Location | Career-Ops report/state | Source Post |\n|---|---|---|---|---|\n${rows(direct, item => `| ${cell(item.employer)} | ${link(item.title, item.official_url)} | ${cell(item.location)} | ${reportState(item)} | ${sourceLink(item)} |`)}\n\n` +
    `## Worth Contacting\n\n| Candidate | Opportunity | Post Signal | State | Source Post |\n|---|---|---:|---|---|\n${rows(ready, item => `| ${link(item.name, item.profile_url)} | ${cell([item.employer, item.title].filter(Boolean).join(' — '))} | ${Number(item.post_signal).toFixed(2)} | ${cell(item.status)} | ${sourceLink(item)} |`)}\n\n` +
    `## Review\n\n| Opportunity | Post Signal | Missing fact/reason | Source Post / Navigation clue |\n|---|---:|---|---|\n${rows(review, item => `| ${opportunityLabel(item)} | ${item.post_signal == null ? '—' : Number(item.post_signal).toFixed(2)} | ${cell(reviewReason(item))} | ${sourceLink(item)} |`)}\n\n` +
    `## Completed\n\n| Opportunity | Result | Reason | Source Post |\n|---|---|---|---|\n${rows(completed, item => `| ${opportunityLabel(item)} | ${cell(item.status)} | ${cell(item.reason_code)} | ${sourceLink(item)} |`)}\n\n` +
    `## Connect/DM drafts\n\n${rows(activeOutreach, item => `### ${cell(item.name)} — ${cell(item.employer)}\n\n- Channel: ${cell(item.channel)}\n- State: ${cell(item.status)}\n- Source: ${sourceLink(item)}\n- Basis: ${cell(item.evidence?.basis)}\n\n> ${String(item.draft).replace(/\n/g, '\n> ')}${item.evidence?.follow_up_draft ? `\n\nFollow-up draft:\n\n> ${String(item.evidence.follow_up_draft).replace(/\n/g, '\n> ')}` : ''}`)}\n`;
  mkdirSync(outputRoot, { recursive: true });
  const file = path.join(outputRoot, `${date}.md`);
  const staged = `${file}.tmp-${process.pid}`;
  writeFileSync(staged, markdown);
  renameSync(staged, file);
  const latestFile = path.join(outputRoot, 'latest.md');
  const latestStaged = `${latestFile}.tmp-${process.pid}`;
  writeFileSync(latestStaged, `[Latest LinkedIn Post Scan report](./${date}.md)\n\nUpdated: ${new Date().toISOString()}\n`);
  renameSync(latestStaged, latestFile);
  return { file, latestFile, snapshot };
}
