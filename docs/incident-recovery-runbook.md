# つむぎ データ消失時の復旧手順書(ランブック)

2026-08-07 の南水元データ消失事故(墓石混入による利用者47名消失)の復旧実績に基づく手順書。
**上から順に実施する。** 慌てて手順を飛ばさないこと。

---

## 0. 鉄則(最初に読む)

1. **Supabase「Scheduled backups」の各行にある Restore ボタンは絶対に押さない。**
   本番データベース全体がその時点に巻き戻り、バックアップ以降の全店の入力が消える。
   (2026-08-07 に誤って実行。事故後時点のバックアップだったため実害は小さかったが、本来は大事故になる)
2. 復旧は必ず「**別の場所に取り出して → 欠けている部分だけをSQLで書き戻す**」方式で行う。
3. 各ステップで実行するSQLは、**書き込みを伴うものは必ず直前に退避テーブルを作ってから**実行する。
4. 端末の操作は最小限に。異常に気づいたら**そのまま触らず**に状況確認から始める(端末の自動同期が状況を悪化させることがある)。

---

## 1. 状況の確定(読み取りのみ・本番SQL Editorで実行)

全店の被害範囲を一度に把握する:

```sql
select key,
  jsonb_array_length(coalesce(data->'systemSettings'->'exerciseItems','[]'::jsonb)) as 運動項目数,
  jsonb_array_length(coalesce(data->'systemSettings'->'exerciseItemsHistory','[]'::jsonb)) as 履歴件数,
  jsonb_array_length(coalesce(data->'patients','[]'::jsonb)) as 利用者数,
  (select count(*) from jsonb_array_elements(coalesce(data->'patients','[]'::jsonb)) p
     where p->'plannedExercises' is not null and p->'plannedExercises' <> '{}'::jsonb) as 基準値あり,
  (select count(*) from jsonb_object_keys(coalesce(data->'deletedIds'->'patients','{}'::jsonb))) as 利用者墓石
from app_state where key like 'store_%' order by key;
```

判定の目安:
- **利用者数が急減 + 利用者墓石が急増** → 墓石混入/削除事故(→ 5章)
- **運動項目数 0 または既定リスト(u1〜)に戻っている** → 項目リスト消失。基準値・過去記録は
  大抵**消えていない**(項目IDに紐づく表示先が消えただけ)。履歴から復元できる(→ 4章)
- **基準値あり が急減** → 利用者データの部分消失(→ 6章)

## 2. 保全(必ず最初にやる)

```sql
-- 現時点の全キーを退避(テーブル名は日付で変える)
create table if not exists app_state_rescue_YYYYMMDD as select * from app_state;
select count(*), now() from app_state_rescue_YYYYMMDD;
```

20分おきスナップショットが動いているか確認:

```sql
select key, version, taken_at from app_state_snapshots order by taken_at desc limit 15;
```

動いていなければ再設定(pg_cron):

```sql
create table if not exists app_state_snapshots (id bigserial primary key, key text not null, version bigint, data jsonb not null, taken_at timestamptz not null default now());
create index if not exists idx_snap_key_time on app_state_snapshots(key, taken_at desc);
create extension if not exists pg_cron;
select cron.schedule('tsumugi-snapshot-20min','*/20 * * * *', $$insert into app_state_snapshots(key,version,data) select a.key,a.version,a.data from app_state a where not exists (select 1 from app_state_snapshots s where s.key=a.key and s.version=a.version);$$);
select cron.schedule('tsumugi-snapshot-cleanup','10 18 * * *', $$delete from app_state_snapshots where taken_at < now() - interval '7 days';$$);
```

## 3. 復旧素材の入手(2経路)

### 3-A. 20分スナップショット(直近7日以内の事故はまずこちら)

`app_state_snapshots` に20分ごと・version変化時のみ・7日分が残っている。

