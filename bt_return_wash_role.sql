-- ============================================================
-- 【BT 高松】返却後洗車 を別役割 'RWASH' に (2026-08-09)
-- 目的: 返却後洗車(type=返却後洗車・_id rw-*)を、前日洗車(WASH)とは
--       別枠にする。同一予約が「前日洗車(w-)」と「返却後洗車(rw-)」の
--       両方を持つため、bt_task_role が両方WASHだと collapse トリガーが
--       日付を無視して1行に畳み、前日洗車を破壊してしまう。
-- ⚠️ BTは独立Supabase(ggqugvyskyiblxiycpci) → BT専用SQL EditorでRUN。
--    bt_task_role は bt_tasks_collapse_dup / bt_task 担当ガード が参照。
--    この関数を差し替えるだけで両ガードに反映される。
-- ============================================================
create or replace function bt_task_role(content text) returns text
language sql immutable as $$
  select case
    when content in ('PUB','DEL','PU','来店','送迎') then 'LEND'
    when content in ('BDB','COL','BD','返却')       then 'RETURN'
    when content = '返却後洗車'                       then 'RWASH'  -- ★別枠(前日洗車WASHと衝突させない)
    when content like '%洗車%'                       then 'WASH'
    else null
  end;
$$;
