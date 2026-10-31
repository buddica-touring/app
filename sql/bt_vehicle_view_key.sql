-- 車両ダッシュボードの閲覧専用リンク（オーナー指示 2026-10-31：配車表にログインせずに見る）
-- procurement.html?tab=karte&view=<キー> で開くと、この関数1本だけで読む（書き込みは不可）。
-- 返すのは車両単位のデータのみ：車両マスター（memo除く）・予約の日付/金額/メーター（お客様の名前・電話・メールは返さない）・
--   整備・月次稼働・設定・傷の件数・市場価格。傷の写真・点検写真・担当スタッフ名は返さない。
-- キーを変える（漏れた時）：update bt_view_keys set key=encode(gen_random_bytes(16),'hex') where name='vehicle_dashboard';
create extension if not exists pgcrypto;
create table if not exists public.bt_view_keys (
  name text primary key,
  key  text not null,
  created_at timestamptz default now()
);
alter table public.bt_view_keys enable row level security;   -- ポリシーなし＝ブラウザからは読めない
insert into public.bt_view_keys(name,key) values ('vehicle_dashboard', encode(gen_random_bytes(16),'hex'))
  on conflict (name) do nothing;

create or replace function public.bt_vehicle_dashboard_view(p_key text, p_from date, p_ym text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  return jsonb_build_object(
    'vehicles', (select coalesce(jsonb_agg(to_jsonb(v) - 'memo' order by v.code),'[]') from bt_vehicles v),
    'fleet',    (select coalesce(jsonb_agg(jsonb_build_object('reservation_id',f.reservation_id,'vehicle_code',f.vehicle_code)),'[]') from bt_fleet f),
    'res',      (select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'start_date',r.start_date,'end_date',r.end_date,'status',r.status,
                   'final_price',r.final_price,'price',r.price,'amount',r.amount,'driven_km',r.driven_km,'start_odo',r.start_odo,
                   'end_odo',r.end_odo,'end_odo_at',r.end_odo_at) order by r.id),'[]') from bt_reservations r where r.start_date >= p_from::text),
    'maint',    (select coalesce(jsonb_agg(jsonb_build_object('vehicle_code',m.vehicle_code,'type',m.type,'date',m.date,'completed_date',m.completed_date,
                   'cost',m.cost,'actual_cost',m.actual_cost,'workshop',m.workshop,'odometer_km',m.odometer_km,'km_at',m.km_at) order by m.id),'[]') from bt_vehicle_maintenance m),
    'kpi',      (select coalesce(jsonb_agg(jsonb_build_object('vehicle_code',k.vehicle_code,'active',k.active)),'[]') from bt_vehicle_monthly_kpi k where k.year_month=p_ym),
    'cfg',      (select to_jsonb(s) from bt_vehicle_life_settings s where s.id=1),
    'dmg',      (select coalesce(jsonb_agg(jsonb_build_object('code',t.id,'n',coalesce(jsonb_array_length(t.current_damages),0),
                   'worst',(select e->>'severity' from jsonb_array_elements(coalesce(t.current_damages,'[]'::jsonb)) e
                            order by case e->>'severity' when 'severe' then 0 when 'moderate' then 1 else 2 end limit 1),
                   'last_check_at',t.last_check_at)),'[]') from vehicle_twins t),
    'market',   (select coalesce(jsonb_agg(to_jsonb(p) order by p.surveyed_at desc),'[]') from (
                   select vehicle_code,source,purpose,surveyed_at,year_from,year_to,km_from,km_to,n,median,p25,p75,min,max,points,query_url,note
                   from bt_market_prices where surveyed_at >= now() - interval '180 days' order by surveyed_at desc limit 2000) p)
  );
end $$;
revoke all on function public.bt_vehicle_dashboard_view(text,date,text) from public;
grant execute on function public.bt_vehicle_dashboard_view(text,date,text) to anon, authenticated;

-- リンク用のキーを表示
select 'procurement.html?tab=karte&view=' || key as link from bt_view_keys where name='vehicle_dashboard';
