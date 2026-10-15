-- 戻し（ETCのデータは消えない）。procurement.html の該当コミットも同時に revert すること
begin;
drop policy if exists etc_anon_sel on public.bt_etc_setup;
drop policy if exists etc_anon_ins on public.bt_etc_setup;
drop policy if exists etc_anon_upd on public.bt_etc_setup;
drop function if exists public.bt_etc_vehicles();
commit;
