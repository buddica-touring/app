-- 高松(BT) 点検タブをログイン不要に（オーナー指示 2026-10-15「ログイン不要」「ナンバーと車両名だけでいい」）
-- 方針：予約番号は画面にもやり取りにも出さない。予約ごとに「推測できない鍵 k」（予約番号＋非公開の塩の HMAC）を作り、
--       画面は k だけで読み書きする。読み書きはすべて SECURITY DEFINER 関数経由。新表は anon に直接開けない。
--       返すのは 日時・車両名・ナンバー・クラス・ブランド・チェック状態・写真パスのみ（氏名/電話/メール/金額/予約番号なし）。
begin;

-- 非公開の塩（anon/authenticated から読めない private スキーマ）
create table if not exists private.bt_insp_secret (id int primary key default 1 check (id = 1), salt text not null);
insert into private.bt_insp_secret (id, salt) values (1, encode(extensions.gen_random_bytes(32), 'hex')) on conflict (id) do nothing;
revoke all on private.bt_insp_secret from public, anon, authenticated;

-- 予約番号 → 鍵
create or replace function private.bt_insp_key(p_id text) returns text
language sql stable security definer set search_path = ''
as $$ select encode(extensions.hmac(p_id, (select salt from private.bt_insp_secret where id = 1), 'sha256'), 'hex') $$;
revoke all on function private.bt_insp_key(text) from public, anon, authenticated;

-- 鍵 → 予約番号（今日-14〜+31日に出発/返却がある有効予約だけを対象）
create or replace function private.bt_insp_resolve(p_k text) returns text
language sql stable security definer set search_path = ''
as $$
  select r.id from public.bt_reservations r
  where coalesce(r.status,'') not in ('キャンセル','cancelled','canceled')
    and ((r.start_date between to_char((now() at time zone 'Asia/Tokyo')::date - 14,'YYYY-MM-DD') and to_char((now() at time zone 'Asia/Tokyo')::date + 31,'YYYY-MM-DD'))
      or (r.end_date   between to_char((now() at time zone 'Asia/Tokyo')::date - 14,'YYYY-MM-DD') and to_char((now() at time zone 'Asia/Tokyo')::date + 31,'YYYY-MM-DD')))
    and private.bt_insp_key(r.id) = p_k
  limit 1
$$;
revoke all on function private.bt_insp_resolve(text) from public, anon, authenticated;

-- 監査：点検2表は専用トリガーで記録（row_id と diff に予約番号を入れない＝anon から読める既存の監査閲覧関数経由で漏れないように）
alter table public.bt_inspection_checks drop column if exists id;   -- 生成列 id（予約番号入り）を外す（両表とも0行で確認済）
drop trigger if exists trg_audit_all on public.bt_inspection_checks;
drop trigger if exists trg_audit_all on public.bt_inspection_photos;
create or replace function private.bt_insp_audit() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_old jsonb; v_new jsonb; v_diff jsonb := '{}'::jsonb; v_rid text; v_k text; a text[]; kk text;
begin
  begin
    a := public._audit_actor();
    v_old := case when TG_OP <> 'INSERT' then to_jsonb(OLD) end;
    v_new := case when TG_OP <> 'DELETE' then to_jsonb(NEW) end;
    v_k := private.bt_insp_key(coalesce(v_new->>'reservation_id', v_old->>'reservation_id'));
    v_rid := v_k || '|' || coalesce(v_new->>'kind', v_old->>'kind', '') || '|' ||
             case when TG_TABLE_NAME = 'bt_inspection_checks' then coalesce(v_new->>'item_key', v_old->>'item_key', '')
                  else 'photo:' || coalesce(v_new->>'id', v_old->>'id', '') end;
    if TG_OP = 'DELETE' then
      insert into public.audit_log(tbl,row_id,op,diff,app_name,actor,actor_id) values (TG_TABLE_NAME, v_rid, 'DELETE', v_old - 'reservation_id', current_setting('application_name', true), a[1], a[2]);
    elsif TG_OP = 'INSERT' then
      insert into public.audit_log(tbl,row_id,op,diff,app_name,actor,actor_id) values (TG_TABLE_NAME, v_rid, 'INSERT', v_new - 'reservation_id', current_setting('application_name', true), a[1], a[2]);
    else
      for kk in select jsonb_object_keys(v_new) loop
        if (v_new->kk) is distinct from (v_old->kk) and kk not in ('updated_at','created_at','reservation_id') then
          v_diff := v_diff || jsonb_build_object(kk, jsonb_build_object('old', v_old->kk, 'new', v_new->kk));
        end if;
      end loop;
      if v_diff <> '{}'::jsonb then
        insert into public.audit_log(tbl,row_id,op,diff,app_name,actor,actor_id) values (TG_TABLE_NAME, v_rid, 'UPDATE', v_diff, current_setting('application_name', true), a[1], a[2]);
      end if;
    end if;
  exception when others then null;
  end;
  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;
