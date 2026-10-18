-- ROLLBACK: 新5引数版を消して旧3引数版・旧bt_staff_shiftsを戻す
BEGIN;
DROP FUNCTION IF EXISTS public.bt_staff_wish(text,text,boolean,text,text);
CREATE OR REPLACE FUNCTION public.bt_staff_shifts(p_token text, p_ym text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_today date := (now() at time zone 'Asia/Tokyo')::date;
        v_ym text := coalesce(nullif(p_ym,''), to_char((now() at time zone 'Asia/Tokyo'),'YYYY-MM'));
        v_rows jsonb; v_editable boolean;
BEGIN
  SELECT name INTO v_name FROM bt_staff WHERE share_token::text=p_token AND coalesce(active,true)=true;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  v_editable := to_date(v_ym||'-01','YYYY-MM-DD') > date_trunc('month',v_today)::date;
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',date,'symbol',coalesce(symbol,''),'start',coalesce(start_time,''),'end',coalesce(end_time,'')) ORDER BY date),'[]'::jsonb)
    INTO v_rows FROM bt_shifts WHERE staff_name=v_name AND date LIKE v_ym||'-%';
  RETURN jsonb_build_object('ok',true,'staff',v_name,'ym',v_ym,'today',to_char(v_today,'YYYY-MM-DD'),
    'cur_ym',to_char(v_today,'YYYY-MM'),'editable',v_editable,'shifts',v_rows);
END; $function$
;

CREATE OR REPLACE FUNCTION public.bt_staff_wish(p_token text, p_date text, p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_today date := (now() at time zone 'Asia/Tokyo')::date; v_cur text;
BEGIN
  SELECT name INTO v_name FROM bt_staff WHERE share_token::text=p_token AND coalesce(active,true)=true;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  IF p_date !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('ok',false,'error','bad_date'); END IF;
  IF date_trunc('month',p_date::date) <= date_trunc('month',v_today) THEN
    RETURN jsonb_build_object('ok',false,'error','not_future','msg','先の月の休み希望のみ入力できます'); END IF;
  SELECT symbol INTO v_cur FROM bt_shifts WHERE staff_name=v_name AND date=p_date;
  IF p_on THEN
    IF coalesce(v_cur,'') NOT IN ('','希') THEN
      RETURN jsonb_build_object('ok',false,'error','locked','msg','すでに予定（'||v_cur||'）が入っています。担当者に連絡してください','symbol',v_cur); END IF;
    INSERT INTO bt_shifts(date,staff_name,symbol) VALUES(p_date,v_name,'希')
      ON CONFLICT (date,staff_name) DO UPDATE SET symbol='希'
      WHERE coalesce(bt_shifts.symbol,'') IN ('','希');
    RETURN jsonb_build_object('ok',true,'symbol','希');
  ELSE
    IF coalesce(v_cur,'')='希' THEN
      UPDATE bt_shifts SET symbol='' WHERE staff_name=v_name AND date=p_date AND coalesce(symbol,'')='希';
      RETURN jsonb_build_object('ok',true,'symbol','');
    ELSIF coalesce(v_cur,'')='' THEN
      RETURN jsonb_build_object('ok',true,'symbol','');
    ELSE
      RETURN jsonb_build_object('ok',false,'error','locked','msg','この日は管理者の予定（'||v_cur||'）です','symbol',v_cur);
    END IF;
  END IF;
END; $function$
;
GRANT EXECUTE ON FUNCTION public.bt_staff_wish(text,text,boolean) TO anon, authenticated, service_role;
COMMIT;
