-- 戻し：ステータス3択(未確認/確認済/交換)・写真不要 → 元(確認済/取替・写真必須)へ。procurement.html の該当コミットも同時に revert
begin;
alter table public.bt_tire_check drop constraint if exists bt_tire_check_status_check;
update public.bt_tire_check set status = case status when '交換' then '取替' when '未確認' then null else status end where status in ('交換','未確認');
alter table public.bt_tire_check add constraint bt_tire_check_status_check check (status in ('確認済','取替'));
drop policy if exists tire_anon_ins on public.bt_tire_check;
drop policy if exists tire_anon_upd on public.bt_tire_check;
create policy tire_anon_ins on public.bt_tire_check for insert to anon with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500
  and (status is null or exists (select 1 from public.bt_tire_photos p where p.code = bt_tire_check.code and not p.deleted)));
create policy tire_anon_upd on public.bt_tire_check for update to anon using (true) with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500
  and (status is null or exists (select 1 from public.bt_tire_photos p where p.code = bt_tire_check.code and not p.deleted)));
commit;
