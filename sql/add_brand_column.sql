-- ============================================================
-- BUDDICA TOURING: bt_vehicles に brand カラム追加
-- ============================================================
-- 目的:
--   AA クラスの車両（ハイエンド）でブランド単位の管理を可能にする。
--   ベンツ / ランボ / ロールス / ベントレー / フェラーリ / ポルシェ など
--
-- 実行方法:
--   Supabase Dashboard → SQL Editor → 下記SQLを貼付け → Cmd+Enter
--   https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
--
-- バージョン: v1.0.35-BT
-- 作成日: 2026-05-14
-- ============================================================

-- 1. brand カラム追加（NULLABLE / デフォルト空文字）
ALTER TABLE bt_vehicles
  ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT '';

-- 2. コメント追加（用途明示）
COMMENT ON COLUMN bt_vehicles.brand IS 'AAクラス（ハイエンド）車両のブランド名（例: ベンツ、ランボルギーニ、ロールスロイス）。プロパークラス（A/B/C/H/S/F）では空でOK。';

-- 3. AA クラス車両の brand 必須化のための CHECK 制約（オプション・後で有効化）
-- ALTER TABLE bt_vehicles ADD CONSTRAINT chk_aa_brand
--   CHECK (type != 'AA' OR (brand IS NOT NULL AND brand != ''));

-- 4. 検証クエリ
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'bt_vehicles' AND column_name = 'brand';
