-- nosh 承認 2026-11-06: 進行管理と同じく公開キーで読み書き
create policy bt_fixed_all on bt_store_fixed_costs for all to public using (true) with check (true);
