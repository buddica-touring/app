-- 2026-11-08 送迎車を送迎タスク（PU/BD）の必須情報に＋渋滞＋到着見込み（那覇と同じ設計・3店統一）
-- project ggqugvyskyiblxiycpci（高松 bt_*）
-- ・hdm_shuttle_vehicles：送迎車の一覧（高松は 白のハイエース 1002。bt_vehicles の送迎車と同じ車）
-- ・bt_tasks.sh_vehicle：そのタスクの送迎車（書くのは bt_staff_shuttle と bt_set_sh_vehicle だけ）
-- ・bt_sh_eta_min：出発からの所要分（実績3件以上→平均／位置→距離／無ければ5分）
-- ・bt_shuttle_status：vehicle・jam_min・jam_at・eta_at を追加（log は従来の5種類だけ）
-- ・bt_staff_view：sh_vehicle を追加
-- ・bt_staff_shuttle：送迎車（p_vehicle）と渋滞（p_min）を受け取る版に入れ替え。出発は送迎車が決まっていないと記録しない
-- 戻し：B_rollback.sql
BEGIN;


CREATE TABLE IF NOT EXISTS public.hdm_shuttle_vehicles (
  id text PRIMARY KEY,
  store text NOT NULL CHECK (store IN ('nha','spk','tkm')),
  label text NOT NULL,
  model text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '',
  plate text NOT NULL DEFAULT '',
  seats int,
  photo_url text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.hdm_shuttle_vehicles IS '2026-11-08 送迎車の一覧（お客様のマイページ・スタッフ画面・OPで同じものを表示）';
ALTER TABLE public.hdm_shuttle_vehicles ENABLE ROW LEVEL SECURITY;
DO $p$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='hdm_shuttle_vehicles' AND policyname='shv_read') THEN
    CREATE POLICY shv_read ON public.hdm_shuttle_vehicles FOR SELECT TO anon, authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='hdm_shuttle_vehicles' AND policyname='shv_write') THEN
    CREATE POLICY shv_write ON public.hdm_shuttle_vehicles FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $p$;
