-- 仕入候補のアーカイブ（オーナー指示 2026-11-01：消さずに下へまとめて折りたたむ）
alter table public.bt_procurement add column if not exists archived boolean not null default false;
