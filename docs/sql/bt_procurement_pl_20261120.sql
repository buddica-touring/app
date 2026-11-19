-- 2026-11-20 進行管理（procurement.html）に PL・インバウンド比率を足すための DB 変更（BT ggqugvyskyiblxiycpci）
-- 起源台帳 ORG-20261120-080153-485 ／ 戻し方＝同じフォルダの bt_procurement_pl_20261120_rollback.sql
--
-- ① bt_pl_manual：PL の手入力セル（給与手当など自動計算しない科目）。1セル＝1行（id = 'YYYY-MM:科目'）。
--    ログインした人（authenticated）だけ読める・書ける。anon は読めない。削除はしない（空欄に戻す＝amount を null）。
-- ② bt_inbound_monthly()：返却月ごとの予約件数・売上とインバウンドの件数・売上を返す集計関数。
--    個人情報は返さない（件数と金額だけ）。売上・件数の数え方は bt_mtg_h2 と同じ（返却月・キャンセル/テスト除外・rev式）。
--    インバウンド判定（オーナー確定 2026-11-20「媒体で限定するな・あらゆる可能性」）＝次のどれか1つでも当たる予約：
--      mail  : 予約メール原本が繁体字/韓国語（日圓・預約・車型・現場付款・ハングル）※媒体を問わない
--      tel   : 電話番号が海外の国番号（+81以外の+番号／0・81で始まらない番号。0抜けの国内番号は除く）
--      name  : 氏名（またはカナ）が日本人名でない＝ハングル／日本で使わない漢字（SJISに無い）／日本語の綴りでないローマ字
--              ／中国・韓国系の姓（漢字2〜3字・日本に少ない姓）／カタカナの外国姓（キム・パク等）
--      addr  : 住所（prefecture 列・メール原本の「予約者住所」）が海外表記
--      lic   : 免許証AIチェックで国際免許・外国免許
--      guide : ご利用ガイドをお客様が日本語以外で操作（スタッフ代理の操作は除く）

begin;

-- ① 手入力セル
create table if not exists public.bt_pl_manual (
  id         text primary key,                                   -- 'YYYY-MM:科目'
  ym         text not null check (ym ~ '^[0-9]{4}-[0-9]{2}$'),
  account    text not null,
  amount     bigint,                                             -- null＝未入力（空欄）
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bt_pl_manual_id_chk check (id = ym || ':' || account)
);
alter table public.bt_pl_manual enable row level security;
revoke all on public.bt_pl_manual from anon, authenticated;   -- 既定の全権（DELETE/TRUNCATE含む）を外してから必要分だけ付ける（omni-review 条件1）
grant select, insert, update on public.bt_pl_manual to authenticated;
drop policy if exists bt_pl_manual_read on public.bt_pl_manual;
drop policy if exists bt_pl_manual_ins  on public.bt_pl_manual;
drop policy if exists bt_pl_manual_upd  on public.bt_pl_manual;
create policy bt_pl_manual_read on public.bt_pl_manual for select to authenticated using (true);
create policy bt_pl_manual_ins  on public.bt_pl_manual for insert to authenticated with check (true);
create policy bt_pl_manual_upd  on public.bt_pl_manual for update to authenticated using (true) with check (true);
drop trigger if exists trg_audit_all on public.bt_pl_manual;
create trigger trg_audit_all after insert or delete or update on public.bt_pl_manual for each row execute function _audit_row();

-- ② インバウンド判定の部品
create or replace function public._bt_ib_nonsjis(t text) returns boolean
language plpgsql immutable as $$
begin
  if t is null or t = '' then return false; end if;
  perform convert_to(t, 'SJIS');
  return false;
exception when others then
  return true;
end $$;

create or replace function public._bt_ib_name(n text) returns boolean
language sql immutable as $$
  with x as (select btrim(coalesce(n,'')) s)
  select case
    when s = '' then false
    when s ~ '[가-힣]' then true
    when public._bt_ib_nonsjis(regexp_replace(s, '[^一-鿿]', '', 'g')) then true
    when s ~ '^[A-Za-z .,''-]+$' then exists (
      select 1 from regexp_split_to_table(lower(s), '[ .,''-]+') w
      where w <> '' and w !~ '^(?:(?:[kgszdtnhbpmr]y?|[fjv]|sh|ch|ts|y(?=[auo])|w(?=[ao]))?[aiueo]|n|m(?=[bpm])|(?<=o)h|k(?=k)|s(?=s)|t(?=t)|p(?=p)|g(?=g)|d(?=d)|b(?=b)|c(?=c)|t(?=ch))+$')
    when regexp_replace(s, '[\s　]', '', 'g') ~ '^[一-鿿]{2,3}$'
      and left(regexp_replace(s, '[\s　]', '', 'g'), 1) = any (string_to_array('陳,黃,張,李,劉,楊,吳,蔡,鄭,謝,許,洪,郭,邱,曾,廖,賴,徐,蕭,潘,簡,鍾,彭,游,詹,盧,趙,顏,魏,孫,戴,范,鄧,傅,薛,阮,蔣,馮,歐,朴,崔,姜,尹,王', ',')) then true
    when split_part(regexp_replace(s, '　', ' ', 'g'), ' ', 1) = any (string_to_array('キム,パク,チェ,チョン,チョ,ユン,チャン,ワン,リン,チン,ホアン,グエン,リー,ジョン,ハン,ソン,ヤン,ウォン', ',')) then true
    else false end
  from x
