#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalizePostingUrl, postingFingerprint, postingKey } from '../../../../src/posting-identity.mjs';
import { validateActiveInterviews } from '../../gmail-job-reply-review/scripts/active-interviews.mjs';

const DISCOVERY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_FLAGS = new Set(['--career-ops', '--active-interviews', '--run', '--dates', '--status', '--limit', '--exclude']);
const BOOLEAN_FLAGS = new Set(['--latest-complete', '--json']);
const SELECTABLE_STATUS = 'Evaluated';
const LOCAL_TIME_ZONE = 'America/Los_Angeles';
const PRIORITY = new Map([
  ['greenhouse', 1], ['ashby', 2], ['microsoft', 3], ['oracle', 4],
  ['workday', 5], ['rippling', 6], ['google', 7], ['lever', 8],
  ['linkedin', 9], ['generic', 10],
]);

function usage() {
  return [
    'Usage:',
    '  node application-batch.mjs --career-ops <path> --active-interviews <path> (--run <run-id> | --latest-complete) [--dates YYYY-MM-DD[,YYYY-MM-DD]] [--status Evaluated] [--limit 1..10] [--exclude report-id,...] [--json]',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = { json: false, latestComplete: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new Error(`Unknown argument: ${flag}\n${usage()}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}\n${usage()}`);
    seen.add(flag);
    if (flag === '--json') {
      args.json = true;
      continue;
    }
    if (flag === '--latest-complete') {
      args.latestComplete = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}\n${usage()}`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

function required(value, name) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`Missing --${name}\n${usage()}`);
  return result;
}

function isCalendarDate(value) {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseDates(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  const dates = [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))];
  if (!dates.length || dates.some(date => !isCalendarDate(date))) {
    throw new Error('--dates must be a comma-separated list of valid YYYY-MM-DD values');
  }
  return dates.sort();
}

export function parseLimit(value) {
  const raw = String(value ?? '5').trim();
  if (!/^\d+$/.test(raw)) throw new Error('--limit must be an integer from 1 to 10');
  const limit = Number(raw);
  if (limit < 1 || limit > 10) throw new Error('--limit must be an integer from 1 to 10');
  return limit;
}

function parseExcluded(value) {
  if (!String(value ?? '').trim()) return new Set();
  const ids = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error('--exclude must contain comma-separated report IDs');
  return new Set(ids.map(id => String(Number(id))));
}

export function companyKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function buildActiveInterviewCompanyIndex(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const companyColumn = Object.keys(row || {}).find(key => key.trim().toLowerCase() === 'company');
    const company = String(companyColumn ? row[companyColumn] : '').trim();
    const key = companyKey(company);
    if (key && !index.has(key)) index.set(key, company);
  }
  return index;
}

function readReceipt(receiptPath) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid receipt ${receiptPath}: ${error.message}`);
  }
  if (!receipt || typeof receipt !== 'object') throw new Error(`Invalid receipt object: ${receiptPath}`);
  return receipt;
}

function validateReceipt(receipt, runId, receiptPath) {
  if (receipt.status !== 'COMPLETE') throw new Error(`Run ${runId} is not COMPLETE`);
  if (receipt.run_id !== runId) throw new Error(`Receipt run_id mismatch in ${receiptPath}`);
  if (!Array.isArray(receipt.reports) || !receipt.reports.length) {
    throw new Error(`COMPLETE receipt ${receiptPath} has no reports`);
  }
}

export function selectReceipt(runsRoot, { run, latestComplete = false }) {
  if (Boolean(run) === Boolean(latestComplete)) {
    throw new Error('Choose exactly one of --run or --latest-complete');
  }
  const root = resolve(runsRoot);
  if (!existsSync(root)) throw new Error(`Runs root not found: ${root}`);

  if (run) {
    const runId = required(run, 'run');
    if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
    const receiptPath = resolve(root, runId, 'receipt.json');
    const rel = relative(root, receiptPath);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(receiptPath)) {
      throw new Error(`Receipt not found for run ${runId}`);
    }
    const receipt = readReceipt(receiptPath);
    validateReceipt(receipt, runId, receiptPath);
    return { runId, receiptPath, receipt };
  }

  const runIds = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && RUN_ID_RE.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const runId of runIds) {
    const receiptPath = resolve(root, runId, 'receipt.json');
    if (!existsSync(receiptPath)) continue;
    const receipt = readReceipt(receiptPath);
    if (receipt.status !== 'COMPLETE') continue;
    validateReceipt(receipt, runId, receiptPath);
    return { runId, receiptPath, receipt };
  }
  throw new Error(`No COMPLETE receipt found under ${root}`);
}

