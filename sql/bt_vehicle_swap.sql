-- スライド入替（オーナー指示 2026-11-01）：売り止めせず、後継車を旧車の枠（車両コード）にスライドする。
-- next_car＝後継車の登録情報（入替車両タブで入力、旧車の車両マスタ行に保存）。swapped_at＝最後にスライドした日（これより前の実績は旧車のもの）。
alter table public.bt_vehicles add column if not exists next_car jsonb, add column if not exists swapped_at date;
-- 入替履歴：スライド前の旧車の車両マスタ情報と生涯成績
create table if not exists public.bt_vehicle_swaps(
  id bigserial primary key, code text not null, swapped_at date not null,
  old jsonb not null, new jsonb, stats jsonb, created_at timestamptz not null default now());
alter table public.bt_vehicle_swaps enable row level security;
drop policy if exists authenticated_full_access on public.bt_vehicle_swaps;
create policy authenticated_full_access on public.bt_vehicle_swaps for all to authenticated using (true) with check (true);