GRANT SELECT ON public.hdm_shuttle_vehicles TO anon, authenticated;
GRANT INSERT, UPDATE ON public.hdm_shuttle_vehicles TO authenticated;
INSERT INTO public.hdm_shuttle_vehicles(id,store,label,model,color,plate,seats,sort) VALUES
  ('tkm-1002','tkm','白のハイエース','ハイエース','白','1002',10,1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.bt_tasks ADD COLUMN IF NOT EXISTS sh_vehicle text;
COMMENT ON COLUMN public.bt_tasks.sh_vehicle IS '2026-11-08 送迎車（hdm_shuttle_vehicles.id）。bt_staff_shuttle と bt_set_sh_vehicle だけが書く';

-- OP・タスクサマリーから送迎車を選ぶ（ログイン中の社員だけ）
CREATE OR REPLACE FUNCTION public.bt_set_sh_vehicle(p_task_ids text[], p_vehicle text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $f$
DECLARE n int;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','auth'); END IF;
  IF coalesce(p_vehicle,'')<>'' AND NOT EXISTS (SELECT 1 FROM hdm_shuttle_vehicles WHERE id=p_vehicle AND store='tkm' AND active) THEN
    RETURN jsonb_build_object('ok',false,'error','bad_vehicle');
  END IF;
  UPDATE bt_tasks SET sh_vehicle=nullif(p_vehicle,''), updated_at=now()
   WHERE _id = ANY(coalesce(p_task_ids,'{}')) AND "内容" IN ('PU','PUB','BD','BDB') AND coalesce(deleted,false)=false;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'n',n);
END $f$;
REVOKE ALL ON FUNCTION public.bt_set_sh_vehicle(text[],text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.bt_set_sh_vehicle(text[],text) TO authenticated;

-- 出発からの所要分（高松空港宛て。店まで約5分）
CREATE OR REPLACE FUNCTION public.bt_sh_eta_min(p_kind text, p_dep timestamptz, p_lat double precision, p_lng double precision)
 RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
DECLARE h int := extract(hour from p_dep at time zone 'Asia/Tokyo')::int;
  da text := CASE WHEN p_kind='bd' THEN 'bd_depart' ELSE 'pu_depart' END;
  aa text := CASE WHEN p_kind='bd' THEN 'bd_at_airport' ELSE 'pu_at_stop' END;
  n int; m numeric; d double precision; spd double precision;
BEGIN
  IF p_dep IS NULL THEN RETURN 5; END IF;
  SELECT count(*), avg(mins) INTO n, m FROM (
    SELECT DISTINCT ON (dep) dep, extract(epoch from (arr-dep))/60 AS mins FROM (
      SELECT (SELECT (e->>'at')::timestamptz FROM jsonb_array_elements(t.sa_log) e WHERE e->>'a'=da LIMIT 1) AS dep,
             (SELECT (e->>'at')::timestamptz FROM jsonb_array_elements(t.sa_log) e WHERE e->>'a'=aa LIMIT 1) AS arr
        FROM bt_tasks t
       WHERE t.sa_log IS NOT NULL AND jsonb_typeof(t.sa_log)='array'
         AND t.date >= to_char((now() at time zone 'Asia/Tokyo')::date - 90,'YYYY-MM-DD')
    ) x
    WHERE dep IS NOT NULL AND arr IS NOT NULL AND arr > dep AND arr - dep < interval '90 minutes'
      AND extract(hour from dep at time zone 'Asia/Tokyo')::int = h
  ) y;
  IF n >= 3 THEN RETURN greatest(3, round(m)::int); END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    d := 6371 * 2 * asin(sqrt(power(sin(radians(34.2142-p_lat)/2),2) + cos(radians(p_lat))*cos(radians(34.2142))*power(sin(radians(134.0156-p_lng)/2),2)));
    spd := 30;
    RETURN least(60, greatest(3, ceil(d*1.3/spd*60 + 2)::int));
  END IF;
  RETURN 5;
END $f$;
GRANT EXECUTE ON FUNCTION public.bt_sh_eta_min(text,timestamptz,double precision,double precision) TO anon, authenticated;

-- マイページ用（log は従来の5種類のまま。vehicle・jam_min・jam_at・eta_at を追加）
CREATE OR REPLACE FUNCTION public.bt_shuttle_status(p_token text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
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
    CROSS JOIN LATERAL (SELECT CASE WHEN t."内容" IN ('BD','BDB') THEN 'bd' ELSE 'pu' END AS k) kk
    LEFT JOIN LATERAL (SELECT (e->>'at')::timestamptz AS at, (e->>'lat')::double precision AS lat, (e->>'lng')::double precision AS lng
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e WHERE e->>'a' = kk.k||'_depart' ORDER BY e->>'at' DESC LIMIT 1) dp ON true
    LEFT JOIN LATERAL (SELECT (e->>'at')::timestamptz AS at
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e WHERE e->>'a' = CASE kk.k WHEN 'bd' THEN 'bd_at_airport' ELSE 'pu_at_stop' END LIMIT 1) ar ON true
    LEFT JOIN LATERAL (SELECT (e->>'min')::int AS mn, e->>'at' AS at
                         FROM jsonb_array_elements(coalesce(t.sa_log,'[]'::jsonb)) e
                        WHERE e->>'a' = kk.k||'_jam' AND (dp.at IS NULL OR (e->>'at')::timestamptz >= dp.at) ORDER BY e->>'at' DESC LIMIT 1) j ON true
    WHERE length(coalesce(p_token,'')) >= 20
      AND r.mypage_token::text = p_token
      AND t."内容" IN ('PU','PUB','BD','BDB')
      AND coalesce(t.deleted,false) = false
      AND t.date::date >= (now() at time zone 'Asia/Tokyo')::date - 1
  ) x;
$function$;
REVOKE ALL ON FUNCTION public.bt_shuttle_status(text) FROM public;
GRANT EXECUTE ON FUNCTION public.bt_shuttle_status(text) TO anon, authenticated;

-- bt_staff_view：本番の定義をそのまま使い、sh_vehicle を足す（他は1文字も変えない）
DO $do$
DECLARE d text; d2 text; n1 int; n2 int;
BEGIN
  d := pg_get_functiondef('public.bt_staff_view(uuid)'::regprocedure);
  IF position('sh_vehicle' in d) > 0 THEN RAISE NOTICE 'bt_staff_view already has sh_vehicle'; RETURN; END IF;
  n1 := (length(d) - length(replace(d, 'coalesce(t.sa_log,''[]''::jsonb) as sa_log', ''))) / length('coalesce(t.sa_log,''[]''::jsonb) as sa_log');
  n2 := (length(d) - length(replace(d, '''sa_log'',sa_log)', ''))) / length('''sa_log'',sa_log)');
  IF n1 <> 1 OR n2 <> 1 THEN RAISE EXCEPTION 'bt_staff_view: 置換箇所が想定と違うため中止 (% / %)', n1, n2; END IF;
  d2 := replace(d, 'coalesce(t.sa_log,''[]''::jsonb) as sa_log', 'coalesce(t.sa_log,''[]''::jsonb) as sa_log, coalesce(t.sh_vehicle,'''') as sh_vehicle');
  d2 := replace(d2, '''sa_log'',sa_log)', '''sa_log'',sa_log,''sh_vehicle'',sh_vehicle)');
  EXECUTE d2;
END $do$;

-- bt_staff_shuttle：送迎車と渋滞を受け取る版へ入れ替え（同じ名前で引数が増えるため、古い5引数版を外してから作る。同じトランザクション内）
--   ・p_action に sh_vehicle（送迎車だけ登録）、pu_jam/bd_jam（渋滞 +p_min 分）を追加
--   ・pu_depart/bd_depart は送迎車が決まっていないと記録しない（p_vehicle を一緒に送れば登録して記録）
--   ・他（乗り場着のメール等）は1文字も変えない
DROP FUNCTION IF EXISTS public.bt_staff_shuttle(uuid,text,text,double precision,double precision);
CREATE OR REPLACE FUNCTION public.bt_staff_shuttle(p_token uuid, p_task_id text, p_action text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_vehicle text DEFAULT NULL, p_min integer DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_type text; v_resv text; v_cust text; v_date text; v_ok_types text[]; v_ev jsonb; v_at timestamptz := now();
        r record; v_url text; v_body text; v_footer text; v_mailed boolean := false; v_reason text := ''; v_cur_veh text;
BEGIN
  SELECT name INTO v_name FROM bt_staff WHERE share_token=p_token AND coalesce(active,true)=true;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  v_ok_types := CASE p_action
    WHEN 'pu_depart' THEN array['PU','PUB'] WHEN 'pu_at_stop' THEN array['PU','PUB'] WHEN 'pu_met' THEN array['PU','PUB']
    WHEN 'bd_depart' THEN array['BD','BDB'] WHEN 'bd_at_airport' THEN array['BD','BDB']
    WHEN 'pu_jam' THEN array['PU','PUB'] WHEN 'bd_jam' THEN array['BD','BDB']
    WHEN 'sh_vehicle' THEN array['PU','PUB','BD','BDB'] ELSE NULL END;
  IF v_ok_types IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unknown_action'); END IF;
  SELECT "内容","予約番号","予約者",date::text,sh_vehicle INTO v_type,v_resv,v_cust,v_date,v_cur_veh FROM bt_tasks WHERE _id=p_task_id AND coalesce(deleted,false)=false;
  IF v_type IS NULL THEN RETURN jsonb_build_object('ok',false,'error','task_not_found'); END IF;
  IF NOT (v_type = ANY(v_ok_types)) THEN RETURN jsonb_build_object('ok',false,'error','wrong_type'); END IF;
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
  RETURN jsonb_build_object('ok',true,'at',v_ev->>'at','mailed',v_mailed,'reason',v_reason,'staff',v_name,'vehicle',v_cur_veh);
END $function$;
REVOKE ALL ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision,text,integer) FROM public;
GRANT EXECUTE ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision,text,integer) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';

COMMIT;
