-- 高松(BT) ETCセットアップ（procurement.html）をログイン不要に（オーナー指示 2026-10-15「ETCセットアップもログイン不要」「ナンバーだけにしていい」）
-- 車両マスタ bt_vehicles は開けない。ETC表に要る列（車両コード=保存キー・ナンバー・店舗・クラス）だけ返す関数を anon に開く。車種名は返さない。
-- bt_etc_setup（ETCの進捗・1車1行）は anon に select/insert/update（DELETE は不可）。個人情報なし。
begin;
create or replace function public.bt_etc_vehicles()
returns table(code text, plate_no text, brand text, vtype text)
language sql stable security definer set search_path = ''
as $$ select v.code, v.plate_no, v.brand, v.type from public.bt_vehicles v order by 1 $$;
revoke all on function public.bt_etc_vehicles() from public;
grant execute on function public.bt_etc_vehicles() to anon, authenticated;

create policy etc_anon_sel on public.bt_etc_setup for select to anon using (true);
-- 書けるのは実在する車両コードだけ・メモ500字/入庫先200字まで（任意コードの行量産を DB で止める）
create policy etc_anon_ins on public.bt_etc_setup for insert to anon with check (code in (select c.code from public.bt_etc_vehicles() c) and coalesce(length(memo),0) <= 500 and coalesce(length(dest),0) <= 200);
create policy etc_anon_upd on public.bt_etc_setup for update to anon using (true) with check (code in (select c.code from public.bt_etc_vehicles() c) and coalesce(length(memo),0) <= 500 and coalesce(length(dest),0) <= 200);
commit;
