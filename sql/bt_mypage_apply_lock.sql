-- 2026-11-08 高松 HDM ブランド：マイページの送迎変更を「依頼 → アクションタブで承認 → DB関数1回で反映」にする（那覇 nha_mypage_apply_lock.sql と同じ設計）
-- ※下書き（未適用）。BUDDICA ブランドの動きは変えない（反映関数は brand='HDM' 以外を拒否）。
--
-- 1) bt_cj                       : changed_json(text) を安全に jsonb 化
-- 2) bt_task_eff_type/time/place  : OPシート(_fromDbTask＋表示式)と同じ読み方。個別URL(bt_staff_view)・マイページもこれを使う
--      type  = 内案あり→内容 / 予約あり＆送迎系→deriveLendType/deriveRetType(予約) / それ以外→内容
--      time  = 変更 || _ssTime || 基本時間（基本時間＝変更/_ssTime/_timeChangeSource=manual/_manualTimeAt があれば 時間、
--              無ければ送迎系だけ予約の col_time||end_time / del_time||start_time、空なら 時間）
--      place = _placeSource='manual' → 基本場所 / それ以外 → _ssPlace || 基本場所
--              （基本場所＝manual/customer/_ssPlace があれば 送迎場所、無ければ送迎系だけ予約の col_place / del_place、空なら 送迎場所）
-- 3) bt_task_mplock / bt_res_mplock : 承認で書いた値を、取込・自動取得・古い画面の丸ごと保存で戻させない（既存ガードの後に動く）
-- 4) bt_apply_mypage_change       : 予約・OPタスク・依頼行を1トランザクションで反映し、OPシートと同じ読み方で読み直し、不一致なら全部取り消す
-- 5) bt_res_effective / bt_mp_sync_check : 現在値（OPシートの読み方）／ロック値とのズレ監視
-- 6) bt_staff_view                : 時間・場所の読み方を 2) に統一
-- 7) mpadmin_pending_bt           : マイページ依頼（キャンセル＋送迎4種）だけを返す。payload・代わりの案・お断りも返す
--
-- 反映できる項目（p_field）＝マイページの「行き」「帰り」の選択肢そのもの:
--   pickup       行き＝空港お迎え(PU)＋時間(＋便名)  予約 visit_type/pickup_time/del_time(/del_flight)・d-タスク 内容/時間/変更
--   visit        行き＝店舗へ来店                     予約 visit_type=来店/pickup_time=null・d-タスク 内容
--   dropoff      帰り＝空港へ送迎(BD)＋時間           予約 return_type/dropoff_time/col_time・c-タスク 内容/時間/変更/返却
--   store_return 帰り＝店舗で返却                     予約 return_type=返却/dropoff_time=null・c-タスク 内容
--   理由：本番 v53 の set_pickup/set_return が書く列の組とちょうど同じ（承認前後で OP に出る結果が変わらない）。
--         4種それぞれが「1つの列セットを一度に書く」ので、部分反映が起きない。代わりの案は pickup/dropoff の時間だけで足りる。
--   依頼行は bt_reservation_changes.change_type = 'mp_pickup' / 'mp_visit' / 'mp_dropoff' / 'mp_store_return'（source='mypage'）。
--   アプリの手入力記録（source=manual/fleet・change_type=日本語、status=requested が約220件）と混ざらない。

-- ===== 0) 依頼行に payload（希望の値・代わりの案・お断り・送った文・反映結果） =====
alter table public.bt_reservation_changes add column if not exists payload jsonb not null default '{}'::jsonb;

-- ===== 1) changed_json =====
create or replace function public.bt_cj(p text) returns jsonb
language plpgsql immutable as $$
begin
  if p is null or btrim(p) = '' then return '{}'::jsonb; end if;
  return case when jsonb_typeof(p::jsonb) = 'object' then p::jsonb else '{}'::jsonb end;
exception when others then return '{}'::jsonb;
end $$;

-- ===== 2) OPシートと同じ読み方 =====
-- app index.html.bak:3883 _btOkPlace / :3884 _btAirportBus
create or replace function public.bt_ok_place(p text) returns boolean
language sql immutable as $$
  select coalesce(btrim(p),'') <> '' and btrim(p) !~ '^(来店|店舗|店頭|ヤード|営業所|ー+|-+|なし|無し|FALSE|false|0)$'
$$;
create or replace function public.bt_airport_bus(p text) returns boolean
language sql immutable as $$
  select coalesce(p,'') ~ '送迎バス|14番のりば|11番|レンタカー送迎バス|高松空港|空港'