revoke all on function private.bt_insp_audit() from public, anon, authenticated;
create trigger trg_insp_audit after insert or update or delete on public.bt_inspection_checks for each row execute function private.bt_insp_audit();
create trigger trg_insp_audit after insert or update or delete on public.bt_inspection_photos for each row execute function private.bt_insp_audit();

-- ① 一覧（出発前=出発日 / 返却後=返却日 で絞る）。チェックと写真もまとめて返す
create or replace function public.bt_inspection_targets(p_kind text, p_from date, p_to date)
returns table(k text, start_date text, start_time text, end_date text, end_time text,
              vehicle_code text, vehicle_name text, plate_no text, vtype text, brand text,
              checks jsonb, photos jsonb)
language sql stable security definer set search_path = ''
as $$
  with w as (select (now() at time zone 'Asia/Tokyo')::date as today),
  rs as (
    select r.* from public.bt_reservations r, w
    where p_kind in ('pre','post')
      and p_from >= w.today - 14 and p_to <= w.today + 31 and p_to - p_from between 0 and 31
      and coalesce(r.status,'') not in ('キャンセル','cancelled','canceled')
      and r.id !~ '^(ZZ|DEMO|KD-DEMO|TEST|DEMOMYPAGE)'
      and coalesce(r.name,'') !~* '(テスト|デモ|test|ZZPTEST|大下|おおした|オオシタ)'
      and coalesce(r.name,'') <> ''
      and ((p_kind = 'pre'  and r.start_date between to_char(p_from,'YYYY-MM-DD') and to_char(p_to,'YYYY-MM-DD'))
        or (p_kind = 'post' and r.end_date   between to_char(p_from,'YYYY-MM-DD') and to_char(p_to,'YYYY-MM-DD')))
  )
  select private.bt_insp_key(r.id), r.start_date, r.start_time, r.end_date, r.end_time,
         vc.code, coalesce(v.name, r.vehicle_name), v.plate_no,
         coalesce(nullif(v.type,''), r.vehicle_class), coalesce(nullif(v.brand,''), r.brand),
         coalesce((select jsonb_object_agg(c.item_key, jsonb_build_object('checked',c.checked,'note',c.note,'vehicle_code',c.vehicle_code,'updated_at',c.updated_at))
                   from public.bt_inspection_checks c where c.reservation_id = r.id and c.kind = p_kind), '{}'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('id',ph.id,'path',ph.path) order by ph.created_at)
                   from public.bt_inspection_photos ph where ph.reservation_id = r.id and ph.kind = p_kind and not ph.deleted), '[]'::jsonb)
  from rs r
  left join lateral (select coalesce((select fl.vehicle_code from public.bt_fleet fl where fl.reservation_id = r.id limit 1), nullif(r.assigned_vehicle,'')) as code) vc on true
  left join public.bt_vehicles v on v.code = vc.code
$$;

