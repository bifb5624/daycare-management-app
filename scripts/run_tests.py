# -*- coding: utf-8 -*-
# つむぎ 自動テストランナー(2026-09-01)。 毎デプロイの締めで実行する。
# 対象: テスト項目一覧の【自動】項目(T-OPS-02/03/04, T-SEC-02, T-EXT-01の生存部分, T-SYNC-07の静的部分)
# 使い方: python3 scripts/run_tests.py [--deployed <rev>]
#   --deployed を渡すと本番の update-notes.json version が一致するかも確認する(デプロイ後チェック)
import json, re, subprocess, sys, urllib.request

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
PROD = 'https://tsumugi-ones-style.vercel.app'
results = []

def check(tid, name, ok, detail=''):
    results.append((tid, name, ok, detail))
    print(('PASS' if ok else 'FAIL'), f'[{tid}]', name, ('- ' + detail if detail else ''))

def scan_brackets(src):
    counts = {'(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0}
    i, n = 0, len(src)
    in_s = None; in_lc = False; in_bc = False
    while i < n:
        c = src[i]; c2 = src[i:i+2]
        if in_lc:
            if c == '\n': in_lc = False
        elif in_bc:
            if c2 == '*/': in_bc = False; i += 1
        elif in_s:
            if c == '\\': i += 1
            elif c == in_s: in_s = None
        else:
            if c2 == '//': in_lc = True; i += 1
            elif c2 == '/*': in_bc = True; i += 1
            elif c in ('"', "'", '`'): in_s = c
            elif c in counts: counts[c] += 1
        i += 1
    return {'(': counts['(']-counts[')'], '[': counts['[']-counts[']'], '{': counts['{']-counts['}']}

# ---- T-OPS-03 静的検査: 括弧バランスがHEADと一致(=編集で構文を壊していない) ----
for f in ['src/App.jsx', 'src/lib/supabase.js']:
    head = subprocess.run(['git', 'show', f'HEAD:{f}'], capture_output=True, text=True, cwd=ROOT).stdout
    cur = open(f'{ROOT}/{f}', encoding='utf-8').read()
    check('T-OPS-03', f'括弧バランス {f}', scan_brackets(head) == scan_brackets(cur), str(scan_brackets(cur)))

# ---- T-OPS-03 競合マーカー・debugger残骸 ----
for f in ['src/App.jsx', 'src/lib/supabase.js', 'src/lib/logic.js']:
    try:
        cur = open(f'{ROOT}/{f}', encoding='utf-8').read()
    except FileNotFoundError:
        continue
    bad = [m for m in ['<<<<<<<', '>>>>>>>', '\ndebugger'] if m in cur]
    check('T-OPS-03', f'競合マーカー/debugger無し {f}', not bad, ','.join(bad))

# ---- T-OPS-02 update-notes.json の整合 ----
try:
    d = json.load(open(f'{ROOT}/public/update-notes.json', encoding='utf-8'))
    ids = [n.get('id') for n in d.get('notes', [])]
    ok = bool(d.get('version')) and len(ids) == len(set(ids)) and all(ids)
    pr = d.get('prompt', 'all')
    ok2 = pr in ('all', 'silent') or isinstance(pr, list)
    check('T-OPS-02', 'update-notes.json 妥当性(version/一意id/prompt)', ok and ok2, f"version={d.get('version')} prompt={pr}")
except Exception as e:
    check('T-OPS-02', 'update-notes.json 妥当性', False, str(e))

# ---- T-OPS-02 台帳(api/changelog.js)の整合: HTMLが解析でき件数がヘッダと一致 ----
try:
    s = open(f'{ROOT}/api/changelog.js', encoding='utf-8').read()
    mm = re.search(r'const HTML = ("(?:[^"\\]|\\.)*");', s)
    html = json.loads(mm.group(1))
    total = int(re.search(r'id="m-total">(\d+)</b>', html).group(1))
    arts = html.count('<article')
    kinds = {k: int(v) for k, v in re.findall(r'<div class="k">([^<]+)</div><div class="v tnum">(\d+)</div>', html) if k in ('バグ修正', '機能追加', '改善・調整')}
    check('T-OPS-02', '台帳: 総件数=記事数', total == arts, f'総{total}/記事{arts}')
    check('T-OPS-02', '台帳: 内訳合計=総件数', sum(kinds.values()) == total, f'{kinds}')
except Exception as e:
    check('T-OPS-02', '台帳整合', False, str(e))

# ---- T-SEC-02 実利用者データのコミット禁止(restore/・まるっとLIFEがgit管理外) ----
tracked = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, cwd=ROOT).stdout
bad = [ln for ln in tracked.splitlines() if ln.startswith('restore/') or 'まるっとLIFE' in ln or 'まるっとライフ' in ln]
check('T-SEC-02', '実利用者データがコミットされていない', not bad, ';'.join(bad[:3]))

# ---- T-SYNC-07(静的) id無し行を生む push の簡易検査: 主要配列へのpushにid欠落が無いかの目視対象を列挙 ----
cur = open(f'{ROOT}/src/App.jsx', encoding='utf-8').read()
suspicious = len(re.findall(r'ticketRecords:\s*\[\.\.\.', cur))
check('T-SYNC-07', 'ticketRecords直結合の箇所数が急増していない(目視基準<=20)', suspicious <= 20, f'{suspicious}箇所')

# ---- T-OPS-04 本番生存確認 ----
def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'tsumugi-test'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

try:
    st, body = fetch(f'{PROD}/update-notes.json?_t=1')
    pj = json.loads(body)
    check('T-OPS-04', '本番 update-notes.json 応答', st == 200 and bool(pj.get('version')), f"version={pj.get('version')}")
    deployed = None
    for i, a in enumerate(sys.argv):
        if a == '--deployed' and i+1 < len(sys.argv): deployed = sys.argv[i+1]
    if deployed:
        check('T-OPS-04', '本番versionが期待値と一致(デプロイ完了)', pj.get('version') == deployed, f"本番={pj.get('version')} 期待={deployed}")
except Exception as e:
    check('T-OPS-04', '本番 update-notes.json 応答', False, str(e))

try:
    st, body = fetch(PROD + '/')
    check('T-OPS-04', '本番トップページ応答', st == 200 and b'<div id="root"' in body, f'status={st}')
except Exception as e:
    check('T-OPS-04', '本番トップページ応答', False, str(e))

try:
    st, body = fetch(f'{PROD}/api/changelog')
    check('T-OPS-04', '本番 台帳API応答', st == 200, f'status={st}')
except urllib.error.HTTPError as e:
    # 台帳はBasic認証つき: 401はAPIが生きている正常応答
    check('T-OPS-04', '本番 台帳API応答(認証保護)', e.code == 401, f'status={e.code}')
except Exception as e:
    check('T-OPS-04', '本番 台帳API応答', False, str(e))

# ---- 結果 ----
fails = [r for r in results if not r[2]]
print()
print(f'==== 結果: {len(results)}項目中 PASS {len(results)-len(fails)} / FAIL {len(fails)} ====')
if fails:
    for tid, name, _, detail in fails:
        print(f'  FAIL [{tid}] {name} {detail}')
    sys.exit(1)
sys.exit(0)
