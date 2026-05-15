-- ============================================================
-- BUDDICA TOURING: bt_vehicles に不足カラムを一括追加
-- ============================================================
-- 目的:
--   APP が車両保存時に参照しているのに bt_vehicles に存在しないカラムを補完。
--   year / equip / ins_price の3カラム。
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor → 下記SQLを貼付け → Cmd+Enter
--   https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
-- ============================================================

ALTER TABLE bt_vehicles ADD COLUMN IF NOT EXISTS year TEXT DEFAULT '';
ALTER TABLE bt_vehicles ADD COLUMN IF NOT EXISTS equip TEXT DEFAULT '';
ALTER TABLE bt_vehicles ADD COLUMN IF NOT EXISTS ins_price TEXT DEFAULT '';

COMMENT ON COLUMN bt_vehicles.year IS '年式（例: 2022）';
COMMENT ON COLUMN bt_vehicles.equip IS '装備・オプション（例: ナビ・ETC・バックカメラ）';
COMMENT ON COLUMN bt_vehicles.ins_price IS '保険料（旧フィールド・任意・テキスト保存）';

-- 検証
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'bt_vehicles'
  AND column_name IN ('year','equip','ins_price','active','brand')
ORDER BY column_name;
