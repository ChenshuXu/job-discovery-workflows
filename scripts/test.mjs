// Run the unchanged suite against a disposable checkout and explicit test policies.
// No maintainer configuration, sibling repositories, or private Git history is read.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(path.join(tmpdir(), 'discovery-tests-'));
const root = path.join(workspace, 'discovery');
try {
  mkdirSync(root);
  for (const name of ['src', 'adapters', 'test', 'scripts', '.agents', 'release', 'assets', 'linkedin-post-scan', 'package.json', 'CLAUDE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const from = path.join(source, name);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(root, name), { recursive: true, filter: (file) => {
      const relative = path.relative(from, file);
      return !relative.split(path.sep).some(part => ['__pycache__', 'data', 'reports', '.local'].includes(part))
        && !(name === 'linkedin-post-scan' && relative.startsWith('config'));
    } });
  }
  mkdirSync(path.join(root, 'config'));
  for (const name of readdirSync(path.join(source, 'config')).filter(name => name.endsWith('.md') || name.endsWith('.example.json'))) {
    cpSync(path.join(source, 'config', name), path.join(root, 'config', name));
  }
  cpSync(path.join(source, 'test/fixtures/config'), path.join(root, 'config'), { recursive: true });
  // Recovery verifies historical bytes; give it a local, fictional root commit.
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', 'config', 'src');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic test baseline');
  const env = { ...process.env };
  for (const key of ['CAREER_OPS_ROOT', 'JOB_DISCOVERY_ADAPTER_REGISTRY', 'SERPAPI_API_KEY']) delete env[key];
  const result = spawnSync(process.execPath, ['--test', ...(process.argv.length > 2 ? process.argv.slice(2) : ['test/*.test.mjs'])], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
