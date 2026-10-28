import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PERM_REPORT_LAYOUT, PERM_REFERENCE_HEADING, MAX_PERM_REFERENCE_CHARS, splitPermHistoryReference, renderCompactReport, readMachineSummary } from './scan-report-contract.mjs';

const tool = fileURLToPath(new URL('./perm-history.py', import.meta.url));
const boundary = '全部申请量和当前待审量不可得；历史认证不证明当前岗位支持 PERM，也不是个人获批概率。';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const cell = value => String(value ?? '不可得').replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
const link = file => encodeURI(file.split(path.sep).join('/')).replaceAll('(', '%28').replaceAll(')', '%29');

function python(command, payload) {
  const run = spawnSync('python3', [tool, command], { input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000 });
  if (run.error || run.status !== 0) throw new Error(`PERM ${command}: ${run.error?.message || run.stderr.trim() || 'local query failed'}`);
  return JSON.parse(run.stdout);
}

function recordsFor(run, results) {
  return run.records.map(record => ({ posting_key: record.primary_key, posting_url: record.primary_url,
    company: record.company, scored: results.byKey.get(record.primary_key)?.status === 'EVALUATED' }));
}

export function reviewPermCompanies(runRoot, run, results, decisions) {
  const snapshot = json(path.join(runRoot, 'baseline.json')).perm_history;
  if (!snapshot || snapshot.company_review === undefined || snapshot.report_layout !== PERM_REPORT_LAYOUT || snapshot.status === 'unavailable') return { status: 'not_required', companies: [] };
  if (snapshot.company_review !== 'company-review-v1') throw new Error('Unsupported PERM company review version');
  const payload = { snapshot, records: recordsFor(run, results) };
  if (!decisions) return python('company-review-queue', payload);
  const file = path.join(runRoot, 'perm-company-review.json');
  if (existsSync(path.join(runRoot, 'receipt.json')) || existsSync(path.join(runRoot, 'perm-history.json'))) throw new Error('PERM review must finish before persistence; existing runs cannot be backfilled');
  let review;
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) throw new Error('Frozen PERM company review cannot be a symlink');
    review = json(file);
    if (!isDeepStrictEqual(review.companies, decisions.companies)) throw new Error('Frozen PERM company review already exists');
    python('company-review-check', { ...payload, review });
  } else {
    review = python('company-review-freeze', { ...payload, decisions: decisions.companies });
    writeFileSync(file, JSON.stringify(review, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { status: 'COMPLETE', companies: review.companies, artifact: file };
}

export function snapshotPermHistory() {
  try { return { ...python('scan-snapshot'), report_layout: PERM_REPORT_LAYOUT }; }
  catch (error) { return { schema_version: 1, status: 'unavailable', reason: error.message, report_layout: PERM_REPORT_LAYOUT }; }
}

function build(runRoot, run, results) {
  const snapshot = json(path.join(runRoot, 'baseline.json')).perm_history;
  if (!snapshot) return null; // Pre-integration runs retain their original report contract.
  if (snapshot.report_layout !== undefined && snapshot.report_layout !== PERM_REPORT_LAYOUT) throw new Error('Unsupported frozen PERM report layout');
  const layout = snapshot.report_layout ? { report_layout: snapshot.report_layout } : {};
  const records = recordsFor(run, results);
  if (snapshot.status === 'ready') {
    if (snapshot.company_review !== undefined && snapshot.report_layout === PERM_REPORT_LAYOUT) {
      if (snapshot.company_review !== 'company-review-v1') throw new Error('Unsupported PERM company review version');
      const file = path.join(runRoot, 'perm-company-review.json');
      if (existsSync(file)) {
        if (lstatSync(file).isSymbolicLink()) throw new Error('PERM company review cannot be a symlink');
        const review = json(file), batch = python('company-review-check', { snapshot, records, review });
        const companyReview = { version: snapshot.company_review, companies: review.companies };
        batch.markdown += '\n## 本次公司名称核实\n\n' + review.companies.map(item => `- ${cell(item.company)}：${cell(item.outcome)}；${cell(item.note)}`).join('\n') + '\n';
        return { ...batch, ...layout, company_review: companyReview };
      }
      if (python('company-review-queue', { snapshot, records }).status === 'required') throw new Error('PERM company research is incomplete; run review-perm-companies prepare, research, then freeze before commit');
    }
    return { ...python('scan-batch', { snapshot, records }), ...layout };
  }
  if (snapshot.status !== 'unavailable') throw new Error('Invalid frozen PERM availability');
  return { schema_version: 1, ...layout, dataset: null, coverage: [],
    postings: records.map((record, index) => ({ ...record, reference_id: `perm-${index + 1}` })),
    references: records.map((record, index) => ({ id: `perm-${index + 1}`, result: { company: record.company, match_status: 'unavailable', match_reason: snapshot.reason } })),
    markdown: `# Daily Scan PERM 参考信息\n\n${boundary}\n\n本次扫描开始时本地数据不可用；请由 AI 完成 README 中的下载和初始化后再开始新扫描。\n\n${records.map(record => `- ${cell(record.company)} / ${cell(record.posting_key)}：unavailable；评分成功：${record.scored}`).join('\n')}\n` };
}

export function preparePermHistory(runRoot, run, results) {
  const artifact = build(runRoot, run, results);
  if (!artifact) return null;
  const outputs = [['perm-history.json', JSON.stringify(artifact, null, 2) + '\n'], ['perm-history.md', artifact.markdown]];
  for (const [name, expected] of outputs) {
    const file = path.join(runRoot, name);
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== expected)) throw new Error(`Frozen PERM artifact changed: ${name}`);
  }
  for (const [name, expected] of outputs) {
    const file = path.join(runRoot, name);
    if (!existsSync(file)) writeFileSync(file, expected, { flag: 'wx', mode: 0o600 });
  }
  return artifact;
}

