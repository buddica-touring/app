-- ============================================================
-- bt_jalan_payments スキーマ修正
-- 実行日: 2026-05-12
-- 問題: APP は NHA系カラム（customer_name, square_payment_url等）を期待しているが
--       BT Supabase には旧スキーマ（guest_name, square_link_url等）が入っている
-- 対処: テーブルは空（0件）のため、DROPして正しいスキーマで再作成
-- ============================================================

-- 既存テーブルを削除
DROP TABLE IF EXISTS public.bt_jalan_payments CASCADE;

-- 正しいスキーマで再作成
CREATE TABLE public.bt_jalan_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE,
  customer_name text,
  customer_email text,
  amount integer DEFAULT 0,
  status text DEFAULT 'new' CHECK (status IN ('new','link_created','email_sent','paid','cancelled','refund','refunded')),
  square_payment_url text,
  square_payment_id text,
  square_order_id text,
  link_created_at timestamptz,
  email_sent_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  lend_date text,
  return_date text,
  vehicle_class text,
  slack_ts text,
  memo text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS有効化
ALTER TABLE public.bt_jalan_payments ENABLE ROW LEVEL SECURITY;

-- 認証済みユーザーのみ全権アクセス（他テーブルと同方針）
CREATE POLICY "authenticated_full_access" ON public.bt_jalan_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- インデックス
CREATE INDEX idx_bt_jalan_payments_status ON public.bt_jalan_payments (status);
CREATE INDEX idx_bt_jalan_payments_resid ON public.bt_jalan_payments (reservation_id);
CREATE INDEX idx_bt_jalan_payments_cancelled ON public.bt_jalan_payments (cancelled_at) WHERE cancelled_at IS NOT NULL;

-- 確認
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='bt_jalan_payments'
ORDER BY ordinal_position;
