-- 売止ブロック（オーナー指示 2026-10-31）：閲覧リンク（?view=キー）から開いた時も、売止日までに後継車が未登録の車の
-- 「売止」ブロック（bt_maintenance label=売止, id=stop_<code>）を自動登録できるようにする。
-- 登録するのは無い車だけ（既にあれば触らない）。返り値＝全ての売止ブロック。ログイン時は画面から直接 bt_maintenance に書く。
create or replace function public.bt_vehicle_stop_sync(p_key text, p_rows jsonb)
returns setof json language plpgsql security definer set search_path = public as $$
declare w jsonb;
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  for w in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    if exists (select 1 from bt_vehicles where code = w->>'code')
       and not exists (select 1 from bt_maintenance where label='売止' and vehicle_code = w->>'code')
       and (w->>'start') ~ '^\d{4}-\d{2}-\d{2}$' and (w->>'end') ~ '^\d{4}-\d{2}-\d{2}$' then
      insert into bt_maintenance(id,vehicle_code,start_date,end_date,label,cost,actual_cost,workshop,invoice_no,maint_notes,status)
      values ('stop_'||(w->>'code'), w->>'code', w->>'start', w->>'end', '売止',0,0,'','','車両ダッシュボードから自動登録（売止）','approved')
      on conflict (id) do nothing;
      insert into bt_intake_actions(action_type,vehicle_code,target_date_from,target_date_to,notified_slack,payload)
      values ('intake_created', w->>'code', (w->>'start')::date, (w->>'end')::date, false, jsonb_build_object('action','intake_created','id','stop_'||(w->>'code'),'label','売止'));
    end if;
  end loop;
  return query select json_build_object('id',id,'vehicle_code',vehicle_code,'start_date',start_date,'end_date',end_date) from bt_maintenance where label='売止';
end $$;
revoke all on function public.bt_vehicle_stop_sync(text,jsonb) from public;
grant execute on function public.bt_vehicle_stop_sync(text,jsonb) to anon, authenticated;
