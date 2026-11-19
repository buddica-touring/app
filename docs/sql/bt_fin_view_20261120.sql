-- 2026-11-20 進行管理の 車両リスト・店舗支出・PL・サマリ損益 をログインなしで見る（オーナー指示「ログインなしで見るのが必須」）
-- 車両ダッシュボードと同じ公開キー（bt_view_keys name='vehicle_dashboard'）で確認してから、閲覧用の数字だけを返す。書き込みは不可。
-- 返すもの：車両（コード・車名・ナンバー・クラス・ブランド・稼働状態・リース/保険/車検/点検の金額・運用期間）／クラス表／月別稼働フラグ／
--   会計の支出（出納帳の出金・カードを 月×種類×科目 で合計した金額と件数だけ。明細・メモ・支払先・入力者は返さない）／PL の手入力値
-- 起源台帳 ORG-20261120-080153-485 ／ 戻し方：①画面を revert（bt-fin.js は全読込がこの関数経由）→ ② drop function if exists public.bt_fin_view(text);
create or replace function public.bt_fin_view(p_key text) returns jsonb
language plpgsql stable security definer set search_path to public, pg_temp as $$
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  return jsonb_build_object(
    'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('code',v.code,'name',v.name,'plate_no',v.plate_no,'type',v.type,'brand',v.brand,
                   'active',v.active,'status',v.status,'lease_monthly',v.lease_monthly,'insurance_annual',v.insurance_annual,
                   'shaken_cost',v.shaken_cost,'tenken_cost',v.tenken_cost,'service_from',v.service_from,'service_to',v.service_to) order by v.code),'[]') from bt_vehicles v),
    'classes',  (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order) order by c.sort_order),'[]') from bt_classes c),
    'kpi',      (select coalesce(jsonb_agg(jsonb_build_object('vehicle_code',k.vehicle_code,'year_month',k.year_month,'active',k.active) order by k.year_month),'[]') from bt_vehicle_monthly_kpi k),
    'acct',     (select coalesce(jsonb_agg(jsonb_build_object('ym',x.ym,'type',x.type,'category',x.category,'amount',x.amount,'n',x.n) order by x.ym,x.type,x.category),'[]')
                   from (select to_char(a.date,'YYYY-MM') ym, a.type, a.category, sum(a.amount)::bigint amount, count(*) n
                         from bt_accounting a where a.type in ('cash_out','card_pay') and a.date is not null group by 1,2,3) x),   -- 月×種類×科目の合計だけ（明細・id・日付は返さない＝omni-review 条件1）
    'manual',   (select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'ym',m.ym,'account',m.account,'amount',m.amount) order by m.id),'[]') from bt_pl_manual m)
  );
end $$;
revoke all on function public.bt_fin_view(text) from public;
grant execute on function public.bt_fin_view(text) to anon, authenticated;