function safeReportPath(careerOpsRoot, reportPath) {
  if (!reportPath) return null;
  const file = resolve(careerOpsRoot, reportPath);
  const rel = relative(careerOpsRoot, file);
  return rel.startsWith('..') || isAbsolute(rel) ? null : file;
}

function canonicalReportPath(value) {
  const path = String(value ?? '');
  if (!path || path !== path.trim() || isAbsolute(path) || path.includes('\\')) return null;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts[0] === 'reports' ? path : null;
}

function extractReportUrl(text) {
  const match = String(text ?? '').match(/^\*\*URL:\*\*\s*(\S+)\s*$/m);
  if (!match) return null;
  return match[1].replace(/^<|>$/g, '').trim();
}

function extractReportRunId(text) {
  return String(text ?? '').match(/^\s*run_id:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] ?? null;
}

function classifyPosting(value) {
  const url = canonicalizePostingUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const fingerprint = postingFingerprint(url);

  let ats = fingerprint?.ats ?? 'generic';
  if (host === 'apply.careers.microsoft.com' || host.endsWith('.careers.microsoft.com')) ats = 'microsoft';
  else if (host === 'ats.rippling.com' || host.endsWith('.rippling.com')) ats = 'rippling';
  else if (host === 'careers.google.com' || host.endsWith('.careers.google.com')) ats = 'google';
  else if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) ats = 'linkedin';
  else if (host.endsWith('.oraclecloud.com')) ats = 'oracle';

  const tenant = fingerprint?.tenant || host;
  const recipe = ['greenhouse', 'ashby', 'microsoft', 'oracle', 'workday', 'google', 'linkedin'].includes(ats) ? ats : 'generic';
  return {
    ats,
    recipe,
    tenant,
    batchKey: `${ats}:${tenant}`,
    requisition: fingerprint?.requisitionId ?? null,
    postingKey: postingKey(fingerprint),
    url,
  };
}

function unresolved(row, reportId, reason) {
  return {
    trackerId: row?.trackerNum ?? null,
    reportId,
    company: row?.company ?? null,
    role: row?.role ?? null,
    reason,
  };
}

function skip(row, reportId, reason) {
  return {
    trackerId: row.trackerNum,
    reportId,
    company: row.company,
    role: row.role,
    reason,
  };
}

function groupPriority(group) {
  return PRIORITY.get(group.items[0]?.ats) ?? 100;
}

function retryHold(notes, today) {
  const state = { noRetry: false, identityReview: false, retryOn: null };
  const marker = /\b(no_retry|identity_review\s*\/\s*no_submit|retry_on)\b(?:\s*(?:[:=]\s*|\s+)((?:clear|\d{4}-\d{2}-\d{2})(?![A-Za-z0-9_-])))?/gi;
  for (const match of String(notes ?? '').matchAll(marker)) {
    const name = match[1].toLowerCase().replace(/\s+/g, '');
    const value = match[2]?.toLowerCase() ?? null;
    if (name === 'no_retry') state.noRetry = value !== 'clear';
    else if (name === 'identity_review/no_submit') state.identityReview = value !== 'clear';
    else state.retryOn = value === 'clear' ? null : value || 'invalid';
  }
  if (state.noRetry) return 'no_retry';
  if (state.identityReview) return 'identity_review/no_submit';
  if (!state.retryOn) return null;
  const retryDate = state.retryOn;
  if (!isCalendarDate(retryDate) || retryDate > today) return retryDate === 'invalid' ? 'retry_on' : `retry_on ${retryDate}`;
  return null;
}

export function localDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function frozenReceiptReports(receipt) {
  const seen = new Set();
  return receipt.reports.map((report, index) => {
    const reportId = Number(report?.report_number);
    const reportPath = canonicalReportPath(report?.report_path);
    const frozenPostingKey = String(report?.posting_key ?? '').trim();
    if (!Number.isInteger(reportId) || reportId < 1) throw new Error(`receipt.reports[${index}] has an invalid report number`);
    if (!reportPath) throw new Error(`receipt.reports[${index}] has a non-canonical report path`);
    if (!frozenPostingKey) throw new Error(`receipt.reports[${index}] has no posting_key`);
    if (seen.has(reportId)) throw new Error(`receipt contains duplicate report ID ${reportId}`);
    seen.add(reportId);
    return { reportId, reportPath, postingKey: frozenPostingKey };
  }).sort((left, right) => left.reportId - right.reportId);
}

