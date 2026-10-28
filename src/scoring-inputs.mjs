import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveCareerPaths, DEFAULT_CAREER_OPS_CODE_ROOT } from './career-ops-paths.mjs';
import { careerBlacklistSnapshot, assertCareerBlacklistUnchanged } from './career-ops-blacklist.mjs';
import { assertPermEmployersUnchanged } from './perm-employers.mjs';

const discoveryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSnapshot = file => existsSync(file) ? readFileSync(file, 'utf8') : null;
const pathSnapshot = paths => ({ data_root: paths.dataRoot, tracker_file: paths.trackerFile, scan_history_file: paths.scanHistoryFile });

function sourcePaths(careerRoot, { vocabulary = true } = {}) {
  const paths = resolveCareerPaths(careerRoot);
  return {
    paths,
    candidates: [['cv.md', paths.cvFile], ['config/profile.yml', paths.profileFile], ['modes/_profile.md', paths.profileSummaryFile]],
    rules: [['modes/_shared.md', paths.sharedRulesFile], ['modes/_custom.md', paths.customRulesFile],
      ...(vocabulary ? [['templates/discard-reasons.yml', path.join(paths.codeRoot, 'templates/discard-reasons.yml')]] : []),
      ...['worker-prompt.md', 'worker-scoring.md', 'report-contract.md'].map(name => [`job-discovery/config/${name}`, path.join(discoveryRoot, 'config', name)])],
  };
}

export function loadDiscardReasonVocabulary(careerRoot) {
  const paths = resolveCareerPaths(careerRoot);
  const file = path.join(paths.codeRoot, 'templates/discard-reasons.yml');
  if (!existsSync(file)) throw new Error(`discard reason vocabulary missing: ${file}`);
  let reasons;
  try {
    const content = readFileSync(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(content); }
    catch {
      const require = createRequire(import.meta.url);
      const { load } = require(require.resolve('js-yaml', { paths: [paths.codeRoot, DEFAULT_CAREER_OPS_CODE_ROOT] }));
      parsed = load(content);
    }
    reasons = parsed?.reasons;
  } catch (error) { throw new Error(`discard reason vocabulary malformed: ${error.message}`); }
  if (!Array.isArray(reasons) || !reasons.length) throw new Error('discard reason vocabulary must contain definitions');
  const ids = new Set();
  for (const reason of reasons) {
    if (!reason || typeof reason.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(reason.id)
        || ids.has(reason.id) || typeof reason.when !== 'string' || !reason.when.trim()
        || /[\u0000-\u001f\u007f]/.test(reason.when)) throw new Error('discard reason vocabulary has invalid, duplicate or undefined id');
    ids.add(reason.id);
  }
  return reasons;
}

export function snapshotScoringInputs(careerRoot) {
  const { paths, candidates, rules } = sourcePaths(careerRoot);
  const snapshot = (entries, kind) => entries.map(([label, file]) => {
    const content = readSnapshot(file);
    if (content === null && label !== 'modes/_custom.md') throw new Error(`approved ${kind} source missing: ${file}`);
    return { label, path: file, content };
  });
  const candidate_sources = snapshot(candidates, 'candidate'), rule_sources = snapshot(rules, 'rule');
  loadDiscardReasonVocabulary(careerRoot);
  return { career_ops_data_root: paths.dataRoot, candidate_sources, rule_sources,
    career_ops_paths: pathSnapshot(paths), blacklist_snapshot: careerBlacklistSnapshot(careerRoot) };
}

// Rules are executable evaluation guidance, never candidate factual evidence.
// Snapshotting an absent optional custom file also detects it appearing during a run.
export function validateScoringInputs(plan, { allowLegacy = false, checkPermLive = true } = {}) {
  if (plan.perm_employers) assertPermEmployersUnchanged(plan.perm_employers, { checkLive: checkPermLive && !allowLegacy });
  if (!path.isAbsolute(plan.career_ops_root ?? '')) throw new Error('assignments career_ops_root must be absolute');
  const historical = allowLegacy && [4, 5, 6, 7, 8].includes(plan.result_schema_version);
  const { paths, candidates, rules } = sourcePaths(plan.career_ops_root, { vocabulary: plan.result_schema_version >= 6 });
  const legacy = allowLegacy && plan.result_schema_version === 4;
  if (!legacy && plan.career_ops_data_root !== paths.dataRoot) throw new Error('assignments Career-Ops data root changed');
  if (!legacy && JSON.stringify(plan.career_ops_paths) !== JSON.stringify(pathSnapshot(paths))) throw new Error('assignments Career-Ops tracker/history paths changed');
  function validate(sources, expected, kind) {
    if (!Array.isArray(sources) || JSON.stringify(sources.map(item => item.label)) !== JSON.stringify(expected.map(([label]) => label))) {
      throw new Error(`assignments ${kind}_sources must contain the approved sources in order`);
    }
    return sources.map((source, index) => {
      const file = legacy && kind === 'candidate' ? path.join(plan.career_ops_root, source.label) : expected[index][1];
      if (source.path !== file) throw new Error(`approved ${kind} source outside configured Career-Ops/source root: ${source.path}`);
      const actual = readSnapshot(file);
      if (actual === null && (kind !== 'rule' || source.label !== 'modes/_custom.md')) throw new Error(`approved ${kind} source missing: ${source.path}`);
      if (typeof source.content !== 'string' && !(source.label === 'modes/_custom.md' && source.content === null)) throw new Error(`invalid approved ${kind} source content: ${source.label}`);
      // Old procedural guidance is provenance, not today's evaluation policy.
      // Candidate facts remain content-bound; historical reads never authorize writes.
      if (actual !== source.content && !(historical && kind === 'rule')) throw new Error(`approved ${kind} source content changed: ${source.label}`);
      return actual === null ? '' : `\n--- ${source.label} ---\n${readFileSync(file, 'utf8')}`;
    }).join('');
  }
  const candidateText = validate(plan.candidate_sources, candidates, 'candidate');
  if (!legacy) {
    validate(plan.rule_sources, rules, 'rule');
    assertCareerBlacklistUnchanged(plan.career_ops_root, plan.blacklist_snapshot);
  }
  if (!historical) loadDiscardReasonVocabulary(plan.career_ops_root);
  return candidateText;
}
