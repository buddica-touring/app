-- 高松(BT) 日常点検（出発前点検／返却後点検）2026-10-15
-- 対象 DB: BT ggqugvyskyiblxiycpci（新規オブジェクトのみ・既存表は変更しない）
-- 画面: app/procurement.html「🔧 点検」タブ（BTアプリにログイン済みの端末＝authenticated で読む/書く）
-- 書込は「1チェック＝1行」upsert（他スタッフのチェックを上書きしない）。写真は1枚＝1行 insert、削除は墓標(deleted=true)。

begin;

-- ① チェック（予約×種別×項目 で1行）
create table if not exists public.bt_inspection_checks (
  reservation_id text not null,
  kind           text not null check (kind in ('pre','post')),   -- pre=出発前点検 / post=返却後点検
  item_key       text not null,                                   -- 項目キー（'_memo' はメモ行）
  checked        boolean not null default false,
  note           text,
  vehicle_code   text,                                            -- チェック時点の配車車両（後で配車替えされたら画面で警告）
  checked_by     text,                                            -- ログイン中のメール
  updated_at     timestamptz not null default now(),             -- 画面が毎回 now を送る（upsert 更新時は default が効かないため）
  id             text generated always as (reservation_id||'|'||kind||'|'||item_key) stored,  -- 台帳(audit_log.row_id)で「どの項目か」を特定するため
  primary key (reservation_id, kind, item_key)
);

-- ② 写真（1枚＝1行・物理削除しない）
create table if not exists public.bt_inspection_photos (
  id             uuid primary key default gen_random_uuid(),
  reservation_id text not null,
  kind           text not null check (kind in ('pre','post')),
  vehicle_code   text,
  path           text not null,                                   -- storage: bt-inspections/<path>
  uploaded_by    text,
  created_at     timestamptz not null default now(),
  deleted        boolean not null default false
);
create index if not exists bt_inspection_photos_resv_idx on public.bt_inspection_photos (reservation_id, kind);

-- RLS：既存 bt_etc_setup / bt_fleet と同じ「authenticated のみ」。anon は不可。
alter table public.bt_inspection_checks enable row level security;
alter table public.bt_inspection_photos enable row level security;
create policy insp_checks_auth_sel on public.bt_inspection_checks for select to authenticated using (true);
create policy insp_checks_auth_ins on public.bt_inspection_checks for insert to authenticated with check (true);
create policy insp_checks_auth_upd on public.bt_inspection_checks for update to authenticated using (true) with check (true);
create policy insp_photos_auth_sel on public.bt_inspection_photos for select to authenticated using (true);
create policy insp_photos_auth_ins on public.bt_inspection_photos for insert to authenticated with check (true);
create policy insp_photos_auth_upd on public.bt_inspection_photos for update to authenticated using (true) with check (true);
-- DELETE ポリシーは作らない（墓標運用）

-- 台帳（既存の監査トリガーを付ける）
create trigger trg_audit_all after insert or delete or update on public.bt_inspection_checks for each row execute function public._audit_row();
create trigger trg_audit_all after insert or delete or update on public.bt_inspection_photos for each row execute function public._audit_row();

-- リアルタイム（複数スタッフが同時に点検しても画面が追従）
alter publication supabase_realtime add table public.bt_inspection_checks;
alter publication supabase_realtime add table public.bt_inspection_photos;

-- ③ 写真の保存先（非公開・5MB・画像のみ）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bt-inspections','bt-inspections', false, 5242880, array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;
create policy bt_insp_obj_ins on storage.objects for insert to authenticated with check (bucket_id = 'bt-inspections');
create policy bt_insp_obj_sel on storage.objects for select to authenticated using (bucket_id = 'bt-inspections');
-- 削除・更新ポリシーは作らない

commit;
