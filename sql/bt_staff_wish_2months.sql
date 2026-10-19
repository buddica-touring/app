-- 高松 希望休：入力できる月を「翌月以降」→「翌々月以降」に（2026-10-19・高松はシフト公開が早いため）
-- 変更は月判定2か所だけ（bt_staff_wish の not_future・bt_staff_shifts の editable）。シグネチャ不変＝CREATE OR REPLACE のみ。
-- 戻し方: bt_staff_wish_time.sql の2関数を再適用（DROP 行は不要）
BEGIN;

CREATE OR REPLACE FUNCTION public.bt_staff_wish(p_token text, p_date text, p_on boolean,
                                               p_from text DEFAULT '', p_to text DEFAULT '')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_today date := (now() at time zone 'Asia/Tokyo')::date; v_cur text; v_memo text := '';
        v_from text := coalesce(p_from,''); v_to text := coalesce(p_to,'');
BEGIN
  SELECT name INTO v_name FROM bt_staff WHERE share_token::text=p_token AND coalesce(active,true)=true;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_token'); END IF;
  IF p_date !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('ok',false,'error','bad_date'); END IF;
  IF date_trunc('month',p_date::date) < date_trunc('month',v_today) + interval '2 month' THEN
    RETURN jsonb_build_object('ok',false,'error','not_future','msg','翌々月以降の休み希望のみ入力できます'); END IF;
  -- 時間指定：両方あり・30分単位・8:00〜20:00・開始<終了。片方だけ／範囲外はエラー。両方空=終日。
  IF v_from<>'' OR v_to<>'' THEN
    IF v_from !~ '^(0[89]|1\d|20):(00|30)$' OR v_to !~ '^(0[89]|1\d|20):(00|30)$'
       OR v_from > '20:00' OR v_to > '20:00' OR v_from >= v_to THEN
      RETURN jsonb_build_object('ok',false,'error','bad_time','msg','時間は 8:00〜20:00 の範囲で、開始＜終了 にしてください'); END IF;
    v_memo := v_from||'-'||v_to;
  END IF;
  SELECT symbol INTO v_cur FROM bt_shifts WHERE staff_name=v_name AND date=p_date;
  IF p_on THEN
    IF coalesce(v_cur,'') NOT IN ('','希') THEN
      RETURN jsonb_build_object('ok',false,'error','locked','msg','すでに予定（'||v_cur||'）が入っています。担当者に連絡してください','symbol',v_cur); END IF;
    INSERT INTO bt_shifts(date,staff_name,symbol,memo) VALUES(p_date,v_name,'希',v_memo)
      ON CONFLICT (date,staff_name) DO UPDATE SET symbol='希', memo=v_memo
      WHERE coalesce(bt_shifts.symbol,'') IN ('','希');
    RETURN jsonb_build_object('ok',true,'symbol','希','memo',v_memo);
  ELSE
    IF coalesce(v_cur,'')='希' THEN
      UPDATE bt_shifts SET symbol='', memo='' WHERE staff_name=v_name AND date=p_date AND coalesce(symbol,'')='希';
      RETURN jsonb_build_object('ok',true,'symbol','');
    ELSIF coalesce(v_cur,'')='' THEN
      RETURN jsonb_build_object('ok',true,'symbol','');
    ELSE
      RETURN jsonb_build_object('ok',false,'error','locked','msg','この日は管理者の予定（'||v_cur||'）です','symbol',v_cur);
    END IF;
  END IF;
END; $function$;

GRANT EXECUTE ON FUNCTION public.bt_staff_wish(text,text,boolean,text,text) TO anon, authenticated, service_role;

-- 出勤簿の読込：希望休の行だけ memo(不可時間) を返す（出勤行の管理メモは返さない）
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
  v_editable := to_date(v_ym||'-01','YYYY-MM-DD') >= (date_trunc('month',v_today) + interval '2 month')::date;
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',date,'symbol',coalesce(symbol,''),'start',coalesce(start_time,''),'end',coalesce(end_time,''),
           'memo',CASE WHEN symbol='希' THEN coalesce(memo,'') ELSE '' END) ORDER BY date),'[]'::jsonb)
    INTO v_rows FROM bt_shifts WHERE staff_name=v_name AND date LIKE v_ym||'-%';
  RETURN jsonb_build_object('ok',true,'staff',v_name,'ym',v_ym,'today',to_char(v_today,'YYYY-MM-DD'),
    'cur_ym',to_char(v_today,'YYYY-MM'),'editable',v_editable,'shifts',v_rows);
END; $function$;

COMMIT;
