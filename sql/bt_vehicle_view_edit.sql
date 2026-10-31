-- 閲覧リンク（?view=キー）からの編集（オーナー指示 2026-10-31：閲覧リンクでも編集可能に）
-- 車両単位の項目だけ書ける。顧客・予約・設定・リレーは書けない。キーは bt_vehicle_view_key.sql と同じ。
create or replace function public.bt_vehicle_view_update(p_key text, p_code text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  k text;
  r bt_vehicles;
  ok text[] := array['purchase_price','purchase_date','life_limit_km','sale_plan_date','sale_expected','sale_price','sale_date','sale_dest','exit_type','current_mileage','odo_at'];
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  for k in select jsonb_object_keys(coalesce(p_patch,'{}'::jsonb)) loop
    if not k = any(ok) then raise exception 'not allowed: %', k; end if;
  end loop;
  r := jsonb_populate_record(null::bt_vehicles, p_patch - 'odo_at');
  update bt_vehicles v set
    purchase_price  = case when p_patch ? 'purchase_price'  then r.purchase_price  else v.purchase_price  end,
    purchase_date   = case when p_patch ? 'purchase_date'   then r.purchase_date   else v.purchase_date   end,
    life_limit_km   = case when p_patch ? 'life_limit_km'   then r.life_limit_km   else v.life_limit_km   end,
    sale_plan_date  = case when p_patch ? 'sale_plan_date'  then r.sale_plan_date  else v.sale_plan_date  end,
    sale_expected   = case when p_patch ? 'sale_expected'   then r.sale_expected   else v.sale_expected   end,
    sale_price      = case when p_patch ? 'sale_price'      then r.sale_price      else v.sale_price      end,
    sale_date       = case when p_patch ? 'sale_date'       then r.sale_date       else v.sale_date       end,
    sale_dest       = case when p_patch ? 'sale_dest'       then r.sale_dest       else v.sale_dest       end,
    exit_type       = case when p_patch ? 'exit_type'       then r.exit_type       else v.exit_type       end,
    current_mileage = case when p_patch ? 'current_mileage' then r.current_mileage else v.current_mileage end,
    specs           = case when p_patch ? 'odo_at' then coalesce(v.specs,'{}'::jsonb) || jsonb_build_object('odo_at', p_patch->>'odo_at') else v.specs end,
    updated_at      = now()
  where v.code = p_code;
  if not found then raise exception 'no vehicle: %', p_code; end if;
end $$;
revoke all on function public.bt_vehicle_view_update(text,text,jsonb) from public;
grant execute on function public.bt_vehicle_view_update(text,text,jsonb) to anon, authenticated;
