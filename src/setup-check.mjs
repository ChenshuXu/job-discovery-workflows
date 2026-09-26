#!/usr/bin/env node
// Read-only setup inventory. Never installs tools, writes profiles or starts workflows.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCvSource } from './resume/cv-source.mjs';
import { loadLocationPolicy } from './location-scope.mjs';
import { loadDailyScanRuntime } from './daily-scan-runtime.mjs';
import { loadGoogleAtsConfig } from '../adapters/google_ats_direct_scan.mjs';
import { buildTemplateBaseline } from './resume/template-baseline.mjs';
import { validateActiveInterviews } from '../.agents/skills/gmail-job-reply-review/scripts/active-interviews.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['career-ops-daily-linkedin-scan', 'career-ops-expand-report', 'career-ops-tailored-resume', 'career-ops-ego-apply', 'gmail-job-reply-review', 'linkedin-post-scan', 'technical-interview-prepare', 'process-infographic'];
const nonempty = file => { if (!statSync(file).isFile() || !readFileSync(file, 'utf8').trim()) throw new Error('missing'); };
const executable = file => accessSync(file, constants.X_OK);

export function checkSetup({ root = ROOT, careerOps = process.env.CAREER_OPS_ROOT || path.resolve(root, '../career-ops'), careerDocs = path.resolve(root, '../career-docs'), jobspy = path.resolve(root, '../JobSpy'), envPath = process.env.PATH ?? '' } = {}) {
  const checks = [];
  const check = (id, scope, file, action, fn = () => nonempty(file)) => {
    try { fn(); checks.push({ id, scope, status: 'present', path: file }); }
    catch { checks.push({ id, scope, status: 'missing_or_invalid', path: file, action }); }
  };
  for (const name of SKILLS) check(`skill:${name}`, 'all', path.join(root, '.agents/skills', name, 'SKILL.md'), 'Restore this bundled Skill; ask the host to load it.');
  for (const name of ['AGENTS.md', 'package.json', 'tracker-parse.mjs', 'tracker-utils.mjs', 'pipeline-lock.mjs', 'scan.mjs', 'merge-tracker.mjs', 'verify-pipeline.mjs', 'doctor.mjs', 'cv-sync-check.mjs']) {
    check(`career-ops:${name}`, 'career-ops', path.join(careerOps, name), 'Install the Career-Ops source checkout here; do not fabricate missing implementation files.');
  }
  for (const name of ['AGENTS.md', 'package.json', 'path-resolver.mjs', 'tracker-parse.mjs', 'stats.mjs']) {
    check(`infographic:${name}`, 'process-infographic', path.join(careerOps, name), 'Install the Career-Ops source and npm dependencies, then verify the canonical tracker and statistics interfaces before collecting.');
  }
  check('infographic:npm-dependencies', 'process-infographic', path.join(careerOps, 'package.json'), 'Run npm install in Career-Ops; its statistics interface imports js-yaml. Verify the interface import after installation.', () => createRequire(path.join(path.resolve(careerOps), 'stats.mjs')).resolve('js-yaml'));
  const cv = path.join(careerOps, 'cv.md');
  check('candidate:cv', 'career-ops', cv, 'Use Career-Ops onboarding with the user CV; resume code needs PROFESSIONAL EXPERIENCE and TECHNICAL SKILLS sections.', () => loadCvSource(cv));
  check('candidate:profile', 'career-ops', path.join(careerOps, 'config/profile.yml'), 'Complete Career-Ops onboarding with confirmed candidate facts.');
  check('candidate:profile-summary', 'career-ops', path.join(careerOps, 'modes/_profile.md'), 'Use Career-Ops onboarding to generate the profile summary from the same confirmed facts.');
  const profile = path.join(careerOps, 'config/profile.yml');
  check('location:scan-policy', 'daily-scan', profile, 'Add location.scan_policy as two-space-indented inline JSON; see README. Do not silently substitute a supported region.', () => loadLocationPolicy(profile));
  for (const name of ['AGENTS.md', 'context/00 Knowledge Base Hub.md']) check(`career-docs:${name}`, 'interviews', path.join(careerDocs, name), 'Create only missing files from examples/career-docs; preserve existing workspace instructions and notes.');
  const register = path.join(careerDocs, 'context/Interview/active-interviews.md');
  check('career-docs:register', 'interviews/apply/retention', register, 'Use the empty register example only after the user confirms no existing register/processes; otherwise preserve or reconcile the existing schema.', () => validateActiveInterviews(readFileSync(register, 'utf8')));
  check('career-docs:git', 'gmail-writer', path.join(careerDocs, '.git'), 'Initialize local Git for a new Career Docs workspace and commit its valid initial register; no public remote. Existing worktrees may use a .git file.', () => {
    const options = { encoding: 'utf8', stdio: 'pipe' };
    const gitRoot = execFileSync('git', ['-C', careerDocs, 'rev-parse', '--show-toplevel'], options).trim();
    const relative = path.relative(realpathSync(gitRoot), realpathSync(register));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('register outside Git repository');
    validateActiveInterviews(execFileSync('git', ['-C', gitRoot, 'show', `HEAD:${relative}`], options));
  });
  const accounts = path.join(root, '.local/gmail-job-reply-review/accounts.json');
  for (const mailbox of ['primary', 'secondary']) {
    check(`gmail:${mailbox}-account`, 'gmail-accounts', accounts, `Set the user-confirmed ${mailbox} email address in this private file; setup --workflows gmail --apply creates a blank mapping. Missing identity blocks only ${mailbox}; the other configured mailbox may continue. Confirm the live account before access.`, () => {
      const value = JSON.parse(readFileSync(accounts, 'utf8'))?.[mailbox];
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('email address');
    });
  }
  for (const name of ['discovery-adapters.v1', 'jobspy-ego', 'jobright', 'google-ats-direct']) {
    const file = path.join(root, 'config', `${name}.json`);
    check(`config:${name}`, name === 'discovery-adapters.v1' ? 'daily-scan' : name, file, 'Copy the matching example only if absent, fill user choices, then run the owning adapter/config validator.', () => {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || value.schema_version !== 1) throw new Error('schema');
      if (name === 'jobright' && (!value.filter_snapshot?.values?.length || !value.filter_snapshot?.visible_controls?.length || !value.filter_snapshot?.codes?.locations?.length)) throw new Error('snapshot');
      if (name === 'google-ats-direct') loadGoogleAtsConfig(file);
    });
  }
  const runtime = path.join(root, 'config/daily-scan-runtime.json');
  check('config:runtime', 'daily-scan', runtime, 'Copy the runtime example if absent and choose an available model/effort, batch size, threshold and retention TTL.', () => loadDailyScanRuntime(runtime));
  const postConfig = path.join(root, 'linkedin-post-scan/config/post-scan.json');
  check('config:post-scan', 'post-scan', postConfig, 'Copy and customize the Post Scan example, including paths, role/location groups, phrase groups and the referenced runtime.', () => {
    const value = JSON.parse(readFileSync(postConfig, 'utf8'));
    for (const key of ['role_groups', 'location_groups', 'phrase_groups']) if (!Object.keys(value[key] ?? {}).length) throw new Error('groups');
    for (const target of Object.values(value.paths ?? {})) statSync(path.resolve(root, target));
    loadDailyScanRuntime(path.resolve(root, value.paths.daily_scan_runtime));
  });
  check('jobspy:python', 'jobspy', path.join(jobspy, '.venv/bin/python'), 'Create the dedicated JobSpy venv, install the checkout, then run runtime-check and the import check.', () => executable(path.join(jobspy, '.venv/bin/python')));
  check('ego:command', 'browser', 'PATH:ego-browser', 'Install the Ego Lite browser and expose its ego-browser command; load its external Skill.', () => {
    if (!envPath.split(path.delimiter).filter(Boolean).some(dir => { try { executable(path.join(dir, 'ego-browser')); return true; } catch { return false; } })) throw new Error('PATH');
  });
  check('resume:template', 'resume', path.join(root, 'assets/cv-template.docx'), 'Follow assets/README.md to prepare your own template, run npm run resume:template, then inspect the rendered pages.', () => {
    buildTemplateBaseline({ templatePath: path.join(root, 'assets/cv-template.docx'), source: loadCvSource(cv) });
  });
  return {
    file_checks_passed: checks.every(item => item.status === 'present'),
    readiness: 'requires_agent_and_user_checks',
    checks,
    manual_checks: [
      'Confirm candidate facts, work authorization, target roles and search preferences with the user; files alone are not evidence of confirmation.',
      'Current location matching assumes Washington-state local cities and US remote; reject unsupported requested geography instead of silently changing it.',
      'Check external Skills, host model availability, browser/Gmail account identity and login without storing credentials in the report.',
      'Run owning config validators, JobSpy import, Career-Ops interface/health checks and adapter dry-run; present paths and exact remediation without exposing profile contents.',
      'For process-infographic, use Python 3 with Pillow and a font covering the chart language; run its scripts/check.py and inspect the rendered PNG before delivery.',
      'Setup does not authorize a live scan, retention, scheduling, applications or messages. Report readiness per selected workflow; pending template/release tests remain visible.',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  const flags = { '--career-ops': 'careerOps', '--career-docs': 'careerDocs', '--jobspy': 'jobspy' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (!flags[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node src/setup-check.mjs [--career-ops PATH] [--career-docs PATH] [--jobspy PATH] [--json]');
    options[flags[args[i]]] = path.resolve(args[++i]);
  }
  const report = checkSetup(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.file_checks_passed ? 0 : 1;
}
