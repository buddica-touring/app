-- 戻し：bt_inspection_20261015.sql で作ったものだけを外す（既存表は触らない）
-- 運用開始後は2段で戻す。データを消す前に必ず退避すること。

-- 【段階1：無害化（データは残す）】画面から読めない・書けない状態にする
begin;
drop policy if exists insp_checks_auth_sel on public.bt_inspection_checks;
drop policy if exists insp_checks_auth_ins on public.bt_inspection_checks;
drop policy if exists insp_checks_auth_upd on public.bt_inspection_checks;
drop policy if exists insp_photos_auth_sel on public.bt_inspection_photos;
drop policy if exists insp_photos_auth_ins on public.bt_inspection_photos;
drop policy if exists insp_photos_auth_upd on public.bt_inspection_photos;
drop policy if exists bt_insp_obj_ins on storage.objects;
drop policy if exists bt_insp_obj_sel on storage.objects;
commit;
-- publication から外す（未登録だとエラーになるので1本ずつ）
-- alter publication supabase_realtime drop table public.bt_inspection_checks;
-- alter publication supabase_realtime drop table public.bt_inspection_photos;

-- 【段階2：削除（退避後のみ）】
-- create table public.bt_inspection_checks_bak as table public.bt_inspection_checks;
-- create table public.bt_inspection_photos_bak as table public.bt_inspection_photos;
-- drop table if exists public.bt_inspection_photos;
-- drop table if exists public.bt_inspection_checks;
-- バケット bt-inspections は中身があると削除できない。空なら: delete from storage.buckets where id='bt-inspections';
