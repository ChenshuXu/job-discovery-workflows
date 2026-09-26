#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSetup } from './setup-check.mjs';
import { loadAdapterRegistry } from './adapter-registry.mjs';
import { loadJobrightConfig } from '../adapters/jobright_recommendations_scan.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOWS = {
  'daily-scan': ['career-ops', 'daily-scan', 'interviews/apply/retention'],
  expand: ['career-ops'], resume: ['career-ops', 'resume'],
  apply: ['career-ops', 'interviews/apply/retention', 'browser'],
  gmail: ['career-ops', 'interviews', 'interviews/apply/retention', 'gmail-writer', 'gmail-accounts'],
  interview: ['interviews', 'interviews/apply/retention', 'browser'],
  'post-scan': ['career-ops', 'post-scan', 'browser'], 'google-ats': ['google-ats-direct'],
  'process-infographic': ['process-infographic', 'interviews', 'interviews/apply/retention'],
};
export function skillRoot(skillFile) {
  const file = realpathSync(skillFile);
  const root = path.resolve(path.dirname(file), '../../..');
  if (path.basename(file) !== 'SKILL.md' || !existsSync(path.join(root, 'src/setup.mjs'))
      || JSON.parse(readFileSync(path.join(root, 'package.json'))).name !== 'job-discovery'
      || path.relative(root, file) !== `.agents/skills/${path.basename(path.dirname(file))}/SKILL.md`) throw new Error('Not a bundled Job Discovery Skill');
  return root;
}
const present = file => { try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function noSymlinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (present(current)?.isSymbolicLink()) throw new Error(`Symlink write path: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
export function setup({ root = ROOT, workflows = [], sources = [], apply = false, links, install = false, python: pythonCommand = 'python3' } = {}) {
  root = realpathSync(root);
  const careerOps = path.resolve(process.env.CAREER_OPS_ROOT || path.join(root, '../career-ops'));
  if (!workflows.length) return { action: 'Choose --workflows ' + Object.keys(WORKFLOWS).join(','), writes: [] };
  if (workflows.some(x => !WORKFLOWS[x]) || sources.some(x => !['jobspy', 'ego-browser', 'jobright'].includes(x))) throw new Error('Unknown workflow or source');
  if (sources.length && !workflows.includes('daily-scan')) throw new Error('--sources requires daily-scan');
  if (workflows.includes('daily-scan') && !sources.length) throw new Error('Choose --sources for daily-scan');
  if (install && !apply) throw new Error('--install requires --apply');
  const writes = [], operations = [], files = new Set();
  if (workflows.includes('daily-scan')) {
    files.add('config/discovery-adapters.v1.json'); files.add('config/daily-scan-runtime.json');
    for (const source of sources) files.add(`config/${source === 'jobright' ? 'jobright' : 'jobspy-ego'}.json`);
  }
  if (workflows.includes('google-ats')) files.add('config/google-ats-direct.json');
  const gmailAccounts = '.local/gmail-job-reply-review/accounts.json';
  if (workflows.includes('gmail')) files.add(gmailAccounts);
  if (workflows.includes('post-scan')) { files.add('linkedin-post-scan/config/post-scan.json'); files.add('config/daily-scan-runtime.json'); files.add('config/jobspy-ego.json'); }
  // Preflight every path and every link before writing any of them.
  for (const relative of files) {
    const target = path.join(root, relative); noSymlinks(target);
    if (present(target)) continue;
    const example = relative === gmailAccounts ? 'config/gmail-accounts.example.json' : relative.replace(/\.json$/, '.example.json');
    const source = [path.join(root, example), path.join(root, 'release/overrides', example)].find(existsSync);
    if (!source) throw new Error(`Missing example: ${example}`);
    let bytes = readFileSync(source);
    if (relative.endsWith('discovery-adapters.v1.json')) {
      const config = JSON.parse(bytes);
      for (const [id, adapter] of Object.entries(config.adapters)) adapter.enabled = sources.includes(id);
      config.minimum_successful_adapters = 1;
      bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
    }
    writes.push(relative); operations.push(() => { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }); });
  }
  const inventory = checkSetup({ root, careerOps });
  if (links) {
    if (!path.isAbsolute(links)) throw new Error('--links must be an explicit absolute host Skill directory');
    noSymlinks(links);
    for (const item of inventory.checks.filter(x => x.id.startsWith('skill:'))) {
      const source = path.dirname(item.path), target = path.join(links, path.basename(source));
      const stat = present(target);
      if (stat) {
        if (!stat.isSymbolicLink() || realpathSync(target) !== realpathSync(source)) throw new Error(`Skill link conflict: ${target}`);
      } else {
        writes.push(target); operations.push(() => { mkdirSync(links, { recursive: true }); symlinkSync(source, target, 'dir'); });
      }
    }
  }
  if (apply) for (const operation of operations) operation();
  const dependencies = [];
  if (workflows.some(x => WORKFLOWS[x].includes('career-ops') || x === 'process-infographic')) dependencies.push({ name: 'Career-Ops', dir: careerOps, url: 'https://github.com/career-ops-hq/career-ops.git' });
  if (sources.includes('jobspy')) dependencies.push({ name: 'JobSpy', dir: path.resolve(root, '../JobSpy'), url: 'https://github.com/speedyapply/JobSpy.git' });
  if (install) for (const dependency of dependencies) {
    noSymlinks(dependency.dir);
    if (!existsSync(dependency.dir)) execFileSync('git', ['clone', ...(dependency.name === 'JobSpy' ? ['--branch', 'main'] : []), dependency.url, dependency.dir], { stdio: 'inherit' });
    if (dependency.name === 'JobSpy') {
      const python = path.join(dependency.dir, '.venv/bin/python');
      const interpreter = existsSync(python) ? python : pythonCommand;
      const version = JSON.parse(execFileSync(interpreter, ['-c', 'import json, sys; print(json.dumps(list(sys.version_info[:2])))'], { encoding: 'utf8' }));
      if (version[0] !== 3 || version[1] < 10) throw new Error(`JobSpy requires Python >=3.10,<4.0; ${interpreter} is ${version.join('.')}. Use --python PATH for a new venv; an existing incompatible venv is preserved.`);
      if (!existsSync(python)) execFileSync(pythonCommand, ['-m', 'venv', path.dirname(path.dirname(python))], { stdio: 'inherit' });
      try { execFileSync(python, ['-c', 'from jobspy import scrape_jobs; assert callable(scrape_jobs)'], { stdio: 'pipe' }); }
      catch {
        execFileSync(python, ['-m', 'pip', 'install', '--upgrade', 'pip>=21.3'], { stdio: 'inherit' });
        execFileSync(python, ['-m', 'pip', 'install', '-e', dependency.dir], { stdio: 'inherit' });
      }
      execFileSync(python, ['-c', 'from jobspy import scrape_jobs; assert callable(scrape_jobs)'], { stdio: 'inherit' });
    }
  }
  const checks = checkSetup({ root, careerOps });
  const results = workflows.map(workflow => {
    const scopes = new Set(['all', ...WORKFLOWS[workflow]]);
    if (workflow === 'daily-scan') for (const source of sources) {
      scopes.add(source === 'jobspy' ? 'jobspy' : 'browser'); scopes.add(source === 'jobright' ? 'jobright' : 'jobspy-ego');
    }
    const selected = checks.checks.filter(x => scopes.has(x.scope));
    const errors = [];
    if (apply && workflow === 'daily-scan') try {
      const registry = loadAdapterRegistry(path.join(root, 'config/discovery-adapters.v1.json'));
      if (JSON.stringify(Object.keys(registry.adapters).filter(x => registry.adapters[x].enabled).sort()) !== JSON.stringify([...new Set(sources)].sort())) throw new Error('Existing registry differs from selected sources; preserved it. Reconcile explicit choices before scanning.');
      for (const source of sources.filter(x => x !== 'jobright')) {
        const command = source === 'jobspy' ? 'python3' : process.execPath;
        const script = source === 'jobspy' ? 'adapters/jobspy_linkedin_scan.py' : 'adapters/egobrowser_linkedin_scan.mjs';
        execFileSync(command, [path.join(root, script), '--dry-run', '--config', path.join(root, 'config/jobspy-ego.json')], { stdio: 'pipe' });
      }
      if (sources.includes('jobright')) loadJobrightConfig(path.join(root, 'config/jobright.json'));
    } catch (e) { errors.push(e.message); }
    return { workflow, status: errors.length ? 'validation failed' : 'needs user input', errors, checks: selected,
      next: 'Confirm actual user settings, host capabilities and accounts; perform README workflow checks. File presence alone is not readiness.' };
  });
  return { root, mode: apply ? 'applied' : 'preview', writes, dependencies, results, manual_checks: checks.manual_checks };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--apply' || flag === '--install') options[flag.slice(2)] = true;
    else if (['--workflows', '--sources', '--links', '--skill-root', '--python'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (flag === '--skill-root') options.skill = value;
      else options[flag.slice(2)] = ['--workflows', '--sources'].includes(flag) ? value.split(',') : value;
    } else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  console.log(options.skill ? skillRoot(options.skill) : JSON.stringify(setup(options), null, 2));
}
