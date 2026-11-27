-- 高松(BT) 進行管理 procurement.html「数値計画シミュレーション」の試算条件を全端末共通にする（オーナー依頼 2026-11-27）
-- これまで試算条件は localStorage（端末ごと）だったため PC とスマホで数字が違った。
-- 行は id='shared' の1行だけ使う。data には「上書きした値だけ」を入れる（入っていない項目は画面側が実績から初期値を出す）。
-- 権限は bt_etc_setup と同じ形：anon は select/insert/update（DELETE なし）、authenticated は all。変更は audit_log に残す。
-- 戻し方：bt_plan_scenario_rollback.sql（画面 revert → anon の書込を止める。drop はしない）
begin;
create table if not exists public.bt_plan_scenario(
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.bt_plan_scenario enable row level security;

revoke all on public.bt_plan_scenario from anon;
grant select, insert, update on public.bt_plan_scenario to anon;
grant all on public.bt_plan_scenario to authenticated;

create policy authenticated_full_access on public.bt_plan_scenario for all to authenticated using (true) with check (true);
create policy plan_anon_sel on public.bt_plan_scenario for select to anon using (true);
-- 書けるのは id='shared' の1行だけ・data は 256KB まで（行の量産・巨大データを DB で止める）
create policy plan_anon_ins on public.bt_plan_scenario for insert to anon
  with check (id = 'shared' and pg_column_size(data) <= 262144);
create policy plan_anon_upd on public.bt_plan_scenario for update to anon
  using (id = 'shared') with check (id = 'shared' and pg_column_size(data) <= 262144);

create trigger trg_audit_all after insert or delete or update on public.bt_plan_scenario
  for each row execute function public._audit_row();

-- updated_at はサーバー時刻で入れる（端末の時計のずれに左右されない。画面は「読んだ時の updated_at と同じ時だけ更新」に使う）
create or replace function public.bt_plan_scenario_touch() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_bt_plan_scenario_touch before insert or update on public.bt_plan_scenario
  for each row execute function public.bt_plan_scenario_touch();
commit;
