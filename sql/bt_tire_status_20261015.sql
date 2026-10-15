-- タイヤチェック：ステータスを「未確認／確認済／交換」の3択に・写真が無くても選べる（オーナー指示 2026-10-15）
-- 現状 bt_tire_check は1行(status=null)・写真0件。旧値「取替」は無いので変換不要（念のため 取替→交換 も入れる）
begin;
alter table public.bt_tire_check drop constraint if exists bt_tire_check_status_check;
update public.bt_tire_check set status = '交換' where status = '取替';
alter table public.bt_tire_check add constraint bt_tire_check_status_check check (status in ('未確認','確認済','交換'));

-- anon の書込条件から「写真が1枚以上」を外す（実在コード・文字数上限は維持）
drop policy if exists tire_anon_ins on public.bt_tire_check;
drop policy if exists tire_anon_upd on public.bt_tire_check;
create policy tire_anon_ins on public.bt_tire_check for insert to anon with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500);
create policy tire_anon_upd on public.bt_tire_check for update to anon using (true) with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500);
commit;
-- 戻し＝bt_tire_status_20261015_rollback.sql
