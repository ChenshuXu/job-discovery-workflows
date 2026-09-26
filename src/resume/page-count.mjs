import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

const DEFAULT_COUNT_DIR = resolve(homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents');

function runOsaScript(args) {
  return execFileSync('/usr/bin/osascript', args, { encoding: 'utf8', timeout: 30000 });
}

export function countWordPages(docxPath, options = {}) {
  if (process.env.RESUME_DISABLE_WORD === '1') {
    return { status: 'NOT RUN', reason: 'Word page counting disabled' };
  }
  const countDir = resolve(options.countDir ?? DEFAULT_COUNT_DIR);
  if (!existsSync(countDir)) {
    return { status: 'NOT RUN', reason: `Word container Documents directory not found: ${countDir}` };
  }
  const marker = `${process.pid}-${Date.now()}`;
  const stagedPath = resolve(countDir, `resume-pagecount-${marker}.docx`);
  const expectedName = basename(stagedPath, '.docx');
  const script = [
    'on run argv',
    'set docPath to item 1 of argv',
    'set expectedName to item 2 of argv',
    'tell application "Microsoft Word"',
    'open (POSIX file docPath)',
    'delay 1',
    'set targetIndex to 0',
    'repeat with i from 1 to (count of documents)',
    'set n to (get name of document i)',
    'if n is expectedName or n is (expectedName & ".docx") then set targetIndex to i',
    'end repeat',
    'if targetIndex is 0 then error "Opened document not found: " & expectedName',
    // Word's AppleScript parser accepts the documented WdStatistic page value (2),
    // but rejects the named `statistic pages` constant.
    'set pageCount to compute statistics document targetIndex statistic 2',
    'close document targetIndex saving no',
    'return pageCount as text',
    'end tell',
    'end run',
  ];
  const args = script.flatMap((line) => ['-e', line]).concat(['--', stagedPath, expectedName]);
  const runScript = options.runScript ?? runOsaScript;
  try {
    // The container copy is byte-for-byte identical to the draft, so its Word page
    // count applies to the draft without granting Word access to the draft location.
    copyFileSync(resolve(docxPath), stagedPath);
    const stdout = runScript(args);
    const pages = Number(String(stdout).trim());
    if (!Number.isInteger(pages) || pages < 1) throw new Error(`invalid Word page count: ${String(stdout).trim()}`);
    return { status: 'PASS', pages };
  } catch (error) {
    return { status: 'NOT RUN', reason: String(error.message).replace(/\s+/g, ' ').trim() };
  } finally {
    try {
      for (const entry of readdirSync(countDir)) {
        if (!entry.includes(marker)) continue;
        try {
          rmSync(resolve(countDir, entry), { force: true });
        } catch {
          // Best-effort cleanup must never mask the page-count result or error.
        }
      }
    } catch {
      // Best-effort cleanup must never mask the page-count result or error.
    }
  }
}
