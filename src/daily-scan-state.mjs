import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadCareerTrackerParser(careerRoot) {
  const parserFile = path.join(path.resolve(careerRoot), 'tracker-parse.mjs');
  if (!existsSync(parserFile)) throw new Error(`Career-Ops tracker parser missing: ${parserFile}`);
  const parser = await import(pathToFileURL(parserFile).href);
  if (typeof parser.resolveColumns !== 'function' || typeof parser.parseTrackerRow !== 'function') {
    throw new Error(`Career-Ops tracker parser is incompatible: ${parserFile}`);
  }
  return parser;
}

export function parseTracker(text, parser) {
  if (typeof parser?.resolveColumns !== 'function' || typeof parser?.parseTrackerRow !== 'function') {
    throw new Error('Career-Ops resolveColumns/parseTrackerRow parser is required');
  }
  const lines = String(text).split(/\r?\n/);
  const columns = parser.resolveColumns(lines);
  return lines.flatMap(line => {
    const row = parser.parseTrackerRow(line, columns);
    if (!row) return [];
    const parts = line.split('|').map(value => value.trim());
    const reportPath = String(row.report ?? '').match(/(?:\.\.\/)?(reports\/[^\s)]+\.md)/)?.[1] ?? null;
    return [{
      number: Number(row.num),
      status: row.status,
      url: columns.url == null ? null : (parts[columns.url] ?? ''),
      report_path: reportPath,
      notes: row.notes,
      raw: row.raw ?? line,
      cells: parts.slice(1, line.trimEnd().endsWith('|') ? -1 : undefined),
      parsed: row,
    }];
  });
}

export function readReportIdentity(text) {
  const value = String(text ?? '');
  const field = name => value.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\r\\n]*)\\r?$`, 'mi'))?.[1]?.trim() ?? '';
  return { posting_url: field('URL'), posting_key: field('Posting Key') };
}

export function trackerNoteHasPostingKey(note, postingKey) {
  const expected = `posting key ${postingKey}`;
  return String(note ?? '').split(';').map(value => value.trim()).includes(expected);
}
