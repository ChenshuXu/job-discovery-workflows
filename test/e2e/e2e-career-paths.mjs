import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createCareerFixture, DISCOVERY_ROOT, PUBLIC_FIXTURE_ROOT, EMPTY_TRACKER, treeManifest } from './e2e-career-fixture.mjs';
import { seedCandidate } from './e2e-scan-inputs.mjs';

const moduleUrl = file => pathToFileURL(path.join(DISCOVERY_ROOT, file)).href;
const require = createRequire(import.meta.url);
const profile = 'location:\n  country: United States\n  scan_policy: {"local_metros":["Seattle"],"remote_country":"United States","require_structured_remote":true,"ambiguous_action":"exclude"}\n';
const cv = '# Fictional Candidate\n\n## PROFESSIONAL EXPERIENCE\n\n### Backend Engineer, Fixture Company | 2020–2026\n- Built distributed services using Java.\n\n## TECHNICAL SKILLS\n\n**Languages:** Java, Python\n';

// This driver is an end-to-end local publication/lookup journey. It invokes
// actual Job Discovery adapters and installed canonical Career-Ops writers.
// Only its candidate inputs are fictional; no writer or resolver is mocked.
const driver = `
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCareerPaths, careerOpsEnv } from ${JSON.stringify(moduleUrl('src/career-ops-paths.mjs'))};
import { reserveScanReportNumbers, releaseScanReportNumbers } from ${JSON.stringify(moduleUrl('src/render-scan-reports.mjs'))};
import { appendCandidateTracker, loadCareerInterfaces, runCareerCommand } from ${JSON.stringify(moduleUrl('src/commit-scan.mjs'))};
import { collectHistoricalPostingKeys } from ${JSON.stringify(moduleUrl('src/posting-history.mjs'))};
import { resolveReport } from ${JSON.stringify(moduleUrl('src/resume/resolve-report.mjs'))};
import { loadCvSource } from ${JSON.stringify(moduleUrl('src/resume/cv-source.mjs'))};
import { snapshotScoringInputs, validateScoringInputs } from ${JSON.stringify(moduleUrl('src/scoring-inputs.mjs'))};
import { loadLocationPolicy } from ${JSON.stringify(moduleUrl('src/location-scope.mjs'))};
import { resolveTitleWarnings } from ${JSON.stringify(moduleUrl('src/career-ops-health.mjs'))};
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const paths = resolveCareerPaths(input.codeRoot);
Object.assign(process.env, careerOpsEnv(paths));
const scoring = snapshotScoringInputs(input.codeRoot);
const location = loadLocationPolicy(paths.profileFile);
const childProfileFile = path.join(input.root, 'child-profile.txt');
runCareerCommand(input.codeRoot, path.join(input.root, 'inputs/profile-path.mjs'), [childProfileFile]);
const childProfile = readFileSync(childProfileFile, 'utf8');
const interfaces = await loadCareerInterfaces(input.codeRoot);
const numbers = reserveScanReportNumbers(input.codeRoot, 2);
releaseScanReportNumbers(input.codeRoot, [numbers[1]]);
const reportPath = 'reports/' + String(numbers[0]).padStart(3,'0') + '-fixture-(backend)-2026-10-03.md';
const reportFile = path.join(paths.dataRoot, reportPath);
writeFileSync(reportFile, input.report.replace('REPORT_NUMBER', String(numbers[0])));
unlinkSync(path.join(paths.reportsRoot, String(numbers[0]).padStart(3,'0') + '-RESERVED.md'));
const additionFile = path.join(input.root, 'inputs/addition.tsv');
writeFileSync(additionFile, 'num\\tdate\\tcompany\\trole\\tstatus\\tscore\\tpdf\\treport\\tnotes\\n' + [numbers[0], '2026-10-03', 'Fixture Company', 'Backend Engineer', 'Evaluated', '4.0/5', '❌', '['+numbers[0]+']('+reportPath+')', 'posting key '+input.key+'; job id '+input.key.split(':').at(-1)].join('\\t') + '\\n');
const row = await appendCandidateTracker({ careerRoot: input.codeRoot, trackerFile: paths.trackerFile,
  trackerParser: interfaces.trackerParser, openTrackerTransaction: interfaces.trackerUtils.openTrackerTransaction,
  postingKey: input.key, record: {primary_key:input.key,primary_url:input.url},
  report: {report_number:numbers[0],report_path:reportPath}, additionFile });
runCareerCommand(input.codeRoot, 'tracker.mjs', ['sync']);
mkdirSync(paths.jdsRoot,{recursive:true});
writeFileSync(path.join(paths.jdsRoot, 'discovery-path-e2e-'+input.key.replace(/[^A-Za-z0-9._-]/g,'-')+'.md'),input.jd);
const scanner = await import(pathToFileURL(path.join(input.codeRoot,'scan.mjs')).href);
await scanner.appendToScanHistory([{url:input.url,company:'Fixture Company',title:'Backend Engineer',location:'Seattle, WA',source:'e2e',description:input.jd}], '2026-10-03', 'daily-scan:path-e2e');
const observations = ['skipped_title', 'skipped_location', 'skipped_age', 'skipped_no_apply_control', 'added', 'skipped_expired'];
for (const [i, status] of observations.entries()) {
  await scanner.appendToScanHistory([{url:input.url.replace(/900[12]$/, String(9100+i)),company:'Fixture Company',title:'Backend Engineer',location:'Seattle, WA',source:'e2e'}], '2026-10-03', status);
}
await scanner.appendToScanHistory([{url:input.url,company:'Fixture Company',title:'Backend Engineer',location:'Seattle, WA',source:'e2e'}], '2026-10-03', 'skipped_title');
const resolved = resolveReport(String(numbers[0]), {careerOpsRoot:input.codeRoot,discoveryRoot:path.join(input.root,'discovery')});
const history = [...collectHistoricalPostingKeys({careerRoot:input.codeRoot})];
const warning = 'Possible duplicates: #' + input.firstNumber + ', #' + numbers[0] + ' (Fixture Company — Backend Engineer)';
const health = input.firstNumber ? resolveTitleWarnings({careerRoot:input.codeRoot,messages:[warning]}) : null;
const lockedProfile = scoring.candidate_sources.find(source=>source.label==='config/profile.yml');
writeFileSync(paths.profileFile, lockedProfile.content + '\\n# concurrent edit\\n');
let staleRejected = false;
try { validateScoringInputs({...scoring,career_ops_root:input.codeRoot,result_schema_version:8}); }
catch (error) { staleRejected = error.message.includes('source content changed: config/profile.yml'); }
finally { writeFileSync(paths.profileFile, lockedProfile.content); }
console.log(JSON.stringify({paths,row,reportPath,resolved,history,cv:loadCvSource(),numbers,lockedProfile,location,childProfile,staleRejected,health},null,2));
`;

