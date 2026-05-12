-- ============================================================
-- BUDDICA TOURING セキュリティロックダウン パッチ (v1.0.1)
-- 実行日: 2026-05-12
-- 目的: v1で漏れていた2テーブルに認証ポリシーを追加
-- ============================================================
--
-- 【実行方法】
-- 1. https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
-- 2. このSQLを全コピペ → Run
-- ============================================================

-- 漏れていた2テーブルにポリシー追加
CREATE POLICY "authenticated_full_access" ON public.bt_advance_alert
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_full_access" ON public.bt_opening_balance
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 確認
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies WHERE pg_policies.tablename = pg_tables.tablename AND pg_policies.schemaname = pg_tables.schemaname) AS policy_count
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('bt_advance_alert', 'bt_opening_balance')
ORDER BY tablename;

-- 期待結果: 両テーブルとも rls_enabled=true, policy_count=1
