#!/usr/bin/env python3
"""Read-only mechanical checks; no semantic, frequency, or search validation."""

import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import unquote, urlsplit


TEMP_PATH = re.compile(r"/(?:private/)?(?:tmp|var/folders)(?=/|$|[\s<>\)\]`\"',;])")
INLINE_CODE = re.compile(r"(`+).*?\1")
ANCHOR = re.compile(r"<a\b[^>]*\b(?:id|name)\s*=\s*['\"](s-[^'\"]+)['\"]", re.I)
BLOCK = re.compile(r"(?:^|\s)\^([A-Za-z0-9-]+)\s*$")
WIKILINK = re.compile(r"\[\[([^\]\n]+)\]\]")
# ponytail: inline Markdown and explicit-path Wikilinks; use a Markdown parser for reference-style links.
# Includes angle destinations and one nested pair.
LINK = re.compile(r"\[[^\]\n]*\]\((<[^>\n]+>|(?:\\.|[^()\n]|\([^()\n]*\))+)\)")


def prose_lines(text):
    """Exclude fenced examples from link, anchor, and table checks."""
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            ticks, suffix = marker.groups()
            if fence is None:
                fence = ticks
                continue
            if ticks[0] == fence[0] and len(ticks) >= len(fence) and not suffix.strip():
                fence = None
                continue
        if fence is None:
            yield number, line


def table_cells(line):
    """Split real separators, preserving escaped pipes and inline code cells."""
    cuts, code = [], None
    for token in re.finditer(r"\\.|`+|\|", line):
        value = token.group()
        if value.startswith("`"):
            if code is None:
                code = value
            elif code == value:
                code = None
        elif value == "|" and code is None:
            cuts.append(token.start())
    if not cuts:
        return None
    parts, start = [], 0
    for end in cuts:
        parts.append(line[start:end].strip())
        start = end + 1
    parts.append(line[start:].strip())
    if not parts[0]:
        parts.pop(0)
    if parts and not parts[-1]:
        parts.pop()
    return parts


def local_links(line):
    line = INLINE_CODE.sub("", line)
    for match in WIKILINK.finditer(line):
        yield match.group(1).replace(r"\|", "|").split("|", 1)[0], True
    for match in LINK.finditer(WIKILINK.sub("", line)):
        yield match.group(1).strip(), False


