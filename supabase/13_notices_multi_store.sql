-- =============================================
-- system_notices: 複数店舗対応 (target_store_ids 配列追加)
-- =============================================
-- 旧 target_store_id (単一) → 新 target_store_ids (text[] 複数)
-- 既存データは target_store_id を target_store_ids[0] にコピー
-- =============================================

alter table public.system_notices add column if not exists target_store_ids text[];

-- 既存の target_store_id データを target_store_ids にコピー
update public.system_notices
set target_store_ids = array[target_store_id]
where target_store_id is not null and target_store_ids is null;

-- 確認
select id, title, target_store_id, target_store_ids
from public.system_notices
order by created_at desc
limit 10;
