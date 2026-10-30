-- 車両カルテ（procurement.html ?tab=karte）用の追加分。すべて追加のみ（既存の列・データは変えない）。
-- 適用前でも画面は動く（リミット＝既定150,000km、仕入額などは未入力扱い、傷の件数は開いた時だけ表示）。

-- 1) 車両ごとのライフサイクル情報（bt_vehicles に列追加）
alter table public.bt_vehicles
  add column if not exists life_limit_km   integer,   -- この車だけのリミット（空ならクラス別→全体の既定）
  add column if not exists purchase_price  integer,   -- 仕入額（税込・諸費用込み）
  add column if not exists purchase_date   date,
  add column if not exists sale_plan_date  date,      -- 売却予定日を手で決めた時だけ（空なら予測で出す）
  add column if not exists sale_expected   integer,   -- 予想売却額（相場を見て入力）
  add column if not exists sale_price      integer,   -- 実際の売却額
  add column if not exists sale_date       date,
  add column if not exists sale_dest       text,      -- 売却先
  add column if not exists life_flag       text,
  add column if not exists exit_type       text not null default 'sell';   -- sell=売却 / ride=乗り潰し      -- 例『10万km超』（リミット延長した理由）

-- 2) 全体設定（1行だけ）
create table if not exists public.bt_vehicle_life_settings (
  id               integer primary key default 1 check (id = 1),
  default_limit_km integer not null default 100000,             -- オーナー指示 2026-10-30：全車10万km
  over_limit_km    integer not null default 150000,             -- 既に10万kmを超えていた車
  class_limits     jsonb   not null default '{}'::jsonb,   -- 例 {"AA":80000,"A":120000}
  lead_months      integer not null default 3,             -- 売却予定の何ヶ月前に仕入れを動かすか
  shaken_rule      text    not null default 'next',        -- next=次の車検期間中にリミット到達なら車検前に売る / always=車検前に必ず売る / ignore=車検は見ない
  updated_at       timestamptz not null default now()
);
insert into public.bt_vehicle_life_settings (id) values (1) on conflict do nothing;

-- 1-2) 適用時点で既に10万kmを超えている車は、リミット15万km＋フラグで固定（あとから10万kmを超えた車は対象外）
update public.bt_vehicles
   set life_limit_km = 150000, life_flag = '10万km超'
 where life_limit_km is null and coalesce(current_mileage,0) >= 100000 and coalesce(type,'') <> '送迎';
alter table public.bt_vehicle_life_settings enable row level security;
drop policy if exists authenticated_full_access on public.bt_vehicle_life_settings;
create policy authenticated_full_access on public.bt_vehicle_life_settings for all to authenticated using (true) with check (true);

-- 3) 傷の件数だけを返す（current_damages は写真込みで全車 約11MB あるため、一覧では件数だけ読む）
create or replace function public.bt_vehicle_damage_summary()
returns table (code text, n integer, worst text, last_check_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select t.id,
         coalesce(jsonb_array_length(t.current_damages), 0),
         (select e->>'severity' from jsonb_array_elements(coalesce(t.current_damages,'[]'::jsonb)) e
           order by case e->>'severity' when 'severe' then 0 when 'moderate' then 1 else 2 end limit 1),
         t.last_check_at
  from vehicle_twins t;
$$;
grant execute on function public.bt_vehicle_damage_summary() to authenticated;

-- 3-2) リアルタイム共有（車両カルテを開いている全員の画面を自動更新）
do $$ begin
  begin alter publication supabase_realtime add table public.bt_vehicles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.bt_vehicle_life_settings; exception when duplicate_object then null; end;
end $$;

-- 4) 返却メーター（bt_reservations.end_odo）が入ったら車両の現在走行距離を進める
--    逆戻り・桁違い（+5,000km超）は反映しない
create or replace function public._bt_sync_vehicle_mileage()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if new.end_odo is null or new.end_odo is not distinct from old.end_odo then return new; end if;
  select vehicle_code into v_code from bt_fleet where reservation_id = new.id limit 1;
  if v_code is null then return new; end if;
  update bt_vehicles set current_mileage = new.end_odo, updated_at = now()
   where code = v_code
     and (current_mileage is null or (new.end_odo > current_mileage and new.end_odo - current_mileage <= 5000));
  return new;
end $$;
drop trigger if exists trg_bt_sync_vehicle_mileage on public.bt_reservations;
create trigger trg_bt_sync_vehicle_mileage after update of end_odo on public.bt_reservations
  for each row execute function public._bt_sync_vehicle_mileage();
