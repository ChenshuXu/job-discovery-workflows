import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DISCOVERY_ROOT } from './e2e-career-fixture.mjs';
import { snapshotAdapterProfile } from '../../src/adapter-registry.mjs';
import { researchFixture } from '../fixtures/scoring-research.mjs';

export const SCAN_DATE = '2026-10-03';
export const EVIDENCE_TEXT = {
  scope: 'Build reliable distributed backend systems, APIs, observability, and production services with end-to-end ownership.',
  compensation: 'Guaranteed base salary is $170,000 to $200,000 per year, with bonus and equity separately stated.',
  culture: 'The platform team has six engineers, direct ownership, and asynchronous collaboration.',
  sponsorship: 'We provide visa sponsorship and transfers for this permanent full-time employee role.',
  uncertainty: 'Final work authorization eligibility will be confirmed after a role-specific review.',
};

export function seedCandidate(fx) {
  fx.write(path.join(fx.dataRoot, 'cv.md'), '# Fictional Candidate\n\n## Experience\nBuilt and operated backend platforms, distributed workflows, observability, and reliable APIs. Owned services through design, delivery and production support.\n');
  fx.write(path.join(fx.dataRoot, 'config/profile.yml'), 'full_name: Fictional Candidate\nemail: fictional@example.invalid\nlocation:\n  city: Seattle\n  visa_status: H-1B\n  needs_sponsorship: true\n  scan_policy: {"local_metros":["Seattle"],"remote_country":"United States","require_structured_remote":true,"ambiguous_action":"exclude"}\nculture_screen:\n  require: ["small teams", "direct ownership"]\n');
  fx.write(path.join(fx.dataRoot, 'modes/_profile.md'), '# Candidate profile\n\n## Your Target Roles\nBackend and Platform Engineer, Mid-level through Senior.\n\n## Compensation\nTarget guaranteed base of $170,000 to $200,000. Current market calibration is not supplied.\n');
  fx.write(path.join(fx.dataRoot, 'modes/_custom.md'), '# Custom rules\n\nUse canonical Career-Ops Global Score dimensions. Daily Scan execution follows the Job Discovery Daily Scan Skill. Candidate facts remain separate.\n');
  fx.write(path.join(fx.dataRoot, 'data/scan-history.tsv'), 'url\tdate\tsource\ttitle\tcompany\tstatus\tlocation\n');
  for (const directory of ['jds', 'output', 'batch/tracker-additions']) mkdirSync(path.join(fx.dataRoot, directory), { recursive: true });
}

export function seedScan(fx, { name = 'frozen-scan', jobs = [{ id: '88000001', company: 'Fictional Platform Co' }], permEmployers = null, permCompanyReview = false } = {}) {
  const runRoot = path.join(fx.root, 'runs', name);
  const sourceRoot = path.join(runRoot, 'sources');
  for (const adapter of snapshotAdapterProfile().adapters) {
    mkdirSync(path.join(sourceRoot, adapter, 'jobs'), { recursive: true });
    fx.write(path.join(sourceRoot, adapter, 'summary.json'), { schema_version: 1, run_id: name, adapter,
      status: adapter === 'jobspy' ? 'SUCCESS' : 'EMPTY', raw_rows: adapter === 'jobspy' ? jobs.length : 0,
      unique_jobs: adapter === 'jobspy' ? jobs.length : 0, markdown_jobs: adapter === 'jobspy' ? jobs.length : 0, errors: 0 });
    fx.write(path.join(sourceRoot, adapter, 'excluded-employers.json'), { schema_version: 1, run_id: name, excluded_count: 0, results: [] });
  }
  for (const job of jobs) {
    const url = job.url ?? `https://www.linkedin.com/jobs/view/${job.id}`;
    const key = job.key ?? `linkedin:linkedin.com:${job.id}`;
    const body = job.body ?? `${EVIDENCE_TEXT.scope}\n${EVIDENCE_TEXT.compensation}\n${EVIDENCE_TEXT.culture}\n${job.verification ? EVIDENCE_TEXT.uncertainty : EVIDENCE_TEXT.sponsorship}\nThis role requires backend service ownership and experience with distributed systems, APIs, data storage, testing, debugging and production incident response. Each team owns its deployment lifecycle and reviews reliability and user outcomes. The engineer collaborates with peers to design pragmatic solutions and document operational tradeoffs. Unique team charter: ${job.id}.`;
    fx.write(path.join(sourceRoot, 'jobspy/jobs', `${job.id}.md`), `# Senior Backend Engineer\n\n**URL:** ${url}\n**Posting Key:** ${key}\n${key.startsWith('linkedin:') ? `**LinkedIn Job ID:** ${job.id}\n` : ''}**Company:** ${job.company}\n**Role:** Senior Backend Engineer\n**Location:** Seattle, WA\n**Employment Type:** Full-time\n**Workplace Type:** hybrid\n**Workplace Type Source:** frozen fictional capture\n**Structured Remote Signal:** false\n**Posted:** ${SCAN_DATE}\n**Source:** jobspy\n\n## Job Description\n\n${body}\n`);
  }
  fx.run(`${name}-baseline`, path.join(DISCOVERY_ROOT, 'src/verify-scan-receipt.mjs'), ['--run', runRoot, '--career-ops', fx.codeRoot, '--capture-baseline', ...(permEmployers ? ['--perm-employers', permEmployers] : [])]);
  // Existing regression fixtures exercise frozen runs from before automatic company review.
  if (!permCompanyReview) { const file = path.join(runRoot, 'baseline.json'), baseline = JSON.parse(readFileSync(file, 'utf8')); if (baseline.perm_history) delete baseline.perm_history.company_review; fx.write(file, baseline); }
  fx.run(`${name}-combine`, path.join(DISCOVERY_ROOT, 'src/combine.mjs'), ['--run', runRoot]);
  return runRoot;
}

