const UNKNOWN_VALUES = new Set(['', 'unknown', 'unspecified', 'not specified', 'n/a', 'none', 'null']);

const clean = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

export function employmentTypeValues(value) {
  const input = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const values = [];
  for (const item of input) {
    const normalized = clean(item);
    if (UNKNOWN_VALUES.has(normalized.toLowerCase()) || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    values.push(normalized);
  }
  return values;
}

export function employmentTypeDisplay(value) {
  const values = employmentTypeValues(value);
  return values.length ? values.join(' | ') : 'unknown';
}