export function planBatch(rows, {
  careerOpsRoot,
  receipt,
  runId,
  receiptPath = null,
  dates = [],
  status = SELECTABLE_STATUS,
  limit = 5,
  excluded = new Set(),
  activeInterviewCompanies = new Map(),
  today = localDate(),
}) {
  if (status !== SELECTABLE_STATUS) throw new Error(`--status must be ${SELECTABLE_STATUS}`);
  if (receipt.status !== 'COMPLETE' || receipt.run_id !== runId) {
    throw new Error(`Run ${runId} does not have a matching COMPLETE receipt`);
  }
  const frozen = frozenReceiptReports(receipt);
  const dateSet = new Set(dates);
  const skipped = [];
  const unresolvedItems = [];
  const selectable = [];

  for (const frozenReport of frozen) {
    const reportId = frozenReport.reportId;
    const matchingRows = rows.filter(row => String(Number(row.reportNum)) === String(reportId));
    if (matchingRows.length !== 1) {
      unresolvedItems.push(unresolved(null, reportId, matchingRows.length ? 'report ID maps to multiple tracker rows' : 'receipt report ID is missing from tracker'));
      continue;
    }
    const row = matchingRows[0];
    if (canonicalReportPath(row.reportPath) !== frozenReport.reportPath) {
      unresolvedItems.push(unresolved(row, reportId, 'tracker report path does not match receipt'));
      continue;
    }
    if (dateSet.size && !dateSet.has(row.date)) {
      unresolvedItems.push(unresolved(row, reportId, 'tracker date is outside the requested date check'));
      continue;
    }
    const reportFile = safeReportPath(careerOpsRoot, frozenReport.reportPath);
    if (!reportFile || !existsSync(reportFile)) {
      unresolvedItems.push(unresolved(row, reportId, 'receipt report file is missing or outside Career-Ops'));
      continue;
    }
    const reportText = readFileSync(reportFile, 'utf8');
    if (extractReportRunId(reportText) !== runId) {
      unresolvedItems.push(unresolved(row, reportId, 'report run_id does not match receipt'));
      continue;
    }
    if (excluded.has(String(reportId))) {
      skipped.push(skip(row, reportId, 'current-task exclusion'));
      continue;
    }
    if (row.status !== status) {
      skipped.push(skip(row, reportId, `status ${row.status || '<blank>'}`));
      continue;
    }
    const activeInterviewCompany = activeInterviewCompanies.get(companyKey(row.company));
    if (activeInterviewCompany) {
      skipped.push(skip(row, reportId, `active interview company: ${activeInterviewCompany}`));
      continue;
    }
    const held = retryHold(row.notes, today);
    if (held) {
      skipped.push(skip(row, reportId, held));
      continue;
    }
    const rawUrl = extractReportUrl(reportText);
    if (!rawUrl) {
      unresolvedItems.push(unresolved(row, reportId, 'report has no valid **URL:** field'));
      continue;
    }
    const posting = classifyPosting(rawUrl);
    if (!posting?.requisition) {
      unresolvedItems.push(unresolved(row, reportId, 'URL does not contain a confirmable posting identity'));
      continue;
    }
    if (posting.postingKey !== frozenReport.postingKey) {
      unresolvedItems.push(unresolved(row, reportId, 'report URL posting key does not match receipt'));
      continue;
    }
    selectable.push({
      trackerId: row.trackerNum,
      reportId,
      date: row.date,
      company: row.company,
      role: row.role,
      reportPath: frozenReport.reportPath,
      ...posting,
    });
  }

  const laneCounts = {};
  for (const item of selectable) laneCounts[item.batchKey] = (laneCounts[item.batchKey] || 0) + 1;

  const grouped = new Map();
  for (const item of selectable) {
    if (!grouped.has(item.batchKey)) grouped.set(item.batchKey, []);
    grouped.get(item.batchKey).push(item);
  }
  const groups = [...grouped.entries()].map(([key, items]) => ({
    key,
    items: items.sort((left, right) => left.reportId - right.reportId),
  })).sort((left, right) => groupPriority(left) - groupPriority(right) || left.key.localeCompare(right.key));
  const waves = groups.flatMap(group => {
    const result = [];
    for (let index = 0; index < group.items.length; index += limit) {
      const items = group.items.slice(index, index + limit);
      result.push({
        key: group.key,
        ats: items[0].ats,
        recipe: items[0].recipe,
        tenant: items[0].tenant,
        size: items.length,
        reportIds: items.map(item => item.reportId),
        items,
      });
    }
    return result;
  });

  return {
    schemaVersion: 1,
    scope: {
      mode: 'receipt',
      runId,
      receiptPath,
      frozenReportIds: frozen.map(item => item.reportId),
      dates,
      status,
      waveLimit: limit,
      excludedReportIds: [...excluded].map(Number).sort((left, right) => left - right),
    },
    summary: {
      frozenReports: frozen.length,
      selectableRows: selectable.length,
      skippedRows: skipped.length,
      unresolvedRows: unresolvedItems.length,
      waveCount: waves.length,
      laneCounts,
    },
    waves,
    batch: waves[0] ?? null,
    skipped: skipped.sort((left, right) => left.reportId - right.reportId),
    unresolved: unresolvedItems.sort((left, right) => left.reportId - right.reportId),
  };
}

