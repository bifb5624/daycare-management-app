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

if ! notebooklm list >/dev/null 2>&1; then
  echo "★ NotebookLMに未ログインです。先に notebooklm login を実行してください(初回のみ)。"
  exit 1
fi

python3 -c "import json,sys;[print(v) for v in json.load(open(sys.argv[1]))['files'].values()]" "$CFG" | while IFS= read -r f; do
  P="$VAULT/$f"
  if [ ! -f "$P" ]; then echo "スキップ(見つからない): $f  ※改名した場合は scripts/obsidian_sync.json を更新"; continue; fi
  T="${f%.md}"
  notebooklm source delete-by-title "$T" --yes >/dev/null 2>&1 || true
  notebooklm source delete-by-title "$f" --yes >/dev/null 2>&1 || true
  if notebooklm source add "$P" >/dev/null 2>&1; then
    echo "同期OK: $f"
  else
    echo "★同期失敗: $f (notebooklm source add \"$P\" を手動確認)"
  fi
done
