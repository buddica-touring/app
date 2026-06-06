-- BT(高松) monthly_snapshots テーブル作成（2026-06-06）
-- メインDB(ckrxttbnawkclshczsia)と同構造。BT Supabase(ggqugvyskyiblxiycpci) SQL Editor で1回RUN。
-- 用途: 経営KPI月次スナップショット（saveMonthlySnapshot）＋ sim.html 実績ライブ取得の正本箱。
create table if not exists monthly_snapshots (
  id uuid primary key default gen_random_uuid(),
  store text not null,
  year_month text not null,
  active_vehicles integer,
  total_rental_days integer,
  total_available_days integer,
  utilization_pct integer,
  total_revenue bigint,
  revpacd integer,
  avg_daily_rate integer,
  total_returns integer,
  same_month_bookings integer,
  booking_rate_pct integer,
  cancel_count integer,
  total_bookings integer,
  cancel_rate_pct integer,
  class_detail jsonb,
  ota_detail jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (store, year_month)
);
alter table monthly_snapshots enable row level security;
create policy "auth_all_monthly_snapshots" on monthly_snapshots
  for all to authenticated using (true) with check (true);
grant select, insert, update on monthly_snapshots to authenticated;