def check(paths):
    issues, cache, anchor_cache, block_cache = [], {}, {}, {}
    totals = dict(documents=len(paths), local_links=0, source_anchors=0, question_ids=0, tables=0)

    def issue(code, path, line, detail):
        issues.append(dict(code=code, file=str(path), line=line, detail=detail))

    def read(path):
        if path not in cache:
            if not path.is_file():
                raise OSError("Target is missing or is not a file")
            cache[path] = path.read_text(encoding="utf-8")
        return cache[path]

    def anchors(text):
        return [(match.group(1), number) for number, line in prose_lines(text)
                for match in ANCHOR.finditer(INLINE_CODE.sub("", line))]

    def blocks(text):
        return [(match.group(1), number) for number, line in prose_lines(text)
                if (match := BLOCK.search(INLINE_CODE.sub("", line))) and not line.lstrip().startswith("|")]

    for raw_path in paths:
        path = Path(raw_path).expanduser().resolve()
        try:
            text = read(path)
        except (OSError, UnicodeError) as error:
            issue("document_unreadable", path, 0, str(error))
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for _ in range(3):
                decoded = unquote(line)
                if decoded == line:
                    break
                line = decoded
            if TEMP_PATH.search(line):
                issue("temporary_path", path, number, "Reader text contains a temporary path")
        seen = {}
        for anchor, number in anchors(text) + [(a, n) for a, n in blocks(text) if a.startswith("s-")]:
            totals["source_anchors"] += 1
            if anchor in seen:
                issue("duplicate_source_anchor", path, number, f"{anchor}; first at line {seen[anchor]}")
            seen[anchor] = number
        seen_blocks = {}
        for block, number in blocks(text):
            if block in seen_blocks and not block.startswith("s-"):
                issue("duplicate_block_id", path, number, block)
            seen_blocks[block] = number
        previous, width, question_ids = None, None, {}
        priority_order = -1
        heading_seen = False
        for number, line in prose_lines(text):
            if re.search(r"\{len\([^{}\n]*\)\}", INLINE_CODE.sub("", line)):
                issue("unrendered_count", path, number, "Reader text contains an unevaluated count")
            cells = table_cells(line)
            separator = bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)
            if separator and previous and width is None:
                width = len(previous)
                totals["tables"] += 1
            # Preparation questions are checkbox tasks only; tables never carry Q-IDs.
            question_cell = ""
            if cells and width is not None:
                if len(cells) != width:
                    issue("table_columns", path, number, f"Expected {width} cells; found {len(cells)}")
            else:
                width = None
                task = re.match(r"^\s*[-*+] \[[ xX]\] (.+)$", line)
                question_cell = task.group(1) if task else ""
                if re.match(r"^ {0,3}#{1,6}\s", line):
                    heading_seen = True
            question = re.match(r"^[*_`]*Q-?(\d+)\b", question_cell, re.I)
            if question:
                identifier = f"Q{int(question.group(1))}"
                totals["question_ids"] += 1
                if identifier in question_ids:
                    issue("duplicate_question_id", path, number,
                          f"{identifier}; first at line {question_ids[identifier]}")
                question_ids[identifier] = number
                block = BLOCK.search(INLINE_CODE.sub("", line))
                if not block:
                    issue("missing_task_block_id", path, number, f"{identifier}: task line has no ^q block ID")
                elif not re.fullmatch(rf"q0*{int(question.group(1))}", block.group(1), re.I):
                    issue("task_block_mismatch", path, number, f"{identifier}: block ^{block.group(1)}")
                priority =re.search(r"/\s*(优先|接着|有余力)(?:准备|再看)?\s*(?:[:：/]|$)", question_cell)
                if priority:
                    rank = ("优先", "接着", "有余力").index(priority.group(1))
                    # Round-group headings share their chapter's order: a heading opens a new
                    # scope only when the next ranked task restarts at 1 or carries no number.
                    sequence = re.search(r"/\s*(?:优先|接着|有余力)(?:准备|再看)?\s*[:：]\s*(\d+)\s*·", question_cell)
                    if heading_seen and (not sequence or int(sequence.group(1)) == 1):
                        priority_order = -1
                    heading_seen = False
                    if rank < priority_order:
                        issue("preparation_order", path, number,
                              f"{identifier}: {priority.group(1)} appears after a lower-priority question")
                    priority_order = max(priority_order, rank)
            elif re.match(r"^[*_`]*Q(?:[-_\d]|\b)", question_cell, re.I):
                issue("unrecognized_question_id", path, number, question_cell)
            previous = cells
            for destination, wiki in local_links(line):
                if destination.startswith("<"):
                    destination = destination[1:-1]
                else:
                    destination = re.sub(r"\s+([\"']).*\1$", "", destination)
                destination = re.sub(r"\\([\\()\[\] <>])", r"\1", destination)
                raw_target, _, fragment = destination.partition("#")
                target_name = re.sub(r":\d+(?::\d+)?$", "", unquote(raw_target))
                fragment = unquote(fragment)
                if target_name.startswith("file:"):
                    target_name = urlsplit(target_name).path
                elif re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target_name) or target_name.startswith("//"):
                    continue
                target = (path.parent / target_name).resolve() if target_name else path
                if wiki and target_name:
                    vault = next((p for p in path.parents if (p / ".obsidian").is_dir()), path.parent)
                    target = (vault / target_name).resolve()
                    if not target.is_file() and not target_name.endswith(".md"):
                        target = Path(str(target) + ".md")
                if target_name:
                    totals["local_links"] += 1
                    if not target.is_file():
                        issue("local_link_not_file", path, number, str(target))
                        continue
                if fragment.startswith("^") or (wiki and fragment):
                    try:
                        if target not in block_cache:
                            target_text = read(target)
                            block_cache[target] = ({a for a, _ in blocks(target_text)},
                                {m.group(1).strip() for _, l in prose_lines(target_text)
                                 if (m := re.match(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", l))})
                        target_blocks, target_headings = block_cache[target]
                    except (OSError, UnicodeError) as error:
                        issue("fragment_target_unreadable", path, number, str(error))
                        continue
                    if fragment.startswith("^"):
                        if fragment[1:] not in target_blocks:
                            issue("missing_block_id", path, number, f"{target}#{fragment}")
                    elif fragment not in target_headings:
                        issue("missing_heading", path, number, f"{target}#{fragment}")
                    continue
                if fragment.lower().startswith("s-"):
                    try:
                        if target not in anchor_cache:
                            target_text = read(target)
                            target_anchors = {value for value, _ in anchors(target_text)}
                            # A source-prefixed heading fragment can be a normal Markdown link.
                            for _, heading_line in prose_lines(target_text):
                                heading = re.match(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", heading_line)
                                if heading:
                                    slug = re.sub(r"[^\w\s-]", "", heading.group(1).lower())
                                    target_anchors.add(re.sub(r"\s", "-", slug))
                            anchor_cache[target] = target_anchors
                        target_anchors = anchor_cache[target]
                    except (OSError, UnicodeError) as error:
                        issue("source_target_unreadable", path, number, str(error))
                        continue
                    if fragment not in target_anchors:
                        issue("missing_source_anchor", path, number, f"{target}#{fragment}")
    if not paths:
        issue("usage", "", 0, "Usage: check_prep.py PREP.md EVIDENCE.md [EXTRA_READER_DOC.md ...] or --self-test")
    return dict(status="FAIL" if issues else "PASS", scope="mechanical_only", checks=totals,
                not_checked=["claim accuracy", "question coverage", "frequency correctness", "search completion"],
                issues=issues)


def self_test():
    with tempfile.TemporaryDirectory(prefix="check-prep-") as directory:
        folder = Path(directory)
        (folder / "evidence folder").mkdir()
        (folder / "evidence folder/raw data.md").write_text('<a id="s-remote"></a>\n')
        (folder / "hash#name.md").write_text("Evidence\n")
        good = folder / "good.md"
        good.write_text('''<a id="s-one"></a>
[source](#s-one)
[angle](<evidence folder/raw data.md:4#s-remote>)
[encoded](evidence%20folder/raw%20data.md:12:3#s-remote)
[hash filename](hash%23name.md)
## S-heading — More
[heading](#s-heading--more)
| ID | Value |
| --- | --- |
| **Q001** | `left|right` |
| Q002 | escaped \\| pipe |
Q001 is also mentioned in prose; Q001 again.
`<a id="s-one"></a>` and `[example](missing.md)` are inline examples.
```markdown
<a id="s-one"></a>
[example](missing.md)
| Q001 | extra | cells |
```
''')
        assert not check([good])["issues"], check([good])
        bad = folder / "bad.md"
        bad.write_text('''/tmp/raw.txt
Candidates: {len(people)}
/private/tmp/raw.txt
%2Fvar%2Ffolders%2Fa%2Fraw.txt
%252Fprivate%252Fvar%252Ffolders%252Fa
<a id="s-dup"></a><a id="s-dup"></a>
[missing](absent.md)
[directory](evidence%20folder)
[anchor](#s-absent)
[remote anchor](<evidence folder/raw data.md#s-absent>)
| ID | Value |
| --- | --- |
| Q001 | first |
| Q001 | second | extra |
```
/tmp/inside-code-is-still-a-reader-path
```
''')
        result = check([bad])
        codes = {item["code"] for item in result["issues"]}
        assert codes == {"temporary_path", "duplicate_source_anchor", "local_link_not_file",
                         "missing_source_anchor", "table_columns", "unrendered_count"}, result
        assert sum(item["code"] == "temporary_path" for item in result["issues"]) == 5
        assert check([good, bad])["status"] == "FAIL"
        assert check([folder / "missing.md"])["issues"][0]["code"] == "document_unreadable"
        probe = folder / "question-ids.md"

        def codes_of(text):
            probe.write_text(text)
            return [i['code'] for i in check([probe])['issues']]

        task = '- [ ] {} / {}：{} · item ^{}\n\n'
        first, second, third = (task.format('Q020', '优先准备', 1, 'q020'),
                                task.format('Q003', '接着准备', 2, 'q003'),
                                task.format('Q002', '有余力再看', 3, 'q002'))
        assert codes_of(first + second + third) == []  # IDs are stable, not ranks.
        probe.write_text(first + second + third)
        assert check([probe])['checks']['question_ids'] == 3
        assert codes_of(first + third + second) == ['preparation_order']
        assert codes_of(third + first + second) == ['preparation_order', 'preparation_order']
        # Round-group headings continue the chapter's numbering, so an inversion across them fails.
        assert codes_of('## Coding\n\n### Group A\n\n' + task.format('Q002', '有余力再看', 1, 'q002')
                        + '### Group B\n\n' + task.format('Q020', '优先准备', 2, 'q020')) == ['preparation_order']
        # A new chapter restarts numbering at 1 and gets its own order.
        restart = task.format('Q030', '优先准备', 1, 'q030')
        assert codes_of('## Coding\n\n' + third + '## BQ\n\n' + restart) == []
        assert codes_of('- [x] Q-001 / 优先准备：1 · a ^q001\n\n- [X] Q1 / 接着准备：2 · b ^q1\n') == [
            'duplicate_question_id']
        assert codes_of('- [ ] Q_001 / 优先准备：1 · malformed ^q001\n') == ['unrecognized_question_id']
        assert codes_of('- [ ] Q004 / 优先准备：1 · no block\n') == ['missing_task_block_id']
        assert codes_of('- [ ] Q004 / 优先准备：1 · wrong block ^q040\n') == ['task_block_mismatch']
        # Tables and plain index bullets are not preparation tasks.
        assert codes_of('| Q-ID | Question |\n| --- | --- |\n| Q001 | a |\n| Q001 | b |\n\n'
                        '- Q001 → Q002 merged ^m001\n- Q001 again\n') == []
        assert codes_of('# Acceptance\nNo questions in this auxiliary document.\n') == []
        (folder / '.obsidian').mkdir()
        other = folder / 'evidence folder/source.md'
        other.write_text('## 来源详情\n\nSource. ^s-one\n\n[[question-ids#^q001|返回题目]]\n')
        probe.write_text('- [x] Q001 / 优先准备：first ^q001\n\n'
                         '[[evidence folder/source#^s-one|来源]]\n'
                         '[[evidence folder/source#来源详情]]\n'
                         '[block](evidence%20folder/source.md#^s-one)\n'
                         '| 来源 | 内容 |\n| --- | --- |\n'
                         '| [[evidence folder/source#^s-one\\|来源]] | valid |\n')
        assert check([probe, other])['status'] == 'PASS', check([probe, other])
        probe.write_text(probe.read_text() + '\n[[evidence folder/source#^absent]]\n'
                         '[[absent note]]\n[[evidence folder/source#Absent heading]]\n'
                         'Duplicate. ^q001\n')
        assert {i['code'] for i in check([probe])['issues']} == {
            'missing_block_id', 'local_link_not_file', 'missing_heading', 'duplicate_block_id'}
    return dict(status="PASS", scope="mechanical_self_test", cases="valid links/tables/tasks/code and negative checks")


if __name__ == "__main__":
    result = self_test() if sys.argv[1:] == ["--self-test"] else check(sys.argv[1:])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(result["status"] != "PASS")
