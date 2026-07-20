# つむぎ 操作ログの「確定（凍結）」SQL

**Supabase ダッシュボード → SQL Editor → 下を全部貼り付けて Run**

これは「操作ログに溜まっている変更を、本体のデータへ全部書き込んで確定させる」処理です。
実行すると、**再読み込み直後から最初の1回で全部表示される**ようになります（一瞬空に見える現象が消えます）。

- 既存のデータは壊しません（操作ログを本体へ畳み込むだけ）
- 何度実行しても安全です
- 実行後、確定済みの操作ログは削除されます（本体に取り込み済みなので消えても問題ありません）

```sql
-- ① 操作ログを本体データへ畳み込んで確定する関数
create or replace function public.compact_sync_ops(p_store_id text)
returns table (from_revision bigint, to_revision bigint, applied integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_data jsonb; v_from bigint; v_to bigint; v_n integer := 0;
  r record; v_idx int; v_target text[]; v_m text[];
begin
  -- 本体行をロック（この間、他の書き込みは待つ＝安全に確定できる）
  select data, coalesce((data->>'__snapRevision')::bigint, 0)
    into v_data, v_from
    from public.app_state where key = p_store_id for update;
  if v_data is null then
    return query select 0::bigint, 0::bigint, 0; return;
  end if;

  select max(revision) into v_to from public.sync_ops where store_id = p_store_id;
  if v_to is null or v_to <= v_from then
    return query select v_from, coalesce(v_to, v_from), 0; return;
  end if;

  if v_data->'ticketRecords' is null then
    v_data := jsonb_set(v_data, '{ticketRecords}', '[]'::jsonb, true);
  end if;

  for r in
    select * from public.sync_ops
    where store_id = p_store_id and revision > v_from and revision <= v_to
    order by revision
  loop
    continue when array_length(r.path, 1) < 2 or r.path[1] <> 'ticketRecords';

    -- 対象レコードの位置を id で探す
    select (ord - 1) into v_idx
      from jsonb_array_elements(v_data->'ticketRecords') with ordinality as t(e, ord)
     where e->>'id' = r.path[2]
     limit 1;

    if r.op_type = 'DELETE' then
      if v_idx is not null then
        v_data := jsonb_set(v_data, '{ticketRecords}',
                  (v_data->'ticketRecords') - v_idx);
        v_n := v_n + 1;
      end if;
      v_idx := null;
      continue;
    end if;

    -- 無ければ新規作成（IDから利用者ID・年・日付を復元しておく）
    if v_idx is null then
      v_m := regexp_match(r.path[2], '^tr_(\d+)_(\d{4})_(\d{1,2})_(\d{1,2})$');
      v_data := jsonb_set(v_data, '{ticketRecords}',
        (v_data->'ticketRecords') || jsonb_build_array(
          case when v_m is null then jsonb_build_object('id', r.path[2])
          else jsonb_build_object('id', r.path[2],
                 'patientId', (v_m[1])::int,
                 'year', (v_m[2])::int,
                 'date', (v_m[3])::int || '月' || (v_m[4])::int || '日')
          end));
      v_idx := jsonb_array_length(v_data->'ticketRecords') - 1;
    end if;

    -- 値を書き込む
    v_target := array['ticketRecords', v_idx::text] || r.path[3:];
    v_data := jsonb_set(v_data, v_target, coalesce(r.value, 'null'::jsonb), true);
    v_n := v_n + 1;
    v_idx := null;
  end loop;

  v_data := jsonb_set(v_data, '{__snapRevision}', to_jsonb(v_to), true);
  update public.app_state
     set data = v_data, version = version + 1
   where key = p_store_id;

  -- 取り込み済みの操作ログを削除
  delete from public.sync_ops where store_id = p_store_id and revision <= v_to;

  return query select v_from, v_to, v_n;
end;
$$;

grant execute on function public.compact_sync_ops(text) to anon, authenticated;

-- ② 今すぐ確定を実行（全店舗ぶん）
select s.key as 店舗, c.* from public.app_state s,
       lateral public.compact_sync_ops(s.key) c
 where s.key <> '__tsumugi_global__';
```

実行すると店舗ごとに `from_revision / to_revision / applied（取り込んだ件数）` が表示されます。
`applied` が0より大きければ確定できています。

## 実行後

- **全端末を1回リロード**してください
- 以降、再読み込み直後から全データが表示されます
- 新しい入力はまた操作ログに溜まるので、**定期的に（週1回程度）この②を実行**すると軽い状態を保てます
  （自動化も可能です。ご希望があれば pg_cron で毎晩実行する設定を入れます）
