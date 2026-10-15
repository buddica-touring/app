-- 戻し：bt_inspection_anon_20261015.sql で足したものだけを外す（点検データは消えない）
-- ※ procurement.html の該当コミットも同時に revert（SQLだけ戻すと点検タブが「取得失敗」になる）
begin;
drop policy if exists bt_insp_obj_anon_ins on storage.objects;
drop policy if exists bt_insp_obj_anon_sel on storage.objects;
drop function if exists public.bt_inspection_photo_del(text,uuid);
drop function if exists public.bt_inspection_photo_add(text,text,text);
drop function if exists public.bt_inspection_set(text,text,text,boolean,text);
drop function if exists public.bt_inspection_targets(text,date,date);
drop trigger if exists trg_insp_audit on public.bt_inspection_checks;
drop trigger if exists trg_insp_audit on public.bt_inspection_photos;
drop function if exists private.bt_insp_audit();
create trigger trg_audit_all after insert or delete or update on public.bt_inspection_checks for each row execute function public._audit_row();
create trigger trg_audit_all after insert or delete or update on public.bt_inspection_photos for each row execute function public._audit_row();
drop function if exists private.bt_insp_resolve(text);
drop function if exists private.bt_insp_key(text);
drop table if exists private.bt_insp_secret;
commit;
