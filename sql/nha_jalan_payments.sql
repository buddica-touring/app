-- bt_jalan_payments テーブル（那覇店じゃらん事前決済）
CREATE TABLE IF NOT EXISTS bt_jalan_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE,
  customer_name text,
  customer_email text,
  amount integer DEFAULT 0,
  status text DEFAULT 'new' CHECK (status IN ('new','link_created','email_sent','paid','cancelled','refund','refunded')),
  square_payment_url text,
  link_created_at timestamptz,
  email_sent_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  lend_date text,
  return_date text,
  vehicle_class text,
  slack_ts text,
  memo text,
  created_at timestamptz DEFAULT now()
);

-- RLS有効化
ALTER TABLE bt_jalan_payments ENABLE ROW LEVEL SECURITY;

-- RLSポリシー（全操作許可）
CREATE POLICY bt_jalan_payments_all ON bt_jalan_payments
  FOR ALL USING (true) WITH CHECK (true);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_bt_jalan_payments_status ON bt_jalan_payments (status);
CREATE INDEX IF NOT EXISTS idx_bt_jalan_payments_resid ON bt_jalan_payments (reservation_id);
