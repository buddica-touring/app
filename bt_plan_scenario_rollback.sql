-- bt_plan_scenario.sql の戻し（2026-11-27）
-- 手順：① 画面 procurement.html を git revert で旧版に戻す ② 下の A で anon の書込を止める。
-- 表の drop はしない（人が入れた値を消すことになる＝§3.5）。drop はオーナーの明示指示がある時だけ。

-- A. 書込を止める（読むのは残す）
revoke insert, update on public.bt_plan_scenario from anon;

-- B. 誤って上書きした時の復元（audit_log に UPDATE ごとの data の old/new が残る）
-- 1) 履歴を見る（changed_at は UTC。JST は +9h）
-- select id, changed_at, actor, diff->'data'->'old' as old_data, diff->'data'->'new' as new_data
--   from public.audit_log where tbl='bt_plan_scenario' and row_id='shared' order by id desc limit 20;
-- 2) 戻したい時点の audit_log.id を選び、その UPDATE の old（＝その直前の値）に戻す
-- update public.bt_plan_scenario set data = (select diff->'data'->'old' from public.audit_log where id = <audit_log.id>)
--   where id='shared';
