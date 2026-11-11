-- 高松 配車表「組み替えモード」の確定処理（BT ggqugvyskyiblxiycpci）
-- 画面で動かした配車（複数件）を、最新データで重なりを確かめてから1回でまとめて保存する。
-- 1件でもだめなら何も保存しない（途中の状態をDBに出さない＝在庫ロボ・自動配車・HP表示が途中を見ない）。
-- 書くもの：bt_fleet（動かした予約の行だけ・manual=true＝人の手動配車）／クラスが変わった予約の
--   bt_reservations.vehicle_class・bt_tasks."クラス"＋bt_reservation_changes の記録（既存のドラッグ配車と同じ同期）。
--   bt_tasks の車両・ナンバーは既存トリガー bt_fleet_push_tasks が直す。
-- 権限：SECURITY INVOKER（スタッフ本人の権限・RLS のまま）。ログインしたスタッフ（authenticated）だけ実行できる。
-- 戻し方：drop function public.bt_fleet_apply_moves(jsonb);  （画面側は組み替えボタンが使えなくなるだけ・既存の配車操作は無関係）

create or replace function public.bt_fleet_apply_moves(p_moves jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n int;
  r record;
  v_cls int := 0;
  v_moved int := 0;
begin
  if coalesce((current_setting('request.jwt.claims', true))::json->>'role', '') <> 'authenticated' then
    raise exception 'REBUILD_AUTH: ログインしたスタッフだけが使えます' using errcode = '42501';
  end if;
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    raise exception 'REBUILD_INPUT: 形式が違います';
  end if;
  n := jsonb_array_length(p_moves);
  if n < 1 or n > 40 then
    raise exception 'REBUILD_INPUT: 1回に保存できるのは1〜40件です（今回 % 件）', n;
  end if;

  -- 入力の形
  if exists (select 1 from jsonb_to_recordset(p_moves) x(id text, "from" text, "to" text)
             where coalesce(x.id, '') = '' or coalesce(x."from", '') = '' or coalesce(x."to", '') = '') then
    raise exception 'REBUILD_INPUT: 仮置きのままの予約、または移動先のない予約があります';
  end if;
  if (select count(distinct x.id) from jsonb_to_recordset(p_moves) x(id text)) <> n then
    raise exception 'REBUILD_INPUT: 同じ予約が2回入っています';
  end if;

  -- 自動配車ロボ（fleet_auto.sweep）と同じ表ロックで、確かめてから書くまでの間に他の配車が割り込まないようにする（数ミリ秒）
  set local lock_timeout = '5s';
  lock table public.bt_fleet in exclusive mode;

  -- 移動先の車が存在するか
  select x."to" as tv into r from jsonb_to_recordset(p_moves) x("to" text)
   where not exists (select 1 from bt_vehicles v where v.code = x."to") limit 1;
  if found then raise exception 'REBUILD_VEHICLE: 車両 % が見つかりません', r.tv; end if;

  -- 画面で動かし始めた時から、ほかの端末やロボで配車が変わっていないか（変わっていたら保存しない）
  select x.id, coalesce(res.name, '') as nm into r
    from jsonb_to_recordset(p_moves) x(id text, "from" text)
    left join bt_fleet f on f.reservation_id = x.id
    left join bt_reservations res on res.id = x.id
   where f.vehicle_code is distinct from x."from" limit 1;
  if found then
    raise exception 'REBUILD_STALE: %様（%）の配車が、ほかの端末か自動配車で変わりました。最新を読み直してからやり直してください', r.nm, r.id;
  end if;

  -- キャンセル済みの予約は動かさない
  select x.id, coalesce(res.name, '') as nm into r
    from jsonb_to_recordset(p_moves) x(id text)
    join bt_reservations res on res.id = x.id
   where lower(coalesce(res.status, '')) in ('cancelled', 'canceled', 'cancel', 'キャンセル') limit 1;
  if found then raise exception 'REBUILD_CANCELLED: %様（%）はキャンセル済みです', r.nm, r.id; end if;

  -- 入替車の貸せる期間（service_from〜service_to）の外には置かない
  select x.id, coalesce(res.name, '') as nm, v.name as vn, v.plate_no as vp into r
    from jsonb_to_recordset(p_moves) x(id text, "to" text)
    join bt_reservations res on res.id = x.id
    join bt_vehicles v on v.code = x."to"
   where (v.service_from is not null and left(replace(coalesce(res.start_date, ''), '/', '-'), 10) < v.service_from::text)
      or (v.service_to   is not null and left(replace(coalesce(res.end_date,   ''), '/', '-'), 10) > v.service_to::text)
   limit 1;
  if found then raise exception 'REBUILD_SERVICE: %様（%）は %（%）の貸せる期間の外です', r.nm, r.id, r.vn, r.vp; end if;

  -- 保存後の姿で、同じ車に期間が重なる予約が残らないか
  with mv as (select x.id, x."to" as tv from jsonb_to_recordset(p_moves) x(id text, "to" text)),
  fin as (  -- 保存後の配車（動かす予約は移動先、それ以外は今のまま）
    select f.reservation_id as id, coalesce(mv.tv, f.vehicle_code) as vc
      from bt_fleet f left join mv on mv.id = f.reservation_id),
  live as (
    select fin.id, fin.vc, res.name,
           left(replace(coalesce(res.start_date, ''), '/', '-'), 10) as s,
           left(replace(coalesce(res.end_date,   ''), '/', '-'), 10) as e
      from fin join bt_reservations res on res.id = fin.id
     where lower(coalesce(res.status, '')) not in ('cancelled', 'canceled', 'cancel', 'キャンセル'))
  select a.id, a.name as an, b.id as bid, b.name as bn, v.name as vn, v.plate_no as vp into r
    from mv join live a on a.id = mv.id
    join live b on b.vc = a.vc and b.id <> a.id and b.s <= a.e and b.e >= a.s
    left join bt_vehicles v on v.code = a.vc
   limit 1;
  if found then
    raise exception 'REBUILD_OVERLAP: %（%）で %様 と %様 の期間が重なっています', r.vn, r.vp, r.an, r.bn;
  end if;

  -- 移動先の車の入庫・修理・安全在庫と重ならないか（画面の checkVehicleConflict と同じく全ラベル対象・取消/却下は除く）
  select x.id, coalesce(res.name, '') as nm, m.label as ml, v.name as vn, v.plate_no as vp into r
    from jsonb_to_recordset(p_moves) x(id text, "to" text)
    join bt_reservations res on res.id = x.id
    join bt_maintenance m on m.vehicle_code = x."to"
    left join bt_vehicles v on v.code = x."to"
   where coalesce(m.status, '') not in ('cancelled', 'canceled', 'rejected', 'キャンセル')
     and left(m.start_date::text, 10) <= left(replace(coalesce(res.end_date, ''), '/', '-'), 10)
     and left(coalesce(nullif(m.end_date::text, ''), m.start_date::text), 10) >= left(replace(coalesce(res.start_date, ''), '/', '-'), 10)
   limit 1;
  if found then
    raise exception 'REBUILD_MAINT: %様 を %（%）に置くと「%」と重なります', r.nm, r.vn, r.vp, coalesce(r.ml, '入庫');
  end if;

  -- ここまで全部OK → 動かした予約の行だけ書く
  update bt_fleet f set vehicle_code = x."to", manual = true
    from jsonb_to_recordset(p_moves) x(id text, "from" text, "to" text)
   where f.reservation_id = x.id and f.vehicle_code = x."from" and f.vehicle_code is distinct from x."to";
  get diagnostics v_moved = row_count;

  -- クラスが変わる予約だけ、予約とタスクのクラスを合わせる（既存のドラッグ配車と同じ同期・変更履歴も残す）
  -- status は承認待ち(requested)にしない＝マイページ承認待ちの件数に混ぜない（omni-review 条件2）
  insert into bt_reservation_changes(reservation_id, change_type, field_name, old_value, new_value, source, status, changed_at)
  select res.id, '組み替え→クラス同期', 'vehicle_class', coalesce(res.vehicle_class, ''), v.type, 'fleet', 'acknowledged',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    from jsonb_to_recordset(p_moves) x(id text, "to" text)
    join bt_reservations res on res.id = x.id
    join bt_vehicles v on v.code = x."to"
   where coalesce(v.type, '') <> '' and res.vehicle_class is distinct from v.type;

  -- changed_json は丸ごと置き換えず、_src だけ重ねる（_own・_cancel 等の既存キーを消さない＝omni-review 条件1）
  update bt_reservations res set vehicle_class = v.type,
         changed_json = (case when coalesce(res.changed_json, '') ~ '^\s*\{' then res.changed_json::jsonb else '{}'::jsonb end
                         || '{"_src":"human"}'::jsonb)::text
    from jsonb_to_recordset(p_moves) x(id text, "to" text)
    join bt_vehicles v on v.code = x."to"
   where res.id = x.id and coalesce(v.type, '') <> '' and res.vehicle_class is distinct from v.type;
  get diagnostics v_cls = row_count;

  update bt_tasks t set "クラス" = v.type, updated_at = now()
    from jsonb_to_recordset(p_moves) x(id text, "to" text)
    join bt_vehicles v on v.code = x."to"
   where t."予約番号" = x.id and coalesce(t.deleted, false) = false
     and lower(coalesce(t."確認"::text, '')) <> 'true'
     and coalesce(v.type, '') <> '' and t."クラス" is distinct from v.type;

  return jsonb_build_object('ok', true, 'moved', v_moved, 'class_synced', v_cls);
end
$$;

revoke all on function public.bt_fleet_apply_moves(jsonb) from public, anon;
grant execute on function public.bt_fleet_apply_moves(jsonb) to authenticated;
