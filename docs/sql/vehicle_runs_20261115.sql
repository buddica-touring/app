-- 2026-11-15 高松 低稼働車の走行タスク（ORG-20261115-171707-906）
-- 方針: タスクは「導出」（返却日+14日・出勤から担当を計算）＝システムは書かない。
--       bt_vehicle_runs は人の操作（担当の手動変更・往路済み・復路済み）だけを1行ずつ記録する。
-- 戻し: ①先に select * from public.bt_vehicle_runs をファイルへ退避（人の操作記録）②drop function public.bt_vehicle_run_list(date); drop table public.bt_vehicle_runs;

create table if not exists public.bt_vehicle_runs(
  id bigserial primary key,
  vehicle_code text not null,          -- bt_vehicles.code
  base_date date not null,             -- このタスクの起点（最終返却日 or 前回走行の復路日）
  assignee text,                       -- 手動で決めた担当（null=自動）
  assignee_at timestamptz,
  out_at timestamptz, out_by text,     -- 往路済み
  back_at timestamptz, back_by text,   -- 復路済み＝走行実施済み
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vehicle_code, base_date)
);
alter table public.bt_vehicle_runs enable row level security;
drop policy if exists authenticated_full_access on public.bt_vehicle_runs;
create policy authenticated_full_access on public.bt_vehicle_runs for all to authenticated using (true) with check (true);
revoke all on public.bt_vehicle_runs from anon;
grant select, insert, update on public.bt_vehicle_runs to authenticated;
revoke delete, truncate on public.bt_vehicle_runs from authenticated;  -- 既定ACLのALLを落とす（削除は墓標 deleted=true）
grant usage, select on sequence public.bt_vehicle_runs_id_seq to authenticated;
drop trigger if exists trg_audit_all on public.bt_vehicle_runs;
create trigger trg_audit_all after insert or delete or update on public.bt_vehicle_runs for each row execute function _audit_row();

