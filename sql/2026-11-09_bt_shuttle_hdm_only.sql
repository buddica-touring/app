-- 2026-11-09 nosh：高松の送迎ボタン（出発/乗り場着/合流/空港着）・送迎車・押し忘れ通知を HANDYMAN 予約だけに。
--   HDM は 貸出(不明)=貸出/DEL・返却(不明)=返却待/COL も対象（押さないとマイページが進まない）。BUDDICA は対象外（押してもお客様に何も届かない）。
--   既存行の一括書換なし。送迎車が1台だけの時は、出発を押した時にその1件にだけ書く。戻し＝2026-11-09_bt_shuttle_hdm_only_rollback.sql
BEGIN;
CREATE OR REPLACE FUNCTION public.bt_staff_shuttle_by(p_name text, p_task_id text, p_action text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_vehicle text DEFAULT NULL::text, p_min integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_type text; v_resv text; v_cust text; v_date text; v_ok_types text[]; v_ev jsonb; v_at timestamptz := now();
        r record; v_brand text; v_url text; v_body text; v_footer text; v_mailed boolean := false; v_reason text := ''; v_cur_veh text;
BEGIN
  v_name := nullif(trim(coalesce(p_name,'')),'');
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  IF p_action LIKE 'undo:%' THEN
    IF substr(p_action,6) NOT IN ('pu_depart','pu_at_stop','pu_met','bd_depart','bd_at_airport','pu_jam','bd_jam') THEN
      RETURN jsonb_build_object('ok',false,'error','bad_target');
    END IF;
    UPDATE bt_tasks SET sa_log = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce(sa_log,'[]'::jsonb)) e WHERE e->>'a' IS DISTINCT FROM substr(p_action,6)),'[]'::jsonb)
     WHERE _id=p_task_id AND coalesce(deleted,false)=false;
    RETURN jsonb_build_object('ok',true,'undone',FOUND,'target',substr(p_action,6),'staff',v_name);
  END IF;
  v_ok_types := CASE p_action
    WHEN 'pu_depart' THEN array['PU','PUB','貸出','DEL'] WHEN 'pu_at_stop' THEN array['PU','PUB','貸出','DEL'] WHEN 'pu_met' THEN array['PU','PUB','貸出','DEL']
    WHEN 'bd_depart' THEN array['BD','BDB','返却待','COL'] WHEN 'bd_at_airport' THEN array['BD','BDB','返却待','COL']
    WHEN 'pu_jam' THEN array['PU','PUB','貸出','DEL'] WHEN 'bd_jam' THEN array['BD','BDB','返却待','COL']
    WHEN 'sh_vehicle' THEN array['PU','PUB','貸出','DEL','BD','BDB','返却待','COL'] ELSE NULL END;
  IF v_ok_types IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unknown_action'); END IF;
  SELECT "内容","予約番号","予約者",date::text,sh_vehicle INTO v_type,v_resv,v_cust,v_date,v_cur_veh FROM bt_tasks WHERE _id=p_task_id AND coalesce(deleted,false)=false;
  IF v_type IS NULL THEN RETURN jsonb_build_object('ok',false,'error','task_not_found'); END IF;
  IF NOT (v_type = ANY(v_ok_types)) THEN RETURN jsonb_build_object('ok',false,'error','wrong_type'); END IF;
  -- 2026-11-09 nosh：送迎ボタンは HANDYMAN 予約だけ（BUDDICA は押してもお客様に何も届かない）
  SELECT brand INTO v_brand FROM bt_reservations WHERE id=v_resv;
  IF coalesce(v_brand,'')<>'HDM' THEN RETURN jsonb_build_object('ok',false,'error','not_hdm'); END IF;
  IF p_action <> 'sh_vehicle' AND left(coalesce(v_date,''),10) > to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD') THEN
    RETURN jsonb_build_object('ok',false,'error','future_date');
  END IF;
  -- 送迎車（必須情報）
  IF nullif(p_vehicle,'') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hdm_shuttle_vehicles WHERE id=p_vehicle AND store='tkm' AND active) THEN
      RETURN jsonb_build_object('ok',false,'error','bad_vehicle');
    END IF;
    UPDATE bt_tasks SET sh_vehicle=p_vehicle WHERE _id=p_task_id;
    v_cur_veh := p_vehicle;
  END IF;
  IF p_action='sh_vehicle' THEN
    IF nullif(p_vehicle,'') IS NULL THEN RETURN jsonb_build_object('ok',false,'error','need_vehicle'); END IF;
    RETURN jsonb_build_object('ok',true,'vehicle',v_cur_veh,'staff',v_name);
  END IF;
  -- 2026-11-09 送迎車が1台だけの時はその車（この1件にだけ書く。APP/バイト用ページの表示と同じ）
  IF p_action IN ('pu_depart','bd_depart') AND nullif(v_cur_veh,'') IS NULL
     AND (SELECT count(*) FROM hdm_shuttle_vehicles WHERE store='tkm' AND active)=1 THEN
    SELECT id INTO v_cur_veh FROM hdm_shuttle_vehicles WHERE store='tkm' AND active;
    UPDATE bt_tasks SET sh_vehicle=v_cur_veh WHERE _id=p_task_id;
  END IF;
  IF p_action IN ('pu_depart','bd_depart') AND nullif(v_cur_veh,'') IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','need_vehicle');
  END IF;
  IF p_action IN ('pu_jam','bd_jam') AND (p_min IS NULL OR p_min < 5 OR p_min > 60) THEN
    RETURN jsonb_build_object('ok',false,'error','bad_min');
  END IF;
  v_ev := jsonb_build_object('a',p_action,'at',to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'by',v_name);
  IF p_action IN ('pu_jam','bd_jam') THEN v_ev := v_ev || jsonb_build_object('min',p_min); END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND abs(p_lat)<=90 AND abs(p_lng)<=180 AND NOT (p_lat=0 AND p_lng=0) THEN
    v_ev := v_ev || jsonb_build_object('lat',p_lat,'lng',p_lng);
  END IF;
  UPDATE bt_tasks SET sa_log = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce(sa_log,'[]'::jsonb)) e WHERE e->>'a' IS DISTINCT FROM p_action),'[]'::jsonb) || jsonb_build_array(v_ev)
   WHERE _id=p_task_id;
  IF p_action IN ('pu_at_stop','pu_depart','pu_jam','bd_at_airport') THEN
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
          ||CASE p_action
              WHEN 'pu_depart' THEN '送迎車が空港の乗り場へ出発しました。'||E'\n'||'乗り場への到着は'||to_char((v_at + make_interval(mins => public.bt_sh_eta_min('pu', v_at, p_lat, p_lng))) at time zone 'Asia/Tokyo','FMHH24時MI分')||'前後（目安）です。'||E'\n'||'乗り場の場所・送迎車の写真はマイページでご確認いただけます。'
              WHEN 'pu_jam' THEN '道路の混雑により、送迎車が約'||p_min||'分遅れております。'||E'\n'||'ご迷惑をおかけし、誠に申し訳ございません。最新の到着の目安はマイページでご確認いただけます。'
              WHEN 'bd_at_airport' THEN '空港に到着いたしました。お忘れ物がないか、いま一度ご確認くださいませ。'||E'\n'||'この度はHANDYMANをご利用いただき、誠にありがとうございました。'
              ELSE '送迎スタッフが乗り場に到着いたしました。'||E'\n'
          ||'お手荷物をお受け取りのうえ、乗り場までお越しくださいませ。'||E'\n'
          ||'乗り場の場所はマイページでご確認いただけます。' END
          ||CASE WHEN v_url<>'' THEN E'\n'||v_url ELSE '' END
          ||E'\n\n'||coalesce(v_footer,'HANDYMAN 高松空港店');
        INSERT INTO hdm_tkm_notifications(reservation_id,kind,to_email,subject,body,log_key)
        VALUES (r.id,p_action,btrim(r.mail),
                '【HANDYMAN 高松空港店】'||CASE p_action WHEN 'pu_depart' THEN '送迎車が乗り場へ出発しました' WHEN 'pu_jam' THEN '送迎車が遅れています' WHEN 'bd_at_airport' THEN 'ご利用ありがとうございました' ELSE '送迎スタッフが乗り場に到着しました' END,
                v_body, p_action||':'||p_task_id||CASE WHEN p_action='pu_jam' THEN ':'||p_min||':'||floor(extract(epoch from v_at)/900)::bigint ELSE '' END)
        ON CONFLICT (log_key) DO NOTHING;
        v_mailed := FOUND; IF NOT v_mailed THEN v_reason := 'already_sent'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'at',v_ev->>'at','mailed',v_mailed,'reason',v_reason,'staff',v_name,'vehicle',v_cur_veh);