$$;

-- app _fromDbTask の type（:589）＋ deriveLendType/deriveRetType（:3885-3886）
create or replace function public.bt_task_eff_type(t public.bt_tasks, r public.bt_reservations) returns text
language sql stable as $$
  select case
    when coalesce(btrim(t."内案"),'') <> '' then t."内容"
    when r.id is null or coalesce(t."予約番号",'') = '' then t."内容"
    when t."内容" in ('COL','BD','BDB','返却','返却待') then
      case when r.return_type = '返却' then '返却'
           when r.return_type in ('PU','BD','DEL','COL') then r.return_type
           when r.return_type in ('PUB','BDB') then 'BD'
           when public.bt_airport_bus(r.col_place) then 'BD'
           when public.bt_ok_place(r.col_place) then 'COL'
           else '返却待' end
    when t."内容" in ('DEL','PU','PUB','来店','PUB来店','貸出') then
      case when r.visit_type = '来店' then '来店'
           when r.visit_type in ('PU','BD','DEL','COL') then r.visit_type
           when r.visit_type in ('PUB','BDB') then 'PU'
           when public.bt_airport_bus(r.del_place) then 'PU'
           when public.bt_ok_place(r.del_place) then 'DEL'
           else '貸出' end
    else t."内容" end
$$;

-- app 表示 timeChange||_ssTime||time（time＝_fromDbTask の time）
create or replace function public.bt_task_eff_time(t public.bt_tasks, r public.bt_reservations) returns text
language sql stable as $$
  with x as (select public.bt_cj(t.changed_json) cj)
  select coalesce(
    nullif(t."変更",''),
    nullif(x.cj->>'_ssTime',''),
    case
      when coalesce(btrim(t."変更"),'') <> '' or coalesce(btrim(x.cj->>'_ssTime'),'') <> ''
        or x.cj->>'_timeChangeSource' = 'manual' or coalesce(btrim(x.cj->>'_manualTimeAt'),'') <> '' then t."時間"
      when r.id is null or coalesce(t."予約番号",'') = '' then t."時間"
      when t."内容" in ('COL','BD','BDB','返却','返却待') then
        (select case when coalesce(btrim(v),'') <> '' then v else t."時間" end
           from (select case when coalesce(r.col_time,'') <> '' then r.col_time else r.end_time end v) q)
      when t."内容" in ('DEL','PU','PUB','来店','PUB来店','貸出') then
        (select case when coalesce(btrim(v),'') <> '' then v else t."時間" end
           from (select case when coalesce(r.del_time,'') <> '' then r.del_time else r.start_time end v) q)
      else t."時間" end, '')
  from x
$$;

-- app 表示 _placeSource==="manual" ? place : (_ssPlace||place)（place＝_fromDbTask の place）
create or replace function public.bt_task_eff_place(t public.bt_tasks, r public.bt_reservations) returns text
language sql stable as $$
  with x as (select public.bt_cj(t.changed_json) cj),
  b as (
    select x.cj, case
      when x.cj->>'_placeSource' in ('manual','customer') or coalesce(btrim(x.cj->>'_ssPlace'),'') <> '' then t."送迎場所"
      when r.id is null or coalesce(t."予約番号",'') = '' then t."送迎場所"
      when t."内容" in ('COL','BD','BDB','返却','返却待') then case when coalesce(btrim(r.col_place),'') <> '' then r.col_place else t."送迎場所" end
      when t."内容" in ('DEL','PU','PUB','来店','PUB来店','貸出') then case when coalesce(btrim(r.del_place),'') <> '' then r.del_place else t."送迎場所" end
      else t."送迎場所" end base
    from x)
  select coalesce(case when b.cj->>'_placeSource' = 'manual' then b.base else coalesce(nullif(b.cj->>'_ssPlace',''), b.base) end, '')
  from b
$$;

