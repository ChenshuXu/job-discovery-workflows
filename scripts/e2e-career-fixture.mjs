import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { careerOpsCodeRoot } from '../src/career-ops-paths.mjs';

export const DISCOVERY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_FIXTURE_ROOT = existsSync(path.join(DISCOVERY_ROOT, 'release/overrides/examples'))
  ? path.join(DISCOVERY_ROOT, 'release/overrides') : DISCOVERY_ROOT;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const EMPTY_TRACKER = '# Applications\n\n| # | Company | Role | Location | Salary | Score | Status | Date | CV | Report | Via | Contact | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';

export function treeManifest(root, { skipNodeModules = true } = {}) {
  if (!existsSync(root)) return [];
  const visit = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (skipNodeModules && entry.name === 'node_modules') return [];
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [{ path: path.relative(root, file), kind: 'symlink', target: readlinkSync(file) }];
    return entry.isDirectory() ? visit(file) : [{ path: path.relative(root, file), sha256: sha256(readFileSync(file)) }];
  });
  return visit(root).sort((a, b) => a.path.localeCompare(b.path));
}

// Copies only public executable/template files, never candidate data or .git.
// Every invocation has its own code and private-data trees; no live writer runs.
export function createCareerFixture({ name, outRoot, sourceRoot = careerOpsCodeRoot(), layout = 'marker' }) {
  const root = path.resolve(outRoot ?? path.join(DISCOVERY_ROOT, '.local/career-ops-e2e', new Date().toISOString().replace(/[:.]/g, '-')), name);
  if (existsSync(root)) throw new Error(`E2E artifact directory already exists: ${root}`);
  const codeRoot = path.join(root, 'code'), dataRoot = path.join(root, 'data');
  mkdirSync(codeRoot, { recursive: true }); mkdirSync(dataRoot, { recursive: true });
  const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); return file; };
  const tracked = execFileSync('git', ['-C', sourceRoot, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const selected = tracked.filter(file => /^([^/]+\.mjs|(?:lib|providers|plugins)\/.+\.(?:mjs|js|json)|templates\/[^/]+\.(?:yml|md)|modes\/(?:_shared|oferta)\.md|package(?:-lock)?\.json|tracker-aliases\.json)$/.test(file));
  for (const relative of selected) {
    const source = path.join(sourceRoot, relative);
    if (!lstatSync(source).isFile()) throw new Error(`Expected regular upstream code file: ${relative}`);
    const destination = path.join(codeRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination);
  }
  if (!existsSync(path.join(codeRoot, 'path-resolver.mjs'))) throw new Error('Installed upstream canonical resolver is missing');
  const dependencies = path.join(sourceRoot, 'node_modules');
  if (!existsSync(dependencies)) throw new Error('Install Career-Ops npm dependencies before this E2E run');
  symlinkSync(dependencies, path.join(codeRoot, 'node_modules'), 'dir');
  const dependencyBaseline = treeManifest(dependencies, { skipNodeModules: false });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CAREER_OPS_/.test(key)) delete env[key];
  env.CAREER_OPS_CODE_ROOT = codeRoot;
  if (layout === 'marker') write(path.join(codeRoot, '.career-ops-data'), '../data\n');
  else if (layout === 'env') env.CAREER_OPS_ROOT = dataRoot;
  else throw new Error(`Unknown E2E layout: ${layout}`);
  write(path.join(dataRoot, 'data/applications.md'), EMPTY_TRACKER);
  mkdirSync(path.join(dataRoot, 'reports'), { recursive: true });
  const baselineCode = treeManifest(codeRoot);
  write(path.join(root, 'source-code.json'), { source_root: sourceRoot,
    source_revision: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: baselineCode });
  const assertions = [], commands = [];
  const check = (label, passed, details = null) => {
    assertions.push({ label, passed: Boolean(passed), details });
    write(path.join(root, 'assertions.json'), assertions);
    if (!passed) throw new Error(`E2E assertion failed: ${label}`);
  };
  const run = (label, script, args = [], options = {}) => {
    const command = [process.execPath, path.resolve(script), ...args];
    const result = spawnSync(command[0], command.slice(1), { cwd: options.cwd ?? DISCOVERY_ROOT, env: { ...env, ...options.env }, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 120000 });
    const number = String(commands.length + 1).padStart(2, '0');
    write(path.join(root, `commands/${number}-${label}.stdout.txt`), result.stdout ?? '');
    write(path.join(root, `commands/${number}-${label}.stderr.txt`), result.stderr ?? '');
    commands.push({ label, command, cwd: options.cwd ?? DISCOVERY_ROOT, env: Object.fromEntries(Object.entries({ ...env, ...options.env }).filter(([key]) => /^CAREER_OPS_|^JOB_DISCOVERY_/.test(key))), exit_code: result.status, error: result.error?.message ?? null });
    write(path.join(root, 'commands.json'), commands);
    if (options.expect !== null) check(`${label}: exit ${options.expect ?? 0}`, result.status === (options.expect ?? 0), { actual: result.status, stderr: result.stderr });
    return result;
  };
  const finish = extra => {
    check('canonical code unchanged', JSON.stringify(treeManifest(codeRoot)) === JSON.stringify(baselineCode));
    check('shared npm dependencies unchanged', JSON.stringify(treeManifest(dependencies, { skipNodeModules: false })) === JSON.stringify(dependencyBaseline));
    const value = { name, root, codeRoot, dataRoot, passed: assertions.every(item => item.passed), assertions, commands: commands.length, ...extra };
    write(path.join(root, 'artifacts.json'), treeManifest(dataRoot));
    write(path.join(root, 'result.json'), value);
    return value;
  };
  return { root, codeRoot, dataRoot, env, write, run, check, finish, baselineCode };
}
