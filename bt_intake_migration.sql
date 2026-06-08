-- BT(高松) 入庫管理（2026-06-07）BT独立DB(ggqugvyskyiblxiycpci) SQL Editor で1回RUN
-- ① bt_maintenance 拡張（札幌と同仕様・承認フロー無し版でも列は共通）
alter table bt_maintenance add column if not exists status text;          -- pending(仮予定)/approved(FIX)。null=通常メンテ(非入庫)
alter table bt_maintenance add column if not exists work_detail text;     -- 作業内容
alter table bt_maintenance add column if not exists actual_out_date date; -- 実出庫日
alter table bt_maintenance add column if not exists start_time text;      -- 入庫時刻
alter table bt_maintenance add column if not exists end_time text;        -- 出庫時刻
alter table bt_maintenance add column if not exists created_at timestamptz default now();

-- ② 通知キュー（GASが拾って (BT通知チャンネル未設定・将来用) へ投稿）
create table if not exists bt_intake_actions (
  id bigint generated always as identity primary key,
  ts timestamptz default now(),
  action_type text not null,      -- intake_created/intake_fixed/intake_unfixed/intake_edited/intake_cancelled/invoice_uploaded/invoice_confirmed
  vehicle_code text default '',
  user_email text default '',
  target_date_from date,
  target_date_to date,
  notified_slack boolean default false,
  notified_at timestamptz,
  payload jsonb
);
alter table bt_intake_actions enable row level security;
create policy "auth_all_bia" on bt_intake_actions for all to authenticated using (true) with check (true);
grant select, insert, update on bt_intake_actions to authenticated;

-- ③ 請求書ファイルメタ
create table if not exists bt_invoice_files (
  id uuid primary key default gen_random_uuid(),
  year_month text not null,
  vehicle_code text default '',
  maintenance_id text default '',   -- 紐付く入庫予定(bt_maintenance.id)。空=共通・全体請求
  file_path text not null,
  file_name text not null,
  mime text default '',
  size_bytes bigint default 0,
  note text default '',
  uploaded_by text default '',
  confirmed_at timestamptz,
  confirmed_by text default '',
  created_at timestamptz default now()
);
alter table bt_invoice_files enable row level security;
create policy "auth_all_bif" on bt_invoice_files for all to authenticated using (true) with check (true);
grant select, insert, update, delete on bt_invoice_files to authenticated;

-- ④ Storageバケット（非公開）＋ポリシー
insert into storage.buckets (id, name, public) values ('bt-invoices','bt-invoices', false)
on conflict (id) do nothing;
create policy "auth_read_bt_invoices" on storage.objects for select to authenticated using (bucket_id = 'bt-invoices');
create policy "auth_insert_bt_invoices" on storage.objects for insert to authenticated with check (bucket_id = 'bt-invoices');
create policy "auth_delete_bt_invoices" on storage.objects for delete to authenticated using (bucket_id = 'bt-invoices');
