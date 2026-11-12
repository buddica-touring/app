-- 古い画面の上書き止め（2026-11-12 nosh「何回やるんだ」「他にパターンあるだろ？全部潰して」）
-- 決まり：スタッフの画面が「その行を読み込んだ時刻」より後に、ほかのだれか（別の画面・お客様の承認・自動処理・直接）が変えた項目は、
--        その画面からは保存できない（その項目だけ今の値のまま。ほかの項目は通る）。画面には知らせが出て最新を読み直す。
-- 画面は x-client-info に「hdm=<画面ID>.<読み込み時刻ms>」を付けて送る。付けない古い画面・別ページは今どおり通る（記録だけ）。
-- 対象（:TASKS/:RES を店ごとに置換して流す）。通知なし。記録 hdm_stale_block。戻し rollback_01.sql。
create table if not exists public.hdm_field_touch(
  tbl text not null, row_id text not null, field text not null,
  changed_at timestamptz not null default clock_timestamp(), client_id text, actor text,
  primary key(tbl,row_id,field));
create table if not exists public.hdm_stale_block(
  id bigserial primary key, ts timestamptz not null default now(), tbl text, row_id text, field text,
  kept text, tried text, client_id text, read_at timestamptz, touched_at timestamptz, touched_by text, actor_id text);
create index if not exists hdm_stale_block_cid on public.hdm_stale_block(client_id, ts desc);
alter table public.hdm_field_touch enable row level security;
alter table public.hdm_stale_block enable row level security;

create or replace function public._hdm_client() returns text[] language plpgsql stable as $$
declare ci text; m text[];
begin
  begin ci := (current_setting('request.headers', true))::json->>'x-client-info'; exception when others then ci := null; end;
  if ci is null then return array[null,null]::text[]; end if;
  m := regexp_match(ci, 'hdm=([A-Za-z0-9]{6,40})\.([0-9]{1,16})');
  if m is null then return array[null,null]::text[]; end if;
  return m;
end $$;

-- 見る項目（人が決める項目＝a1_hdm_rule と同じ）。ほかの列（状態・決済・車など）は対象外＝今どおり
create or replace function public._hdm_stale_fields(p_tbl text) returns text[] language sql immutable as $$
  select case
    when p_tbl in ('nha_reservations','bt_reservations') then array['del_place','del_time','col_place','col_time','insurance','visit_type','return_type','opt_b','opt_c','opt_j','start_time','end_time']
    when p_tbl = 'reservations' then array['del_place','del_time','col_place','col_time','insurance','visit_type','return_type','opt_b','opt_c','opt_j','lend_time','return_time']
    when p_tbl in ('nha_tasks','bt_tasks') then array['担当','送迎場所','時間','変更','メモ','集客','確認']
    when p_tbl = 'tasks' then array['assignee','place','col_place','time','return_time','memo','done']
    else array[]::text[] end $$;

create or replace function public._hdm_stale_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare c text[]; cid text; ra timestamptz; rid text; ov jsonb; nv jsonb; t record; hit boolean := false; a text[];
begin
  if pg_trigger_depth() > 1 then return new; end if;                       -- 連動の書き込みは対象外（元の保存だけ見る）
  if coalesce(current_setting('nha.mp_apply', true),'') in ('1','on','true')
     or coalesce(current_setting('spk.mp_apply', true),'') in ('1','on','true')
     or coalesce(current_setting('bt.mp_apply', true),'') in ('1','on','true')
     or coalesce(current_setting('hdm.one_value', true),'') = '1'
     or nullif(btrim(coalesce(current_setting('hdm.rule_bypass', true),'')),'') is not null then return new; end if;
  c := public._hdm_client(); cid := c[1];
  if cid is null then return new; end if;                                  -- 印を送らない書き込み（古い画面・別ページ・サーバ）は今どおり
  a := public._audit_actor();
  if a[1] is distinct from 'staff' then return new; end if;
  ra := to_timestamp(c[2]::numeric / 1000.0);
  ov := to_jsonb(old); nv := to_jsonb(new);
  rid := coalesce(ov->>'_id', ov->>'id');
  for t in select field, changed_at, coalesce(client_id, actor, '?') as who from public.hdm_field_touch
            where tbl = tg_table_name and row_id = rid and changed_at > ra and client_id is distinct from cid
              and field = any(public._hdm_stale_fields(tg_table_name)) loop
    continue when not (nv ? t.field) or (nv->t.field) is not distinct from (ov->t.field);
    insert into public.hdm_stale_block(tbl,row_id,field,kept,tried,client_id,read_at,touched_at,touched_by,actor_id)
      values(tg_table_name, rid, t.field, ov->>t.field, nv->>t.field, cid, ra, t.changed_at, t.who, a[2]);
    nv := jsonb_set(nv, array[t.field], ov->t.field); hit := true;
  end loop;
  if hit then new := jsonb_populate_record(new, nv); end if;
  return new;
end $$;

create or replace function public._hdm_touch() returns trigger language plpgsql security definer set search_path=public as $$
declare ov jsonb := to_jsonb(old); nv jsonb := to_jsonb(new); k text; rid text; cid text; a text;
begin
  rid := coalesce(nv->>'_id', nv->>'id'); if rid is null then return null; end if;
  cid := (public._hdm_client())[1]; a := (public._audit_actor())[1];
  foreach k in array public._hdm_stale_fields(tg_table_name) loop
    continue when (nv->k) is not distinct from (ov->k);
    insert into public.hdm_field_touch(tbl,row_id,field,changed_at,client_id,actor)
      values(tg_table_name, rid, k, clock_timestamp(), cid, a)
      on conflict (tbl,row_id,field) do update set changed_at = excluded.changed_at, client_id = excluded.client_id, actor = excluded.actor;
  end loop;
  return null;
end $$;

-- 画面が「自分の保存が止められたか」を確かめる（止められたら画面が最新を読み直す）
create or replace function public.hdm_stale_mine(p_client text, p_since_ms bigint default 20000)
returns table(tbl text, row_id text, field text, kept text, tried text, touched_by text, ts timestamptz)
language sql security definer set search_path=public as $$
  select b.tbl, b.row_id, b.field, b.kept, b.tried, b.touched_by, b.ts from public.hdm_stale_block b
   where b.client_id = p_client and b.ts > now() - make_interval(secs => least(greatest(p_since_ms,1000),600000)/1000.0)
   order by b.id desc limit 50 $$;
create or replace function public.hdm_now_ms() returns bigint language sql stable as $$ select (extract(epoch from clock_timestamp())*1000)::bigint $$;
revoke all on function public.hdm_stale_mine(text,bigint) from public, anon;
grant execute on function public.hdm_stale_mine(text,bigint) to authenticated;
grant execute on function public.hdm_now_ms() to authenticated, anon;