-- ② チェック／メモ 1項目を保存（1チェック＝1行 upsert）
create or replace function public.bt_inspection_set(p_k text, p_kind text, p_item text, p_checked boolean, p_note text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_id text; v_code text; v_row public.bt_inspection_checks;
begin
  if p_k !~ '^[0-9a-f]{64}$' or p_kind not in ('pre','post') or p_item !~ '^[_a-z0-9]{1,40}$' then raise exception 'bad request'; end if;
  v_id := private.bt_insp_resolve(p_k);
  if v_id is null then raise exception 'not found'; end if;
  select coalesce((select fl.vehicle_code from public.bt_fleet fl where fl.reservation_id = v_id limit 1),
                  (select nullif(r.assigned_vehicle,'') from public.bt_reservations r where r.id = v_id)) into v_code;
  insert into public.bt_inspection_checks (reservation_id, kind, item_key, checked, note, vehicle_code, checked_by, updated_at)
  values (v_id, p_kind, p_item, coalesce(p_checked,false), left(p_note, 2000), v_code, 'anon:procurement', now())
  on conflict (reservation_id, kind, item_key) do update
    set checked = case when p_checked is null then public.bt_inspection_checks.checked else excluded.checked end,
        note    = case when p_note    is null then public.bt_inspection_checks.note    else excluded.note    end,
        vehicle_code = excluded.vehicle_code, checked_by = excluded.checked_by, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('item_key',v_row.item_key,'checked',v_row.checked,'note',v_row.note,'vehicle_code',v_row.vehicle_code,'updated_at',v_row.updated_at);
end $$;

-- ③ 写真を記録（ファイルは storage に <k>/<kind>/<uuid>.<ext> で先に置く）
create or replace function public.bt_inspection_photo_add(p_k text, p_kind text, p_path text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id text; v_code text; v_pid uuid;
begin
  if p_k !~ '^[0-9a-f]{64}$' or p_kind not in ('pre','post')
     or p_path <> (p_k || '/' || p_kind || '/' || split_part(p_path,'/',3))
     or split_part(p_path,'/',3) !~ '^[0-9a-zA-Z_-]+\.(jpg|png|webp)$' then raise exception 'bad request'; end if;
  v_id := private.bt_insp_resolve(p_k);
  if v_id is null then raise exception 'not found'; end if;
  select coalesce((select fl.vehicle_code from public.bt_fleet fl where fl.reservation_id = v_id limit 1),
                  (select nullif(r.assigned_vehicle,'') from public.bt_reservations r where r.id = v_id)) into v_code;
  insert into public.bt_inspection_photos (reservation_id, kind, vehicle_code, path, uploaded_by)
  values (v_id, p_kind, v_code, p_path, 'anon:procurement') returning id into v_pid;
  return v_pid;
end $$;

-- ④ 写真を外す（墓標。物理削除しない）
create or replace function public.bt_inspection_photo_del(p_k text, p_photo uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_id text;
begin
  if p_k !~ '^[0-9a-f]{64}$' then raise exception 'bad request'; end if;
  v_id := private.bt_insp_resolve(p_k);
  if v_id is null then raise exception 'not found'; end if;
  update public.bt_inspection_photos set deleted = true where id = p_photo and reservation_id = v_id;
  return found;
end $$;

revoke all on function public.bt_inspection_targets(text,date,date) from public;
revoke all on function public.bt_inspection_set(text,text,text,boolean,text) from public;
revoke all on function public.bt_inspection_photo_add(text,text,text) from public;
revoke all on function public.bt_inspection_photo_del(text,uuid) from public;
grant execute on function public.bt_inspection_targets(text,date,date) to anon, authenticated;
grant execute on function public.bt_inspection_set(text,text,text,boolean,text) to anon, authenticated;
grant execute on function public.bt_inspection_photo_add(text,text,text) to anon, authenticated;
grant execute on function public.bt_inspection_photo_del(text,uuid) to anon, authenticated;

-- 写真バケット：anon にも insert/select（パス形式を限定・更新/削除は不可）
create policy bt_insp_obj_anon_ins on storage.objects for insert to anon
  with check (bucket_id = 'bt-inspections' and name ~ '^[0-9a-f]{64}/(pre|post)/[0-9a-zA-Z_-]+\.(jpg|png|webp)$');
create policy bt_insp_obj_anon_sel on storage.objects for select to anon using (bucket_id = 'bt-inspections');

commit;