export function scoreReport({ confidence = 'Medium', statuses = {}, verification = false } = {}) {
  const sources = { cv_match: 'cv.md/Experience', north_star: 'modes/_profile.md/Your Target Roles',
    compensation: `JD: ${EVIDENCE_TEXT.compensation}`, culture: `JD: ${EVIDENCE_TEXT.culture}`, red_flags: `JD: ${EVIDENCE_TEXT.sponsorship}` };
  const defaults = { cv_match: 'supported', north_star: 'supported', compensation: 'partial', culture: 'supported', red_flags: 'supported' };
  const observations = { cv_match: 'The candidate has documented backend platform ownership.', north_star: 'Backend/platform is an explicit target.',
    compensation: 'The stated base matches the target; bonus and equity values remain unverified.', culture: 'The JD supports a small team and direct ownership.',
    red_flags: 'The role states permanent employment and sponsorship.' };
  const questions = { cv_match: 'Confirm experience relevant to the required platform scope.', north_star: 'Confirm this role matches a target archetype.',
    compensation: 'Confirm current market positioning and total compensation.', culture: 'Confirm practical team ownership.', red_flags: 'Resolve role-specific eligibility.' };
  const entries = Object.entries({ ...defaults, ...statuses }).map(([dimension, status]) => [dimension, {
    status, source: status === 'unknown' ? null : sources[dimension],
    observation: dimension === 'compensation' && status === 'supported' ? 'The explicit guaranteed base matches the documented target; assessment is limited to guaranteed base.' : observations[dimension],
    question: status === 'supported' ? null : questions[dimension],
  }]);
  const gaps = entries.filter(([, detail]) => detail.question !== null).map(([, detail]) => detail.question);
  if (verification && !gaps.includes(questions.red_flags)) gaps.unshift(questions.red_flags);
  return { archetype: 'Backend / Platform', reason: 'Backend ownership matches documented experience and target role.',
    evidence: [{ source: 'jd', quote: EVIDENCE_TEXT.scope, explanation: 'The role owns reliable backend platforms.' },
      { source: 'candidate', locator: 'cv.md/Experience', fact: 'Built and operated backend platforms.', explanation: 'Directly relevant delivery and operations experience.' }],
    gaps: [], hiring_manager_review: { summary: 'No evidence-supported interview refusal reason in this fictional resume/JD.', concerns: [] },
    risk_level: 'Low', confidence, requirement_importance: [], keywords: ['distributed systems', 'APIs', 'observability', 'testing', 'debugging'], discard_reasons: [], fixed_term_evidence: null,
    score_evidence: Object.fromEntries(entries), confidence_gaps: gaps.slice(0, 3),
    risk_summary: { classification: 'clear', culture: 'pass', interview_redflags: 'not_evaluated', ai_infra: 'not_evaluated' },
    advertised_comp: EVIDENCE_TEXT.compensation, company_confidential_evidence: null };
}

export function writeScoreParts(fx, runRoot, makeResult = () => ({})) {
  const plan = JSON.parse(readFileSync(path.join(runRoot, 'assignments.json'), 'utf8'));
  const records = new Map(JSON.parse(readFileSync(path.join(runRoot, 'acquisition.json'), 'utf8')).acquired.map(record => [record.primary_key, record]));
  mkdirSync(path.join(runRoot, 'results'), { recursive: true });
  for (const [worker, keys] of Object.entries(plan.assignments)) {
    for (let index = 0; index < keys.length; index += plan.runtime.scheduler.batch_size) {
      const results = keys.slice(index, index + plan.runtime.scheduler.batch_size).map(posting_key => ({ posting_key,
        ...(plan.research_version === 1 ? { research: researchFixture(posting_key, records.get(posting_key).company) } : {}),
        fit_score: 4.2, level_signal: 'target', level_evidence: 'JD: "Senior Backend Engineer"',
        eligibility_status: 'eligible', eligibility_category: null, eligibility_evidence: null,
        legitimacy_tier: 'High Confidence', work_authorization: { value: 'sponsors', quote: EVIDENCE_TEXT.sponsorship },
        report: scoreReport(), ...makeResult(posting_key) }));
      fx.write(path.join(runRoot, 'results', `${worker}.part-${Math.floor(index / plan.runtime.scheduler.batch_size) + 1}.json`), {
        result_schema_version: plan.result_schema_version, worker, part: Math.floor(index / plan.runtime.scheduler.batch_size) + 1, results });
    }
  }
  return plan;
}

export function mergeAll(fx, runRoot, plan = JSON.parse(readFileSync(path.join(runRoot, 'assignments.json'), 'utf8'))) {
  for (const worker of Object.keys(plan.assignments)) fx.run(`${path.basename(runRoot)}-${worker}`, path.join(DISCOVERY_ROOT, 'src/merge-worker-results.mjs'), ['--run', runRoot, '--worker', worker]);
}
