#!/usr/bin/env python3
"""Check one saved Ego page before the agent considers another browser action.

No browser/network calls. CLEAR still requires visual/semantic review by the agent.
"""
import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit


def check(path):
    try:
        page = json.loads(Path(path).read_text())
        if not isinstance(page, dict):
            raise ValueError('Capture must be an object')
        for key in ('url', 'title', 'text', 'captured_at'):
            if not isinstance(page.get(key), str):
                raise ValueError(f'Missing string field: {key}')
        url = urlsplit(page['url'])
        if url.scheme not in ('https', 'http') or not url.hostname:
            raise ValueError('Expected actual HTTP(S) page URL')
    except (OSError, ValueError) as error:
        return {'state': 'REVIEW', 'reason': str(error)}

    host = url.hostname.lower()
    title = page['title'].strip()
    lines = [line.strip() for line in page['text'].splitlines() if line.strip()]
    # Only the actual page URL, never links/snippets containing a challenge URL.
    if re.fullmatch(r'(?:www\.)?google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})', host) and url.path.startswith('/sorry/'):
        return {'state': 'HUMAN_HANDOFF', 'reason': 'Google challenge: hand off this browser line; other workers continue'}
    verification = r'(?:Security Verification|安全验证|访问验证|请完成安全验证)'
    if (re.fullmatch(verification, title, re.I)
            or any(re.fullmatch(verification, line, re.I) for line in lines)
            or re.search(r'our systems have detected unusual traffic|verify (?:that )?you are human', page['text'], re.I)):
        return {'state': 'HUMAN_HANDOFF', 'reason': 'Human verification: preserve page and pause only this browser line'}
    if page.get('http_status') in (403, 429):
        return {'state': 'STOP_SOURCE', 'reason': f"Observed HTTP {page['http_status']}"}
    warning = r'(?:403 Forbidden|429 Too Many Requests|Too Many Requests|Access Denied|访问过于频繁|访问警告)'
    if re.fullmatch(r'(?:403|429|' + warning + ')', title, re.I) or any(re.fullmatch(warning, line, re.I) for line in lines):
        return {'state': 'STOP_SOURCE', 'reason': 'Visible access warning'}
    if (host == '1point3acres.com' or host.endswith('.1point3acres.com')) and '提示信息' in title:
        return {'state': 'REVIEW', 'reason': 'BBS prompt: inspect saved message before any further navigation'}
    if ((host == 'xiaohongshu.com' or host.endswith('.xiaohongshu.com'))
            and url.path == '/website-login/error'
            and any(re.fullmatch(r'url is invalid', line, re.I) for line in lines)):
        return {'state': 'REVIEW', 'reason': 'Invalid XHS link: inspect original card href; not proof of a sitewide block'}
    if not page['text'].strip():
        return {'state': 'REVIEW', 'reason': 'No readable text; inspect screenshot/dialog/loading state'}
    return {'state': 'CLEAR', 'reason': 'No known warning detected; agent must review actual page and coverage'}


def self_test():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'page.json'

        def probe(**updates):
            page = dict(url='https://www.google.com/search?q=Example', title='Search',
                        text='LC 429 and 403 appear in a normal result. ref=429', captured_at='2026-09-05T00:00:00Z')
            page.update(updates)
            path.write_text(json.dumps(page))
            before = path.read_bytes()
            result = check(path)
            assert path.read_bytes() == before
            return result['state']

        assert probe() == 'CLEAR'
        assert probe(text='429\n403\n普通题号') == 'CLEAR'
        assert probe(url='https://www.google.com/sorry/index?continue=search') == 'HUMAN_HANDOFF'
        assert probe(http_status=429) == 'STOP_SOURCE'
        assert probe(text='Security Verification\nDrag the slider') == 'HUMAN_HANDOFF'
        assert probe(http_status=403, text='Security Verification\nDrag the slider') == 'HUMAN_HANDOFF'
        assert probe(http_status=403, text='Access Denied') == 'STOP_SOURCE'
        assert probe(url='https://www.1point3acres.com/bbs/search.php', title='提示信息 - 一亩三分地') == 'REVIEW'
        xhs_error = dict(url='https://www.xiaohongshu.com/website-login/error',
                         title='安全限制', text='安全限制\nurl is invalid\n300017\n返回首页')
        assert probe(**xhs_error) == 'REVIEW'
        assert probe(**xhs_error, http_status=403) == 'STOP_SOURCE'
        assert probe(text='A result says url is invalid, code 300017') == 'CLEAR'
        assert probe(text='') == 'REVIEW'
        assert probe(text='x' * 100000 + '\nSecurity Verification') == 'HUMAN_HANDOFF'
        assert probe(text='A search result links to https://www.google.com/sorry/index') == 'CLEAR'
        path.write_text('{}')
        assert check(path)['state'] == 'REVIEW'
        path.write_text('{broken')
        assert check(path)['state'] == 'REVIEW'
    return {'state': 'CLEAR', 'scope': 'offline_self_test', 'cases': 16}


if __name__ == '__main__':
    result = self_test() if sys.argv[1:] == ['--self-test'] else (
        check(sys.argv[1]) if len(sys.argv) == 2 else
        {'state': 'REVIEW', 'reason': 'Usage: check_capture.py CAPTURE.json | --self-test'})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['state'] == 'CLEAR' else 2)