-- ===== 3) タスク側のロック =====
-- changed_json._mpLock = {"列名":{"v":承認値,"p":承認前の値,"at":ISO(UTC)}}。ロックは「更新前の行(old)」から読むので、
-- アプリの丸ごと保存（changed_json を作り直す _toDbTask）や古い画面の保存で _mpLock が消えても効き続ける。
-- ロック中の列を変えてよいのは:
--   ・承認の反映処理そのもの（bt.mp_apply）
--   ・変更／返却：OPシートでの手入力（新しい changed_json._manualTimeAt が承認時刻より新しい）。変更が外れたら同じタスクの 返却 も外す
--   ・内容：内案が今回の保存で変わった（OPシートでの種別変更）
-- それ以外（取込・自動取得・古い画面の保存・空欄化）は承認値に戻し bt_guard_log に残す
create or replace function public.bt_task_mplock() returns trigger
language plpgsql as $$
declare lk jsonb; k text; e jsonb; nv text; ncj jsonb; ok boolean; at text; fix jsonb := '{}'::jsonb; rel_chg boolean := false;
begin
  if current_setting('bt.mp_apply', true) = '1' then return new; end if;
  lk := public.bt_cj(old.changed_json)->'_mpLock';
  if lk is null or jsonb_typeof(lk) <> 'object' or lk = '{}'::jsonb then return new; end if;
  ncj := public.bt_cj(new.changed_json);
  for k, e in select * from jsonb_each(lk) loop
    nv := to_jsonb(new)->>k;
    if nv is not distinct from (e->>'v') then continue; end if;
    at := coalesce(e->>'at','');
    ok := false;
    if coalesce(btrim(nv),'') <> '' then
      if k in ('変更','返却') then ok := coalesce(ncj->>'_manualTimeAt','') > at;
      elsif k = '内容' then ok := new."内案" is distinct from old."内案";
      end if;
    end if;
    if ok then
      lk := lk - k; if k = '変更' then rel_chg := true; end if;
    else
      fix := fix || jsonb_build_object(k, e->'v');
    end if;
  end loop;
  if rel_chg then fix := fix - '返却'; lk := lk - '返却'; end if;
  if fix <> '{}'::jsonb then
    insert into public.bt_guard_log(row_id, field, blocked_new, kept_old)
      select new._id, f.key || '(承認ロック)', to_jsonb(new)->>f.key, f.value #>> '{}' from jsonb_each(fix) f;
    new := jsonb_populate_record(new, fix);
  end if;
  -- 承認値が生きている間は OPシートの読み方でもタスク値が勝つようにフラグを維持
  if lk ? '変更' then ncj := ncj || '{"_timeChangeSource":"manual"}'::jsonb; end if;
  if lk = '{}'::jsonb then ncj := ncj - '_mpLock'; else ncj := ncj || jsonb_build_object('_mpLock', lk); end if;
  new.changed_json := ncj::text;
  return new;
end $$;

-- BEFORE トリガーは名前順。既存 trg_bt_src_guard → trg_bt_task_ota_force_insurance → trg_bt_tasks_fill の後に動かす
drop trigger if exists trg_bt_zz_task_mplock on public.bt_tasks;
create trigger trg_bt_zz_task_mplock before update on public.bt_tasks for each row execute function public.bt_task_mplock();

-- ===== 3') 予約側のロック =====
-- _mpSeen：このトリガー（と反映処理）が changed_json に付ける印。新しい changed_json に印が無い＝今回の保存で
--   クライアントが changed_json を作り直した（updateReservationField の {_src:'human'}、丸ごと保存の {_src:'system'}）。
--   印があるのに _src が残っているのは前回の値なので「今回の人の保存」とは見なさない。
-- ロック中の列を変えてよいのは:
--   ・承認の反映処理そのもの
--   ・OPシートの予約編集（今回作り直された changed_json の _src='human'）で、空欄でも承認前の値でもない値
--   ・visit_type/return_type：OPシートの「受取/返却方法」変更（updated_by='manual_visit_return' で changed_json は触らない保存）
--   ・時間列：同じ予約の OP タスクの「変更」と一致（d-→del_time/pickup_time、c-→col_time/dropoff_time）
-- 取込(system)・自動取得・その他はすべて承認値に戻す
create or replace function public.bt_res_mplock() returns trigger
language plpgsql as $$
declare lk jsonb; k text; e jsonb; nv text; ncj jsonb; ok boolean; fresh_src text; tv text; fix jsonb := '{}'::jsonb;
begin
  if current_setting('bt.mp_apply', true) = '1' then return new; end if;
  lk := public.bt_cj(old.changed_json)->'_mpLock';
  if lk is null or jsonb_typeof(lk) <> 'object' or lk = '{}'::jsonb then return new; end if;
  ncj := public.bt_cj(new.changed_json);
  fresh_src := case when not (ncj ? '_mpSeen') then ncj->>'_src' end;
  for k, e in select * from jsonb_each(lk) loop
    nv := to_jsonb(new)->>k;
    if nv is not distinct from (e->>'v') then continue; end if;
    ok := false;
    if coalesce(btrim(nv),'') <> '' then
      if fresh_src = 'human' and nv is distinct from (e->>'p') then ok := true; end if;
      if not ok and k in ('visit_type','return_type') and (ncj ? '_mpSeen') and new.updated_by = 'manual_visit_return' then ok := true; end if;
      if not ok and k in ('del_time','pickup_time','col_time','dropoff_time') then
        select t."変更" into tv from public.bt_tasks t
         where t."予約番号" = new.id and coalesce(t.deleted,false) = false
           and t._id like (case when k in ('del_time','pickup_time') then 'd-%' else 'c-%' end)
         order by t._id limit 1;
        ok := (nv = coalesce(tv,''));
      end if;
    end if;
    if ok then lk := lk - k;
    else fix := fix || jsonb_build_object(k, e->'v');
    end if;
  end loop;
  if fix <> '{}'::jsonb then
    insert into public.bt_res_guard_log(row_id, field, would_block_new, kept_old, note)
      select new.id, f.key, to_jsonb(new)->>f.key, f.value #>> '{}', 'mplock' from jsonb_each(fix) f;
    new := jsonb_populate_record(new, fix);
  end if;
  if lk = '{}'::jsonb then ncj := ncj - '_mpLock' - '_mpSeen'; else ncj := ncj || jsonb_build_object('_mpLock', lk, '_mpSeen', 1); end if;
  new.changed_json := ncj::text;
  return new;
