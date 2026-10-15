-- 戻し（2段）。procurement.html の該当コミットも同時に revert すること
-- 段階1：無害化（データは残す）
begin;
drop policy if exists tire_anon_sel  on public.bt_tire_check;
drop policy if exists tire_anon_ins  on public.bt_tire_check;
drop policy if exists tire_anon_upd  on public.bt_tire_check;
drop policy if exists tirep_anon_sel on public.bt_tire_photos;
drop policy if exists tirep_anon_ins on public.bt_tire_photos;
drop policy if exists tirep_anon_upd on public.bt_tire_photos;
drop policy if exists bt_tires_obj_ins on storage.objects;
drop policy if exists bt_tires_obj_sel on storage.objects;
commit;
-- 段階2：削除（退避後のみ）
-- create table public.bt_tire_check_bak as table public.bt_tire_check;
-- create table public.bt_tire_photos_bak as table public.bt_tire_photos;
-- alter publication supabase_realtime drop table public.bt_tire_check;
-- alter publication supabase_realtime drop table public.bt_tire_photos;
-- drop table public.bt_tire_photos; drop table public.bt_tire_check;
-- バケット bt-tires は空なら: delete from storage.buckets where id='bt-tires';
