-- 導入方法（一括仕入／リース）。オーナー指示 2026-11-01
-- リース額は車両マスタ（配車表）の lease_monthly をそのまま使う。空（null）の車は画面で自動判定（仕入額なし＋リース月額あり＝リース）
alter table bt_vehicles add column if not exists acquire_type text check (acquire_type in ('buy','lease'));