export function runPathsE2E({ outRoot, sourceRoot } = {}) {
  const results = [];
  for (const scenario of ['marker', 'profile-absolute', 'profile-relative', 'data-env', 'root-env', 'external-tracker', 'legacy-tracker', 'symlink-data']) {
    const fixture = createCareerFixture({ name: `paths-${scenario}`, outRoot, sourceRoot });
    const { root, codeRoot, dataRoot, env, write, run, check, finish } = fixture;
    let activeDataRoot = dataRoot;
    if (scenario === 'data-env' || scenario === 'root-env') {
      activeDataRoot = path.join(root, 'environment-data');
      env.CAREER_OPS_DATA_DIR = '../environment-data';
      if (scenario === 'root-env') {
        env.CAREER_OPS_ROOT = '../environment-data';
        env.CAREER_OPS_DATA_DIR = '../ignored-data';
      }
    } else if (scenario === 'symlink-data') {
      activeDataRoot=path.join(root,'data-link');
      symlinkSync(dataRoot,activeDataRoot,'dir');
      env.CAREER_OPS_ROOT='../data-link';
    }
    write(path.join(activeDataRoot, 'cv.md'), cv);
    write(path.join(activeDataRoot, 'config/profile.yml'), profile);
    let profileFile = path.join(activeDataRoot, 'config/profile.yml');
    if (scenario.startsWith('profile-')) {
      profileFile = write(path.join(root, 'lane/profile.yml'), profile.replace('Seattle', 'Bellevue'));
      env.CAREER_OPS_PROFILE = scenario === 'profile-absolute' ? profileFile : path.relative(DISCOVERY_ROOT, profileFile);
    }
    write(path.join(root, 'inputs/profile-path.mjs'), `import {getProfilePath} from ${JSON.stringify(pathToFileURL(path.join(codeRoot, 'path-resolver.mjs')).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],getProfilePath());`);
    write(path.join(activeDataRoot, 'modes/_profile.md'), 'Fictional backend engineer.\n');
    write(path.join(activeDataRoot, 'data/applications.md'), EMPTY_TRACKER);
    write(path.join(activeDataRoot, 'reports/.keep'), '');
    let trackerFile = path.join(activeDataRoot, 'data/applications.md');
    if (scenario === 'external-tracker') {
      trackerFile = path.join(root, 'external-ledger/applications.md');
      env.CAREER_OPS_TRACKER = '../external-ledger/applications.md';
      env.CAREER_OPS_SCAN_HISTORY = '../external-ledger/scan-history.tsv';
      write(trackerFile, EMPTY_TRACKER);
    } else if (scenario === 'legacy-tracker') {
      trackerFile = path.join(activeDataRoot, 'applications.md');
      env.CAREER_OPS_TRACKER = trackerFile;
      write(trackerFile, EMPTY_TRACKER);
    }
    trackerFile=realpathSync(trackerFile);
    const key = 'greenhouse:fixture:9001', url = 'https://job-boards.greenhouse.io/fixture/jobs/9001';
    const jd = `# Fixture Backend Engineer\n\n**URL:** ${url}\n**Company:** Fixture Company\n**Role:** Backend Engineer\n**Location:** Seattle, WA\n**Posting Key:** ${key}\n\n## Job Description\n\nBuild distributed backend services using Java.\n`;
    const report = `# Evaluation: Fixture Company — Backend Engineer\n\n**Report Number:** REPORT_NUMBER\n**Date:** 2026-10-03\n**Score:** 4.0/5\n**Legitimacy:** High\n**Work Auth:** Unstated\n**URL:** ${url}\n**Posting Key:** ${key}\n**PDF:** not generated\n\n## Summary\n\nFictional evaluation input.\n\nrun_id: "path-e2e"\nposting_key: "${key}"\n`;
    const inputFile = write(path.join(root, 'inputs/journey.json'), {root,codeRoot,key,url,jd,report});
    const driverFile = write(path.join(root, 'inputs/journey.mjs'), driver);
    const before = treeManifest(dataRoot);
    const result = JSON.parse(run('publication-and-lookup', driverFile, [inputFile]).stdout);
    check('code root remains executable root', result.paths.codeRoot === codeRoot);
    check('official precedence selects intended data root', result.paths.dataRoot === activeDataRoot);
    check('profile override selects and locks the intended file', result.paths.profileFile === profileFile && result.lockedProfile.path === profileFile);
    check('profile location policy follows the selected file', result.location.local_metros[0] === (scenario.startsWith('profile-') ? 'Bellevue' : 'Seattle'));
    check('child commands read the same profile', result.childProfile === profileFile);
    check('profile edits invalidate scoring snapshots', result.staleRejected);
    check('tracker override resolves relative to code root', result.paths.trackerFile === trackerFile);
    check('resume resolves exact persisted report', result.resolved.reportPath === path.join(activeDataRoot,result.reportPath));
    check('resume output stays in data root', result.resolved.targetPath.startsWith(path.join(activeDataRoot,'output')+path.sep));
    check('candidate CV comes from selected data root', result.cv.roles[0].bullets[0].text === 'Built distributed services using Java.');
    check('history includes committed exact posting key', result.history.some(([found]) => found === key));
    check('observational rows never suppress rediscovery', [9100,9101,9102,9103].every(id=>!result.history.some(([found])=>found==='greenhouse:fixture:'+id)));
    check('committed and terminal history still suppress duplicates', [9104,9105].every(id=>result.history.some(([found])=>found==='greenhouse:fixture:'+id)));
    const trackerText = readFileSync(trackerFile,'utf8');
    const parser = require(path.join(codeRoot, 'tracker-parse.mjs'));
    const reportLink = parser.parseMarkdownLinks(trackerText).find(link=>link.label===String(result.numbers[0]))?.target;
    check('persisted tracker link opens the actual report', path.resolve(path.dirname(trackerFile),reportLink) === result.resolved.reportPath);
    check('canonical tracker SQLite sync exists', existsSync(trackerFile.replace(/\.md$/,'.db')));
    check('reservation and release leave no sentinel', !treeManifest(path.join(activeDataRoot,'reports')).some(item=>item.path.endsWith('-RESERVED.md')));
    if (scenario === 'external-tracker' || scenario === 'legacy-tracker') check('unused default tracker is unchanged', readFileSync(path.join(activeDataRoot,'data/applications.md'),'utf8') === EMPTY_TRACKER);
    if (realpathSync(activeDataRoot) !== realpathSync(dataRoot)) check('env precedence leaves marker data untouched', JSON.stringify(treeManifest(dataRoot)) === JSON.stringify(before));
    const priorRow = trackerText.split('\n').find(line=>line.includes(key));
    const secondInput = write(path.join(root,'inputs/second-journey.json'),{root,codeRoot,firstNumber:result.numbers[0],key:key.replace('9001','9002'),url:url.replace('9001','9002'),jd:jd.replaceAll('9001','9002'),report:report.replaceAll('9001','9002')});
    const secondResult = JSON.parse(run('second-publication',driverFile,[secondInput]).stdout);
    check('second publication preserves existing tracker row',readFileSync(trackerFile,'utf8').split('\n').includes(priorRow));
    check('second publication reserves a distinct report',secondResult.numbers[0]!==result.numbers[0] && secondResult.resolved.reportPath!==result.resolved.reportPath);
    check('health reads parenthesized report identities',secondResult.health.resolved.length===1 && secondResult.health.unresolved.length===0);
    write(path.join(root,'second-journey-result.json'),secondResult);
    const found = JSON.parse(run('official-find',path.join(codeRoot,'find.mjs'),[String(result.numbers[0]),'--json'],{cwd:codeRoot}).stdout);
    check('official lookup selects exact report', found.length===1 && Number(found[0].reportNum)===result.numbers[0]);
    const setup = JSON.parse(run('setup-check',path.join(DISCOVERY_ROOT,'src/setup-check.mjs'),['--career-ops',codeRoot,'--career-docs',path.join(root,'career-docs'),'--jobspy',path.join(root,'JobSpy'),'--json'],{expect:1}).stdout);
    check('setup diagnoses candidate files in data root', ['candidate:cv','candidate:profile','candidate:profile-summary'].every(id=>setup.checks.find(item=>item.id===id)?.status==='present'));
    if (scenario === 'external-tracker') {
      const docs = path.join(root,'career-docs');
      const register = write(path.join(docs,'context/Interview/active-interviews.md'),readFileSync(path.join(PUBLIC_FIXTURE_ROOT,'examples/active-interviews.md'),'utf8'));
      write(path.join(root,'runs/path-e2e/receipt.json'),{status:'COMPLETE',run_id:'path-e2e',reports:[
        {posting_key:key,report_number:result.numbers[0],report_path:result.reportPath},
        {posting_key:key.replace('9001','9002'),report_number:secondResult.numbers[0],report_path:secondResult.reportPath},
      ]});
      const batch = JSON.parse(run('application-batch',path.join(DISCOVERY_ROOT,'.agents/skills/career-ops-ego-apply/scripts/application-batch.mjs'),
        ['--career-ops',codeRoot,'--active-interviews',register,'--runs-root',path.join(root,'runs'),'--run','path-e2e','--json']).stdout);
      check('application batch preserves both external-tracker report identities',batch.summary.selectableRows===2 && batch.unresolved.length===0);
      const infographicRoot=path.join(root,'infographic');
      run('infographic-collect',path.join(DISCOVERY_ROOT,'.agents/skills/process-infographic/scripts/collect.mjs'),
        ['--career-ops',codeRoot,'--career-docs',docs,'--out',infographicRoot]);
      const snapshot=JSON.parse(readFileSync(path.join(infographicRoot,'snapshot.json'),'utf8'));
      check('infographic uses canonical external tracker',snapshot.paths.tracker===trackerFile && snapshot.sources.some(item=>item.path===trackerFile));
      const state=path.join(root,'gmail-state');
      write(path.join(state,'gmail-job-reply-state.json'),{version:1,last_successful_run_at:'2026-01-01T00:00:00.000Z',processed_message_ids:[]});
      write(path.join(state,'gmail-job-reply-secondary-state.json'),{version:1,last_successful_run_at:'2026-01-01T00:00:00.000Z',processed_thread_tokens:[],processed_thread_versions:[],legacy_thread_tokens:[],legacy_thread_token_floor_at:'2026-01-01T00:00:00.000Z'});
      const gitInit=write(path.join(root,'inputs/initialize-career-docs.mjs'),`import {execFileSync} from 'node:child_process';\nfor (const args of [['init','-q','--template='],['add','context/Interview/active-interviews.md'],['-c','user.name=Fictional E2E','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','Synthetic register']]) execFileSync('git',args,{cwd:${JSON.stringify(docs)},stdio:'pipe'});\n`);
      run('gmail-register-git',gitInit);
      const gmail=path.join(DISCOVERY_ROOT,'.agents/skills/gmail-job-reply-review/scripts/gmail-job-reply-run.mjs');
      const common=['--career-ops-root',codeRoot,'--interviews-file',register,'--state-root',state];
      const beforeGmail=readFileSync(trackerFile,'utf8');
      const begun=JSON.parse(run('gmail-begin',gmail,['begin',...common]).stdout);
      const ledger=JSON.parse(readFileSync(path.join(state,'runs/active.json'),'utf8'));
      check('Gmail captures the exact external tracker baseline',ledger.workspace_baseline.application_rows && Object.keys(ledger.workspace_baseline.application_rows).length===2);
      run('gmail-status',gmail,['status',...common]);
      run('gmail-abort-fixture',gmail,['abort',...common,'--run-id',begun.run_id,'--token',begun.token,'--reason-code','e2e_complete']);
      check('Gmail diagnostic transaction preserves tracker',readFileSync(trackerFile,'utf8')===beforeGmail && !existsSync(path.join(state,'runs/active.json')));
    }
    write(path.join(root,'journey-result.json'),result);
    write(path.join(root,'selected-data-artifacts.json'),treeManifest(activeDataRoot));
    if (scenario==='external-tracker') write(path.join(root,'external-ledger-artifacts.json'),treeManifest(path.dirname(trackerFile)));
    results.push(finish({scenario,activeDataRoot,trackerFile}));
  }
  const post=createCareerFixture({name:'paths-linkedin-handoff',outRoot,sourceRoot});
  seedCandidate(post);
  const discovery=path.join(post.root,'discovery');
  for(const name of ['src','.agents/skills/gmail-job-reply-review/scripts'])
    cpSync(path.join(DISCOVERY_ROOT,name),path.join(discovery,name),{recursive:true});
  cpSync(path.join(DISCOVERY_ROOT,'test/fixtures/config'),path.join(discovery,'config'),{recursive:true});
  for(const name of readdirSync(path.join(DISCOVERY_ROOT,'config')).filter(name=>name.endsWith('.md')))
    cpSync(path.join(DISCOVERY_ROOT,'config',name),path.join(discovery,'config',name));
  const config=JSON.parse(readFileSync(path.join(PUBLIC_FIXTURE_ROOT,'config/linkedin-post-scan.example.json'),'utf8'));
  config.paths={career_ops_root:post.codeRoot,cv:path.join(post.codeRoot,'cv.md'),profile:path.join(post.codeRoot,'config/profile.yml'),
    employer_exclusions:path.join(discovery,'config/jobspy-ego.json'),daily_scan_runtime:path.join(discovery,'config/daily-scan-runtime.json')};
  const configFile=post.write(path.join(discovery,'config/linkedin-post-scan.json'),config);
  const dbFile=path.join(discovery,'.local/linkedin-post-scan/e2e.db');
  const postKey='greenhouse:fixture:9901';
  const dbSeed=post.write(path.join(post.root,'inputs/post-opportunity.mjs'),`import {openDatabase} from ${JSON.stringify(pathToFileURL(path.join(discovery,'src/linkedin-post-scan/db.mjs')).href)};\nconst db=openDatabase(${JSON.stringify(dbFile)});\ndb.prepare('INSERT INTO opportunities (opportunity_id,kind,posting_key,employer,title,location,official_url,post_signal,status,reason_code,evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('e2e-opportunity','EXACT_JOB',${JSON.stringify(postKey)},'Fictional Post Company','Senior Backend Engineer','Seattle, WA','https://job-boards.greenhouse.io/fixture/jobs/9901',1,'HANDOFF_READY',null,JSON.stringify({jd_text:'Build reliable distributed backend services, APIs, infrastructure, databases, observability and production tooling. This full-time employee role provides sponsorship and visa transfers. We design pragmatic, maintainable systems and collaborate with a small team to own delivery, testing, rollout and operations. The platform enables product teams to ship reliable features. Work includes debugging, documentation, incident review and measuring reliability improvements.',employment_type:'Full-time',workplace_type:'hybrid',published_at:'2026-10-03'}),'2026-10-03T00:00:00Z','2026-10-03T00:00:00Z');db.close();\n`);
  post.run('linkedin-seed-opportunity',dbSeed);
  const handoff=JSON.parse(post.run('linkedin-handoff-plan',path.join(discovery,'src/linkedin-post-scan/cli.mjs'),
    ['handoff-plan','--config',configFile,'--db',dbFile,'--posting-key',postKey]).stdout);
  post.check('LinkedIn handoff uses split candidate sources',handoff.stages.plan.candidate_sources.every(item=>item.path.startsWith(post.dataRoot+path.sep)));
  post.check('LinkedIn exact posting reaches scoring assignment',handoff.non_empty_assignments.some(item=>item.assigned.includes(postKey)));
  post.check('LinkedIn handoff leaves candidate tracker empty',readFileSync(path.join(post.dataRoot,'data/applications.md'),'utf8')===EMPTY_TRACKER);
  results.push(post.finish({scope:'LinkedIn captured-post handoff through real baseline/combine/contract/URL/planner CLIs; no browser or scoring execution.'}));
  return {passed:results.every(result=>result.passed),results};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at=process.argv.indexOf('--out');
  console.log(JSON.stringify(runPathsE2E({outRoot:at>=0?process.argv[at+1]:undefined}),null,2));
}
