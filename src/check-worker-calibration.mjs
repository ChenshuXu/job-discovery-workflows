#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDailyScanRuntime } from './daily-scan-runtime.mjs';
import { loadLocationPolicy } from './location-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILE = path.join(ROOT, 'test/fixtures/worker-calibration-cases.json');
const CANDIDATE_FILES = [
  path.resolve(ROOT, '../career-ops/cv.md'),
  path.resolve(ROOT, '../career-ops/config/profile.yml'),
  path.resolve(ROOT, '../career-ops/modes/_profile.md'),
];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function outputSchema(caseIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: caseIds.length,
        maxItems: caseIds.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'fit_score', 'level_signal', 'level_evidence', 'eligibility_status', 'eligibility_category', 'eligibility_evidence', 'legitimacy_tier', 'rationale'],
          properties: {
            id: { type: 'string', enum: caseIds },
            fit_score: { type: 'number', minimum: 1, maximum: 5, multipleOf: 0.1 },
            level_signal: { type: 'string', enum: ['target', 'staff_equivalent', 'unclear'] },
            level_evidence: { type: 'string', minLength: 1 },
            eligibility_status: { type: 'string', enum: ['eligible', 'ineligible', 'needs_verification'] },
            eligibility_category: { type: ['string', 'null'] },
            eligibility_evidence: { type: ['string', 'null'] },
            legitimacy_tier: { type: 'string', enum: ['High Confidence', 'Proceed with Caution', 'Suspicious'] },
            rationale: { type: 'string', minLength: 1, maxLength: 150 },
          },
        },
      },
    },
  };
}

export function buildCalibrationPrompt(fixture, runtime, candidateFiles = CANDIDATE_FILES) {
  const scoring = readFileSync(path.join(ROOT, 'config/worker-scoring.md'), 'utf8');
  const locationPolicy = loadLocationPolicy(candidateFiles[1]);
  const candidateSources = candidateFiles.map(file => `\n--- CANDIDATE SOURCE: ${path.basename(file)} ---\n${readFileSync(file, 'utf8')}`).join('\n');
  const cases = fixture.cases.map(item => {
    const jd = readFileSync(path.join(ROOT, 'test/fixtures', item.jd_path), 'utf8');
    return `\n--- CASE ${item.id} | ${item.company} | ${item.role} ---\n${jd}`;
  }).join('\n');
  return `You are running an isolated scoring diagnostic, not a Daily Scan or launch gate. Do not use tools, browse, or write files. The supplied candidate sources are locked for this diagnostic. Runtime: ${JSON.stringify(runtime)}. Location policy: ${JSON.stringify(locationPolicy)}.\n\nApply the v4 scoring judgment below to each supplied case in order. Return only the diagnostic output schema: one result per case with a concise rationale and exact JD evidence. Do not return reports, work_authorization or derived legacy fields.\n\n--- SCORING JUDGMENT ---\n${scoring}\n${candidateSources}\n${cases}`;
}

function validate(fixture, payload) {
  const byId = new Map(payload.results.map(item => [item.id, item]));
  if (byId.size !== fixture.cases.length) throw new Error('calibration output has duplicate or missing case ids');
  return fixture.cases.map(item => {
    const actual = byId.get(item.id);
    const expected = item.expected;
    if (!actual) return { id: item.id, expected, actual: null, pass: false, details: 'missing result' };
    const failures = [];
    if (actual.fit_score < expected.score_min || actual.fit_score > expected.score_max) failures.push(`fit_score ${actual.fit_score} outside ${expected.score_min}-${expected.score_max}`);
    const hardExclusion = actual.eligibility_status === 'ineligible';
    if (hardExclusion !== expected.hard_exclusion) failures.push(`ineligible=${hardExclusion}, expected ${expected.hard_exclusion}`);
    if (Array.from(actual.rationale.trim()).length > 150 || /\r|\n/.test(actual.rationale)) failures.push('rationale is not a single line of at most 150 characters');
    if (expected.rationale_contains_any && !expected.rationale_contains_any.some(token => actual.rationale.toLowerCase().includes(token.toLowerCase()))) failures.push(`rationale lacks one of: ${expected.rationale_contains_any.join(', ')}`);
    if (hardExclusion) {
      const quote = String(actual.eligibility_evidence ?? '').match(/^JD:\s*["“]([\s\S]+)["”]\.?$/)?.[1];
      const jd = readFileSync(path.join(ROOT, 'test/fixtures', item.jd_path), 'utf8');
      if (!quote || !jd.includes(quote)) failures.push('hard-exclusion evidence is not an exact JD substring');
    } else if (actual.eligibility_status === 'eligible' && actual.eligibility_evidence != null) {
      failures.push('eligible result must use null evidence');
    }
    return { id: item.id, expected, actual, pass: failures.length === 0, details: failures.join('; ') || 'within expected range' };
  });
}

function printTable(rows) {
  const values = rows.map(row => ({
    case: row.id,
    expected_score: row.expected ? `${row.expected.score_min}-${row.expected.score_max}` : '-',
    actual_score: row.actual?.fit_score ?? '-',
    expected_hard: row.expected?.hard_exclusion ?? '-',
    actual_hard: row.actual ? row.actual.eligibility_status === 'ineligible' : '-',
    status: row.pass ? 'PASS' : 'FAIL',
    rationale: row.actual?.rationale ?? row.details,
  }));
  console.table(values);
}

export function runCalibration() {
  const fixture = readJson(FIXTURE_FILE);
  const runtime = loadDailyScanRuntime();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'job-discovery-calibration-'));
  const schemaFile = path.join(tempDir, 'schema.json');
  const outputFile = path.join(tempDir, 'result.json');
  writeFileSync(schemaFile, `${JSON.stringify(outputSchema(fixture.cases.map(item => item.id)), null, 2)}\n`);
  try {
    const child = spawnSync('codex', [
      'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--model', runtime.worker.model,
      '-c', `model_reasoning_effort="${runtime.worker.reasoning_effort}"`,
      '--output-schema', schemaFile, '--output-last-message', outputFile, '-'
    ], {
      cwd: tempDir,
      input: buildCalibrationPrompt(fixture, runtime),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(`codex calibration evaluator failed (${child.status}): ${(child.stderr || child.stdout).trim()}`);
    const rows = validate(fixture, readJson(outputFile));
    printTable(rows);
    const failed = rows.filter(row => !row.pass);
    console.log(`Calibration: ${rows.length - failed.length}/${rows.length} cases passed using ${runtime.worker.model} (${runtime.worker.reasoning_effort}).`);
    if (failed.length) process.exitCode = 1;
    return rows;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCalibration(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