$$;

create or replace function public._bt_ib_tel(t text) returns boolean
language sql immutable as $$
  with x as (select regexp_replace(coalesce(t,''), '[^0-9+]', '', 'g') d)
  select case
    when d = '' then false
    when d like '+%' then d not like '+81%'
    when d ~ '^(0|81)' then false
    when d ~ '^[789]0[0-9]{8}$' or d ~ '^[1-9][0-9]{8}$' then false   -- 先頭の0が抜けた国内番号
    else true end
  from x
$$;

create or replace function public._bt_ib_addr(a text) returns boolean
language sql immutable as $$
  select case
    when btrim(coalesce(a,'')) = '' then false
    when a ~* '[가-힣]|台灣|台湾|香港|澳門|中國|中国|韓国|韓國|taiwan|korea|hong ?kong|china|usa|singapore|thailand|malaysia|vietnam|philippines|australia' then true
    when a !~ '[ぁ-ヿ一-鿿]' then true
    else false end
$$;

-- ③ 月別集計（個人情報は返さない）
create or replace function public.bt_inbound_monthly() returns jsonb
language sql stable security definer set search_path to 'public' as $$
with r as (
  select res.id,
    case when coalesce(res.base_price,0)>0 or coalesce(res.option_price,0)>0
      then coalesce(res.base_price,0)+coalesce(res.option_price,0)-coalesce(res.discount,0)
      else coalesce(res.price,0) end as rev,
    substr(coalesce(res.end_date,''),1,7) as ym,
    res.name, res.kana, res.tel, res.prefecture
  from bt_reservations res
  where substr(coalesce(res.end_date,''),1,7) >= '2026-08'
    and coalesce(res.status,'') not in ('キャンセル','cancelled','canceled')
    and res.id !~ '^(ZZ|DEMO|KD-DEMO|TEST|DEMOMYPAGE)'
    and coalesce(res.name,'') !~ '(テスト|デモ|test|ZZPTEST|大下|おおした|オオシタ)'
    and coalesce(res.name,'') <> ''
),
em as (
  select e.reservation_id,
    bool_or(e.raw_body ~ '[가-힣]|日圓|預約|車型|現場付款') as lang,
    max(substring(e.raw_body from '予約者住所[:：][ 　]*([^\r\n]*)')) as addr
  from bt_reservation_emails e where e.reservation_id is not null group by 1
),
s as (
  select r.ym, r.rev,
    coalesce(em.lang,false) as s_mail,
    public._bt_ib_tel(r.tel) as s_tel,
    (public._bt_ib_name(r.name) or public._bt_ib_name(r.kana)) as s_name,
    (public._bt_ib_addr(r.prefecture) or public._bt_ib_addr(em.addr)) as s_addr,
    exists (select 1 from license_ai_checks l, jsonb_array_elements(case when jsonb_typeof(l.persons)='array' then l.persons else '[]'::jsonb end) p
            where l.reservation_id = r.id and p->>'kind' in ('intl_permit','foreign_license')) as s_lic,
    exists (select 1 from bt_guide_action_log g
            where g.reservation_id = r.id and coalesce(g.meta->>'lang','ja') in ('zh','ko','en')
              and not coalesce(g.staff_proxy,false)) as s_guide
  from r left join em on em.reservation_id = r.id
),
t as (select *, (s_mail or s_tel or s_name or s_addr or s_lic or s_guide) as ib from s)
select jsonb_build_object(
  'generated', to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI'),
  'data', coalesce((select jsonb_object_agg(ym, o) from (
    select ym, jsonb_build_object(
      'c', count(*), 'r', sum(rev),
      'ic', count(*) filter (where ib), 'ir', coalesce(sum(rev) filter (where ib),0),
      'sig', jsonb_build_object('mail', count(*) filter (where s_mail), 'tel', count(*) filter (where s_tel),
        'name', count(*) filter (where s_name), 'addr', count(*) filter (where s_addr),
        'lic', count(*) filter (where s_lic), 'guide', count(*) filter (where s_guide))) o
    from t group by ym) z), '{}'::jsonb))
$$;
revoke all on function public._bt_ib_nonsjis(text), public._bt_ib_name(text), public._bt_ib_tel(text), public._bt_ib_addr(text) from public, anon, authenticated;
revoke all on function public.bt_inbound_monthly() from public;
grant execute on function public.bt_inbound_monthly() to anon, authenticated, service_role;

commit;
