-- ============================================================
-- BUDDICA TOURING 高松店 管理APP - Supabase DBスキーマ完全版
-- プロジェクト: ggqugvyskyiblxiycpci.supabase.co
-- テーブルプレフィックス: bt_（BUDDICA TOURING全社共通）
-- ベース: HANDYMAN 那覇店 NHA v3.4.73 (2026-05-07時点)
-- 作成日: 2026-05-07
-- ============================================================
--
-- 実行方法:
-- 1. https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new を開く
-- 2. このファイル全文をコピペ → 「Run」をクリック
-- 3. 警告が出たら確認して続行
-- 4. 完了後、左メニュー Database → Tables で全テーブル作成を確認
--
-- 含まれるもの:
-- - 24個の bt_* テーブル（CREATE TABLE）
-- - 4個の共有テーブル（app_settings, inquiries, sq_terminal_failed, vehicle_twins）
-- - Realtime 有効化（必要なテーブルのみ）
-- - RLS ポリシー（全許可・anon可）
-- ============================================================


-- ============================================================
-- 1. 予約マスター（メインテーブル）
-- ============================================================
CREATE TABLE bt_reservations (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  kana TEXT,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  start_time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  del_time TEXT DEFAULT '',
  col_time TEXT DEFAULT '',
  vehicle_class TEXT DEFAULT '',
  vehicle_name TEXT,
  plate_no TEXT,
  source TEXT,
  status TEXT DEFAULT 'confirmed',
  memo TEXT,
  tel TEXT DEFAULT '',
  mail TEXT DEFAULT '',
  ota TEXT DEFAULT '',
  booking_no TEXT,
  no TEXT,
  people INTEGER DEFAULT 0,
  insurance TEXT DEFAULT '',
  del_place TEXT DEFAULT '',
  col_place TEXT DEFAULT '',
  del_flight TEXT DEFAULT '',
  col_flight TEXT,
  usb TEXT,
  car_seat TEXT DEFAULT '0',
  junior_seat TEXT DEFAULT '0',
  -- 新オプション列（v3.2.70-NHA以降の正規スキーマ）
  opt_b INTEGER DEFAULT 0,        -- ベビーシート台数
  opt_c INTEGER DEFAULT 0,        -- チャイルドシート台数
  opt_j INTEGER DEFAULT 0,        -- ジュニアシート台数
  opt_usb INTEGER DEFAULT 0,      -- USB台数
  options TEXT,
  amount INTEGER DEFAULT 0,
  price INTEGER DEFAULT 0,
  -- 価格内訳（v3.2.42-NHA以降）
  base_price INTEGER DEFAULT 0,   -- 基本料金
  option_price INTEGER DEFAULT 0, -- 付帯売上
  discount INTEGER DEFAULT 0,     -- 割引
  final_price INTEGER DEFAULT 0,
  line TEXT,
  payment TEXT,
  paid BOOLEAN DEFAULT false,     -- 入金フラグ
  del_date TEXT,
  del_route TEXT,
  del_memo TEXT,
  col_date TEXT,
  col_route TEXT,
  col_memo TEXT,
  visit_type TEXT DEFAULT '',
  return_type TEXT DEFAULT '',
  assigned_vehicle TEXT DEFAULT '',
  prefecture TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  changed_json TEXT,
  -- 予約日（リードタイム精度改善）
  booked_at TIMESTAMPTZ,          -- メール受信日 = 実際の予約日
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_reservations_start_date ON bt_reservations(start_date);
CREATE INDEX idx_bt_reservations_end_date ON bt_reservations(end_date);
CREATE INDEX idx_bt_reservations_status ON bt_reservations(status);
CREATE INDEX idx_bt_reservations_ota ON bt_reservations(ota);
COMMENT ON COLUMN bt_reservations.opt_b IS 'ベビーシート（v3.2.70～）';
COMMENT ON COLUMN bt_reservations.opt_c IS 'チャイルドシート（v3.2.70～）';
COMMENT ON COLUMN bt_reservations.opt_j IS 'ジュニアシート（v3.2.70～）';
COMMENT ON COLUMN bt_reservations.opt_usb IS 'USB（v3.2.70～）';
COMMENT ON COLUMN bt_reservations.booked_at IS 'メール受信日 = 実際の予約日（リードタイム精度改善）';
COMMENT ON COLUMN bt_reservations.paid IS '入金フラグ（じゃらん事前決済等）';


-- ============================================================
-- 2. 配車テーブル
-- ============================================================
CREATE TABLE bt_fleet (
  reservation_id TEXT PRIMARY KEY REFERENCES bt_reservations(id) ON DELETE CASCADE,
  vehicle_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_fleet_vehicle_code ON bt_fleet(vehicle_code);


-- ============================================================
-- 3. タスクテーブル（日別業務タスク）
-- ============================================================
CREATE TABLE bt_tasks (
  _id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  "担当" TEXT DEFAULT '',
  "時間" TEXT DEFAULT '',
  "変更" TEXT DEFAULT '',
  "内容" TEXT DEFAULT '',
  "内案" TEXT DEFAULT '',
  "予約者" TEXT DEFAULT '',
  "人数" TEXT DEFAULT '',
  "便名" TEXT DEFAULT '',
  "空港" TEXT DEFAULT '',
  "クラス" TEXT DEFAULT '',
  "車種" TEXT DEFAULT '',
  "No" TEXT DEFAULT '',
  "B" TEXT DEFAULT '',
  "C" TEXT DEFAULT '',
  "J" TEXT DEFAULT '',
  "USB" TEXT DEFAULT '',
  "確認" TEXT DEFAULT '',
  "確定" TEXT DEFAULT '',
  "メモ" TEXT DEFAULT '',
  "約款" TEXT DEFAULT '',
  "LINE" TEXT DEFAULT '',
  "決済" TEXT DEFAULT '',
  "返却日" TEXT DEFAULT '',
  "返却" TEXT DEFAULT '',
  "送迎" TEXT DEFAULT '',
  "送迎場所" TEXT DEFAULT '',
  "集客" TEXT DEFAULT '',
  "OTA" TEXT DEFAULT '',
  "予約番号" TEXT DEFAULT '',
  "TEL" TEXT DEFAULT '',
  "MAIL" TEXT DEFAULT '',
  class TEXT DEFAULT '',
  vehicle_code TEXT DEFAULT '',
  assigned_vehicle TEXT DEFAULT '',
  changed_json TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_tasks_date ON bt_tasks(date);


-- ============================================================
-- 4. 車両マスター（車検/点検カラム含む v3.4.73）
-- ============================================================
CREATE TABLE bt_vehicles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plate_no TEXT DEFAULT '',
  type TEXT NOT NULL,
  seats INTEGER DEFAULT 0,
  insurance_veh BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',          -- active / retired / maintenance
  -- 走行距離・メンテナンス
  current_mileage INTEGER DEFAULT 0,
  last_oil_change_date DATE,
  last_oil_change_km INTEGER,
  oil_interval_km INTEGER DEFAULT 5000,
  -- ランニングコスト（月額）
  insurance_annual INTEGER DEFAULT 0,    -- 月額保険料（v2.6 命名は annual だが意味は月額）
  lease_monthly INTEGER DEFAULT 0,
  car_tax INTEGER DEFAULT 0,             -- 自動車税（年額）
  shaken_cost INTEGER DEFAULT 0,         -- 車検代（概算）
  tenken_cost INTEGER DEFAULT 0,         -- 半年点検代（概算）
  -- 車両情報
  grade TEXT DEFAULT '',
  color TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  -- 車検・点検（v3.4.73 機能）
  inspection_due_date DATE,              -- 車検満了日
  inspection_next_date DATE,             -- 次回車検予定日（予備）
  tenken_due_date DATE,                  -- 半年点検期限
  tenken_next_date DATE,                 -- 次回半年点検予定日（予備）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON COLUMN bt_vehicles.inspection_due_date IS '車検満了日（車検証記載・法的期限）';
COMMENT ON COLUMN bt_vehicles.tenken_due_date IS '半年点検期限（前回点検 + 6ヶ月）';
COMMENT ON COLUMN bt_vehicles.insurance_annual IS '保険料 月額（命名は annual だが月額の意味）';


-- ============================================================
-- 5. メンテナンス（配車表ブロック）
-- ============================================================
CREATE TABLE bt_maintenance (
  id TEXT PRIMARY KEY,
  vehicle_code TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  label TEXT DEFAULT '',                 -- 車検/半年点検/修理/その他
  cost INTEGER DEFAULT 0,                -- 概算費用
  actual_cost INTEGER DEFAULT 0,         -- 確定金額
  workshop TEXT DEFAULT '',              -- 整備工場
  invoice_no TEXT DEFAULT '',            -- 請求書番号
  maint_notes TEXT DEFAULT '',           -- メモ
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_maintenance_vehicle_code ON bt_maintenance(vehicle_code);
CREATE INDEX idx_bt_maintenance_dates ON bt_maintenance(start_date, end_date);


-- ============================================================
-- 6. 車両メンテナンス履歴（独立テーブル）
-- ============================================================
CREATE TABLE bt_vehicle_maintenance (
  id TEXT PRIMARY KEY,
  vehicle_code TEXT NOT NULL,
  type TEXT NOT NULL,                    -- shaken / tenken / oil / repair / other
  date DATE NOT NULL,
  cost INTEGER DEFAULT 0,
  actual_cost INTEGER DEFAULT 0,
  workshop TEXT DEFAULT '',
  invoice_no TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  km_at INTEGER,                         -- 実施時走行距離
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_vehicle_maintenance_vehicle ON bt_vehicle_maintenance(vehicle_code);
CREATE INDEX idx_bt_vehicle_maintenance_type ON bt_vehicle_maintenance(type);


-- ============================================================
-- 7. スタッフマスター
-- ============================================================
CREATE TABLE bt_staff (
  name TEXT PRIMARY KEY,
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT '',
  role TEXT DEFAULT '',
  active BOOLEAN DEFAULT TRUE,
  type TEXT DEFAULT '',                  -- 正社員/アルバイト/業務委託
  memo TEXT DEFAULT '',
  hourly_wage INTEGER DEFAULT 0,
  transport_cost INTEGER DEFAULT 0,
  monthly_salary INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 8. シフト
-- ============================================================
CREATE TABLE bt_shifts (
  date TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  symbol TEXT DEFAULT '',
  start_time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  status TEXT DEFAULT '',
  PRIMARY KEY (date, staff_name)
);
CREATE INDEX idx_bt_shifts_date ON bt_shifts(date);


-- ============================================================
-- 9. 出勤記録
-- ============================================================
CREATE TABLE bt_attendance (
  date TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  start_time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  approved BOOLEAN DEFAULT FALSE,
  memo TEXT DEFAULT '',
  absent BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (date, staff_name)
);


-- ============================================================
-- 10. 給与履歴（時給変更履歴）
-- ============================================================
CREATE TABLE bt_wage_history (
  id TEXT PRIMARY KEY,
  staff_name TEXT NOT NULL,
  effective_date DATE NOT NULL,
  hourly_wage INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_wage_history_staff ON bt_wage_history(staff_name);


-- ============================================================
-- 11. アプリ設定（Key-Value）
-- ============================================================
CREATE TABLE bt_app_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 12. 予約変更履歴
-- ============================================================
CREATE TABLE bt_reservation_changes (
  id SERIAL PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  change_type TEXT DEFAULT '',
  field_name TEXT DEFAULT '',
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  changed_by TEXT DEFAULT '',
  changed_at TEXT DEFAULT '',
  source TEXT DEFAULT ''
);
CREATE INDEX idx_bt_res_changes_resv ON bt_reservation_changes(reservation_id);


-- ============================================================
-- 13. 編集ログ（手動編集の監査）
-- ============================================================
CREATE TABLE bt_edit_log (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT,
  edited_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_edit_log_record ON bt_edit_log(table_name, record_id);


-- ============================================================
-- 14. 会計（売上・支出・立替）
-- ============================================================
CREATE TABLE bt_accounting (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  type TEXT NOT NULL,                    -- sales / expense / advance / extra_sales
  category TEXT DEFAULT '',              -- 科目（駐車場代/燃料代/食事代等）
  amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT DEFAULT '',        -- cash / card / advance / square
  reservation_id TEXT,                   -- 関連予約
  memo TEXT DEFAULT '',
  input_by TEXT DEFAULT '',              -- 入力者
  staff_name TEXT DEFAULT '',            -- 関連スタッフ
  paid BOOLEAN DEFAULT FALSE,            -- 立替の場合の精算済みフラグ
  paid_date DATE,                        -- 精算日
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_accounting_date ON bt_accounting(date);
CREATE INDEX idx_bt_accounting_type ON bt_accounting(type);
CREATE INDEX idx_bt_accounting_resv ON bt_accounting(reservation_id);


-- ============================================================
-- 15. 場所マスター（送迎場所マッピング）
-- ============================================================
CREATE TABLE bt_places (
  reservation_id TEXT PRIMARY KEY,
  del_place TEXT DEFAULT '',
  col_place TEXT DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 16. じゃらん事前決済（v3.2.46-NHA以降）
-- ============================================================
CREATE TABLE bt_jalan_payments (
  id SERIAL PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  guest_name TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',   -- new/link_created/email_sent/paid/cancelled/refund/refunded
  square_link_url TEXT,
  square_payment_id TEXT,
  square_order_id TEXT,
  email_sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  start_date TEXT,
  end_date TEXT,
  memo TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_jalan_payments_status ON bt_jalan_payments(status);
CREATE INDEX idx_bt_jalan_payments_resv ON bt_jalan_payments(reservation_id);


-- ============================================================
-- 17. メモ（TOPメモボックス）
-- ============================================================
CREATE TABLE bt_memos (
  id SERIAL PRIMARY KEY,
  text TEXT DEFAULT '',
  posted_by TEXT DEFAULT '',
  pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_memos_created ON bt_memos(created_at DESC);


-- ============================================================
-- 18. 車両クラスマスター
-- ============================================================
CREATE TABLE bt_classes (
  id TEXT PRIMARY KEY,                   -- A/B/C/D/F/H/S
  store_id TEXT DEFAULT 'tkm',
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 19. 車両（damage check用・vehicle_twins と連携）
-- ============================================================
CREATE TABLE bt_cars (
  id TEXT PRIMARY KEY,
  store_id TEXT DEFAULT 'tkm',
  code TEXT,
  name TEXT,
  plate_no TEXT,
  type TEXT,
  status TEXT DEFAULT 'active',
  memo TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 20. 車両データ（走行距離・オイル交換等）
-- ============================================================
CREATE TABLE bt_car_data (
  id TEXT PRIMARY KEY,
  store_id TEXT DEFAULT 'tkm',
  vehicle_code TEXT NOT NULL,
  type TEXT NOT NULL,                    -- mileage / oil_change / repair
  date DATE NOT NULL,
  value INTEGER,                         -- 走行距離(km)等
  cost INTEGER DEFAULT 0,
  memo TEXT DEFAULT '',
  staff_name TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bt_car_data_vehicle ON bt_car_data(vehicle_code);
CREATE INDEX idx_bt_car_data_type ON bt_car_data(type);


-- ============================================================
-- 21. ログ（操作ログ）
-- ============================================================
CREATE TABLE bt_logs (
  id TEXT PRIMARY KEY,
  store_id TEXT DEFAULT 'tkm',
  date DATE NOT NULL,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  staff_name TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 22. 月次KPIスナップショット
-- ============================================================
CREATE TABLE bt_vehicle_monthly_kpi (
  store_id TEXT NOT NULL,
  ym TEXT NOT NULL,                      -- YYYY-MM
  data JSONB NOT NULL,                   -- 月次集計データ全体
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (store_id, ym)
);


-- ============================================================
-- 23. オープニング残高（月初現金残高）
-- ============================================================
CREATE TABLE bt_opening_balance (
  ym TEXT PRIMARY KEY,                   -- YYYY-MM
  amount INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 24. 立替金アラート
-- ============================================================
CREATE TABLE bt_advance_alert (
  id SERIAL PRIMARY KEY,
  accounting_id TEXT NOT NULL,
  alerted_at TIMESTAMPTZ DEFAULT NOW(),
  unique_key TEXT UNIQUE
);


-- ============================================================
-- 共有テーブル（プレフィックスなし）
-- ============================================================

-- 全店共通アプリ設定
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 問い合わせ管理（問い合わせAPP用）
CREATE TABLE inquiries (
  id SERIAL PRIMARY KEY,
  store_id TEXT DEFAULT 'tkm',
  message_id TEXT UNIQUE,                -- Gmail message ID
  thread_id TEXT,
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  from_email TEXT DEFAULT '',
  from_name TEXT DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',         -- pending / replied / archived / blocked
  reply_body TEXT,
  reply_sent_at TIMESTAMPTZ,
  replied_by TEXT,
  category TEXT,                         -- 予約変更/キャンセル/料金問合せ/その他
  reservation_id TEXT,
  memo TEXT DEFAULT '',
  alerted_at TIMESTAMPTZ,                -- 未対応アラート通知日時
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_store ON inquiries(store_id);
CREATE INDEX idx_inquiries_received ON inquiries(received_at DESC);

-- Square端末決済 自動取込失敗
CREATE TABLE sq_terminal_failed (
  id TEXT PRIMARY KEY,                   -- Square payment_id
  payment_at TIMESTAMPTZ NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT DEFAULT '',
  item_name TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  raw_data JSONB,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_store TEXT,                   -- TKM / SPK / NHA / UNKNOWN
  resolved_accounting_id TEXT,
  resolved_memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sq_terminal_failed_resolved ON sq_terminal_failed(resolved);
CREATE INDEX idx_sq_terminal_failed_payment_at ON sq_terminal_failed(payment_at DESC);

-- 車両ダメージチェック（車両チェックAPP用）
CREATE TABLE vehicle_twins (
  id TEXT PRIMARY KEY,                   -- 車両コード
  store_id TEXT DEFAULT 'tkm',
  vehicle_data JSONB NOT NULL,
  damage_state JSONB DEFAULT '{}',
  last_check_event_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Supabase Realtime 有効化（リアルタイム同期が必要なテーブル）
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE bt_reservations;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_fleet;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_vehicles;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_maintenance;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_staff;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_shifts;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_attendance;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_app_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_memos;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_jalan_payments;
ALTER PUBLICATION supabase_realtime ADD TABLE bt_accounting;


-- ============================================================
-- RLS（Row Level Security）ポリシー
-- 注: 開発初期は全許可。本番運用時は要見直し
-- ============================================================
ALTER TABLE bt_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_fleet ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_vehicle_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_wage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_reservation_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_edit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_accounting ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_jalan_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_cars ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_car_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_vehicle_monthly_kpi ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_opening_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE bt_advance_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sq_terminal_failed ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_twins ENABLE ROW LEVEL SECURITY;

-- 全許可ポリシー（anon / authenticated 両対応）
CREATE POLICY "Allow all bt_reservations" ON bt_reservations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_fleet" ON bt_fleet FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_tasks" ON bt_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_vehicles" ON bt_vehicles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_maintenance" ON bt_maintenance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_vehicle_maintenance" ON bt_vehicle_maintenance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_staff" ON bt_staff FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_shifts" ON bt_shifts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_attendance" ON bt_attendance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_wage_history" ON bt_wage_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_app_settings" ON bt_app_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_reservation_changes" ON bt_reservation_changes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_edit_log" ON bt_edit_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_accounting" ON bt_accounting FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_places" ON bt_places FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_jalan_payments" ON bt_jalan_payments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_memos" ON bt_memos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_classes" ON bt_classes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_cars" ON bt_cars FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_car_data" ON bt_car_data FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_logs" ON bt_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_vehicle_monthly_kpi" ON bt_vehicle_monthly_kpi FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_opening_balance" ON bt_opening_balance FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all bt_advance_alert" ON bt_advance_alert FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all app_settings" ON app_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all inquiries" ON inquiries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all sq_terminal_failed" ON sq_terminal_failed FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all vehicle_twins" ON vehicle_twins FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- 初期データ（クラスマスター）
-- ============================================================
INSERT INTO bt_classes (id, store_id, name, sort_order, color) VALUES
  ('A', 'tkm', 'アルファードHクラス', 1, '#dc2626'),
  ('B', 'tkm', 'ワンボックスB',       2, '#ea580c'),
  ('C', 'tkm', 'コンパクトSUV',       3, '#16a34a'),
  ('D', 'tkm', 'ワンボックスD',       4, '#0891b2'),
  ('F', 'tkm', 'コンパクト',          5, '#7c3aed'),
  ('H', 'tkm', 'ハイブリッド',        6, '#0d9488'),
  ('S', 'tkm', 'ハリアー',            7, '#92400e');

-- ============================================================
-- 初期データ（アプリ設定）
-- ============================================================
INSERT INTO bt_app_settings (key, value) VALUES
  ('store_code', 'tkm'),
  ('store_name', 'BUDDICA TOURING 高松店'),
  ('app_version', 'v1.0.0-BT'),
  ('initialized_at', NOW()::TEXT);

INSERT INTO app_settings (key, value) VALUES
  ('bt_initialized', 'true'),
  ('bt_initialized_at', NOW()::TEXT);


-- ============================================================
-- 完了
-- ============================================================
-- 28テーブル作成完了
-- bt_* テーブル: 24個
-- 共有テーブル: 4個（app_settings, inquiries, sq_terminal_failed, vehicle_twins）
-- Realtime 有効化: 12テーブル
-- RLS 全許可ポリシー: 28テーブル
--
-- 次のステップ:
-- 1. 車両マスタ登録（bt_vehicles）→ 高松店車両情報
-- 2. スタッフ登録（bt_staff）→ 高松店スタッフ
-- 3. APP 起動確認（https://buddica-touring.github.io/app/ 予定）
-- ============================================================
