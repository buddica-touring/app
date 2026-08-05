-- ===== BT お知らせ掲示板 (all-staff board) =====
create table if not exists public.bt_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  link_url text,
  author text,
  pinned boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bt_ann_created on public.bt_announcements(created_at desc);

create table if not exists public.bt_announcement_reads (
  id text primary key,             -- announcement_id || ':' || user_key
  announcement_id uuid not null,
  user_key text not null,
  user_name text,
  read_at timestamptz not null default now()
);
create index if not exists idx_bt_ann_reads_ann on public.bt_announcement_reads(announcement_id);

alter table public.bt_announcements enable row level security;
alter table public.bt_announcement_reads enable row level security;

drop policy if exists bt_ann_all on public.bt_announcements;
create policy bt_ann_all on public.bt_announcements for all to authenticated using (true) with check (true);
drop policy if exists bt_ann_reads_all on public.bt_announcement_reads;
create policy bt_ann_reads_all on public.bt_announcement_reads for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.bt_announcements;
alter publication supabase_realtime add table public.bt_announcement_reads;
