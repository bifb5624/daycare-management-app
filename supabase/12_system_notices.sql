-- =============================================
-- システムお知らせテーブル (本部 → 全店舗 / 個別店舗)
-- =============================================
-- フランチャイズ展開時のメンテナンス通知 / アップデート告知用
-- =============================================

create table if not exists public.system_notices (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  -- 対象店舗 (null なら全店共通、特定 store_id なら個別)
  target_store_id text references public.stores(id) on delete cascade,
  -- 重要度 (info / warning / critical)
  severity text not null default 'info',
  -- 表示期間
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text -- 作成した本部 admin の username
);

-- インデックス
create index if not exists idx_system_notices_target_store on public.system_notices(target_store_id);
create index if not exists idx_system_notices_period on public.system_notices(starts_at, ends_at);

-- RLS: 認証済みなら全員 SELECT 可、INSERT/UPDATE/DELETE は anon (実運用は本部管理者のみ)
alter table public.system_notices enable row level security;

drop policy if exists "anyone can read notices" on public.system_notices;
create policy "anyone can read notices" on public.system_notices for select using (true);

drop policy if exists "anyone can write notices" on public.system_notices;
create policy "anyone can write notices" on public.system_notices for all using (true) with check (true);

-- 確認
select 'system_notices' as table_name, count(*) as rows from public.system_notices;
