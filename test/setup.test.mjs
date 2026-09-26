import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup, skillRoot } from '../src/setup.mjs';

test('setup is create-only, selection-aware and resolves all linked Skills outside cwd', t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'discovery-setup-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'discovery'), links = path.join(dir, 'host/skills'); mkdirSync(root);
  for (const name of ['package.json', 'src', '.agents']) cpSync(name, path.join(root, name), { recursive: true });
  const examples = existsSync('release/overrides/config') ? 'release/overrides/config' : 'config';
  cpSync(examples, path.join(root, 'config'), { recursive: true, filter: file => file === examples || file.endsWith('.example.json') });
  const preview = setup({ root, workflows: ['google-ats'], links });
  assert.deepEqual(preview.writes.filter(x => !path.isAbsolute(x)), ['config/google-ats-direct.json']);
  assert.equal(existsSync(links), false);
  setup({ root, workflows: ['google-ats'], links, apply: true });
  const file = path.join(root, 'config/google-ats-direct.json');
  const config = JSON.parse(readFileSync(file)); config.role_terms = ['user choice']; writeFileSync(file, JSON.stringify(config));
  const before = readFileSync(file, 'utf8');
  const second = setup({ root, workflows: ['google-ats'], links, apply: true });
  assert.deepEqual(second.writes, []); assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(second.results[0].checks.every(x => !x.id.startsWith('career-ops:')));
  for (const skill of readdirSync(links)) assert.equal(skillRoot(path.join(links, skill, 'SKILL.md')), root);
  assert.deepEqual(readdirSync(links).sort(), readdirSync(path.join(root, '.agents/skills')).sort());
  const infographic = setup({ root, workflows: ['process-infographic'] });
  assert.equal(infographic.dependencies[0].name, 'Career-Ops');
  assert.ok(infographic.results[0].checks.some(x => x.id === 'infographic:stats.mjs'));
  assert.equal(infographic.results[0].checks.find(x => x.id === 'infographic:npm-dependencies').status, 'missing_or_invalid');
  assert.ok(infographic.results[0].checks.every(x => !x.id.startsWith('candidate:')));
  const priorCareerOps = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = path.join(dir, 'custom-career');
  try {
    const custom = setup({ root, workflows: ['expand'] });
    assert.equal(custom.dependencies[0].dir, process.env.CAREER_OPS_ROOT);
    assert.equal(custom.results[0].checks.find(x => x.id === 'career-ops:AGENTS.md').path, path.join(custom.dependencies[0].dir, 'AGENTS.md'));
  } finally {
    if (priorCareerOps === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = priorCareerOps;
  }
  const first = path.join(links, readdirSync(links)[0]); rmSync(first); mkdirSync(first);
  assert.throws(() => setup({ root, workflows: ['google-ats'], links, apply: true }), /conflict/);
  assert.throws(() => setup({ root, workflows: ['daily-scan'] }), /sources/);
  assert.throws(() => setup({ root, workflows: ['unknown'] }), /Unknown/);
  const outside = path.join(dir, 'outside'); writeFileSync(outside, 'private'); rmSync(file); symlinkSync(outside, file);
  assert.throws(() => setup({ root, workflows: ['google-ats'], apply: true }), /Symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'private');
});

test('Gmail setup creates a private blank account mapping without inventing or replacing identities', t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gmail-setup-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'discovery'); mkdirSync(root);
  const examples = existsSync('release/overrides/config') ? 'release/overrides/config' : 'config';
  cpSync(examples, path.join(root, 'config'), { recursive: true, filter: file => file === examples || file.endsWith('.example.json') });
  const relative = '.local/gmail-job-reply-review/accounts.json', file = path.join(root, relative);
  assert.deepEqual(setup({ root, workflows: ['gmail'] }).writes, [relative]);
  assert.equal(existsSync(file), false);
  const applied = setup({ root, workflows: ['gmail'], apply: true });
  assert.deepEqual(JSON.parse(readFileSync(file)), { primary: '', secondary: '' });
  assert.equal(applied.results[0].checks.find(x => x.id === 'gmail:primary-account').status, 'missing_or_invalid');
  const accounts = JSON.stringify({ primary: 'test-user@example.invalid', secondary: '' });
  writeFileSync(file, accounts);
  const repeated = setup({ root, workflows: ['gmail'], apply: true });
  assert.deepEqual(repeated.writes, []);
  assert.equal(readFileSync(file, 'utf8'), accounts);
  assert.equal(repeated.results[0].checks.find(x => x.id === 'gmail:primary-account').status, 'present');
  assert.equal(repeated.results[0].checks.find(x => x.id === 'gmail:secondary-account').status, 'missing_or_invalid');
  assert.doesNotMatch(JSON.stringify(repeated), /test-user@example/);
});