```sql
-- 1) 戻したい時点を探す(事故発生「直前」のものを選ぶ)
select id, version, taken_at, jsonb_array_length(coalesce(data->'patients','[]'::jsonb)) as 利用者数
from app_state_snapshots where key = 'store_XXXX' order by taken_at desc limit 30;

-- 2) 中身を確認してから(例: 利用者数・設定の項目数)
select jsonb_array_length(data->'patients') as 利用者数,
       jsonb_array_length(data->'systemSettings'->'exerciseItems') as 運動項目数
from app_state_snapshots where id = <ID>;

-- 3) 必要なフィールド「だけ」書き戻す(例: patients)。丸ごと戻すのは最終手段。
update app_state a
set data = jsonb_set(a.data, '{patients}', s.data->'patients'),
    version = coalesce(a.version,0) + 1
from app_state_snapshots s
where s.id = <ID> and a.key = s.key;
```

### 3-B. 日次バックアップ(7日より前・またはスナップショットが無い場合)

1. Supabase → Database → Backups → **「Restore to new project」タブ**(BETA)を開く
2. 事故**前**の時刻のバックアップ(19:05 UTC = JST翌朝4:05 が日次)の Restore を押す
   → **新しいプロジェクト**が作られる(本番には影響しない)。名前は `tsumugi-restore-日付` 等
3. 新プロジェクトの SQL Editor で `select key, version, data::text as data from app_state order by key;`
   → **Export → Download CSV**
4. CSV を `Googleドライブ > Claude > restore/` に置き、Claude に解析を依頼
   (`restore/extract_tool.py` は .sql/.sql.gz 形式用。CSVはそのまま渡せばよい)
5. 抽出が終わったら新プロジェクトは**削除**(課金停止)

## 4. 「運動項目・基準値・整体が全部消えた」への対処(表示問題の可能性大)

基準値・過去記録は店舗独自の項目ID(`ex_<数字>`)に紐づいて保存されている。
項目リスト(exerciseItems)が既定(`u1`〜)に置き換わると、**データは残っているのに全部消えたように見える。**

```sql
-- 履歴の最新リストが基準値のキーをカバーしているか判定
with latest as (
  select a.key,
         (select h from jsonb_array_elements(a.data->'systemSettings'->'exerciseItemsHistory') h
           where jsonb_array_length(h->'items') > 0
           order by coalesce(h->>'effectiveTo','') desc limit 1) as h
  from app_state a where a.key like 'store_%'
),
bk as (
  select a.key, k as bkey from app_state a,
       jsonb_array_elements(coalesce(a.data->'patients','[]'::jsonb)) p,
       jsonb_object_keys(coalesce(p->'plannedExercises','{}'::jsonb)) k
  where a.key like 'store_%' and k like 'ex\_%' and coalesce(p->'plannedExercises'->>k,'') <> ''
)
select l.key, l.h->>'effectiveTo' as 履歴最新, jsonb_array_length(l.h->'items') as 履歴項目数,
  (select count(distinct b.bkey) from bk b where b.key=l.key) as 基準値exキー数,
  (select count(distinct b.bkey) from bk b where b.key=l.key
     and not exists (select 1 from jsonb_array_elements(l.h->'items') i where i->>'id'=b.bkey)) as 履歴に無いキー数
from latest l order by l.key;
```

「履歴に無いキー数 = 0」なら、履歴からの書き戻しで完全復旧できる(店舗ごとに実行):

```sql
update app_state a set
  data = jsonb_set(a.data, '{systemSettings}',
    (a.data->'systemSettings') || jsonb_build_object(
      'exerciseItems',
        (select h->'items' from jsonb_array_elements(a.data->'systemSettings'->'exerciseItemsHistory') h
          where jsonb_array_length(h->'items') > 0
          order by coalesce(h->>'effectiveTo','') desc limit 1),
      '_updatedAt', (extract(epoch from now())*1000)::bigint,
      '_fieldTs', coalesce(a.data->'systemSettings'->'_fieldTs','{}'::jsonb)
        || jsonb_build_object('exerciseItems', (extract(epoch from now())*1000)::bigint)
    )),
  version = coalesce(version,0) + 1
where a.key = 'store_XXXX';
```

