-- 適用後の確認（B）。最後に必ず例外を出して全部ロールバックする＝データは残らない
DO $t$
DECLARE tid text; tok text; stok uuid; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; st jsonb; o jsonb;
BEGIN
  SELECT share_token INTO stok FROM bt_staff WHERE coalesce(active,true) AND share_token IS NOT NULL LIMIT 1;
  SELECT t._id, r0.mypage_token::text INTO tid, tok FROM bt_tasks t JOIN bt_reservations r0 ON r0.id=t."予約番号"
   WHERE t."内容"='PU' AND coalesce(t.deleted,false)=false AND t.date>=to_char((now() at time zone 'Asia/Tokyo')::date,'YYYY-MM-DD') AND r0.mypage_token IS NOT NULL ORDER BY t.date LIMIT 1;
  UPDATE bt_tasks SET date=to_char((now() at time zone 'Asia/Tokyo')::date,'YYYY-MM-DD'), sh_vehicle=NULL, sa_log=NULL WHERE _id=tid;
  r1 := public.bt_staff_shuttle(stok, tid, 'pu_depart');                                   -- 車なし→ need_vehicle
  r2 := public.bt_staff_shuttle(stok, tid, 'pu_depart', 34.3150, 134.0460, 'tkm-1002');    -- 車あり→ ok
  r3 := public.bt_staff_shuttle(stok, tid, 'pu_jam', NULL, NULL, NULL, 10);                -- 渋滞+10
  r4 := public.bt_staff_shuttle(stok, tid, 'pu_jam', NULL, NULL, NULL, 99);                -- 範囲外→ bad_min
  st := public.bt_shuttle_status(tok);
  SELECT e INTO o FROM jsonb_array_elements(st) e WHERE e->'vehicle' IS NOT NULL AND e->'vehicle'<>'null'::jsonb LIMIT 1;
  RAISE EXCEPTION 'TEST_RESULT r1=% | r2.ok=% veh=% | r3.ok=% | r4=% | status=% | staff_view_has=%', r1->>'error', r2->>'ok', r2->>'vehicle', r3->>'ok', r4->>'error', o,
    position('sh_vehicle' in pg_get_functiondef('public.bt_staff_view(uuid)'::regprocedure))>0;
END $t$;