test('standalone Post Scan setup creates its shared config and checks its referenced runtime', t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'post-scan-setup-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'discovery'); mkdirSync(root);
  const examples = existsSync('release/overrides/config') ? 'release/overrides/config' : 'config';
  cpSync(examples, path.join(root, 'config'), { recursive: true, filter: file => file === examples || file.endsWith('.example.json') });
  mkdirSync(path.join(root, 'linkedin-post-scan/config'), { recursive: true });
  writeFileSync(path.join(root, 'linkedin-post-scan/config/post-scan.example.json'), JSON.stringify({
    role_groups: { role: ['Engineer'] }, location_groups: { remote: ['US'] }, phrase_groups: { hiring: ['Hiring'] },
    paths: { career_ops_root: '../career-ops', cv: '../career-ops/cv.md', profile: '../career-ops/config/profile.yml', employer_exclusions: 'config/jobspy-ego.json', daily_scan_runtime: 'config/daily-scan-runtime.json' },
  }));
  const career = path.join(dir, 'career-ops'); mkdirSync(path.join(career, 'config'), { recursive: true });
  writeFileSync(path.join(career, 'cv.md'), 'Synthetic candidate'); writeFileSync(path.join(career, 'config/profile.yml'), 'Synthetic profile');
  const applied = setup({ root, workflows: ['post-scan'], apply: true });
  assert.ok(applied.writes.includes('config/jobspy-ego.json'));
  assert.equal(applied.results[0].checks.find(x => x.id === 'config:post-scan').status, 'present');
  writeFileSync(path.join(root, 'config/daily-scan-runtime.json'), '{}');
  const repeated = setup({ root, workflows: ['post-scan'], apply: true });
  assert.equal(repeated.results[0].checks.find(x => x.id === 'config:post-scan').status, 'missing_or_invalid');
  assert.deepEqual(repeated.writes, []);
  assert.equal(readFileSync(path.join(root, 'config/daily-scan-runtime.json'), 'utf8'), '{}');
});

test('JobSpy install rejects old Python and bootstraps editable-install pip in the selected venv', t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'jobspy-setup-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'discovery'); mkdirSync(root); mkdirSync(path.join(dir, 'career-ops')); mkdirSync(path.join(dir, 'JobSpy'));
  const examples = existsSync('release/overrides/config') ? 'release/overrides/config' : 'config';
  cpSync(examples, path.join(root, 'config'), { recursive: true, filter: file => file === examples || file.endsWith('.example.json') });
  const interpreter = path.join(dir, 'python'), log = path.join(dir, 'calls.jsonl'), installed = path.join(dir, 'installed');
  const script = version => `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '-c' && args[1].includes('version_info')) console.log(JSON.stringify(${JSON.stringify(version)}));
else if (args[0] === '-c') process.exit(fs.existsSync(${JSON.stringify(installed)}) ? 0 : 1);
else if (args[1] === 'venv') { const target = path.join(args[2], 'bin/python'); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(__filename, target); fs.chmodSync(target, 0o755); }
else if (args.includes('-e')) fs.writeFileSync(${JSON.stringify(installed)}, 'installed');
`;
  const options = { root, workflows: ['daily-scan'], sources: ['jobspy'], apply: true, install: true, python: interpreter };
  writeFileSync(interpreter, script([3, 9])); chmodSync(interpreter, 0o755);
  assert.throws(() => setup(options), /requires Python >=3.10,<4.0/);
  assert.equal(existsSync(path.join(dir, 'JobSpy/.venv')), false);
  writeFileSync(interpreter, script([3, 12]));
  setup(options);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const bootstrap = calls.findIndex(args => args.includes('pip>=21.3'));
  assert.ok(bootstrap >= 0 && bootstrap < calls.findIndex(args => args.includes('-e')));
  assert.ok(existsSync(installed));
  const venvPython = path.join(dir, 'JobSpy/.venv/bin/python'), oldVenv = script([3, 9]);
  writeFileSync(venvPython, oldVenv);
  assert.throws(() => setup(options), /existing incompatible venv is preserved/);
  assert.equal(readFileSync(venvPython, 'utf8'), oldVenv);
});
