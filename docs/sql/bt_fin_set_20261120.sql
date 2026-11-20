-- 2026-11-20 進行管理の PL 手入力と車両の金額（リース・保険・車検・点検）を、ログインなしで入力できるようにする（オーナー指示「入力できない　支出」＝ログインなしで入力が必須）
-- 車両ダッシュボード・bt_fin_view と同じ公開キー（bt_view_keys name='vehicle_dashboard'）で確認してから、1回に1セル（1台の1項目）だけ書く。
-- 書ける科目・列は下の一覧だけ（それ以外は拒否）。金額は -10億〜10億の整数。PL の手入力を空欄に戻す＝amount null（行は消さない）。
-- 書いた記録は既存の監査トリガー（_audit_row → audit_log）に残る（未ログインは actor=anon）。
-- 緊急停止（未ログインの書込だけ止める）：revoke execute on function public.bt_fin_set_manual(text,text,text,bigint), public.bt_fin_set_vehicle_cost(text,text,text,integer) from anon;
-- 注意：本体APPの整備入力（費用>0の車検/半年点検）は shaken_cost/tenken_cost を実費で上書きする。科目一覧は bt-fin.js の PL 配列と2か所＝足す時は両方。
-- 起源台帳 ORG-20261120-080153-485 ／ 戻し方：①画面を revert → ② drop function public.bt_fin_set_manual(text,text,text,bigint), public.bt_fin_set_vehicle_cost(text,text,text,integer);

create or replace function public.bt_fin_set_manual(p_key text, p_ym text, p_account text, p_amount bigint) returns jsonb
language plpgsql volatile security definer set search_path to public, pg_temp as $$
declare v_id text; r bt_pl_manual;
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  if p_ym is null or p_ym !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' or p_ym < '2026-04'
     or p_ym > to_char((now() at time zone 'Asia/Tokyo') + interval '2 years','YYYY-MM') then raise exception 'invalid ym'; end if;   -- 画面で選べる幅だけ（omni-review 条件1）
  if p_account is null or not (p_account = any (array['売上原価','給与手当','賞与','賞与引当金繰入額','業務委託費（内部）','業務委託費（外部）','法定福利費','福利厚生費',
      '外注費','旅費交通費','調査費','通信費','交際費','会議費','減価償却費','地代家賃','水道光熱費','広告宣伝費','消耗品費','燃料費','租税公課',
      '諸会費','新聞図書費','教育研修費','整備費用','雑費'])) then raise exception 'invalid account'; end if;
  if p_amount is not null and (p_amount > 1000000000 or p_amount < -1000000000) then raise exception 'invalid amount'; end if;
  v_id := p_ym || ':' || p_account;
  insert into bt_pl_manual(id, ym, account, amount, updated_by, updated_at)
    values (v_id, p_ym, p_account, p_amount, '進行管理ページ', now())
  on conflict (id) do update set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return jsonb_build_object('id', r.id, 'amount', r.amount);
end $$;

create or replace function public.bt_fin_set_vehicle_cost(p_key text, p_code text, p_col text, p_amount integer) returns jsonb
language plpgsql volatile security definer set search_path to public, pg_temp as $$
declare v integer;
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000000 then raise exception 'invalid amount'; end if;
  if p_col = 'lease_monthly' then update bt_vehicles set lease_monthly = p_amount, updated_at = now() where code = p_code returning lease_monthly into v;
  elsif p_col = 'insurance_annual' then update bt_vehicles set insurance_annual = p_amount, updated_at = now() where code = p_code returning insurance_annual into v;
  elsif p_col = 'shaken_cost' then update bt_vehicles set shaken_cost = p_amount, updated_at = now() where code = p_code returning shaken_cost into v;
  elsif p_col = 'tenken_cost' then update bt_vehicles set tenken_cost = p_amount, updated_at = now() where code = p_code returning tenken_cost into v;
  else raise exception 'invalid column'; end if;
  if v is null then raise exception 'vehicle not found'; end if;
  return jsonb_build_object('code', p_code, 'col', p_col, 'amount', v);
end $$;

revoke all on function public.bt_fin_set_manual(text,text,text,bigint) from public;
revoke all on function public.bt_fin_set_vehicle_cost(text,text,text,integer) from public;
grant execute on function public.bt_fin_set_manual(text,text,text,bigint) to anon, authenticated;
grant execute on function public.bt_fin_set_vehicle_cost(text,text,text,integer) to anon, authenticated;
