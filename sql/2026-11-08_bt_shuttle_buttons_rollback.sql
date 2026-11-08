-- 2026-11-08 高松 送迎ボタンの戻し。列 sa_log は残す（DROP しない）。関数は呼べないようにするだけ
DO $do$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.bt_staff_view(uuid)'::regprocedure);
  d := replace(d, ' coalesce(t.sa_log,''[]''::jsonb) as sa_log,', '');
  d := replace(d, ',''sa_log'',sa_log', '');
  EXECUTE d;
END $do$;
REVOKE EXECUTE ON FUNCTION public.bt_staff_shuttle(uuid,text,text,double precision,double precision) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bt_shuttle_status(text) FROM anon, authenticated;
