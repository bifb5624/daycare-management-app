# つむぎ 提供記録の専用テーブル（一般的なSaaS方式）フェーズ1

**Supabase → SQL Editor に貼り付けて Run**

- 既存のデータ・テーブルには**一切触りません**（新規追加のみ）
- 実行してもアプリの動作は**変わりません**（コード側がまだ使っていないため）
- 何度実行しても安全です

```sql
-- ① 提供記録テーブル（1記録＝1行）
create table if not exists public.ticket_records (
  id          text primary key,          -- tr_<利用者ID>_<年>_<月>_<日>
  store_id    text        not null,
  patient_id  integer,
  rec_date    date,                      -- 実日付（月別集計・請求で使う）
  data        jsonb       not null default '{}'::jsonb,  -- 記録内容
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists ticket_records_store_date_idx
  on public.ticket_records (store_id, rec_date);
create index if not exists ticket_records_store_patient_idx
  on public.ticket_records (store_id, patient_id);

-- ② 変更した項目だけを送って、サーバー側で1行にまとめる
--    data = 既存 || 送られてきた項目  → 触っていない項目は消えない
--    時刻はサーバーの now() のみを使う（端末の時計は一切使わない）
create or replace function public.upsert_ticket_records(p_store_id text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer := 0;
begin
  insert into public.ticket_records (id, store_id, patient_id, rec_date, data, updated_at)
  select r->>'id',
         p_store_id,
         nullif(r->>'patientId','')::integer,
         nullif(r->>'recDate','')::date,
         coalesce(r->'data', '{}'::jsonb),
         now()
  from jsonb_array_elements(p_rows) as r
  where coalesce(r->>'id','') <> ''
  on conflict (id) do update
    set data       = public.ticket_records.data || excluded.data,  -- ★項目単位で統合
        patient_id = coalesce(excluded.patient_id, public.ticket_records.patient_id),
        rec_date   = coalesce(excluded.rec_date,   public.ticket_records.rec_date),
        updated_at = now(),
        deleted_at = null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ③ 削除（墓石。復活しないように行は残す）
create or replace function public.delete_ticket_record(p_store_id text, p_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ticket_records
     set deleted_at = now(), updated_at = now()
   where id = p_id and store_id = p_store_id;
$$;

-- ④ アクセス制御（既存の app_state と同じ水準。書き込みは関数経由のみ）
alter table public.ticket_records enable row level security;
drop policy if exists ticket_records_select on public.ticket_records;
create policy ticket_records_select on public.ticket_records
  for select to anon, authenticated using (true);

grant select on public.ticket_records to anon, authenticated;
grant execute on function public.upsert_ticket_records(text, jsonb) to anon, authenticated;
grant execute on function public.delete_ticket_record(text, text)   to anon, authenticated;

-- ⑤ Realtime（他端末へ即座に反映）
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='ticket_records') then
    alter publication supabase_realtime add table public.ticket_records;
  end if;
end $$;

-- ⑥ 既存データをテーブルへ取り込む（app_state の ticketRecords をそのまま移す）
insert into public.ticket_records (id, store_id, patient_id, rec_date, data, updated_at)
select e->>'id',
       s.key,
       nullif(e->>'patientId','')::integer,
       -- "7月20日" + year から実日付を作る
       case when e->>'year' ~ '^\d{4}$' and e->>'date' ~ '^\d{1,2}月\d{1,2}日$'
            then make_date((e->>'year')::int,
                           (regexp_match(e->>'date','^(\d{1,2})月'))[1]::int,
                           (regexp_match(e->>'date','月(\d{1,2})日'))[1]::int)
            else null end,
       e,
       now()
from public.app_state s,
     lateral jsonb_array_elements(coalesce(s.data->'ticketRecords','[]'::jsonb)) as e
where s.key <> '__tsumugi_global__'
  and coalesce(e->>'id','') <> ''
on conflict (id) do nothing;

-- ⑦ 確認
select store_id as 店舗, count(*) as 記録件数,
       min(rec_date) as 最古, max(rec_date) as 最新
  from public.ticket_records group by store_id;
```

## この設計のポイント

- **1記録＝1行**。「今日の分をください」で必要な行だけ取得できる（数KB）
- **端末の時計を一切使わない**。順序も更新時刻もサーバーの `now()` だけ
- **変更した項目だけ送れば、サーバー側で統合**される（`data || excluded.data`）
  → 別の端末が別の項目を編集しても、お互い消えない
- **確定（compaction）が不要**。足し算が無いので「一瞬空っぽ」が起きない

## 実行後

アプリの動作は変わりません。⑦の件数が既存データと合っていることだけ確認してください。
次にアプリ側を「このテーブルへ書く（読み取りは従来どおり）」に変更し、
問題がないことを確認してから読み取りも切り替えます。
