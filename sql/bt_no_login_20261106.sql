-- 進行管理：仕入候補・タイヤ・ETC をログインなしで使えるように（オーナー指示 2026-11-06「ログインはずせ」）
begin;
-- 仕入候補：誰でも読み書き
grant select, insert, update, delete on public.bt_procurement to anon;
drop policy if exists proc_anon_all on public.bt_procurement;
create policy proc_anon_all on public.bt_procurement for all to anon using (true) with check (true);
grant usage, select on all sequences in schema public to anon;
-- タイヤ・ETC：仕入候補（proc_<id>）の行も書けるように
drop policy if exists etc_anon_ins on public.bt_etc_setup;
drop policy if exists etc_anon_upd on public.bt_etc_setup;
create policy etc_anon_ins on public.bt_etc_setup for insert to anon with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and coalesce(length(memo),0) <= 500 and coalesce(length(dest),0) <= 200);
create policy etc_anon_upd on public.bt_etc_setup for update to anon using (true) with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and coalesce(length(memo),0) <= 500 and coalesce(length(dest),0) <= 200);
drop policy if exists tire_anon_ins on public.bt_tire_check;
drop policy if exists tire_anon_upd on public.bt_tire_check;
create policy tire_anon_ins on public.bt_tire_check for insert to anon with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500);
create policy tire_anon_upd on public.bt_tire_check for update to anon using (true) with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500);
drop policy if exists tirep_anon_ins on public.bt_tire_photos;
drop policy if exists tirep_anon_upd on public.bt_tire_photos;
create policy tirep_anon_ins on public.bt_tire_photos for insert to anon with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$' and deleted = false);
create policy tirep_anon_upd on public.bt_tire_photos for update to anon using (true) with check ((code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p)) and path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$');
grant execute on function public.bt_company_vehicles() to anon;
-- 車両タブ（PR #143）の公開キー
update public.bt_view_keys set key='tourism-public' where name='vehicle_dashboard';
commit;