end $$;

-- 既存 trg_bt_derive_del_col_type → trg_bt_ota_force_insurance → trg_bt_res_detect → trg_bt_set_brand → trg_rakuten_coupon の後
drop trigger if exists trg_zz_bt_res_mplock on public.bt_reservations;
create trigger trg_zz_bt_res_mplock before update on public.bt_reservations for each row execute function public.bt_res_mplock();

-- ===== 4) 承認の反映（1トランザクション） =====
-- p_flight：pickup の便名（空なら予約の便名はそのまま）。p_change_id：bt_reservation_changes.id（渡すと同じトランザクションで approved にする）
-- 呼び出しは EF（service_role）から。x-bt-writer=customer を立てて既存の _bt_src_guard に「人の入力」として通す（v53 と同じ扱い）
create or replace function public.bt_apply_mypage_change(p_res text, p_field text, p_val text, p_actor text,
                                                         p_change_id bigint default null, p_flight text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_val,'')); fl text := nullif(btrim(coalesce(p_flight,'')),'');
        r public.bt_reservations; t public.bt_tasks; c public.bt_reservation_changes;
        at text; old_v text; rlk jsonb; tlk jsonb; cj jsonb; n int := 0; bad text := ''; hm int; et text; ety text; want_ty text;
begin
  if p_field not in ('pickup','visit','dropoff','store_return') then raise exception '反映できない項目です: %', p_field; end if;
  if p_field in ('pickup','dropoff') then
    if v !~ '^\d{1,2}:\d{2}$' then raise exception '時間の形式が不正です: %', v; end if;
    hm := split_part(v,':',1)::int * 60 + split_part(v,':',2)::int;
    if not ((hm between 540 and 1125 and hm % 15 = 0) or hm = 1130) then raise exception '受付時間外です（9:00〜18:50・15分刻み）: %', v; end if;
    v := lpad(split_part(v,':',1),2,'0') || ':' || split_part(v,':',2);
  end if;
  want_ty := case p_field when 'pickup' then 'PU' when 'visit' then '来店' when 'dropoff' then 'BD' else '返却' end;

  perform set_config('bt.mp_apply', '1', true);
  perform set_config('request.headers',
    (coalesce(nullif(current_setting('request.headers', true),''),'{}')::jsonb || '{"x-bt-writer":"customer"}'::jsonb)::text, true);
  at := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  if p_change_id is not null then
    select * into c from public.bt_reservation_changes where id = p_change_id for update;
    if not found then raise exception '依頼が見つかりません'; end if;
    if c.reservation_id is distinct from p_res then raise exception '依頼と予約が一致しません'; end if;
    if c.status is distinct from 'requested' then raise exception '処理済みの依頼です（%）', c.status; end if;
  end if;

  select * into r from public.bt_reservations where id = p_res for update;
  if not found then raise exception '予約が見つかりません'; end if;
  if coalesce(r.brand,'') <> 'HDM' then raise exception 'HDMブランドの予約だけが対象です'; end if;
  if coalesce(r.status,'') ~* 'cancel' or coalesce(r.status,'') like '%キャンセル%' then raise exception 'キャンセル済みの予約です'; end if;

  rlk := coalesce(public.bt_cj(r.changed_json)->'_mpLock', '{}'::jsonb);
  if p_field = 'pickup' then
    old_v := coalesce(nullif(r.pickup_time,''), '');
    rlk := rlk || jsonb_build_object(
      'visit_type',  jsonb_build_object('v', 'PU', 'p', coalesce(r.visit_type,''),  'at', at),
      'pickup_time', jsonb_build_object('v', v,    'p', coalesce(r.pickup_time,''), 'at', at),
      'del_time',    jsonb_build_object('v', v,    'p', coalesce(r.del_time,''),    'at', at))
      || case when fl is not null then jsonb_build_object('del_flight', jsonb_build_object('v', fl, 'p', coalesce(r.del_flight,''), 'at', at)) else '{}'::jsonb end;
    update public.bt_reservations set visit_type = 'PU', pickup_time = v, del_time = v, del_flight = coalesce(fl, del_flight),
      updated_by = 'mypage_approve', updated_at = now(),
      changed_json = (public.bt_cj(changed_json) || jsonb_build_object('_src','customer','_mpLock', rlk, '_mpSeen', 1))::text where id = p_res;
  elsif p_field = 'visit' then
    old_v := coalesce(r.visit_type,'');
    rlk := rlk || jsonb_build_object(
      'visit_type',  jsonb_build_object('v', '来店', 'p', coalesce(r.visit_type,''), 'at', at),
      'pickup_time', jsonb_build_object('v', null,   'p', coalesce(r.pickup_time,''), 'at', at));
    update public.bt_reservations set visit_type = '来店', pickup_time = null, updated_by = 'mypage_approve', updated_at = now(),
      changed_json = (public.bt_cj(changed_json) || jsonb_build_object('_src','customer','_mpLock', rlk, '_mpSeen', 1))::text where id = p_res;
  elsif p_field = 'dropoff' then
    old_v := coalesce(nullif(r.dropoff_time,''), '');
    rlk := rlk || jsonb_build_object(
      'return_type',  jsonb_build_object('v', 'BD', 'p', coalesce(r.return_type,''),  'at', at),
      'dropoff_time', jsonb_build_object('v', v,    'p', coalesce(r.dropoff_time,''), 'at', at),
      'col_time',     jsonb_build_object('v', v,    'p', coalesce(r.col_time,''),     'at', at));
    update public.bt_reservations set return_type = 'BD', dropoff_time = v, col_time = v, updated_by = 'mypage_approve', updated_at = now(),
      changed_json = (public.bt_cj(changed_json) || jsonb_build_object('_src','customer','_mpLock', rlk, '_mpSeen', 1))::text where id = p_res;
  else
    old_v := coalesce(r.return_type,'');
    rlk := rlk || jsonb_build_object(
      'return_type',  jsonb_build_object('v', '返却', 'p', coalesce(r.return_type,''), 'at', at),
      'dropoff_time', jsonb_build_object('v', null,   'p', coalesce(r.dropoff_time,''), 'at', at));
    update public.bt_reservations set return_type = '返却', dropoff_time = null, updated_by = 'mypage_approve', updated_at = now(),
      changed_json = (public.bt_cj(changed_json) || jsonb_build_object('_src','customer','_mpLock', rlk, '_mpSeen', 1))::text where id = p_res;
  end if;

  -- OPタスク（d-=行き、c-=帰り。削除済みは除く）
  for t in select * from public.bt_tasks where "予約番号" = p_res and coalesce(deleted,false) = false
             and _id like (case when p_field in ('pickup','visit') then 'd-%' else 'c-%' end) for update loop
    cj := public.bt_cj(t.changed_json);
    tlk := coalesce(cj->'_mpLock','{}'::jsonb) || jsonb_build_object('内容', jsonb_build_object('v', want_ty, 'p', coalesce(t."内容",''), 'at', at));
    if p_field = 'pickup' then
      tlk := tlk || jsonb_build_object('変更', jsonb_build_object('v', v, 'p', coalesce(t."変更",''), 'at', at));
      update public.bt_tasks set "内容" = 'PU', "時間" = v, "変更" = v, updated_at = now(),
        changed_json = (cj || jsonb_build_object('_src','customer','_timeChangeSource','manual','_mpLock', tlk))::text where _id = t._id;
    elsif p_field = 'dropoff' then
      tlk := tlk || jsonb_build_object('変更', jsonb_build_object('v', v, 'p', coalesce(t."変更",''), 'at', at),
                                       '返却', jsonb_build_object('v', v, 'p', coalesce(t."返却",''), 'at', at));
      update public.bt_tasks set "内容" = 'BD', "時間" = v, "変更" = v, "返却" = v, updated_at = now(),
        changed_json = (cj || jsonb_build_object('_src','customer','_timeChangeSource','manual','_mpLock', tlk))::text where _id = t._id;
    else
      update public.bt_tasks set "内容" = want_ty, updated_at = now(),
        changed_json = (cj || jsonb_build_object('_src','customer','_mpLock', tlk))::text where _id = t._id;
    end if;
    n := n + 1;
  end loop;

  -- 読み直し確認：OPシート・タスクサマリー・個別URL（同じ読み方）で承認値になっているか
  select * into r from public.bt_reservations where id = p_res;
  if (p_field = 'pickup' and (r.visit_type is distinct from 'PU' or r.pickup_time is distinct from v or r.del_time is distinct from v
                              or (fl is not null and r.del_flight is distinct from fl)))
     or (p_field = 'visit' and (r.visit_type is distinct from '来店' or r.pickup_time is not null))
     or (p_field = 'dropoff' and (r.return_type is distinct from 'BD' or r.dropoff_time is distinct from v or r.col_time is distinct from v))
     or (p_field = 'store_return' and (r.return_type is distinct from '返却' or r.dropoff_time is not null)) then
    bad := bad || ' 予約';
  end if;
  for t in select * from public.bt_tasks where "予約番号" = p_res and coalesce(deleted,false) = false
             and _id like (case when p_field in ('pickup','visit') then 'd-%' else 'c-%' end) loop
    ety := public.bt_task_eff_type(t, r); et := public.bt_task_eff_time(t, r);
    if ety is distinct from want_ty then bad := bad || ' ' || t._id || '(種別:' || coalesce(ety,'') || ')'; end if;
    if p_field in ('pickup','dropoff') and et is distinct from v then bad := bad || ' ' || t._id || '(時間:' || coalesce(et,'') || ')'; end if;
  end loop;
  if bad <> '' then raise exception '反映の確認で不一致:%（何も変更していません）', bad; end if;

  if p_change_id is not null then
    update public.bt_reservation_changes set status = 'approved', decided_by = p_actor, decided_at = now(),
      payload = coalesce(payload,'{}'::jsonb) || jsonb_build_object('applied', jsonb_build_object('field', p_field, 'value', v, 'flight', fl, 'old', old_v, 'tasks', n, 'at', at))
     where id = p_change_id;
  end if;
  return jsonb_build_object('ok', true, 'field', p_field, 'tasks', n, 'old', old_v, 'new', v);
