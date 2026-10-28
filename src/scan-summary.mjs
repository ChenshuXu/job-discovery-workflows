import { statSync } from 'node:fs';

// Complete data stays at artifact; preview clipping never changes its contents.
export function compactSummary({ stage, status, artifact, counts = {}, errors = [], errorCount = errors.length }) {
  if (!statSync(artifact).isFile()) throw new Error(`summary artifact is not a file: ${artifact}`);
  const preview = errors.slice(0, 5).map(error => [...String(error)].slice(0, 180).join(''));
  const summary = { stage, status, artifact, counts, next_action: 'Inspect the complete artifact; use --full to expand command output.', error_count: errorCount,
    preview_count: preview.length, truncated: errorCount > preview.length || errors.slice(0, 5).some(e => [...String(e)].length > 180), errors_preview: preview };
  while ([...JSON.stringify(summary)].length > 2000 && summary.errors_preview.length) {
    summary.errors_preview.pop(); summary.preview_count--; summary.truncated = true;
  }
  if ([...JSON.stringify(summary)].length > 2000) throw new Error('summary metadata exceeds 2000 characters; inspect the complete artifact');
  return summary;
}