END $function$;

CREATE OR REPLACE FUNCTION public.bt_set_sh_vehicle(p_task_ids text[], p_vehicle text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n int;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','auth'); END IF;
  IF coalesce(p_vehicle,'')<>'' AND NOT EXISTS (SELECT 1 FROM hdm_shuttle_vehicles WHERE id=p_vehicle AND store='tkm' AND active) THEN
    RETURN jsonb_build_object('ok',false,'error','bad_vehicle');
  END IF;
  UPDATE bt_tasks t SET sh_vehicle=nullif(p_vehicle,''), updated_at=now()
   WHERE t._id = ANY(coalesce(p_task_ids,'{}')) AND t."内容" IN ('PU','PUB','貸出','DEL','BD','BDB','返却待','COL') AND coalesce(t.deleted,false)=false
     AND EXISTS (SELECT 1 FROM bt_reservations r WHERE r.id=t."予約番号" AND r.brand='HDM');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'n',n);
END $function$;

CREATE OR REPLACE FUNCTION public._bt_task_sh_default()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v text; n int;
BEGIN
  IF NEW."内容" IN ('PU','PUB','貸出','DEL','BD','BDB','返却待','COL') AND nullif(NEW.sh_vehicle,'') IS NULL
     AND EXISTS (SELECT 1 FROM bt_reservations r WHERE r.id=NEW."予約番号" AND r.brand='HDM') THEN
    SELECT count(*), min(id) INTO n, v FROM hdm_shuttle_vehicles WHERE store='tkm' AND active;
    IF n = 1 THEN NEW.sh_vehicle := v; END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.bt_shuttle_status(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_agg(x.o ORDER BY x.d), '[]'::jsonb) FROM (
    SELECT t.date AS d, jsonb_build_object(
      'type', t."内容",
      'date', t.date,
      'time', coalesce(nullif(t."変更",''), t."時間"),
      'done', (t."確認"='true'),
      'log', coalesce((SELECT jsonb_agg(jsonb_build_object('a', e->>'a', 'at', e->>'at') ORDER BY e->>'at')
                       FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e
                       WHERE e->>'a' IN ('pu_depart','pu_at_stop','pu_met','bd_depart','bd_at_airport')), '[]'::jsonb),
      'vehicle', (SELECT jsonb_build_object('label',v.label,'model',v.model,'color',v.color,'plate',v.plate,'photo',nullif(v.photo_url,''))
                    FROM hdm_shuttle_vehicles v WHERE v.id = t.sh_vehicle),
      'jam_min', j.mn,
      'jam_at', j.at,
      'eta_at', CASE WHEN dp.at IS NOT NULL AND ar.at IS NULL THEN
                  to_char((dp.at + make_interval(mins => public.bt_sh_eta_min(kk.k, dp.at, dp.lat, dp.lng) + coalesce(j.mn,0))) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END
    ) AS o
    FROM bt_reservations r
    JOIN bt_tasks t ON t."予約番号" = r.id
    CROSS JOIN LATERAL (SELECT CASE WHEN t."内容" IN ('BD','BDB','返却待','COL') THEN 'bd' ELSE 'pu' END AS k) kk
    LEFT JOIN LATERAL (SELECT (e->>'at')::timestamptz AS at, (e->>'lat')::double precision AS lat, (e->>'lng')::double precision AS lng
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e WHERE e->>'a' = kk.k||'_depart' ORDER BY e->>'at' DESC LIMIT 1) dp ON true
    LEFT JOIN LATERAL (SELECT (e->>'at')::timestamptz AS at
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e WHERE e->>'a' = CASE kk.k WHEN 'bd' THEN 'bd_at_airport' ELSE 'pu_at_stop' END LIMIT 1) ar ON true
    LEFT JOIN LATERAL (SELECT (e->>'min')::int AS mn, e->>'at' AS at
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e
                        WHERE e->>'a' = kk.k||'_jam' AND (dp.at IS NULL OR (e->>'at')::timestamptz >= dp.at) ORDER BY e->>'at' DESC LIMIT 1) j ON true
    WHERE length(coalesce(p_token,'')) >= 20
      AND r.mypage_token::text = p_token
      AND t."内容" IN ('PU','PUB','貸出','DEL','BD','BDB','返却待','COL')
      AND r.brand = 'HDM'
      AND coalesce(t.deleted,false) = false
      AND t.date::date >= (now() at time zone 'Asia/Tokyo')::date - 1
  ) x;
$function$;

CREATE OR REPLACE FUNCTION public.bt_staff_press_watch(p_notify boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _today text := to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD');
  _tok text := private.slack_bot_token('slack_bot_token');
  g record; _msg text; _rid bigint; _out jsonb := '[]'::jsonb;
begin
  for g in
    with t as (
      select case when tk."内容" in ('PU','PUB','貸出','DEL') then 'PU' else 'BD' end typ, coalesce(nullif(tk."変更",''), nullif(tk."時間",''),
               case when tk."内容" in ('PU','PUB','貸出','DEL') then r.start_time else r.end_time end) hm,
             coalesce(nullif(btrim(tk."担当"),''),'担当未定') who,
             exists(select 1 from jsonb_array_elements(coalesce(tk.sa_log,'[]'::jsonb)) e where e->>'a'='pu_depart') dep,
             exists(select 1 from jsonb_array_elements(coalesce(tk.sa_log,'[]'::jsonb)) e where e->>'a'='pu_at_stop') stp,
             exists(select 1 from jsonb_array_elements(coalesce(tk.sa_log,'[]'::jsonb)) e where e->>'a'='bd_at_airport') air
        from bt_tasks tk left join bt_reservations r on r.id = tk."予約番号"
       where tk.date = _today and coalesce(tk.deleted,false) = false
         and tk."内容" in ('PU','PUB','貸出','DEL','BD','BDB','返却待','COL')
         and r.brand = 'HDM'
         and coalesce(tk."確認"::text,'') <> 'true'
         and not (lower(coalesce(r.status,'')) ~ 'cancel' or coalesce(r.status,'') ~ 'キャンセル')
    ), m as (
      select *, extract(epoch from ((_today||' '||hm||':00')::timestamp at time zone 'Asia/Tokyo' - now()))/60 mins
        from t where hm ~ '^\d{1,2}:\d{2}$'
    ), s as (
      select *, case
        when typ = 'PU' and not dep and not stp and mins > 10 and mins <= 15 then 'pre'
        when typ = 'PU' and not dep and not stp and mins > -5 and mins <= 0 then 'late'
        when typ = 'PU' and not stp and mins > -10 and mins <= -5 then 'nostop'
        when typ = 'BD' and not air and mins > -35 and mins <= -30 then 'noair'
        else null end slot
      from m
    )
    select typ, hm, slot, count(*) n, string_agg(distinct who, '・') who from s where slot is not null group by 1,2,3
  loop
    _msg := case g.slot
      when 'pre'    then '⏰ 【高松】'||g.hm||' 空港お迎え（'||g.n||'名）の「出発」がまだ押されていません。担当：'||g.who
      when 'late'   then '🔴 【高松】'||g.hm||' 空港お迎え（'||g.n||'名）時刻を過ぎても「出発」が押されていません。お客様のマイページは「出発のお知らせがまだ」のままです。担当：'||g.who
      when 'nostop' then '🔴 【高松】'||g.hm||' 空港お迎え（'||g.n||'名）時刻を過ぎても「乗り場着」が押されていません。お客様に「乗り場に着きました」が届いていません。担当：'||g.who
      else               '🔴 【高松】'||g.hm||' 空港お送り（'||g.n||'名）30分過ぎても「空港着」が押されていません。担当：'||g.who end;
    _rid := null;
    if p_notify then
      begin
        select net.http_post(url:='https://slack.com/api/chat.postMessage',
          headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||_tok),
          body:=jsonb_build_object('channel','C0BFMBLEJGZ','text',_msg)) into _rid;
      exception when others then null; end;
    end if;
    insert into staff_press_alerts(store, ref, kind, slot, message, posted) values ('tkm', g.typ||'|'||g.hm, lower(g.typ), g.slot, _msg, _rid is not null);
    _out := _out || jsonb_build_object('typ',g.typ,'hm',g.hm,'slot',g.slot,'n',g.n);
  end loop;
  return jsonb_build_object('today',_today,'alerted',_out);
end $function$;

CREATE OR REPLACE FUNCTION public.mpadmin_handoff_bt(p_tokens text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH tk AS (
    SELECT DISTINCT x AS token FROM unnest(coalesce(p_tokens,'{}'::text[])) x
     WHERE length(coalesce(x,'')) >= 20 LIMIT 500
  ),
  d AS (SELECT (((now() at time zone 'Asia/Tokyo')::date)::timestamp at time zone 'Asia/Tokyo') AS from_ts),
  ev AS (
    SELECT r.mypage_token::text AS token, e->>'a' AS k, (e->>'at')::timestamptz AS at
      FROM bt_reservations r JOIN tk ON tk.token = r.mypage_token::text
      JOIN bt_tasks t ON t."予約番号" = r.id, d,
           jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e
     WHERE coalesce(t.deleted,false) = false AND t."内容" IN ('PU','PUB','貸出','DEL','BD','BDB','返却待','COL') AND r.brand = 'HDM'
       AND (e->>'at') IS NOT NULL AND (e->>'at')::timestamptz >= d.from_ts
  ),
  m AS (SELECT token, k, max(at) AS at FROM ev GROUP BY 1,2)
  SELECT coalesce(jsonb_object_agg(token, acts), '{}'::jsonb)
    FROM (SELECT token, jsonb_object_agg(k, to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) AS acts FROM m GROUP BY token) x;
$function$;

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
  select coalesce(jsonb_agg(jsonb_build_object('_id',_id,'type',type,'date',eff_date,'time',eff_time,'customer',cust,'vehicle',veh_name,'plate',plate,'place',eff_place,'done',done,'ota',ota,'resv',resv,'mypage',mypage_token,'paid',paid,'pay_url',pay_url,'payment',payment,'price',price,'opt_b',opt_b,'opt_c',opt_c,'opt_j',opt_j,'opt_usb',opt_usb,'lic',lic,'terms',terms,'damage',dmg,'start_odo',start_odo,'end_odo',end_odo,'driven_km',driven_km,'sa_log',sa_log,'sh_vehicle',sh_vehicle,'brand',brand) order by eff_date,eff_time),'[]'::jsonb)
  into v_res from mine;
  return jsonb_build_object('ok',true,'staff',v_name,'today',v_today,'tasks',v_res,'requests','[]'::jsonb,'skips','[]'::jsonb);
end $function$;

COMMIT;
