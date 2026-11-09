-- bt_coating_20261109.sql の戻し（画面を先に revert してから実行）。人の入力を退避してから新表だけを消す。既存表・関数は触らない。
begin;
create table public.bt_coating_bak_20261109 as select * from public.bt_coating;
alter table public.bt_coating_bak_20261109 enable row level security;
alter publication supabase_realtime drop table public.bt_coating;
drop table if exists public.bt_coating;
commit;
