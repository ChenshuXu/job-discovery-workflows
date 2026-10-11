import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const DEFAULT_CAREER_OPS_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../career-ops');

// --career-ops selects executable code. CAREER_OPS_ROOT is reserved for the
// upstream data-root override, including when code and private data are separate.
export function careerOpsCodeRoot(requested) {
  return path.resolve(requested || process.env.CAREER_OPS_CODE_ROOT || DEFAULT_CAREER_OPS_CODE_ROOT);
}

function canonical(file) {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

export function resolveCareerPaths(requested) {
  const codeRoot = careerOpsCodeRoot(requested);
  const resolverFile = path.join(codeRoot, 'path-resolver.mjs');
  let dataRoot, trackerFile, trackerWriteFile;
  if (existsSync(resolverFile)) {
    const resolver = require(resolverFile);
    const previous = process.cwd();
    process.chdir(codeRoot);
    try {
      dataRoot = resolver.getCareerOpsRoot();
      trackerFile = resolver.resolveTrackerPath(dataRoot);
      trackerWriteFile = resolver.resolveTrackerPathForWrite?.(dataRoot) ?? trackerFile;
    } finally { process.chdir(previous); }
  } else {
    // Setup diagnostics and small offline fixtures may precede installation.
    // Production operations separately require the upstream writer interfaces.
    const marker = path.join(codeRoot, '.career-ops-data');
    const selected = process.env.CAREER_OPS_ROOT?.trim() || process.env.CAREER_OPS_DATA_DIR?.trim()
      || (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '') || '.';
    dataRoot = path.resolve(codeRoot, selected);
    const override = process.env.CAREER_OPS_TRACKER?.trim();
    trackerFile = canonical(override ? path.resolve(codeRoot, override)
      : existsSync(path.join(dataRoot, 'data/applications.md')) ? path.join(dataRoot, 'data/applications.md') : path.join(dataRoot, 'applications.md'));
    trackerWriteFile = override ? trackerFile : path.join(dataRoot, 'data/applications.md');
  }
  const configured = (key, fallback) => process.env[key]?.trim()
    ? path.resolve(codeRoot, process.env[key].trim()) : path.join(dataRoot, fallback);
  return {
    codeRoot, dataRoot, trackerFile, trackerWriteFile,
    reportsRoot: path.join(dataRoot, 'reports'),
    healthReportsRoot: path.resolve(dataRoot, process.env.CAREER_OPS_REPORTS || 'reports'),
    portalsFile: configured('CAREER_OPS_PORTALS', 'portals.yml'), jdsRoot: path.join(dataRoot, 'jds'), outputRoot: path.join(dataRoot, 'output'),
    cvFile: path.join(dataRoot, 'cv.md'), profileFile: path.join(dataRoot, 'config/profile.yml'),
    profileSummaryFile: path.join(dataRoot, 'modes/_profile.md'), customRulesFile: path.join(dataRoot, 'modes/_custom.md'),
    sharedRulesFile: path.join(codeRoot, 'modes/_shared.md'), ofertaRulesFile: path.join(codeRoot, 'modes/oferta.md'),
    blacklistFile: path.join(dataRoot, 'data/blacklist.md'),
    scanHistoryFile: configured('CAREER_OPS_SCAN_HISTORY', 'data/scan-history.tsv'),
    pipelineFile: configured('CAREER_OPS_PIPELINE', 'data/pipeline.md'),
    followupsFile: configured('CAREER_OPS_FOLLOWUPS', 'data/follow-ups.md'),
    statusLogFile: path.join(path.dirname(trackerFile), 'status-log.tsv'),
    scanRunsFile: path.join(dataRoot, 'data/scan-runs.tsv'),
    additionsRoot: configured('CAREER_OPS_ADDITIONS', 'batch/tracker-additions'),
    commitLockFile: path.join(dataRoot, '.daily-scan-commit'),
  };
}

export function careerOpsEnv(pathsOrRoot, overrides = {}) {
  const paths = typeof pathsOrRoot === 'object' ? pathsOrRoot : resolveCareerPaths(pathsOrRoot);
  return { ...process.env, CAREER_OPS_CODE_ROOT: paths.codeRoot,
    CAREER_OPS_ROOT: paths.dataRoot, CAREER_OPS_DATA_DIR: paths.dataRoot,
    CAREER_OPS_TRACKER: paths.trackerFile,
    CAREER_OPS_SCAN_HISTORY: paths.scanHistoryFile, CAREER_OPS_PIPELINE: paths.pipelineFile,
    CAREER_OPS_FOLLOWUPS: paths.followupsFile, ...overrides };
}

// find.mjs strips ../ from Report links. For a tracker outside data/, resolve
// the original tracker cell first so that path normalization cannot change its
// target. The returned relative path remains the report identity used in scans.
export function resolveCareerReportLink(pathsOrRoot, reportField, reportNumber = null) {
  const paths = typeof pathsOrRoot === 'object' ? pathsOrRoot : resolveCareerPaths(pathsOrRoot);
  const links = [...String(reportField).matchAll(/\[(\d+)\]\(([^)]+)\)/g)]
    .filter(match => reportNumber == null || Number(match[1]) === Number(reportNumber));
  if (links.length !== 1) throw new Error('Career-Ops report link must identify one exact report');
  const target = links[0][2];
  const trackerRelative = path.resolve(path.dirname(paths.trackerFile), target);
  const rootRelative = path.resolve(paths.dataRoot, target);
  // Upstream verify-pipeline accepts old root-relative links after trying the
  // actual Markdown location. Preserve that documented compatibility.
  const file = existsSync(trackerRelative) ? trackerRelative : existsSync(rootRelative) ? rootRelative : trackerRelative;
  const reportRelative = path.relative(canonical(paths.reportsRoot), canonical(file));
  if (!reportRelative || reportRelative.startsWith('..') || path.isAbsolute(reportRelative)) {
    throw new Error(`Career-Ops report link is outside the configured reports directory: ${target}`);
  }
  return { file, relative: `reports/${reportRelative.split(path.sep).join('/')}` };
}