end $$;

-- ===== 5) 現在値（OPシートの読み方）とズレ監視 =====
create or replace function public.bt_res_effective(p_res text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.bt_reservations; d public.bt_tasks; c public.bt_tasks;
begin
  select * into r from public.bt_reservations where id = p_res;
  if not found then return null; end if;
  select * into d from public.bt_tasks where "予約番号" = p_res and coalesce(deleted,false) = false and _id like 'd-%' order by _id limit 1;
  select * into c from public.bt_tasks where "予約番号" = p_res and coalesce(deleted,false) = false and _id like 'c-%' order by _id limit 1;
  return jsonb_build_object(
    'lend_type',   case when d._id is not null then public.bt_task_eff_type(d, r) end,
    'lend_time',   case when d._id is not null then public.bt_task_eff_time(d, r) else coalesce(nullif(r.del_time,''), r.start_time, '') end,
    'del_place',   case when d._id is not null then public.bt_task_eff_place(d, r) else coalesce(r.del_place,'') end,
    'return_type', case when c._id is not null then public.bt_task_eff_type(c, r) end,
    'return_time', case when c._id is not null then public.bt_task_eff_time(c, r) else coalesce(nullif(r.col_time,''), r.end_time, '') end,
    'col_place',   case when c._id is not null then public.bt_task_eff_place(c, r) else coalesce(r.col_place,'') end,
    'visit_type', r.visit_type, 'return_type_res', r.return_type, 'pickup_time', r.pickup_time, 'dropoff_time', r.dropoff_time, 'del_flight', r.del_flight,
    'has_d', d._id is not null, 'has_c', c._id is not null);
end $$;

-- ロックが生きているのに、今の値（列そのもの／OPシートの読み方）が承認値と違う行を返す。0行が正常。
create or replace function public.bt_mp_sync_check(p_days int default 30)
returns table(kind text, row_id text, resv text, col text, locked text, current_value text)
language sql stable security definer set search_path = public as $$
  with today as (select to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD') d,
                        to_char((now() at time zone 'Asia/Tokyo') + make_interval(days => p_days),'YYYY-MM-DD') d2),
  res as (
    select 'reservation'::text kind, r.id row_id, r.id resv, l.key col, l.value->>'v' locked, to_jsonb(r)->>l.key current_value
      from public.bt_reservations r, today, jsonb_each(public.bt_cj(r.changed_json)->'_mpLock') l
     where jsonb_typeof(public.bt_cj(r.changed_json)->'_mpLock') = 'object' and coalesce(r.end_date,'') >= today.d),
  tsk as (
    select 'task'::text kind, t._id row_id, t."予約番号" resv, l.key col, l.value->>'v' locked,
           case l.key when '変更' then public.bt_task_eff_time(t, r) when '内容' then public.bt_task_eff_type(t, r) else to_jsonb(t)->>l.key end current_value
      from public.bt_tasks t left join public.bt_reservations r on r.id = t."予約番号", today,
           jsonb_each(public.bt_cj(t.changed_json)->'_mpLock') l
     where coalesce(t.deleted,false) = false and jsonb_typeof(public.bt_cj(t.changed_json)->'_mpLock') = 'object'
       and t.date between today.d and today.d2)
  select * from res where locked is distinct from current_value
  union all
  select * from tsk where locked is distinct from current_value
$$;

-- ===== 6) 個別URL：時間・場所を OPシートと同じ読み方に（他は現行のまま） =====
create or replace function public.bt_staff_view(p_token uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_name text; v_sur text; v_today date := (now() at time zone 'Asia/Tokyo')::date; v_res jsonb;
begin
  select name into v_name from bt_staff where share_token=p_token and coalesce(active,true)=true;
  if v_name is null then return jsonb_build_object('ok',false,'error','invalid_token'); end if;
  v_sur := split_part(v_name,' ',1);
  with base as (
    select t._id, t."内容" as type, t."予約者" as cust,
      coalesce(nullif(v.name,''),nullif(t."車種",''),t.assigned_vehicle) as veh_name,
      t."No" as plate, (t."確認"='true') as done, t."OTA" as ota,
      t."予約番号" as resv, t."担当" as assignee, r.mypage_token,
      r.paid as paid, r.pay_url as pay_url, r.payment as payment,
      coalesce(nullif(r.final_price,0),r.price,0) as price,
      r.start_odo as start_odo, r.end_odo as end_odo, r.driven_km as driven_km,
      (exists(select 1 from license_uploads lu where lu.reservation_id=t."予約番号")) as lic,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type='terms_agree')) as terms,
      (exists(select 1 from handover_signatures hs where hs.reservation_id=t."予約番号" and hs.sign_type='damage_approval')) as dmg,
      case when r.id is not null then coalesce(r.opt_b,0) else coalesce((nullif(t."B",''))::int,0) end as opt_b,
      case when r.id is not null then coalesce(r.opt_c,0) else coalesce((nullif(t."C",''))::int,0) end as opt_c,
      case when r.id is not null then coalesce(r.opt_j,0) else coalesce((nullif(t."J",''))::int,0) end as opt_j,
      case when r.id is not null then coalesce(r.opt_usb,0) else coalesce((nullif(t."USB",''))::int,0) end as opt_usb,
      case when t."内容" in ('洗車','返却後洗車') and t.changed_json is not null and t.changed_json ~ '"_nextDayWash":\s*true' then (t.date::date + 1) else t.date::date end as eff_date,
      public.bt_task_eff_time(t, r) as eff_time,
      public.bt_task_eff_place(t, r) as eff_place
    from bt_tasks t left join bt_reservations r on r.id=t."予約番号" left join bt_vehicles v on v.code=t.assigned_vehicle
    where coalesce(t.deleted,false)=false
  ),
  mine as (select * from base where ( replace(coalesce(assignee,''),' ','')=replace(v_name,' ','') or replace(coalesce(assignee,''),' ','')=v_sur ) and eff_date between v_today and v_today+14)
  select coalesce(jsonb_agg(jsonb_build_object('_id',_id,'type',type,'date',eff_date,'time',eff_time,'customer',cust,'vehicle',veh_name,'plate',plate,'place',eff_place,'done',done,'ota',ota,'resv',resv,'mypage',mypage_token,'paid',paid,'pay_url',pay_url,'payment',payment,'price',price,'opt_b',opt_b,'opt_c',opt_c,'opt_j',opt_j,'opt_usb',opt_usb,'lic',lic,'terms',terms,'damage',dmg,'start_odo',start_odo,'end_odo',end_odo,'driven_km',driven_km) order by eff_date,eff_time),'[]'::jsonb)
  into v_res from mine;
  return jsonb_build_object('ok',true,'staff',v_name,'today',v_today,'tasks',v_res,'requests','[]'::jsonb,'skips','[]'::jsonb);
