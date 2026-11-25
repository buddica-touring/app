CREATE OR REPLACE FUNCTION public.bt_staff_view(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_sur text; v_today date := (now() at time zone 'Asia/Tokyo')::date; v_res jsonb;
begin
  select name into v_name from bt_staff where share_token=p_token and coalesce(active,true)=true;
  if v_name is null then return jsonb_build_object('ok',false,'error','invalid_token'); end if;
  v_sur := split_part(v_name,' ',1);
  with base as (
    select t._id, t."内容" as type, t."予約者" as cust,
      coalesce(nullif(v.name,''),nullif(t."車種",''),t.assigned_vehicle) as veh_name,
      t."No" as plate, (t."確認"='true') as done, t."OTA" as ota,
      t."予約番号" as resv, t."担当" as assignee, r.mypage_token, r.brand as brand, coalesce(t.sa_log,'[]'::jsonb) as sa_log, coalesce(t.sh_vehicle,'') as sh_vehicle,
      r.del_flight as flight, r.status as r_status, r.start_date as r_start, r.end_date as r_end, r.return_type as return_type, r.del_place as r_del_place, r.col_place as r_col_place, r.pickup_time as pu_time, r.visit_type as visit_type,
      r.paid as paid, r.pay_url as pay_url, r.payment as payment,
      case when t."内容" in ('DEL','PU','PUB','来店','PUB来店','貸出','COL','BD','BDB','返却','返却待') then btrim(split_part(coalesce(r.memo,''),'##BCJ:',1)) else '' end as rmemo, /* 2026-11-24 予約の備考（読むだけ） */
      coalesce(nullif(r.final_price,0),r.price,0) as price,
      r.start_odo as start_odo, r.end_odo as end_odo, r.driven_km as driven_km,
      (exists(select 1 from license_uploads lu where lu.reservation_id=t."予約番号")) as lic,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type='terms_agree')) as terms,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type in ('damage_approval','damage_approve'))) as dmg,
      case when r.id is not null then coalesce(r.opt_b,0) else coalesce((nullif(t."B",''))::int,0) end as opt_b,
      case when r.id is not null then coalesce(r.opt_c,0) else coalesce((nullif(t."C",''))::int,0) end as opt_c,
      case when r.id is not null then coalesce(r.opt_j,0) else coalesce((nullif(t."J",''))::int,0) end as opt_j,
      case when r.id is not null then coalesce(r.opt_usb,0) else coalesce((nullif(t."USB",''))::int,0) end as opt_usb,
      case when t."内容" in ('洗車','返却後洗車') and t.changed_json is not null and t.changed_json ~ '"_nextDayWash":\s*true' then (t.date::date + 1) else t.date::date end as eff_date,
      public.bt_task_eff_time(t, r) as eff_time,
      public.bt_task_eff_place(t, r) as eff_place
    from bt_tasks t left join bt_reservations r on r.id=t."予約番号" left join bt_vehicles v on v.code=t.assigned_vehicle
    where coalesce(t.deleted,false)=false
  ),
  mine as (select * from base where ( replace(coalesce(assignee,''),' ','')=replace(v_name,' ','') or replace(coalesce(assignee,''),' ','')=v_sur ) and eff_date between v_today and v_today+14
    /* 2026-11-16 受付は予約が今も PU/BD で、その日が貸出/返却日の時だけ（APP btRecvHide と同じ導出） */
    and ( type not in ('出発受付','返却受付') or (
      lower(coalesce(r_status,'')) not in ('cancelled','canceled','cancel','キャンセル')
      and ( (type='出発受付' and eff_date::text = r_start and (
              coalesce(visit_type,'') in ('PU','PUB','BDB')
              or (coalesce(visit_type,'') not in ('来店','BD','DEL','COL') and coalesce(r_del_place,'') ~ '送迎バス|14番のりば|11番|高松空港|空港')))
         or (type='返却受付' and eff_date::text = r_end and (
              coalesce(return_type,'') in ('BD','PUB','BDB')
              or (coalesce(return_type,'') not in ('返却','PU','DEL','COL') and coalesce(r_col_place,'') ~ '送迎バス|14番のりば|11番|高松空港|空港'))) ) ) ))
  select coalesce(jsonb_agg(jsonb_build_object('_id',_id,'type',type,'date',eff_date,'time',eff_time,'customer',cust,'vehicle',veh_name,'plate',plate,'place',eff_place,'done',done,'ota',ota,'resv',resv,'rmemo',rmemo,'mypage',mypage_token,'paid',paid,'pay_url',pay_url,'payment',payment,'price',price,'opt_b',opt_b,'opt_c',opt_c,'opt_j',opt_j,'opt_usb',opt_usb,'lic',lic,'terms',terms,'damage',dmg,'start_odo',start_odo,'end_odo',end_odo,'driven_km',driven_km,'sa_log',sa_log,'sh_vehicle',sh_vehicle,'brand',brand,'flight',flight,'pu_time',pu_time,'visit_type',visit_type,'return_type',return_type,'del_place',r_del_place,'col_place',r_col_place) order by eff_date,eff_time),'[]'::jsonb)
  into v_res from mine;
  return jsonb_build_object('ok',true,'staff',v_name,'today',v_today,'tasks',v_res,'requests','[]'::jsonb,'skips','[]'::jsonb);
end $function$;
