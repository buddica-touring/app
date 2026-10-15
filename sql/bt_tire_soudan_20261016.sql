-- タイヤチェック：ステータスに「相談」を追加（未確認／確認済／交換／相談・オーナー指示 2026-10-16）
-- 既存行は変更しない（制約の許可値を1つ増やすだけ）。書く画面は procurement.html だけ
begin;
alter table public.bt_tire_check drop constraint if exists bt_tire_check_status_check;
alter table public.bt_tire_check add constraint bt_tire_check_status_check check (status in ('未確認','確認済','交換','相談'));
commit;
-- 戻し＝bt_tire_soudan_20261016_rollback.sql
