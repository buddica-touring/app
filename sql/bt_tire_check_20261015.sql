-- 高松(BT) 🛞タイヤチェック（procurement.html の新タブ・ETCセットアップと同じ作り・ログイン不要）2026-10-15 オーナー指示
-- 1車1行：ステータス（確認済／取替）・交換予定日・入庫先・備考。写真は1枚＝1行（必須＝写真が1枚も無い車はステータスを付けられない）。
-- 車両の一覧は既存関数 bt_etc_vehicles()（コード・ナンバー・店舗・クラスのみ）を使う。新しい表は個人情報なし。
begin;

create table if not exists public.bt_tire_check (
  code       text primary key,
  status     text check (status in ('確認済','取替')),
  plan_date  date,
  dest       text,
  memo       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.bt_tire_photos (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  path       text not null,          -- storage: bt-tires/<uuid>.jpg
  created_at timestamptz not null default now(),
  deleted    boolean not null default false
);
create index if not exists bt_tire_photos_code_idx on public.bt_tire_photos (code);

alter table public.bt_tire_check  enable row level security;
alter table public.bt_tire_photos enable row level security;

-- スタッフ(authenticated)は全操作（既存 BT 表と同じ）／anon は読む・書く（削除なし）
create policy tire_auth_all  on public.bt_tire_check  for all to authenticated using (true) with check (true);
create policy tirep_auth_all on public.bt_tire_photos for all to authenticated using (true) with check (true);

create policy tire_anon_sel on public.bt_tire_check for select to anon using (true);
-- 書けるのは実在する車両コードだけ・入庫先200字/備考500字まで・ステータスは写真が1枚以上ある時だけ（画像必須）
create policy tire_anon_ins on public.bt_tire_check for insert to anon with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500
  and (status is null or exists (select 1 from public.bt_tire_photos p where p.code = bt_tire_check.code and not p.deleted)));
create policy tire_anon_upd on public.bt_tire_check for update to anon using (true) with check (
  code in (select c.code from public.bt_etc_vehicles() c)
  and coalesce(length(dest),0) <= 200 and coalesce(length(memo),0) <= 500
  and (status is null or exists (select 1 from public.bt_tire_photos p where p.code = bt_tire_check.code and not p.deleted)));

create policy tirep_anon_sel on public.bt_tire_photos for select to anon using (true);
create policy tirep_anon_ins on public.bt_tire_photos for insert to anon with check (
  code in (select c.code from public.bt_etc_vehicles() c) and path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$' and deleted = false);
create policy tirep_anon_upd on public.bt_tire_photos for update to anon using (true) with check (
  code in (select c.code from public.bt_etc_vehicles() c) and path ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$');   -- 画面は deleted=true（墓標）にするだけ

-- 写真行は anon からは deleted（外す）だけ更新可（path の差替え・別の車への移動・復活を防ぐ）
revoke update on public.bt_tire_photos from anon;
grant update (deleted) on public.bt_tire_photos to anon;

-- 監査（row_id は code / 写真は id。どちらも予約・個人情報を含まない）
create trigger trg_audit_all after insert or delete or update on public.bt_tire_check  for each row execute function public._audit_row();
create trigger trg_audit_all after insert or delete or update on public.bt_tire_photos for each row execute function public._audit_row();

alter publication supabase_realtime add table public.bt_tire_check;
alter publication supabase_realtime add table public.bt_tire_photos;

-- 写真の保存先（非公開・5MB・画像のみ・ファイル名は uuid だけ）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bt-tires','bt-tires', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy bt_tires_obj_ins on storage.objects for insert to anon, authenticated with check (bucket_id = 'bt-tires' and name ~ '^[0-9a-f-]{36}\.(jpg|png|webp)$');
create policy bt_tires_obj_sel on storage.objects for select to anon, authenticated using (bucket_id = 'bt-tires');

commit;
