-- =========================================================
-- stores テーブルに address_building (建物名・部屋番号) 列を追加
-- つむぎ管理局の店舗登録で入力した建物名を、店舗ログイン後の
-- 各種設定(事業所情報)に反映するために使用する。
-- Supabase ダッシュボード > SQL Editor で実行してください。
-- =========================================================
alter table public.stores add column if not exists address_building text;

-- 確認
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'stores'
order by ordinal_position;
