-- 戻し（B）: 画面側を戻してから実行。列とテーブルは残す。関数だけ11/8以前の本番定義へ
BEGIN;
CREATE OR REPLACE FUNCTION public.bt_shuttle_status(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'type', t."内容",
      'date', t.date,
      'time', coalesce(nullif(t."変更",''), t."時間"),
      'done', (t."確認"='true'),
      'log', coalesce((SELECT jsonb_agg(jsonb_build_object('a', e->>'a', 'at', e->>'at') ORDER BY e->>'at')
                       FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e), '[]'::jsonb)
    ) ORDER BY t.date), '[]'::jsonb)
  FROM bt_reservations r
  JOIN bt_tasks t ON t."予約番号" = r.id
  WHERE length(coalesce(p_token,'')) >= 20
    AND r.mypage_token::text = p_token
    AND t."内容" IN ('PU','PUB','BD','BDB')
    AND coalesce(t.deleted,false) = false
    AND t.date::date >= (now() at time zone 'Asia/Tokyo')::date - 1;
$function$
;

DROP FUNCTION IF EXISTS public.bt_staff_shuttle(uuid,text,text,double precision,double precision,text,integer);
CREATE OR REPLACE FUNCTION public.bt_staff_shuttle(p_token uuid, p_task_id text, p_action text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_type text; v_resv text; v_cust text; v_date text; v_ok_types text[]; v_ev jsonb; v_at timestamptz := now();
        r record; v_url text; v_body text; v_footer text; v_mailed boolean := false; v_reason text := '';
BEGIN
  SELECT name INTO v_name FROM bt_staff WHERE share_token=p_token AND coalesce(active,true)=true;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  v_ok_types := CASE p_action
    WHEN 'pu_depart' THEN array['PU','PUB'] WHEN 'pu_at_stop' THEN array['PU','PUB'] WHEN 'pu_met' THEN array['PU','PUB']
    WHEN 'bd_depart' THEN array['BD','BDB'] WHEN 'bd_at_airport' THEN array['BD','BDB'] ELSE NULL END;
  IF v_ok_types IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unknown_action'); END IF;
  SELECT "内容","予約番号","予約者",date::text INTO v_type,v_resv,v_cust,v_date FROM bt_tasks WHERE _id=p_task_id AND coalesce(deleted,false)=false;
  IF v_type IS NULL THEN RETURN jsonb_build_object('ok',false,'error','task_not_found'); END IF;
  IF NOT (v_type = ANY(v_ok_types)) THEN RETURN jsonb_build_object('ok',false,'error','wrong_type'); END IF;
  v_ev := jsonb_build_object('a',p_action,'at',to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'by',v_name);
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND abs(p_lat)<=90 AND abs(p_lng)<=180 AND NOT (p_lat=0 AND p_lng=0) THEN
    v_ev := v_ev || jsonb_build_object('lat',p_lat,'lng',p_lng);
  END IF;
  UPDATE bt_tasks SET sa_log = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce(sa_log,'[]'::jsonb)) e WHERE e->>'a' IS DISTINCT FROM p_action),'[]'::jsonb) || jsonb_build_array(v_ev)
   WHERE _id=p_task_id;
  IF p_action='pu_at_stop' THEN
    IF nullif(v_resv,'') IS NULL THEN v_reason := 'no_resv';
    ELSE
      SELECT id,name,mail,brand,status,mypage_token INTO r FROM bt_reservations WHERE id=v_resv;
      IF r.id IS NULL THEN v_reason := 'resv_not_found';
      ELSIF coalesce(r.brand,'')<>'HDM' THEN v_reason := 'not_hdm';
      ELSIF lower(coalesce(r.status,'')) ~ 'cancel' OR coalesce(r.status,'') ~ 'キャンセル' THEN v_reason := 'cancelled';
      ELSIF nullif(btrim(coalesce(r.mail,'')),'') IS NULL THEN v_reason := 'no_mail';
      ELSE
        v_url := CASE WHEN r.mypage_token IS NOT NULL THEN 'https://nosh2318.github.io/spk-task/my-tkm.html?t='||r.mypage_token::text ELSE '' END;
        SELECT body INTO v_footer FROM hdm_tkm_templates WHERE key='_footer';
        v_body := coalesce(nullif(r.name,''),nullif(v_cust,''),'お客様')||'様'||E'\n\n'
          ||'送迎スタッフが乗り場に到着いたしました。'||E'\n'
          ||'お手荷物をお受け取りのうえ、乗り場までお越しくださいませ。'||E'\n'
          ||'乗り場の場所はマイページでご確認いただけます。'
          ||CASE WHEN v_url<>'' THEN E'\n'||v_url ELSE '' END
          ||E'\n\n'||coalesce(v_footer,'HANDYMAN 高松空港店');
        INSERT INTO hdm_tkm_notifications(reservation_id,kind,to_email,subject,body,log_key)
        VALUES (r.id,'pu_at_stop',btrim(r.mail),'【HANDYMAN 高松空港店】送迎スタッフが乗り場に到着しました',v_body,'pu_at_stop:'||p_task_id)
        ON CONFLICT (log_key) DO NOTHING;
        v_mailed := FOUND; IF NOT v_mailed THEN v_reason := 'already_sent'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'at',v_ev->>'at','mailed',v_mailed,'reason',v_reason,'staff',v_name);
END $function$
;

GRANT EXECUTE ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision) TO anon, authenticated;
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
      t."予約番号" as resv, t."担当" as assignee, r.mypage_token, coalesce(t.sa_log,'[]'::jsonb) as sa_log,
      r.paid as paid, r.pay_url as pay_url, r.payment as payment,
      coalesce(nullif(r.final_price,0),r.price,0) as price,
      r.start_odo as start_odo, r.end_odo as end_odo, r.driven_km as driven_km,
      (exists(select 1 from license_uploads lu where lu.reservation_id=t."予約番号")) as lic,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type='terms_agree')) as terms,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type='damage_approval')) as dmg,
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
  mine as (select * from base where ( replace(coalesce(assignee,''),' ','')=replace(v_name,' ','') or replace(coalesce(assignee,''),' ','')=v_sur ) and eff_date between v_today and v_today+14)
  select coalesce(jsonb_agg(jsonb_build_object('_id',_id,'type',type,'date',eff_date,'time',eff_time,'customer',cust,'vehicle',veh_name,'plate',plate,'place',eff_place,'done',done,'ota',ota,'resv',resv,'mypage',mypage_token,'paid',paid,'pay_url',pay_url,'payment',payment,'price',price,'opt_b',opt_b,'opt_c',opt_c,'opt_j',opt_j,'opt_usb',opt_usb,'lic',lic,'terms',terms,'damage',dmg,'start_odo',start_odo,'end_odo',end_odo,'driven_km',driven_km,'sa_log',sa_log) order by eff_date,eff_time),'[]'::jsonb)
  into v_res from mine;
  return jsonb_build_object('ok',true,'staff',v_name,'today',v_today,'tasks',v_res,'requests','[]'::jsonb,'skips','[]'::jsonb);
end $function$
;

NOTIFY pgrst, 'reload schema';
COMMIT;
