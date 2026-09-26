#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, POST_SCAN_ROOT } from './config.mjs';
import { beginRun, DEFAULT_DB, finishRun, openDatabase, openDatabaseReadOnly, purgeExpiredTombstones,
  queryCoverageState, queryTimingSamples, recordQuery, statusSnapshot } from './db.mjs';
import { buildQueryPlan, calibrationQueries, summarizeCalibration } from './query-plan.mjs';
import { processCapturedPosts } from './process-posts.mjs';
import { renderDailyReport } from './report.mjs';
import { autoPreparePackage, recordOutreachObservation, recordPrepared, validateOutreachDraft } from './outreach.mjs';
import { finalizeHandoff, runHandoffPlanning } from './career-ops.mjs';

const arg = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : null; };
const command = process.argv[2] || 'status';
const pacificDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const readInput = file => JSON.parse(readFileSync(file === '-' ? 0 : path.resolve(file), 'utf8'));
const requireCaptureFilters = query => {
  if (query.filters?.posts !== true || query.filters?.past_week !== true) throw new Error('LINKEDIN_FILTER_UNVERIFIED');
};

async function main() {
  const config = loadConfig(arg('--config') || undefined);
  const dbFile = arg('--db') || DEFAULT_DB;
  if (command === 'status') {
    const db = openDatabaseReadOnly(dbFile);
    if (!db) return { status: 'NOT_INITIALIZED', database: path.resolve(dbFile), report: null };
    try {
      const report = path.join(POST_SCAN_ROOT, 'reports/daily', `${pacificDate()}.md`);
      return { ...statusSnapshot(db), report: existsSync(report) ? report : null };
    } finally { db.close(); }
  }
  const db = openDatabase(dbFile);
  try {
    purgeExpiredTombstones(db);
    if (command === 'query-plan') {
      const strategy = arg('--strategy') || config.search.default_strategy;
      const coverage = queryCoverageState(db);
      return { strategy, coverage, queries: buildQueryPlan(config, { strategy, lastSuccess: coverage.last_success }), calibration: calibrationQueries(config) };
    }
    if (command === 'calibrate') {
      const input = readInput(arg('--input'));
      for (const item of input.captures ?? []) requireCaptureFilters(item);
      const runId = arg('--run-id') || input.run_id || `postscan-calibrate-${Date.now()}`;
      beginRun(db, { runId, mode: 'calibrate' });
      try {
        for (const item of input.captures ?? []) recordQuery(db, runId, { ...item, query_key: item.query_key || `${item.sample_key}:${item.variant}` });
        const result = summarizeCalibration(config, input.captures ?? [], {
          timingSamples: queryTimingSamples(db).filter(item => item.run_id !== runId),
        });
        finishRun(db, runId, { receipt: result, coverage: result });
        renderDailyReport(db, pacificDate());
        return { run_id: runId, ...result };
      } catch (error) { finishRun(db, runId, { status: 'FAILED', stopCode: error.message, receipt: { error: error.message } }); throw error; }
    }
    if (command === 'scan') {
      const input = readInput(arg('--input'));
      const runId = arg('--run-id') || input.run_id || `postscan-${Date.now()}`;
      beginRun(db, { runId, mode: 'scan' });
      const totals = { observed: 0, unchanged: 0, tombstoned: 0, exact_jobs: 0, outreach_ready: 0, review: 0, excluded: 0,
        identity_review: [], errors: [] };
      let completedQueries = 0;
      let currentQuery = null;
      try {
        for (const query of input.queries ?? []) {
          currentQuery = query;
          try { requireCaptureFilters(query); }
          catch (error) { recordQuery(db, runId, { ...query, status: 'STOPPED' }); throw error; }
          recordQuery(db, runId, query);
          const counts = processCapturedPosts(db, { runId, queryKey: query.query_key, posts: query.posts, config });
          for (const key of ['observed', 'unchanged', 'tombstoned', 'exact_jobs', 'outreach_ready', 'review', 'excluded']) totals[key] += counts[key];
          totals.identity_review.push(...counts.identity_review);
          totals.errors.push(...counts.errors);
          completedQueries += 1;
        }
        const coverage = { planned_queries: Number(input.planned_queries ?? input.queries?.length ?? 0), completed_queries: input.queries?.length ?? 0,
          truncated_queries: (input.queries ?? []).filter(item => item.truncated).length, cursor: input.next_cursor ?? null };
        finishRun(db, runId, { status: totals.errors.length ? 'FAILED' : 'COMPLETE', stopCode: totals.errors.length ? 'POST_PROCESSING_ERRORS' : null,
          coverage, receipt: totals });
        const report = renderDailyReport(db, pacificDate());
        return { run_id: runId, totals, coverage, report: report.file };
      } catch (error) {
        const coverage = { planned_queries: Number(input.planned_queries ?? input.queries?.length ?? 0), completed_queries: completedQueries,
          truncated_queries: (input.queries ?? []).slice(0, completedQueries).filter(item => item.truncated).length,
          cursor: currentQuery?.query_key ?? input.next_cursor ?? null };
        finishRun(db, runId, { status: 'STOPPED', stopCode: error.message, coverage, receipt: { ...totals, error: error.message } });
        renderDailyReport(db, pacificDate());
        throw error;
      }
    }
    if (command === 'auto-prepare') {
      const candidate = arg('--candidate');
      if (process.argv.includes('--record-visible-state')) {
        const evidence = readInput(arg('--evidence'));
        const result = recordOutreachObservation(db, { candidate, evidence });
        const report = renderDailyReport(db, pacificDate());
        return { ...result, report: report.file };
      }
      const prepared = autoPreparePackage(db, candidate);
      if (!process.argv.includes('--record-prepared')) return prepared;
      const evidence = readInput(arg('--evidence'));
      const validated = validateOutreachDraft({ draft: prepared.draft, liveLimit: evidence.live_limit, evidence: prepared.evidence });
      recordPrepared(db, { outreachId: prepared.outreach_id, channel: evidence.channel, visibleState: evidence.visible_state, evidence: { ...prepared.evidence, ...evidence, validated } });
      renderDailyReport(db, pacificDate());
      return { outreach_id: prepared.outreach_id, status: 'PREPARED', validated };
    }
    if (command === 'handoff-plan') {
      const result = runHandoffPlanning(db, config, arg('--posting-key'));
      const report = renderDailyReport(db, pacificDate());
      return { ...result, report: report.file };
    }
    if (command === 'handoff-finalize') {
      const result = finalizeHandoff(db, config, arg('--posting-key'));
      const report = renderDailyReport(db, pacificDate());
      return { ...result, report: report.file };
    }
    throw new Error(`unknown command: ${command}`);
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
