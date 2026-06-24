-- ============================================================
-- 【BT 高松】タスク重複collapse — 「同じ予約×役割は1行」をDBで強制 (2026-06-24)
-- NHA版の高松横展開。BTはNHAと同じ日本語列(bt_tasks)。
-- ⚠️ BTは独立Supabase(ggqugvyskyiblxiycpci) → BT専用SQL EditorでRUN。
-- 依存: bt_task_role() / bt_task_assignments (bt_task_assignment_guard.sql) を先にRUN済み。
-- ============================================================

create or replace function bt_tasks_collapse_dup() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text; ex bt_tasks%rowtype;
begin
  if NEW."予約番号" is null or btrim(NEW."予約番号") = '' then return NEW; end if;
  v_role := bt_task_role(NEW."内容");
  if v_role is null then return NEW; end if;
  select * into ex from bt_tasks
   where "予約番号" = NEW."予約番号"
     and bt_task_role("内容") = v_role
     and _id <> NEW._id
   order by (case when btrim(coalesce("担当",'')) <> '' then 0 else 1 end),
            updated_at desc nulls last
   limit 1;
  if not found then return NEW; end if;
  update bt_tasks set
    date       = NEW.date,
    "内容"     = NEW."内容",
    "時間"     = coalesce(nullif(btrim(NEW."時間"),''),   bt_tasks."時間"),
    "変更"     = coalesce(nullif(btrim(NEW."変更"),''),   bt_tasks."変更"),
    "内案"     = NEW."内案",
    "予約者"   = coalesce(nullif(btrim(NEW."予約者"),''), bt_tasks."予約者"),
    "担当"     = coalesce(nullif(btrim(NEW."担当"),''),   bt_tasks."担当"),
    "確認"     = NEW."確認",
    "メモ"     = coalesce(nullif(btrim(NEW."メモ"),''),   bt_tasks."メモ"),
    "OTA"      = NEW."OTA", "TEL" = NEW."TEL", "MAIL" = NEW."MAIL",
    assigned_vehicle = coalesce(nullif(btrim(NEW.assigned_vehicle),''), bt_tasks.assigned_vehicle),
    "No"       = coalesce(nullif(btrim(NEW."No"),''),     bt_tasks."No"),
    "人数"     = NEW."人数",
    "送迎場所" = coalesce(nullif(btrim(NEW."送迎場所"),''), bt_tasks."送迎場所"),
    "クラス"   = NEW."クラス", "確定" = NEW."確定", "便名" = NEW."便名",
    "返却日"   = NEW."返却日",
    "返却"     = coalesce(nullif(btrim(NEW."返却"),''),   bt_tasks."返却"),
    "送迎"     = NEW."送迎",
    "集客"     = coalesce(nullif(btrim(NEW."集客"),''),   bt_tasks."集客"),
    "B" = NEW."B", "C" = NEW."C", "J" = NEW."J", "USB" = NEW."USB",
    "約款" = NEW."約款", "LINE" = NEW."LINE", "決済" = NEW."決済",
    "車種" = NEW."車種", "空港" = NEW."空港",
    vehicle_code = NEW.vehicle_code, class = NEW.class,
    sort_order = NEW.sort_order, changed_json = NEW.changed_json,
    updated_at = now()
  where _id = ex._id;
  return null;
end; $$;

drop trigger if exists trg_bt_tasks_collapse_dup on bt_tasks;
create trigger trg_bt_tasks_collapse_dup
  before insert on bt_tasks
  for each row execute function bt_tasks_collapse_dup();

with ranked as (
  select _id,
         row_number() over (
           partition by "予約番号", bt_task_role("内容")
           order by (case when btrim(coalesce("担当",'')) <> '' then 0 else 1 end),
                    updated_at desc nulls last
         ) as rn
  from bt_tasks
  where "予約番号" is not null and btrim("予約番号") <> ''
    and bt_task_role("内容") is not null
)
delete from bt_tasks t using ranked r where t._id = r._id and r.rn > 1;
