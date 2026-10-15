-- 戻し：「相談」を外して3択に戻す。相談の行は 未確認 に戻す（audit 用に先に select で控えること）。procurement.html の該当コミットも revert
begin;
alter table public.bt_tire_check drop constraint if exists bt_tire_check_status_check;
update public.bt_tire_check set status = '未確認' where status = '相談';
alter table public.bt_tire_check add constraint bt_tire_check_status_check check (status in ('未確認','確認済','交換'));
commit;
