# -*- coding: utf-8 -*-
"""つむぎ変更管理台帳(api/changelog.js)をObsidianボールトへMarkdownとして書き出す。

使い方: リポジトリ直下で  python3 scripts/export_changelog_obsidian.py
出力先: Googleドライブの「つむぎ アプリ開発」ボールト直下「つむぎ変更管理台帳.md」
台帳を更新(rev/件数/記事追加)するたびに実行して同期する。
"""
import json, re, os, datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, 'api', 'changelog.js')
VAULT = '/Users/masabou/Library/CloudStorage/GoogleDrive-honbu@ones-style.co.jp/マイドライブ/つむぎ アプリ開発/つむぎ アプリ開発'
OUT = os.path.join(VAULT, 'つむぎ変更管理台帳.md')
ARTIFACT_URL = 'https://claude.ai/code/artifact/93519484-4d11-4358-a1b7-f1a4d39540a5'

s = open(SRC, encoding='utf-8').read()
m = re.search(r'const HTML = ("(?:[^"\\]|\\.)*");', s)
html = json.loads(m.group(1))

def strip_tags(t):
    t = re.sub(r'<br\s*/?>', '\n', t)
    t = re.sub(r'<[^>]+>', '', t)
    return t.strip()

# ヘッダ情報
total = re.search(r'id="m-total">(\d+)</b>', html)
rev = re.search(r'rev\. ([a-f0-9]{7})', html)
period = re.search(r'期間 <b[^>]*>([^<]+)</b>', html)
counts = dict(re.findall(r'<div class="k">([^<]+)</div><div class="v tnum">(\d+)</div>', html))

lines = []
lines.append('# つむぎ 変更管理台帳')
lines.append('')
lines.append(f'> 総件数 **{total.group(1) if total else "?"}件**'
             + (f'（{"・".join(f"{k} {v}" for k, v in counts.items())}）' if counts else '')
             + f' / 版 rev. {rev.group(1) if rev else "?"}'
             + (f' / 期間 {strip_tags(period.group(1))}' if period else ''))
lines.append(f'> 書き出し: {datetime.date.today().isoformat()} / [Web版(Artifact)]({ARTIFACT_URL})')
lines.append('')
lines.append('---')
lines.append('')

# 記事
arts = re.findall(r'<article class="row k-(\w+)"(.*?)</article>', html, re.S)
KIND = {'bug': 'バグ修正', 'feat': '機能追加', 'imp': '改善・調整'}
last_date = None
for kind, body in arts:
    crit = 'data-crit="1"' in body.split('>')[0] or re.search(r'data-crit="1"', body[:300])
    date_m = re.search(r'<span class="date tnum">([^<]+)</span>', body)
    area_m = re.search(r'<span class="area">([^<]+)</span>', body)
    title_m = re.search(r'<p class="title">(.*?)</p>', body, re.S)
    date = date_m.group(1) if date_m else ''
    if date != last_date:
        lines.append(f'## {date}')
        lines.append('')
        last_date = date
    tag = KIND.get(kind, kind)
    head = f'### [{tag}]{"[重大]" if crit else ""} {strip_tags(title_m.group(1)) if title_m else "(無題)"}'
    if area_m:
        head += f'（{area_m.group(1)}）'
    lines.append(head)
    # 原因/対応/内容/記録 のペア
    for lb, tx in re.findall(r'<span class="lb">([^<]+)</span><span class="tx">(.*?)</span>(?=<span class="lb">|</div>)', body, re.S):
        txt = strip_tags(tx)
        if lb == '記録':
            txt = ' '.join(re.findall(r'[a-f0-9]{7}', tx)) or txt
            lines.append(f'- **{lb}**: `{txt}`')
        else:
            lines.append(f'- **{lb}**: {txt}')
    lines.append('')

open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print(f'ok: {OUT} ({len(arts)} 記事)')
