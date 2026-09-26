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
        question_header = False
        priority_order = -1
        for number, line in prose_lines(text):
            if re.search(r"\{len\([^{}\n]*\)\}", INLINE_CODE.sub("", line)):
                issue("unrendered_count", path, number, "Reader text contains an unevaluated count")
            cells = table_cells(line)
            separator = bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)
            if separator and previous and width is None:
                width = len(previous)
                priority_order = -1
                totals["tables"] += 1
                question_header |= bool(re.search(r"\bQ-ID\b|题号", previous[0], re.I))
            if cells and width is not None:
                if len(cells) != width:
                    issue("table_columns", path, number, f"Expected {width} cells; found {len(cells)}")
                question_cell = cells[0]
            else:
                width = None
                task = re.match(r"^\s*[-*+] (?:\[[ xX]\] )?(.+)$", line)
                question_cell = task.group(1) if task else ""
                question_header |= bool(task and re.match(r"Q(?:[-_\d]|\b)", question_cell, re.I))
                if re.match(r"^ {0,3}#{1,6}\s", line):
                    priority_order = -1
            question = re.match(r"^[*_`]*Q-?(\d+)\b", question_cell, re.I)
            if question:
                identifier = f"Q{int(question.group(1))}"
                totals["question_ids"] += 1
                if identifier in question_ids:
                    issue("duplicate_question_id", path, number,
                          f"{identifier}; first at line {question_ids[identifier]}")
                question_ids[identifier] = number
                priority = re.search(r"/\s*(优先|接着|有余力)(?:准备|再看)?\s*(?:[:：/]|$)", question_cell)
                if priority:
                    rank = ("优先", "接着", "有余力").index(priority.group(1))
                    if rank < priority_order:
                        issue("preparation_order", path, number,
                              f"{identifier}: {priority.group(1)} appears after a lower-priority question")
                    priority_order = max(priority_order, rank)
            elif re.match(r"^[*_`]*Q(?:[-_\d]|\b)", question_cell, re.I) and not separator:
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
        if question_header and not question_ids:
            issue("no_question_ids", path, 0, "Question table found but no question IDs recognized")
    if not paths:
        issue("usage", "", 0, "Usage: check_prep.py PREP.md [EXTRA_READER_DOC.md ...] or --self-test")
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
                         "missing_source_anchor", "duplicate_question_id", "table_columns", "unrendered_count"}, result
        assert sum(item["code"] == "temporary_path" for item in result["issues"]) == 5
        assert check([good, bad])["status"] == "FAIL"
        assert check([folder / "missing.md"])["issues"][0]["code"] == "document_unreadable"
        probe = folder / "question-ids.md"
        probe.write_text('| Q-ID | Question |\n| --- | --- |\n| Q-001 | first |\n| Q002 | second |\n')
        assert check([probe])["status"] == "PASS"
        assert check([probe])["checks"]["question_ids"] == 2
        probe.write_text(probe.read_text().replace('Q002', 'Q001'))
        assert any(i['code'] == 'duplicate_question_id' for i in check([probe])['issues'])
        probe.write_text('| Q-ID | Question |\n| --- | --- |\n| Q_001 | malformed |\n')
        assert {i['code'] for i in check([probe])['issues']} == {'unrecognized_question_id', 'no_question_ids'}
        probe.write_text('| Q-ID | Question |\n| --- | --- |\n')
        assert check([probe])['issues'][0]['code'] == 'no_question_ids'
        probe.write_text('# Acceptance\nNo question table in this auxiliary document.\n')
        assert check([probe])['status'] == 'PASS'
        header = '| Q-ID / 顺序 / 理由 | Question |\n| --- | --- |\n'
        rows = ['| Q020 / 优先：本轮要求 | first |\n',
                '| Q003 / 接着准备：相关 | second |\n',
                '| Q002 / 有余力再看：补充 | third |\n']
        probe.write_text(header + ''.join(rows))
        assert check([probe])['status'] == 'PASS'  # IDs are stable, not ranks.
        probe.write_text(header + rows[0] + rows[2] + rows[1])
        assert [i['code'] for i in check([probe])['issues']] == ['preparation_order']
        probe.write_text(header + rows[2] + rows[0] + rows[1])
        assert len(check([probe])['issues']) == 2
        probe.write_text(header + rows[2] + '\n## Next round\n' + header + rows[0])
        assert check([probe])['status'] == 'PASS'  # Each round/table has its own order.
        probe.write_text('### Coding\n- [ ] Q002 / 优先准备：first\n\n  Details.\n\n'
                         '- [x] Q001 / 接着准备：second\n\n### BQ\n- [X] Q003 / 优先准备：third\n')
        assert check([probe])['status'] == 'PASS'
        assert check([probe])['checks']['question_ids'] == 3
        probe.write_text(probe.read_text() + header + '| Q002 | duplicate in table |\n')
        assert [i['code'] for i in check([probe])['issues']] == ['duplicate_question_id']
        probe.write_text('- [ ] Q001 / 有余力再看：later\n\n- [x] Q002 / 优先准备：earlier\n')
        assert [i['code'] for i in check([probe])['issues']] == ['preparation_order']
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
    return dict(status="PASS", scope="mechanical_self_test", cases="valid links/tables/code and negative checks")


if __name__ == "__main__":
    result = self_test() if sys.argv[1:] == ["--self-test"] else check(sys.argv[1:])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(result["status"] != "PASS")