create or replace function public.bt_vehicle_run_list(p_date date default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path to 'public'
as $function$
declare
  d date := coalesce(p_date, (now() at time zone 'Asia/Tokyo')::date);
  plates text[] := array['1715','1698','1700','1714'];   -- 対象車（ナンバー）
  idle_days int := 14;
  off_sym text[] := array['公','有','休','欠','×','振','代','夏','特','育','産'];
  known boolean; nm_s text; nm_t text; nm_o text; s_in boolean; t_in boolean; o_in boolean;
  cnt jsonb := '{}'::jsonb; items jsonb := '[]'::jsonb; res jsonb := '[]'::jsonb; r record; it jsonb; who text; src text;
begin
  -- 出勤（在席）：その日のシフト（確定/申請・休み記号以外・記号か開始時刻あり）かつ 勤怠で欠勤でない
  select exists(select 1 from bt_shifts s where s.date::date=d and coalesce(s.status,'') in ('確定','申請')) into known;
  select name into nm_s from bt_staff where coalesce(active,true) and (name like '%斉藤%' or name like '%齊藤%' or name like '%斎藤%') order by sort_order nulls last limit 1;
  select name into nm_t from bt_staff where coalesce(active,true) and name like '%武山%' order by sort_order nulls last limit 1;
  select name into nm_o from bt_staff where coalesce(active,true) and name like '%大下%' order by sort_order nulls last limit 1;
  select bool_or(x) into s_in from (select (nm_s is not null and exists(select 1 from bt_shifts s where s.date::date=d and replace(s.staff_name,' ','')=replace(nm_s,' ','') and coalesce(s.status,'') in ('確定','申請') and coalesce(s.symbol,'')<>all(off_sym) and (coalesce(s.symbol,'')<>'' or coalesce(s.start_time,'')<>''))
      and not exists(select 1 from bt_attendance a where a.date::date=d and replace(a.staff_name,' ','')=replace(nm_s,' ','') and a.absent is true)) x) q;
  select bool_or(x) into t_in from (select (nm_t is not null and exists(select 1 from bt_shifts s where s.date::date=d and replace(s.staff_name,' ','')=replace(nm_t,' ','') and coalesce(s.status,'') in ('確定','申請') and coalesce(s.symbol,'')<>all(off_sym) and (coalesce(s.symbol,'')<>'' or coalesce(s.start_time,'')<>''))
      and not exists(select 1 from bt_attendance a where a.date::date=d and replace(a.staff_name,' ','')=replace(nm_t,' ','') and a.absent is true)) x) q;
  select bool_or(x) into o_in from (select (nm_o is not null and exists(select 1 from bt_shifts s where s.date::date=d and replace(s.staff_name,' ','')=replace(nm_o,' ','') and coalesce(s.status,'') in ('確定','申請') and coalesce(s.symbol,'')<>all(off_sym) and (coalesce(s.symbol,'')<>'' or coalesce(s.start_time,'')<>''))
      and not exists(select 1 from bt_attendance a where a.date::date=d and replace(a.staff_name,' ','')=replace(nm_o,' ','') and a.absent is true)) x) q;

  for r in
    with v as (
      select code, name, plate_no, coalesce(specs->>'fuel','') fuel from bt_vehicles
      where plate_no = any(plates) and coalesce(active,true) and coalesce(status,'active')='active'
    ),
    rent as (  -- 配車(bt_fleet)された有効予約
      select f.vehicle_code code, rv.start_date::date sd, rv.end_date::date ed
      from bt_fleet f join bt_reservations rv on rv.id=f.reservation_id
      where f.vehicle_code in (select code from v)
        and lower(coalesce(rv.status,'')) not in ('cancelled','キャンセル','cancel')
        and rv.start_date ~ '^\d{4}-\d{2}-\d{2}' and rv.end_date ~ '^\d{4}-\d{2}-\d{2}'
    ),
    runs as (select * from bt_vehicle_runs where vehicle_code in (select code from v) and not deleted),
    b as (
      select v.*,
        greatest((select max(ed) from rent where rent.code=v.code and ed<=d),
                 (select max((back_at at time zone 'Asia/Tokyo')::date) from runs where runs.vehicle_code=v.code and back_at is not null)) base,
        exists(select 1 from rent where rent.code=v.code and sd<=d and d<=ed) renting,
        (select min(sd) from rent where rent.code=v.code and sd>d) next_lend,
        exists(select 1 from bt_maintenance m where m.vehicle_code=v.code and lower(coalesce(m.status,''))<>'cancelled'
               and m.start_date ~ '^\d{4}-\d{2}-\d{2}' and m.start_date::date<=d and d<=(case when m.end_date ~ '^\d{4}-\d{2}-\d{2}' then m.end_date::date else m.start_date::date end)) inmaint
      from v
    )
    select b.*, (b.base+idle_days) due, (d-b.base) idle, x.assignee man, x.out_at, x.out_by, x.back_at, x.back_by,
      (select y.back_at from runs y where y.vehicle_code=b.code and y.back_at is not null and (y.back_at at time zone 'Asia/Tokyo')::date=d order by y.back_at desc limit 1) done_today_at,
      (select y.back_by from runs y where y.vehicle_code=b.code and y.back_at is not null and (y.back_at at time zone 'Asia/Tokyo')::date=d order by y.back_at desc limit 1) done_today_by
    from b left join runs x on x.vehicle_code=b.code and x.base_date=b.base
    order by (b.base+idle_days), b.plate_no
  loop
    if r.base is null or r.renting or r.inmaint then continue; end if;
    -- 今日 復路まで済んだ車＝実施済みとして表示（起点が今日に変わる＝次は14日後）
    if r.done_today_at is not null and r.base=d then
      items := items || jsonb_build_object('code',r.code,'name',r.name,'plate',r.plate_no,'fuel',r.fuel,'base',r.base,'due',null,'idle',0,
              'stage','done','assignee',r.done_today_by,'assignee_src','done','out_at',null,'back_at',r.done_today_at,'next_lend',r.next_lend);
      continue;
    end if;
    if d < r.base+idle_days then continue; end if;
    if r.man is not null and r.man<>'' then who := r.man; src := 'manual';
    elsif r.out_at is not null and coalesce(r.out_by,'')<>'' then who := r.out_by; src := 'out';
    else who := null; src := 'pending';
    end if;
    if who is not null then cnt := jsonb_set(cnt, array[who], to_jsonb(coalesce((cnt->>who)::int,0)+1)); end if;
    items := items || jsonb_build_object('code',r.code,'name',r.name,'plate',r.plate_no,'fuel',r.fuel,'base',r.base,'due',r.due,'idle',r.idle,
            'stage',case when r.out_at is not null then 'out' else 'todo' end,
            'assignee',who,'assignee_src',src,'out_at',r.out_at,'out_by',r.out_by,'back_at',null,'next_lend',r.next_lend);
  end loop;
  -- 2周目：自動割当（手動・往路済みの担当を先に数えてから、期限の早い順に）
  for it in select value from jsonb_array_elements(items) loop
    if it->>'assignee_src' = 'pending' then
      if not known then who := null; src := 'unknown';
      elsif s_in and t_in then
        if coalesce((cnt->>nm_t)::int,0) < coalesce((cnt->>nm_s)::int,0) then who := nm_t; else who := nm_s; end if; src := 'auto';
      elsif s_in then who := nm_s; src := 'auto';
      elsif t_in then who := nm_t; src := 'auto';
      elsif o_in then who := nm_o; src := 'auto';
      else who := null; src := 'unknown';
      end if;
      if who is not null then cnt := jsonb_set(cnt, array[who], to_jsonb(coalesce((cnt->>who)::int,0)+1)); end if;
      it := it || jsonb_build_object('assignee',who,'assignee_src',src);
    end if;
    res := res || it;
  end loop;
  return jsonb_build_object('ok',true,'date',d,'shift_known',known,'runs',res);
end
$function$;
revoke all on function public.bt_vehicle_run_list(date) from public, anon;
grant execute on function public.bt_vehicle_run_list(date) to authenticated;
