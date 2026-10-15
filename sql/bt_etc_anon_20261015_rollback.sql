-- 戻し（ETCのデータは消えない）。procurement.html の該当コミットも同時に revert すること
begin;
drop policy if exists etc_anon_sel on public.bt_etc_setup;
drop policy if exists etc_anon_ins on public.bt_etc_setup;
drop policy if exists etc_anon_upd on public.bt_etc_setup;
-- 関数 bt_etc_vehicles() はタイヤチェック(bt_tire_check_20261015.sql)のポリシーも使うため消さない（消すとタイヤ側が壊れる・依存で drop も失敗する）
commit;
