# つむぎ 確定処理の自動化（毎晩3時）

**Supabase → SQL Editor に貼り付けて Run**

前回作った `compact_sync_ops()` を、**毎晩自動で実行**します。以降、手動でSQLを実行する必要はありません。

```sql
-- pg_cron を有効化（Supabaseに同梱。未有効なら1回だけ必要）
create extension if not exists pg_cron;

-- 全店舗の操作ログを確定する関数
create or replace function public.compact_all_stores()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare r record; total integer := 0; c record;
begin
  for r in select key from public.app_state where key <> '__tsumugi_global__' loop
    begin
      select * into c from public.compact_sync_ops(r.key);
      total := total + coalesce(c.applied, 0);
    exception when others then
      -- 1店舗で失敗しても他店舗は続行する
      raise warning 'compact failed for %: %', r.key, sqlerrm;
    end;
  end loop;
  return total;
end;
$$;

-- 毎晩 3:00(日本時間) に実行。SupabaseはUTCなので 18:00 UTC を指定
select cron.schedule('tsumugi-compact-nightly', '0 18 * * *', $$select public.compact_all_stores()$$);

-- 登録確認
select jobname, schedule, active from cron.job where jobname = 'tsumugi-compact-nightly';
```

`active` が `true` になっていれば設定完了です。

## 解除したいとき

```sql
select cron.unschedule('tsumugi-compact-nightly');
```

## 今すぐ1回実行したいとき

```sql
select public.compact_all_stores();
```
