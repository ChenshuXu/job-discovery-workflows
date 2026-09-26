function containsKeyword(text, keyword) {
  const re = new RegExp(`(?<![A-Za-z0-9])${RegExp.escape(keyword)}(?![A-Za-z0-9])`, 'i');
  return re.test(String(text ?? ''));
}

const CV_SUPPORT_STOP_WORDS = ['of', 'and', 'the', 'for', 'in', 'on', 'with', 'to', 'a', 'an'];

function cvSupportsKeyword(cvText, keyword) {
  const words = String(keyword).trim().split(/\s+/);
  if (words.length === 1) return containsKeyword(cvText, keyword);
  return words
    .filter((word) => !CV_SUPPORT_STOP_WORDS.includes(word.toLowerCase()))
    .every((word) => containsKeyword(cvText, word));
}

export function reportSections(markdown, titles) {
  const sections = {};
  for (const title of titles) {
    const marker = `## ${title}`;
    const start = String(markdown).indexOf(marker);
    if (start < 0) continue;
    const bodyStart = start + marker.length;
    const next = String(markdown).indexOf('\n## ', bodyStart);
    sections[title] = String(markdown).slice(bodyStart, next < 0 ? undefined : next).trim();
  }
  return sections;
}

export function tailoringReportSections(markdown) {
  const compactTitles = ['Verdict', 'Evidence', 'Gaps', 'Work Authorization'];
  const compact = reportSections(markdown, compactTitles);
  if (compactTitles.every((title) => compact[title])) return compact;

  const full = reportSections(markdown, [
    'A) Role Summary',
    'B) Match with CV',
    'B) CV Match',
    'E) Personalization Plan',
    'E) Customization Plan',
  ]);
  const role = full['A) Role Summary'];
  const match = full['B) Match with CV'] ?? full['B) CV Match'];
  const plan = full['E) Personalization Plan'] ?? full['E) Customization Plan'];
  if (role && match && plan) {
    return {
      'A) Role Summary': role,
      'B) Match with CV': match,
      'E) Customization Plan': plan,
    };
  }
  throw new Error('report must contain compact Verdict/Evidence/Gaps/Work Authorization or full A/B/E sections');
}

export function classifyCoverage(keywords, { resumeText, cvText, jdText = undefined }) {
  const coverage = { hit: [], miss: [], gap: [], unverified: [] };
  for (const keyword of keywords) {
    if (typeof jdText === 'string' && !containsKeyword(jdText, keyword)) coverage.unverified.push(keyword);
    else if (containsKeyword(resumeText, keyword)) coverage.hit.push(keyword);
    else if (cvSupportsKeyword(cvText, keyword)) coverage.miss.push(keyword);
    else coverage.gap.push(keyword);
  }
  return coverage;
}