end $function$;

-- ===== 7) アクションタブの依頼一覧（BT） =====
-- マイページ由来（source='mypage'）かつ 種類が キャンセル／送迎4種 だけ。アプリの手入力記録（約220件）は出さない。
-- 受付中(requested)・代わりの案の返事待ち(proposed)は常に、処理済みは30日分。payload・代わりの案・お断りも返す。
create or replace function public.mpadmin_pending_bt()
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(row order by ord desc),'[]'::jsonb) from (
    select jsonb_build_object('bucket', case when coalesce(r.brand,'BUDDICA')='HDM' then 'hdm_tkm' else 'but_tkm' end,
      'id',c.id::text,'rid',c.reservation_id,'field',coalesce(nullif(c.change_type,''),c.field_name),'newv',c.new_value,'oldv',c.old_value,
      'note',coalesce(c.payload->>'note',''),'status',c.status,
      'at',coalesce(nullif(c.changed_at,''),to_char(c.decided_at,'YYYY-MM-DD"T"HH24:MI:SS')),
      'payload',coalesce(c.payload,'{}'::jsonb),'proposal',c.payload->'proposal','reject',c.payload->'reject',
      'name',r.name,'ota',r.ota,'sd',r.start_date,'ed',r.end_date,'cls',r.vehicle_class,'price',r.price,'mail',r.mail,'line',false,'renewal',true,'token',r.mypage_token) row, c.id ord
    from bt_reservation_changes c left join bt_reservations r on r.id=c.reservation_id
    where c.source='mypage'
      and c.change_type in ('cancel','mp_pickup','mp_visit','mp_dropoff','mp_store_return')
      and (c.status in ('requested','proposed')
           or (c.status in ('approved','rejected','acknowledged','declined_by_guest','expired') and c.decided_at>now()-interval '30 days'))
  ) t;
