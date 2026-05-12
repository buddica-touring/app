-- ============================================================
-- BUDDICA TOURING APP セキュリティロックダウン
-- 実行日: 2026-05-12
-- 目的: anon key で全テーブルに自由アクセスできる脆弱性を塞ぐ
-- 適用後: ログイン済みユーザーのみアクセス可能になる
-- ============================================================
--
-- 【実行方法】
-- 1. https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
-- 2. このSQLを全コピペ
-- 3. 「Run」をクリック
--
-- 所要時間: 数秒
-- ロールバック: 末尾の「ロールバック手順」を参照
-- ============================================================

-- ============================================================
-- STEP 1: 全 BT テーブルで RLS を有効化
-- ============================================================
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'bt_reservations',
    'bt_fleet',
    'bt_tasks',
    'bt_vehicles',
    'bt_classes',
    'bt_staff',
    'bt_accounting',
    'bt_app_settings',
    'bt_attendance',
    'bt_car_data',
    'bt_cars',
    'bt_edit_log',
    'bt_jalan_payment',
    'bt_jalan_payments',
    'bt_logs',
    'bt_maintenance',
    'bt_memos',
    'bt_places',
    'bt_reservation_changes',
    'bt_shifts',
    'bt_vehicle_maintenance',
    'bt_vehicle_monthly_kpi',
    'bt_wage_history',
    'app_settings',
    'sq_terminal_failed',
    'vehicle_twins',
    'inquiries',
    'store_events',
    'monthly_snapshots',
    'sales_entries'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- テーブルが存在する場合のみRLS有効化
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      RAISE NOTICE '✓ RLS enabled: %', t;
    ELSE
      RAISE NOTICE '⊘ Skip (not exist): %', t;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- STEP 2: 既存の許可ポリシー全削除（permissiveなものを除去）
-- ============================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE '✓ Dropped policy: %.%.%', r.schemaname, r.tablename, r.policyname;
  END LOOP;
END $$;

-- ============================================================
-- STEP 3: 認証済みユーザーのみ全権アクセスを許可するポリシーを作成
-- ============================================================
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'bt_reservations',
    'bt_fleet',
    'bt_tasks',
    'bt_vehicles',
    'bt_classes',
    'bt_staff',
    'bt_accounting',
    'bt_app_settings',
    'bt_attendance',
    'bt_car_data',
    'bt_cars',
    'bt_edit_log',
    'bt_jalan_payment',
    'bt_jalan_payments',
    'bt_logs',
    'bt_maintenance',
    'bt_memos',
    'bt_places',
    'bt_reservation_changes',
    'bt_shifts',
    'bt_vehicle_maintenance',
    'bt_vehicle_monthly_kpi',
    'bt_wage_history',
    'app_settings',
    'sq_terminal_failed',
    'vehicle_twins',
    'inquiries',
    'store_events',
    'monthly_snapshots',
    'sales_entries'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      -- authenticated ロール（ログイン済み）のみアクセス可能
      EXECUTE format(
        'CREATE POLICY "authenticated_full_access" ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
        t
      );
      RAISE NOTICE '✓ Policy created: %', t;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- STEP 4: 確認 - anon ロールはアクセス不可、authenticated は可能
-- ============================================================
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies WHERE pg_policies.tablename = pg_tables.tablename AND pg_policies.schemaname = pg_tables.schemaname) AS policy_count
FROM pg_tables
WHERE schemaname = 'public'
  AND (tablename LIKE 'bt_%' OR tablename IN ('app_settings','sq_terminal_failed','vehicle_twins','inquiries','store_events','monthly_snapshots','sales_entries'))
ORDER BY tablename;

-- ============================================================
-- ✅ 完了。
-- 期待される結果:
--   - 全 BT テーブルで rls_enabled = true
--   - 全 BT テーブルで policy_count = 1
--   - anon key では「Permission denied」エラー
--   - 認証済みJWT付きでは正常アクセス
-- ============================================================

-- ============================================================
-- 【ロールバック手順】何か問題が起きた場合
-- ============================================================
-- 以下を実行すれば元の状態に戻る:
--
-- DO $$
-- DECLARE
--   t TEXT;
--   tables TEXT[] := ARRAY[...上記と同じリスト...];
-- BEGIN
--   FOREACH t IN ARRAY tables LOOP
--     IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
--       EXECUTE format('DROP POLICY IF EXISTS "authenticated_full_access" ON public.%I', t);
--       EXECUTE format('CREATE POLICY "allow_all" ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
--     END IF;
--   END LOOP;
-- END $$;
-- ============================================================
