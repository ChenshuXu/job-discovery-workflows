#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validatePermEmployers } from '../../../../src/perm-employers.mjs';

const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const statuses = new Set(['正常办理', '已暂停', '受限', 'LMT难通过', '不确定']);
try {
  const snapshotFile = arg('--snapshot'), out = arg('--out');
  if (!snapshotFile || !out) throw new Error('Usage: import-tracker.mjs --snapshot <Ego-full-page-snapshot.txt> --out <catalog.json>');
  const snapshot = readFileSync(snapshotFile, 'utf8');
  const cutoff = snapshot.match(/数据截止 (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/)?.[1];
  const displayed = Number(snapshot.match(/text "正常办理 (\d+)"/)?.[1]);
  const current = Number(snapshot.match(/text "当前显示"\n[ \t]*text "(\d+)"/)?.[1]);
  const headers = [...snapshot.matchAll(/^ {12}container \[ref=\d+[^\n]*\]\n {14}heading\n {16}text "([^"\n]+)"\n {14}text "([^"\n]+)"/gm)];
  if (!cutoff || !displayed || current !== displayed || headers.length !== displayed || headers.some(match => match[2] !== '正常办理')) {
    throw new Error('capture must show every normal-status group with no search/platform filter; counts or snapshot layout differ');
  }
  const groups = headers.map((header, index) => {
    const block = snapshot.slice(header.index, headers[index + 1]?.index ?? snapshot.length).split(/\n {10}container /)[0];
    const sourceCount = Number(block.match(/^ {14}text "(\d+) 条来源"/m)?.[1]);
    const body = block.slice(block.indexOf('              svg_root') + '              svg_root'.length);
    const sources = body.split(/^ {14}container[^\n]*$/m).flatMap(section => {
      const beforeHeading = section.split(/^\s+heading$/m)[0];
      const fields = [...beforeHeading.matchAll(/^ {14,16}text "(.*)"$/gm)].map(match => match[1]);
      if (!fields.length) return [];
      const status = statuses.has(fields[1]) ? fields[1] : null;
      return [{ platform: fields[0], status, published_label: fields[status ? 2 : 1] ?? '未标注',
        url: section.match(/anchor \[[^\n]*url=(https?:\/\/[^\]\n]+)\]/)?.[1] ?? null }];
    });
    if (sources.length !== sourceCount) throw new Error(`${header[1]}: source count ${sources.length} differs from displayed ${sourceCount}`);
    return { company: header[1], aliases: [], status: header[2], information_date: block.match(/^ {14}text "信息时间 ([^"]+)"/m)?.[1],
      source_count: sourceCount, conflicting_statuses: [...new Set(sources.map(source => source.status).filter(status => status && status !== '正常办理'))], sources };
  });
  const catalog = validatePermEmployers({ schema_version: 1, source_url: 'https://muse.ai/s/perm-tracker-2-gh65gxaxqvxfxyu',
    source_snapshot_at: new Date(cutoff.replace(' ', 'T').replace(' UTC', 'Z')).toISOString(), captured_at: new Date().toISOString(),
    selection: 'tracker-current-status', displayed_group_count: displayed,
    companies: groups.filter(group => !/^(?:unknown\b|未具名|多家)/i.test(group.company)).sort((a, b) => a.company.localeCompare(b.company, 'en')),
    unresolved_groups: groups.filter(group => /^(?:unknown\b|未具名|多家)/i.test(group.company)) });
  const target = path.resolve(out), staged = `${target}.tmp-${process.pid}`;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(staged, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
  renameSync(staged, target);
  console.log(JSON.stringify({ catalog: target, companies: catalog.companies.length, unresolved_groups: catalog.unresolved_groups.length,
    displayed_groups: displayed, company_sources: groups.reduce((sum, group) => sum + group.source_count, 0), source_snapshot_at: catalog.source_snapshot_at }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
