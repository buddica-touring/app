-- ============================================================
-- BUDDICA TOURING: bt_vehicles に active カラム追加
-- ============================================================
-- 目的:
--   APP が車両保存時に active (boolean) フィールドを参照しているが、
--   bt_vehicles にこのカラムが無くて schema cache エラーが発生する。
--   既存の status (text) カラムと併存させて、active で稼働/未稼働を管理する。
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor → 下記SQLを貼付け → Cmd+Enter
--   https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
--
-- バージョン: v1.0.37-BT
-- 作成日: 2026-05-14
-- ============================================================

-- 1. active カラム追加（true デフォルト）
ALTER TABLE bt_vehicles
  ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- 2. 既存レコードを稼働中扱い
UPDATE bt_vehicles SET active = true WHERE active IS NULL;

-- 3. コメント
COMMENT ON COLUMN bt_vehicles.active IS '稼働中フラグ。配車対象から外す場合は false。status カラム (text) と併存（後方互換）。';

-- 4. 検証
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'bt_vehicles' AND column_name IN ('active','status','brand')
ORDER BY column_name;
