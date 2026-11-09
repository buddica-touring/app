-- 高松(BT) ✨コーティング（procurement.html 車両>準備「ETCセットアップ」の下・ETCと同じ作り・ログイン不要）2026-11-09 オーナー指示
-- 1車1行：ボディコーティング済(body)・撥水済(water) の2チェックだけ。個人情報なし。
-- 書けるのは実在する車両コード（bt_etc_vehicles）か仕入候補の proc_<id> だけ（ETC と同じ条件）。anon は削除不可。
begin;

create table if not exists public.bt_coating (
  code       text primary key,
  body       boolean not null default false,
  water      boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.bt_coating enable row level security;

create policy coat_auth_all on public.bt_coating for all to authenticated using (true) with check (true);
create policy coat_anon_sel on public.bt_coating for select to anon using (true);
create policy coat_anon_ins on public.bt_coating for insert to anon with check (
  code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p));
create policy coat_anon_upd on public.bt_coating for update to anon using (true) with check (
  code in (select c.code from public.bt_etc_vehicles() c) or code in (select 'proc_'||p.id::text from public.bt_procurement p));

-- anon は読む・足す・直すだけ（削除・TRUNCATE なし）
revoke all on public.bt_coating from anon;
grant select, insert, update on public.bt_coating to anon;

create trigger trg_audit_all after insert or delete or update on public.bt_coating for each row execute function public._audit_row();
alter publication supabase_realtime add table public.bt_coating;

-- 初期値（オーナー 2026-11-09「初期からあった車両（ハイエース含む）は終わっています。追加された車両は行っていません」）
-- 初期＝仕入候補(bt_procurement)で追加されていない16台。追加された25台・仕入中3台は行を作らない（＝未）。
insert into public.bt_coating (code, body, water) values
 ('ヴォク1010',true,true),('ライズ1011',true,true),('プリウ1016',true,true),('ヤリス1018',true,true),
 ('ハリアgc90',true,true),('ポルシqs4p',true,true),('ウルスr0wd',true,true),('カブリrtbz',true,true),
 ('イヴォs3sw',true,true),('ゲレンsdoc',true,true),('ﾙｰﾐb0bs',true,true),('アルフ1697',true,true),
 ('ヴェル1699',true,true),('アルフ1728',true,true),('アルフ1730',true,true),('ハイエース1002',true,true)
on conflict (code) do nothing;

commit;