export function renderPermHistoryReference(artifact, record, reportFile, runRoot) {
  if (!artifact) return '';
  const posting = artifact.postings.find(item => item.posting_key === record.primary_key);
  if (!posting || posting.posting_url !== record.primary_url || posting.company !== record.company || !posting.scored) throw new Error('PERM posting binding differs from scored acquisition');
  const result = artifact.references.find(item => item.id === posting.reference_id)?.result;
  if (!result || result.company !== record.company) throw new Error('PERM reference missing or company mismatch');
  const detail = link(path.relative(path.dirname(reportFile), path.join(runRoot, 'perm-history.md')));
  const evidence = link(path.relative(path.dirname(reportFile), path.join(runRoot, artifact.company_review ? 'perm-company-review.json' : 'baseline.json')));
  const label = { exact: '精确法人名', verified_alias: '证据映射已核实', not_found: '所选披露无确认记录', ambiguous: '名称或地点存在歧义', unavailable: '本地数据不可用', missing_context: '缺少已核实岗位身份', context_mismatch: '超出已核实岗位范围', unresolved: '公司身份待核实' }[result.match_status] ?? result.match_status;
  const modern = artifact.report_layout === PERM_REPORT_LAYOUT;
  const text = modern ? value => String(value ?? '不可得').replace(/[\r\n]+/g, ' ').replace(/[\\`*_\[\]<>#|]/g, '\\$&') : cell;
  const lines = modern ? [PERM_REFERENCE_HEADING, '', `[perm-history:${PERM_REPORT_LAYOUT}]: #`, '', `匹配：${text(label)}；招聘公司：${text(record.company)}；数据版本：${text(artifact.dataset?.revision)}。`]
    : ['**PERM 历史（仅供参考）**', '', `匹配：${cell(label)}；数据版本：${cell(artifact.dataset?.revision)}。`];
  if (result.coverage) lines.push('覆盖：' + result.coverage.map(item => `FY${item.fiscal_year} Q${item.quarter}（${item.start} 至 ${item.end}）`).join('；') + '。');
  for (const employer of result.matched_employers ?? []) lines.push(`法人：${text(employer.name)}（${text(employer.city)}, ${text(employer.state)}）。`);
  if (result.alias) lines.push(`名称映射范围：${modern ? (result.alias.scope.type === 'posting' ? '仅已核实的原岗位' : '公司范围内的明确法人/地点组') : cell(result.alias.scope.type)}；证据核实：${[...new Set(result.alias.evidence.map(item => item.checked_at))].map(cell).join('；')}。`);
  if (modern && result.alias?.relationship_type === 'company_history_reference') {
    lines.push('公司级历史参考：仅展示有证据关联的所列法人及历史披露地点，未涵盖全部关联企业；当前岗位的雇佣法人未由此确认，历史记录不代表当前岗位支持办理。');
    if (result.alias.reason) lines.push(`核实范围：${text(result.alias.reason)}`);
  }
  const reviewed = artifact.company_review?.companies.find(item => item.company === record.company);
  if (modern && reviewed) lines.push(`本次名称核实：${text({ verified: '已核实', ambiguous: '存在歧义，已询问', not_found: '未找到足够证据', source_unavailable: '来源不可用', publisher: '发布方或客户未确认' }[reviewed.outcome])}；${text(reviewed.note)}`);
  const entities = result.years ? [result] : result.entities ?? [];
  for (const entity of entities) {
    if (entity.legal_name) lines.push('', `法人明细：${text(entity.legal_name)}。`);
    if (!entity.years) continue;
    if (modern) {
      const years = Object.entries(entity.years);
      lines.push('', '|裁定结果|' + years.map(([year]) => `FY${year}${year === '2026' ? ' YTD' : ''}`).join('|') + '|', '|---|' + years.map(() => '---:').join('|') + '|');
      lines.push('|已披露案件|' + years.map(([, summary]) => summary.disclosed_cases).join('|') + '|');
      for (const [status, label] of [['Certified', '认证'], ['Certified-Expired', '认证后过期'], ['Denied', '拒绝'], ['Withdrawn', '撤回']]) lines.push(`|${label}|` + years.map(([, summary]) => summary.status_counts[status]).join('|') + '|');
    } else {
      lines.push('', '|裁定财年|已披露|认证|认证后过期|拒绝|撤回|曾认证占比|', '|---|---:|---:|---:|---:|---:|---|');
      for (const [year, summary] of Object.entries(entity.years)) {
        const counts = summary.status_counts, rate = summary.historical_certification_share;
        lines.push(`|FY${year}|${summary.disclosed_cases}|${counts.Certified}|${counts['Certified-Expired']}|${counts.Denied}|${counts.Withdrawn}|${rate.numerator}/${rate.denominator} (${rate.value === null ? '不可计算' : (100 * rate.value).toFixed(1) + '%'})|`);
      }
    }
    if (modern) for (const [year, summary] of Object.entries(entity.years)) {
      const rate = summary.historical_certification_share;
      lines.push(`- FY${year}${year === '2026' ? ' YTD' : ''} 曾认证占比：${rate.numerator}/${rate.denominator}（${rate.value === null ? '不可计算' : (100 * rate.value).toFixed(1) + '%'}）。`);
    }
    lines.push('', '曾认证占比 =（认证 + 认证后过期）/（认证 + 认证后过期 + 拒绝）；撤回不计分母。');
    lines.push(`最近裁定：${cell(entity.recent_dates.decision)}；最近认证：${cell(entity.recent_dates.certification_decision)}。`);
    if (modern) {
      lines.push(`已披露记录中最近收到：${text(entity.recent_dates.received_among_disclosed)}；不是公司最新实际递交日。`, '', '**处理时长（所选窗口合计，天）**', '');
      for (const [status, stats] of Object.entries(entity.processing_days)) lines.push(`- ${status}：中位数 ${text(stats.median)}；P25/P75 ${text(stats.p25)}/${text(stats.p75)}；n=${stats.n}，排除 ${stats.excluded}。`);
      const names = { job_titles: '历史岗位', soc: 'SOC', primary_worksites: '工作地点（仅主工作地点；多地点标记保留，非雇主办公地址）', law_firms: '律所/代理机构', representatives: '公开代理律师（不自动合并同名个人）' };
      for (const [dimension, groups] of Object.entries(entity.breakdowns)) {
        lines.push('', `**${names[dimension]}（前 3 组，共 ${groups.length} 组）**`, '');
        for (const group of groups.slice(0, 3)) lines.push(`- ${Object.entries(group.values).map(([key, value]) => `${key === 'multiple_worksites' ? '多地点：' : ''}${text(value === '(unknown)' ? '未披露' : value)}`).join(' / ')}：已披露 ${group.disclosed_cases} 件。`);
        if (groups.length > 3) lines.push(`其余 ${groups.length - 3} 组见本地完整明细。`);
      }
    }
  }
  if (!result.years && (!modern || !entities.some(entity => entity.years))) lines.push(`统计状态：${text(result.match_reason || '无确认统计；不能解释为零申请。')}`);
  const sources = artifact.coverage.map(source => `[FY${source.fiscal_year} Q${source.quarter}](${source.xlsx.url})${modern ? ` · [字段说明](${source.layout.url})` : ''}`).join(' · ');
  lines.push('', `官方来源：${sources || '本次不可用'}。`, modern
    ? `本地完整明细（工作区文件，网页不提供下载）：\`${detail}#${posting.reference_id}\`；映射及证据快照：\`${evidence}\`。`
    : `[完整时长、职位/SOC、地点、律所及案件证据](${detail}#${posting.reference_id}) · [扫描开始时的映射及证据快照](${evidence})。`, '', boundary, '仅作参考，不参与岗位评分、筛选或报告门槛。');
  if (modern) {
    lines.push('当前待审案件不在完整披露范围内；上述 Work Authorization 原判断保持不变。', '', `[perm-history-end:${PERM_REPORT_LAYOUT}]: #`);
    if ([...lines.join('\n')].length > MAX_PERM_REFERENCE_CHARS) throw new Error('PERM reference exceeds bounded report summary; keep full details in run artifact');
  }
  return lines.join('\n') + '\n\n';
}

export function auditPermHistory({ runRoot, run, results, reports, dataRoot, requirePersistence }) {
  const expected = build(runRoot, run, results);
  if (!expected) return null;
  const file = path.join(runRoot, 'perm-history.json'), md = path.join(runRoot, 'perm-history.md');
  if (!existsSync(file) || !existsSync(md) || lstatSync(file).isSymbolicLink() || lstatSync(md).isSymbolicLink()
      || JSON.stringify(json(file)) !== JSON.stringify(expected) || readFileSync(md, 'utf8') !== expected.markdown) throw new Error('PERM artifact is missing or differs from frozen data/posting bindings');
  if (requirePersistence) for (const report of reports) {
    const record = run.records.find(item => item.primary_key === report.posting_key), reportFile = path.join(dataRoot, report.report_path);
    const block = renderPermHistoryReference(expected, record, reportFile, runRoot);
    const document = readFileSync(reportFile, 'utf8');
    if (expected.report_layout === PERM_REPORT_LAYOUT) {
      try {
        const delimiter = document.indexOf('\n---\n\n');
        if (delimiter < 0) throw new Error('missing report header/body delimiter');
        const body = document.slice(delimiter + '\n---\n\n'.length);
        const { markdown, reference } = splitPermHistoryReference(body);
        const original = renderCompactReport({ result: results.byKey.get(record.primary_key), record, runId: path.basename(runRoot) });
        const auth = text => text.split('## Work Authorization\n\n')[1]?.split(/\n## /)[0].trim();
        if (reference !== block.trim() || document.split(PERM_REFERENCE_HEADING).length !== 2
            || (markdown.match(/^## Work Authorization$/gm) ?? []).length !== 1 || auth(markdown) !== auth(original)
            || !isDeepStrictEqual(readMachineSummary(markdown), readMachineSummary(original))) throw new Error('reference or original authorization/summary changed');
      } catch (error) { throw new Error(`${report.posting_key}: report PERM reference differs from frozen artifact: ${error.message}`); }
    } else if (!document.split('\n---\n\n')[0].includes(block.trim())) throw new Error(`${report.posting_key}: report PERM reference differs from frozen artifact`);
  }
  const scored = expected.postings.filter(item => item.scored);
  const counts = {};
  for (const posting of scored) {
    const status = expected.references.find(item => item.id === posting.reference_id).result.match_status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const companyReview = expected.company_review ? { version: expected.company_review.version, outcomes: {}, pending_companies: [] } : null;
  for (const item of expected.company_review?.companies ?? []) {
    companyReview.outcomes[item.outcome] = (companyReview.outcomes[item.outcome] ?? 0) + 1;
    if (item.outcome !== 'verified') companyReview.pending_companies.push(item.company);
  }
  return { artifact: 'perm-history.json', details: 'perm-history.md', ...(expected.report_layout ? { report_layout: expected.report_layout } : {}), ...(companyReview ? { company_review: companyReview } : {}), status_counts: counts, scored_keys: scored.map(item => item.posting_key).sort(), dataset: expected.dataset, reference_only: true };
}
