-- 2026-11-20 PL の給与手当に「給与枠」（アルバイト・社員・本部 など）を足せるようにする（オーナー指示「給与枠を追加できるように　アルバイト　社員　本部　など」）
-- bt_fin_set_manual の科目チェックだけを広げる：既存26科目＋「給与手当/<枠名>」（枠名 1〜20文字・/ : 改行などの制御文字なし・前後空白なし）。
-- 枠の数は30まで（公開キーで誰でも書けるため、行が無限に増えないように）。それ以外は 2026-11-20 版（bt_fin_set_20261120.sql）と同じ。
-- 起源台帳 ORG-20261120-080153-485 ／ 戻し方：bt_fin_set_20261120.sql の bt_fin_set_manual を再実行（給与枠の行は残るが、画面の revert で表示されなくなる）

create or replace function public.bt_fin_set_manual(p_key text, p_ym text, p_account text, p_amount bigint) returns jsonb
language plpgsql volatile security definer set search_path to public, pg_temp as $$
declare v_id text; r bt_pl_manual; v_sal boolean;
begin
  if p_key is null or not exists (select 1 from bt_view_keys where name='vehicle_dashboard' and key=p_key) then
    raise exception 'invalid view key';
  end if;
  if p_ym is null or p_ym !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' or p_ym < '2026-04'
     or p_ym > to_char((now() at time zone 'Asia/Tokyo') + interval '2 years','YYYY-MM') then raise exception 'invalid ym'; end if;
  v_sal := p_account is not null and p_account ~ '^給与手当/[^/:[:cntrl:]]{1,20}$' and p_account = btrim(p_account)
           and substr(p_account, 6) = btrim(substr(p_account, 6));
  if p_account is null or not (v_sal or p_account = any (array['売上原価','給与手当','賞与','賞与引当金繰入額','業務委託費（内部）','業務委託費（外部）','法定福利費','福利厚生費',
      '外注費','旅費交通費','調査費','通信費','交際費','会議費','減価償却費','地代家賃','水道光熱費','広告宣伝費','消耗品費','燃料費','租税公課',
      '諸会費','新聞図書費','教育研修費','整備費用','雑費'])) then raise exception 'invalid account'; end if;
  if v_sal and not exists (select 1 from bt_pl_manual where account = p_account)
     and (select count(distinct account) from bt_pl_manual where account like '給与手当/%') >= 30 then raise exception 'too many salary rows'; end if;
  if p_amount is not null and (p_amount > 1000000000 or p_amount < -1000000000) then raise exception 'invalid amount'; end if;
  v_id := p_ym || ':' || p_account;
  insert into bt_pl_manual(id, ym, account, amount, updated_by, updated_at)
    values (v_id, p_ym, p_account, p_amount, '進行管理ページ', now())
  on conflict (id) do update set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return jsonb_build_object('id', r.id, 'amount', r.amount);
end $$;
revoke all on function public.bt_fin_set_manual(text,text,text,bigint) from public;
grant execute on function public.bt_fin_set_manual(text,text,text,bigint) to anon, authenticated;
