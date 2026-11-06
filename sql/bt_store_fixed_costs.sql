-- 固定費・販管費の内訳（1店 / 月、単位：万円）。オーナー指示 2026-11-06
-- 出口シミュ（resale-sim.html）の「参考シミュレーション」タブで入力・保存し、合計を「固定費・販管費 /月（1店あたり）」に自動で入れる。
create table if not exists public.bt_store_fixed_costs(
  id bigserial primary key,
  item text not null,
  amount numeric not null default 0,
  sort int not null default 0,
  note text,
  updated_at timestamptz not null default now());
alter table public.bt_store_fixed_costs enable row level security;
drop policy if exists authenticated_full_access on public.bt_store_fixed_costs;
create policy authenticated_full_access on public.bt_store_fixed_costs for all to authenticated using (true) with check (true);
