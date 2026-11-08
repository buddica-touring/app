-- 2026-11-08 高松 送迎（PU/BD）のボタン記録（那覇 2026-11-08_nha_shuttle_buttons と同じ設計・3店統一）
-- ・bt_tasks.sa_log：押した記録 [{a,at,by,lat?,lng?}]（書くのは bt_staff_shuttle だけ。1ボタン1件・押し直しは最新時刻で上書き・行単位で一括更新＝取り合いなし）
-- ・bt_staff_view：各タスクに sa_log を返す
-- ・bt_staff_shuttle：スタッフ画面のボタン。「乗り場着」だけ HANDYMAN 予約のお客様へメール（高松は LINE なし。hdm_tkm_notifications 経由で1分以内に送信）
-- ・bt_shuttle_status：マイページ(my-tkm)用。何を何時に押したかだけ（スタッフ名・位置は返さない）
-- 戻し：2026-11-08_bt_shuttle_buttons_rollback.sql

alter table public.bt_tasks add column if not exists sa_log jsonb;
comment on column public.bt_tasks.sa_log is '2026-11-08 送迎(PU/BD)ボタンの押下記録 [{a,at,by}]。bt_staff_shuttle だけが書く';

-- bt_staff_view：本番の定義をそのまま使い、sa_log の2か所だけ足す（他の行は1文字も変えない）
DO $do$
DECLARE d text; d2 text;
BEGIN
  d := pg_get_functiondef('public.bt_staff_view(uuid)'::regprocedure);
  IF position('sa_log' in d) > 0 THEN RAISE NOTICE 'bt_staff_view already has sa_log'; RETURN; END IF;
  d2 := replace(d, 'r.mypage_token,', 'r.mypage_token, coalesce(t.sa_log,''[]''::jsonb) as sa_log,');
  d2 := replace(d2, '''driven_km'',driven_km)', '''driven_km'',driven_km,''sa_log'',sa_log)');
  IF (length(d2) - length(d)) <> (length(' coalesce(t.sa_log,''[]''::jsonb) as sa_log,') + length(',''sa_log'',sa_log')) THEN
    RAISE EXCEPTION 'bt_staff_view: 置換箇所が想定と違うため中止';
  END IF;
  EXECUTE d2;
END $do$;

CREATE OR REPLACE FUNCTION public.bt_staff_shuttle(p_token uuid, p_task_id text, p_action text, p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL)
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
  -- 1行の中で「同じボタンの古い記録を外して新しい記録を足す」を一度に行う（押し直しは最新時刻で上書き）
  UPDATE bt_tasks SET sa_log = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce(sa_log,'[]'::jsonb)) e WHERE e->>'a' IS DISTINCT FROM p_action),'[]'::jsonb) || jsonb_build_array(v_ev)
   WHERE _id=p_task_id;
  -- 「乗り場着」だけお客様へメール（HANDYMAN 予約・メールあり・キャンセルでない）。同じタスクには1通だけ
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
END $function$;
REVOKE ALL ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision) FROM public;
GRANT EXECUTE ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision) TO anon, authenticated;

-- マイページ(my-tkm)用：お客様の予約の送迎タスク（昨日以降）と押された記録（a と at だけ）
CREATE OR REPLACE FUNCTION public.bt_shuttle_status(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
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
$function$;
REVOKE ALL ON FUNCTION public.bt_shuttle_status(text) FROM public;
GRANT EXECUTE ON FUNCTION public.bt_shuttle_status(text) TO anon, authenticated;

-- マイページ管理（mypage-active.html）用：今日の送迎ボタンを マイページの鍵ごとに「何を何時に押したか」だけ返す（札幌・那覇の mpadmin_handoff と同じ形）
CREATE OR REPLACE FUNCTION public.mpadmin_handoff_bt(p_tokens text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
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
     WHERE coalesce(t.deleted,false) = false AND t."内容" IN ('PU','PUB','BD','BDB')
       AND (e->>'at') IS NOT NULL AND (e->>'at')::timestamptz >= d.from_ts
  ),
  m AS (SELECT token, k, max(at) AS at FROM ev GROUP BY 1,2)
  SELECT coalesce(jsonb_object_agg(token, acts), '{}'::jsonb)
    FROM (SELECT token, jsonb_object_agg(k, to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) AS acts FROM m GROUP BY token) x;
$function$;
REVOKE ALL ON FUNCTION public.mpadmin_handoff_bt(text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.mpadmin_handoff_bt(text[]) TO anon, authenticated;