function printHuman(result) {
  console.log(`Run: ${result.scope.runId}; frozen report IDs: ${result.scope.frozenReportIds.join(', ')}`);
  console.log(`Selectable: ${result.summary.selectableRows}; unresolved: ${result.summary.unresolvedRows}; skipped: ${result.summary.skippedRows}; waves: ${result.summary.waveCount}`);
  if (!result.waves.length) {
    console.log('No selectable waves.');
    return;
  }
  result.waves.forEach((wave, index) => {
    console.log(`Wave ${index + 1}: ${wave.key} (${wave.size}) — ${wave.reportIds.map(id => `#${id}`).join(', ')}`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const careerOpsRoot = resolve(required(args['career-ops'], 'career-ops'));
  const trackerPath = resolve(careerOpsRoot, 'data/applications.md');
  const activeInterviewsPath = resolve(required(args['active-interviews'], 'active-interviews'));
  const findModule = resolve(careerOpsRoot, 'find.mjs');
  const trackerParseModule = resolve(careerOpsRoot, 'tracker-parse.mjs');
  const processQualityModule = resolve(careerOpsRoot, 'process-quality.mjs');
  if (![trackerPath, activeInterviewsPath, findModule, trackerParseModule].every(existsSync)) {
    throw new Error(`Invalid Career-Ops root or missing active-interview gate: ${careerOpsRoot}`);
  }

  const selection = selectReceipt(resolve(DISCOVERY_ROOT, 'runs'), {
    run: args.run,
    latestComplete: args.latestComplete,
  });
  const trackerText = readFileSync(trackerPath, 'utf8');
  const activeInterviewsText = readFileSync(activeInterviewsPath, 'utf8');
  const { parseTrackerRows } = await import(pathToFileURL(findModule).href);
  const { parseTrackerRow, resolveColumns } = await import(pathToFileURL(trackerParseModule).href);
  const columns = resolveColumns(trackerText.split('\n'));
  const notesByTrackerId = new Map(trackerText.split('\n').map(line => parseTrackerRow(line, columns)).filter(Boolean).map(row => [row.num, row.notes]));
  const rows = parseTrackerRows(trackerText).map(row => ({ ...row, notes: notesByTrackerId.get(row.trackerNum) || '' }));
  const processSchema = /^\s*##\s+(?:Active Processes|Current TODO|Archived Processes)\s*$/im.test(activeInterviewsText);
  let activeRows;
  if (processSchema) {
    activeRows = validateActiveInterviews(activeInterviewsText).active;
  } else {
    if (!existsSync(processQualityModule)) throw new Error(`Missing active-interview parser: ${processQualityModule}`);
    const { parseActiveInterviews } = await import(pathToFileURL(processQualityModule).href);
    activeRows = parseActiveInterviews(activeInterviewsText);
  }
  const activeInterviewCompanies = buildActiveInterviewCompanyIndex(activeRows);
  const result = planBatch(rows, {
    careerOpsRoot,
    ...selection,
    dates: parseDates(args.dates),
    status: String(args.status ?? 'Evaluated').trim(),
    limit: parseLimit(args.limit),
    excluded: parseExcluded(args.exclude),
    activeInterviewCompanies,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
