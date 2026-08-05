create table if not exists public.bt_vehicle_wash(
  vehicle_code text primary key,
  last_washed_date date,
  updated_at timestamptz default now()
);
alter table public.bt_vehicle_wash enable row level security;
drop policy if exists bt_vehicle_wash_all on public.bt_vehicle_wash;
create policy bt_vehicle_wash_all on public.bt_vehicle_wash for all to anon, authenticated using(true) with check(true);
grant select, insert, update on public.bt_vehicle_wash to anon, authenticated;
insert into public.bt_vehicle_wash(vehicle_code,last_washed_date,updated_at) values
 ('アルフ1728','2026-08-03',now()),
 ('アルフ1697','2026-08-03',now()),
 ('ﾙｰﾐb0bs','2026-08-03',now()),
 ('プリウ1016','2026-08-04',now()),
 ('ライズ1011','2026-08-04',now()),
 ('ヤリス1018','2026-08-04',now()),
 ('アルフ1730','2026-08-05',now()),
 ('ヴェル1699','2026-08-05',now()),
 ('ハリアgc90','2026-08-05',now())
on conflict (vehicle_code) do update set last_washed_date=excluded.last_washed_date, updated_at=now();
