#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = process.argv.indexOf('--out');
const out = path.resolve(at < 0 ? path.join(root, '.local/career-ops-e2e', new Date().toISOString().replace(/[:.]/g, '-')) : process.argv[at + 1]);
if (existsSync(out)) throw new Error(`Artifact directory already exists; choose a fresh --out: ${out}`);
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceFiles = ['src', 'test/e2e', 'test/run.mjs', 'config', 'test/career-ops-integration-e2e.plan.json'];
function manifest(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isDirectory()) return manifest(file, relative);
    return entry.isFile() ? [{ path: relative, bytes: statSync(file).size }] : [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
const sources = sourceFiles.flatMap(file => file.endsWith('.json') || file.endsWith('.mjs')
  ? [{ path: file, bytes: statSync(path.join(root, file)).size }]
  : manifest(path.join(root, file), file));
for (const file of [...git('diff', '--name-only').split('\n'), ...git('ls-files', '.agents/skills').split('\n')].filter(Boolean)) {
  if (existsSync(path.join(root, file)) && !sources.some(item => item.path === file)) sources.push({ path: file, bytes: statSync(path.join(root, file)).size });
}
sources.sort((a, b) => a.path.localeCompare(b.path));
write('source.json', { root, revision: git('rev-parse', 'HEAD'), working_tree_changes: git('status', '--short'), node: process.version, files: sources });
writeFileSync(path.join(out, 'failure-modes.json'), readFileSync(path.join(root, 'test/career-ops-integration-e2e.plan.json')));
const commands = [];
for (const name of ['paths', 'reports-health', 'scoring', 'blacklist', 'report-v6', 'keywords', 'requirements-listing', 'research']) {
  const args = [path.join(root, `test/e2e/e2e-career-${name}.mjs`), '--out', out];
  process.stdout.write(`Running ${name} E2E...\n`);
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(path.join(out, `${name}.stdout.txt`), result.stdout ?? '');
  writeFileSync(path.join(out, `${name}.stderr.txt`), result.stderr ?? '');
  commands.push({ name, command: [process.execPath, ...args], exit_code: result.status, error: result.error?.message ?? null });
  write('commands.json', commands);
  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout || result.error?.message || `${name} failed`); break; }
}
const results = manifest(out).filter(item => item.path.endsWith(`${path.sep}result.json`)).map(item => JSON.parse(readFileSync(path.join(out, item.path), 'utf8')));
const passed = commands.length === 8 && commands.every(item => item.exit_code === 0)
  && ['scoring', 'blacklist', 'reports-health', 'report-v6', 'keywords', 'requirements-listing', 'research'].every(name => results.some(item => item.name === name))
  && results.some(item => item.name.startsWith('paths-')) && results.every(item => item.passed);
write('summary.json', { passed, assertions: results.reduce((total, result) => total + result.assertions.length, 0),
  scenarios: results.map(result => ({ name: result.name, passed: result.passed, assertions: result.assertions.length, commands: result.commands, root: result.root })),
  rerun: 'npm run test:career-ops:e2e -- --out <fresh-artifact-directory>',
  scope: 'Frozen fictional data with actual installed Career-Ops code and actual CLI workflows. No live acquisition, model quality, or application submission claim.' });
write('artifacts.json', manifest(out));
console.log(JSON.stringify({ passed, artifact: path.join(out, 'summary.json') }));
if (!passed) process.exitCode = 1;