ポイント: **`_fieldTs` に現在時刻(ミリ秒)を刻む**こと。これが無いと端末側の古いデータとの
マージで巻き戻される(項目単位マージは時刻の新しい方が勝つ仕様)。

## 5. 「利用者が消えた・墓石が増えた」への対処

同期の削除は墓石(`deletedIds`)方式: **端末とクラウドの墓石は常に和集合**され、墓石にあるIDの
利用者・記録は復活できない。つまり**クラウドの墓石を消すだけでは、端末に残った墓石で再削除される。**

対処手順:
1. 墓石の中身と時刻を確認:
   ```sql
   select k as 種類, count(*) from app_state, jsonb_object_keys(data->'deletedIds') k
   -- 件数の内訳は: select jsonb_object_keys(data->'deletedIds'->'patients') ... 等で個別に
   where key='store_XXXX' group by k;
   ```
2. 正当な削除でない(混入・誤操作)なら、**コード側に「アムネスティ」を追加**する:
   `src/lib/supabase.js` の `scrubAmnestyTombstones` に対象店舗とカットオフ時刻を設定し、
   デプロイ → 全端末「今すぐ更新」。カットオフより古い墓石が pull/push/seed の3経路で無効化される。
3. その後、バックアップ/スナップショットから利用者を書き戻す(`restore/minamimizumoto_restore.sql` が実例)。
   書き戻しSQLの要点: patients 配列の各利用者に `_savedAt`=現在ms と保護フィールドの `_fieldTs` を刻印、
   `deletedIds` を空に、`patientIdSeq` は `greatest(現在値, バックアップ値)` で維持、`version+1`。
4. 提供記録は `ticket_records` テーブル(別管理・deleted_at方式)にあるため、利用者が戻れば表示も戻る。

## 6. 「一部の利用者の基準値だけ消えた」への対処

バックアップ(3-A/3-B)から `plannedExercises` を**空のところだけ**埋める合成SQLを作る
(Claude に依頼: 「バックアップCSVから基準値合成SQLを作って。既存の非空データは上書きしない条件で」)。

## 7. 復旧後のチェックリスト

- [ ] 対象店舗の端末で「今すぐ更新」→ 利用者数・基準値・過去記録の表示を確認
- [ ] 全店サマリSQL(1章)を再実行して他店に異常が無いか確認
- [ ] 20分スナップショットが動いているか確認(2章)
- [ ] 変更管理台帳に記録(修正内容・原因・commit hash)
- [ ] 復旧用の新プロジェクトを削除したか
- [ ] `restore/` の個人情報ファイルは Git管理外(.gitignore済み)のまま残す/不要なら削除

## 8. 2026-08-07 事故の記録(参考)

- 原因: 店舗切替/放置復帰端末の pull 時に、前の店舗(試作店)の墓石193個が南水元の墓石に和集合され、
  ID範囲が重なる南水元の利用者47名(id31〜77)が全端末で削除された。
  pull の墓石和集合だけ「前のデータが同じ店舗か」の確認が漏れていたのが根本原因(164d140以降で修正済み)。
- 対策(すべて実装済み):
  1. pull墓石和集合に店舗一致ガード(`prev._sbStoreId === newStoreId`)
  2. push入口に店舗不一致ブロック(`supabaseMergeAndSyncStateForStore` 冒頭)
  3. 墓石アムネスティ(`scrubAmnestyTombstones`・南水元/カットオフ 2026-08-07T05:00Z)
  4. 20分スナップショット(app_state_snapshots・7日保持)
- 復旧: 8/6 19:05 バックアップ → Restore to new project → CSV → 47名書き戻し(墓石解除込み)。
  運動項目は exerciseItemsHistory から書き戻し(扇橋)。
