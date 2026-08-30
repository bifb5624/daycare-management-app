#!/bin/bash
# つむぎのObsidianノート(台帳/開発ガードレール/未来の修正点)をNotebookLMへ同期する。
# 非公式CLI notebooklm-py を使用(uv tool install "notebooklm-py[browser]" 済み)。
#
# 初回のみ(手動):
#   notebooklm login                      # ブラウザが開くのでGoogleにログイン
#   notebooklm create "つむぎ開発"          # 専用ノートブックを作成
#   notebooklm use <表示されたID>           # 既定のノートブックに設定
# 以後の同期: bash scripts/sync_notebooklm.sh
# 仕組み: 同名ソースを delete-by-title で消してから add し直す(=常に最新版に置き換え)
set -u
export PATH="$HOME/.local/bin:$PATH"
CFG="$(cd "$(dirname "$0")" && pwd)/obsidian_sync.json"
VAULT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['vault'])" "$CFG")
NB_TITLE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['notebook_title'])" "$CFG")

if ! notebooklm list >/dev/null 2>&1; then
  echo "★ NotebookLMに未ログインです。先に notebooklm login を実行してください(初回のみ)。"
  exit 1
fi

# ★ 「現在選択中のノートブック」に依存せず、設定のノートブック名からIDを解決して明示指定する
#   (2026-08-30: 調査用ノートブックをuse中に実行すると3ノートがそちらへ入る事故があった)
NB_ID=$(notebooklm list --json 2>/dev/null | python3 -c "import json,sys; t=sys.argv[1]; d=json.load(sys.stdin); nb=[n for n in (d if isinstance(d,list) else d.get('notebooks',[])) if n.get('title')==t]; print(nb[0]['id'] if nb else '')" "$NB_TITLE")
if [ -z "$NB_ID" ]; then
  echo "★ ノートブック『$NB_TITLE』が見つかりません。notebooklm create \"$NB_TITLE\" で作成してください。"
  exit 1
fi

python3 -c "import json,sys;[print(v) for v in json.load(open(sys.argv[1]))['files'].values()]" "$CFG" | while IFS= read -r f; do
  P="$VAULT/$f"
  if [ ! -f "$P" ]; then echo "スキップ(見つからない): $f  ※改名した場合は scripts/obsidian_sync.json を更新"; continue; fi
  T="${f%.md}"
  notebooklm source delete-by-title "$T" -n "$NB_ID" --yes >/dev/null 2>&1 || true
  notebooklm source delete-by-title "$f" -n "$NB_ID" --yes >/dev/null 2>&1 || true
  if notebooklm source add "$P" -n "$NB_ID" >/dev/null 2>&1; then
    echo "同期OK: $f -> $NB_TITLE"
  else
    echo "★同期失敗: $f (notebooklm source add \"$P\" -n $NB_ID を手動確認)"
  fi
done
