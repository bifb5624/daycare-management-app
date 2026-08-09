# つむぎ — AIエージェント向け開発ガイド (AGENTS.md)

通所介護(デイサービス)の管理アプリ。React 単一ページ(src/App.jsx 約4.4万行)+ Supabase。
本番: https://tsumugi.ones-style.co.jp (Vercel / stable-rebuild ブランチが本番)。

## 最重要ルール

1. **本番データは介護事業の実データ。データ消失は実害になる。** 疑わしい変更はしない。
2. **同期まわり(pull/push/マージ/墓石)に触る変更は、必ず次のシナリオを机上で確認してから**:
   店舗切替直後 / 放置端末のスリープ復帰 / 複数端末の同時編集 / 起動直後の空ローカル状態。
   2026-08-07 に店舗切替時の墓石(削除記録)混入で1店舗の利用者47名が全端末から消える事故が起きた。
3. **stable-rebuild への直接 push は Claude Code(実装担当)のみ。** 他のエージェントは
   ブランチを切って PR を作ること。マージ判断は人間(運営)が行う。
4. 利用者の個人情報(実名・記録)をコード・コミット・ログに含めない。`restore/` は
   復旧作業用の個人情報フォルダで .gitignore 済み(触らない)。
5. 修正・変更は変更管理台帳(api/changelog.js)と public/update-notes.json に記録する運用。

## アーキテクチャ要点

- **データ**: Supabase `app_state` テーブルに店舗ごと1行(key=`store_<名>`、data=巨大JSONB、
  version=楽観ロックCAS)。提供記録のみ `ticket_records` テーブル(store_id列+deleted_at)に分離。
  20分ごとのスナップショットが `app_state_snapshots`(pg_cron・7日保持)。
- **同期**: 4秒ポーリング+Realtime。pull は App.jsx の checkAndPull(~16900行台)、
  push は src/lib/supabase.js の supabaseMergeAndSyncStateForStore(CAS+項目単位マージ)。
- **項目単位保護(_fieldTs)**: フィールドごとの更新時刻で新しい方が勝つ。書き戻しSQL等では
  _fieldTs に現在時刻(ms)を刻まないと端末の古いデータに巻き戻される。
- **削除=墓石(deletedIds)**: id→削除時刻(ms) のマップ。端末とクラウドで和集合。
  `_store` キーは出所店舗タグ(文字列)— idマップではないのでキー巡回では必ずスキップ。
  他店タグの墓石一式は validateTombStore が読み捨てる。
- **店舗分離**: 端末メモリ上のデータには `_sbStoreId`(最後にpullした店舗)が刻まれる。
  pull の持ち越し系処理と push 入口は `_sbStoreId === storeId` を必ず確認(混入防止)。
- **利用者IDは店舗内でのみ一意**(1,2,3…)。店舗をまたぐ処理では必ず store_id で絞る。
  patient_id だけで外部テーブルを検索してはならない(family_accounts 等)。

## 検証方法

- ローカルに node が無い環境で編集されることがある。最低限、編集ブロックの括弧バランスを
  確認する(過去の運用: python で抽出+検査)。node があれば `npm run build` が最良。
- テストは src/lib/logic.test.js のみ。同期ロジックの変更は手動シナリオ確認が中心。

## ディレクトリ

- src/App.jsx — アプリ本体(巨大。行番号はコミットごとにずれる。関数名・コメントで検索する)
- src/lib/supabase.js — 同期・CAS・マージ・墓石検証・アムネスティ
- src/lib/syncOps.js — ticket_records テーブル同期(操作ログ方式)
- api/changelog.js — 変更管理台帳(Basic認証Webページ)
- api/runbook.js — 復旧手順書(運営用・症状検索/R-xxコード)
- docs/incident-recovery-runbook.md — 復旧手順書(技術詳細版)
- public/update-notes.json — アプリ内「更新内容」お知らせ(先頭に追記)

## エージェント間の役割分担(運用)

- **Codex(ChatGPT)**: 調査・監査・レビュー担当。読み取り中心。修正提案はブランチ+PR。
- **Claude Code**: 実装・デプロイ・復旧担当。stable-rebuild への push はこちらのみ。
- 双方、同じファイルを同時に変更しない。調査結果は Markdown で docs/reviews/ に置くか
  運営者経由でもう一方に渡す。
