-- ============================================================
-- 【BT 高松】担当(タスク割当) 恒久保護 — DBレベルの確固たる構造 (2026-06-24)
-- NHA版の高松横展開。BTはNHAと同じ日本語列(担当/予約番号/内容)。表=bt_tasks。
-- ⚠️ BTは独立Supabaseプロジェクト(ggqugvyskyiblxiycpci) → BT専用のSQL EditorでRUN。
-- 仕組み: 担当を (予約番号 × 役割LEND/RETURN/WASH) に紐づけ別表へ永続化し、
--   タスクが担当空で書かれたら自動で埋め戻す(BEFORE) / 担当が入ったら保存(AFTER)。
--   どのコード経路で書いても DB が担当を守る(書き手非依存)。
-- ============================================================

create table if not exists bt_task_assignments (
  reservation_id text not null,
  role           text not null,            -- 'LEND' | 'RETURN' | 'WASH'
  assignee       text not null,
  updated_at     timestamptz not null default now(),
  primary key (reservation_id, role)
);
alter table bt_task_assignments enable row level security;

create or replace function bt_task_role(content text) returns text
language sql immutable as $$
  select case
    when content in ('PUB','DEL','PU','来店','送迎') then 'LEND'
    when content in ('BDB','COL','BD','返却')       then 'RETURN'
    when content like '%洗車%'                       then 'WASH'
    else null end;
$$;

create or replace function bt_tasks_fill_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text; v_assignee text;
begin
  if NEW."予約番号" is null or btrim(NEW."予約番号") = '' then return NEW; end if;
  v_role := bt_task_role(NEW."内容");
  if v_role is null then return NEW; end if;
  if NEW."担当" is null or btrim(NEW."担当") = '' then
    select assignee into v_assignee
      from bt_task_assignments
     where reservation_id = NEW."予約番号" and role = v_role;
    if v_assignee is not null then NEW."担当" := v_assignee; end if;
  end if;
  return NEW;
end; $$;

create or replace function bt_tasks_save_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if NEW."予約番号" is null or btrim(NEW."予約番号") = '' then return NEW; end if;
  v_role := bt_task_role(NEW."内容");
  if v_role is null then return NEW; end if;
  if NEW."担当" is not null and btrim(NEW."担当") <> '' then
    insert into bt_task_assignments(reservation_id, role, assignee, updated_at)
    values (NEW."予約番号", v_role, NEW."担当", now())
    on conflict (reservation_id, role)
      do update set assignee = excluded.assignee, updated_at = now();
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_bt_tasks_fill on bt_tasks;
create trigger trg_bt_tasks_fill
  before insert or update on bt_tasks
  for each row execute function bt_tasks_fill_assignee();

drop trigger if exists trg_bt_tasks_save on bt_tasks;
create trigger trg_bt_tasks_save
  after insert or update on bt_tasks
  for each row execute function bt_tasks_save_assignee();

insert into bt_task_assignments(reservation_id, role, assignee, updated_at)
select distinct on (t."予約番号", bt_task_role(t."内容"))
       t."予約番号", bt_task_role(t."内容"), t."担当", now()
from bt_tasks t
where t."予約番号" is not null and btrim(t."予約番号") <> ''
  and t."担当"   is not null and btrim(t."担当")   <> ''
  and bt_task_role(t."内容") is not null
order by t."予約番号", bt_task_role(t."内容"), t.updated_at desc nulls last
on conflict (reservation_id, role) do nothing;

-- 確認: select count(*) from bt_task_assignments;
