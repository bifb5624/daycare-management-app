-- =========================================================
-- つむぎ 操作ログ同期 フェーズ1 マイグレーション
--
-- ★ 安全性について
--   ・既存テーブル(app_state / patients 等)には一切触りません
--   ・新しいテーブルと関数を「追加」するだけです
--   ・実行してもアプリの動作は変わりません(コード側がまだ使っていないため)
--   ・何度実行しても安全です(if not exists / or replace)
--
-- 実行方法: Supabase ダッシュボード → SQL Editor → 貼り付けて Run
-- =========================================================

-- ---------------------------------------------------------
-- ① 操作ログ本体
--    revision は bigserial。Postgres が採番するので「サーバーが決めた順序」になり、
--    端末の時計に一切依存しない。
-- ---------------------------------------------------------
create table if not exists public.sync_ops (
  revision   bigserial   primary key,
  store_id   text        not null,
  event_id   uuid        not null,
  path       text[]      not null,
  op_type    text        not null default 'SET',
  value      jsonb,
  sender_id  text        not null default '',
  created_at timestamptz not null default now()
);

-- 同じ操作を再送しても二重に適用されないようにする(ID冪等)
create unique index if not exists sync_ops_event_id_uidx on public.sync_ops (event_id);

-- 「この番号より後の操作をください」を高速に引くための索引
create index if not exists sync_ops_store_rev_idx on public.sync_ops (store_id, revision);


-- ---------------------------------------------------------
-- ② 送信 RPC
--    クライアントは操作の配列を渡す。サーバーは重複を弾いて登録し、
--    採番した revision を返す。★この戻り値がそのまま ACK になる。
--    (既に登録済みの操作にも既存の revision を返すので、再送しても必ず ACK が返る)
-- ---------------------------------------------------------
create or replace function public.push_sync_ops(p_store_id text, p_ops jsonb)
returns table (out_event_id uuid, out_revision bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.sync_ops (store_id, event_id, path, op_type, value, sender_id)
  select p_store_id,
         (o->>'eventId')::uuid,
         array(select jsonb_array_elements_text(o->'path')),
         coalesce(o->>'type', 'SET'),
         o->'value',
         coalesce(o->>'senderId', '')
  from jsonb_array_elements(p_ops) as o
  on conflict (event_id) do nothing;

  return query
  select s.event_id, s.revision
  from public.sync_ops s
  where s.store_id = p_store_id
    and s.event_id in (select (o->>'eventId')::uuid from jsonb_array_elements(p_ops) as o);
end;
$$;


-- ---------------------------------------------------------
-- ③ アクセス制御
--    現在 Supabase Auth を使っていないため、実効的な行レベル制御はできません
--    (既存の app_state と同じ状態)。将来 Auth を導入した際にここを絞ります。
--    ・書き込みは RPC 経由のみ(security definer)。テーブルへの直接 INSERT は許可しない
--    ・削除は許可しない(刈り取りは将来 DB 側の関数で行う)
-- ---------------------------------------------------------
alter table public.sync_ops enable row level security;

drop policy if exists sync_ops_select on public.sync_ops;
create policy sync_ops_select on public.sync_ops
  for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on public.sync_ops to anon, authenticated;
grant execute on function public.push_sync_ops(text, jsonb) to anon, authenticated;


-- ---------------------------------------------------------
-- ④ Realtime を有効化
--    他端末の操作を1〜2秒で受け取るために、このテーブルの INSERT を配信対象にする
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_ops'
  ) then
    alter publication supabase_realtime add table public.sync_ops;
  end if;
end $$;


-- ---------------------------------------------------------
-- ⑤ 確認用(実行すると結果が表示されます)
-- ---------------------------------------------------------
select
  (select count(*) from information_schema.tables
     where table_schema='public' and table_name='sync_ops')                        as テーブル作成,
  (select count(*) from information_schema.routines
     where routine_schema='public' and routine_name='push_sync_ops')               as 関数作成,
  (select count(*) from pg_publication_tables
     where pubname='supabase_realtime' and tablename='sync_ops')                   as realtime有効,
  (select count(*) from pg_policies
     where schemaname='public' and tablename='sync_ops')                           as ポリシー数;
-- すべて 1 以上になっていれば成功です。