$function$;

-- ===== 権限：新しい関数は service_role だけ（EF から呼ぶ）。bt_staff_view / mpadmin_pending_bt は現行の権限のまま（replace は権限を保つ） =====
revoke all on function public.bt_cj(text) from public, anon, authenticated;
revoke all on function public.bt_ok_place(text) from public, anon, authenticated;
revoke all on function public.bt_airport_bus(text) from public, anon, authenticated;
revoke all on function public.bt_task_eff_type(public.bt_tasks, public.bt_reservations) from public, anon, authenticated;
revoke all on function public.bt_task_eff_time(public.bt_tasks, public.bt_reservations) from public, anon, authenticated;
revoke all on function public.bt_task_eff_place(public.bt_tasks, public.bt_reservations) from public, anon, authenticated;
revoke all on function public.bt_task_mplock() from public, anon, authenticated;
revoke all on function public.bt_res_mplock() from public, anon, authenticated;
revoke all on function public.bt_apply_mypage_change(text,text,text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.bt_res_effective(text) from public, anon, authenticated;
revoke all on function public.bt_mp_sync_check(int) from public, anon, authenticated;
grant execute on function public.bt_cj(text) to service_role;
grant execute on function public.bt_ok_place(text) to service_role;
grant execute on function public.bt_airport_bus(text) to service_role;
grant execute on function public.bt_task_eff_type(public.bt_tasks, public.bt_reservations) to service_role;
grant execute on function public.bt_task_eff_time(public.bt_tasks, public.bt_reservations) to service_role;
grant execute on function public.bt_task_eff_place(public.bt_tasks, public.bt_reservations) to service_role;
grant execute on function public.bt_apply_mypage_change(text,text,text,text,bigint,text) to service_role;
grant execute on function public.bt_res_effective(text) to service_role;
grant execute on function public.bt_mp_sync_check(int) to service_role;

-- ===== 戻し方（必要なとき） =====
-- drop trigger if exists trg_bt_zz_task_mplock on public.bt_tasks;
-- drop trigger if exists trg_zz_bt_res_mplock on public.bt_reservations;
-- bt_staff_view / mpadmin_pending_bt は適用前の定義（git の前版コメント参照）で create or replace し直す。
