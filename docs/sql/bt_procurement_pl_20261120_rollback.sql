-- 戻し方（bt_procurement_pl_20261120.sql の取り消し）。
-- ⚠️ 手入力が始まった後は bt_pl_manual を drop しない（人の入力の物理削除になる）。その場合は関数の drop と画面の revert だけにして表は残す。
begin;
drop function if exists public.bt_inbound_monthly();
drop function if exists public._bt_ib_addr(text);
drop function if exists public._bt_ib_tel(text);
drop function if exists public._bt_ib_name(text);
drop function if exists public._bt_ib_nonsjis(text);
drop table if exists public.bt_pl_manual;
commit;
