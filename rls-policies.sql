-- ============================================================
-- RLS (Row Level Security) ポリシー
-- 前提: Supabase Anonymous Auth が有効化済みであること
-- GAS側は service_role キー使用（RLSバイパス）
-- ============================================================

-- 全テーブルにRLSを有効化
ALTER TABLE bt_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_reservation_changes ENABLE ROW LEVEL SECURITY;

-- Tier 1: 業務テーブル（認証済みユーザーにフルアクセス）
CREATE POLICY "auth_all" ON bt_reservations FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_fleet FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_tasks FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_vehicles FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_maintenance FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_reservation_changes FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Tier 2: センシティブテーブル
CREATE POLICY "auth_all" ON bt_staff FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_shifts FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_all" ON bt_attendance FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Tier 3: アプリ設定
CREATE POLICY "auth_select" ON bt_app_settings FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "auth_insert" ON bt_app_settings FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_update" ON bt_app_settings FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "auth_delete" ON bt_app_settings FOR DELETE
  USING (auth.role() = 'authenticated');

-- パスコードDB化
INSERT INTO bt_app_settings (key, value) VALUES ('pas_code', '2318')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
