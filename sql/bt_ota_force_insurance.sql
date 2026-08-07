-- ============================================================
-- BT (高松) OTA予約の補償=免責 恒久ルール（正本トリガー / class根治）
-- 対象OTA: エアトリ / たびらい / レンタカードットコム（+ GAS内部コード 'O'=エアトリ）
-- これら3社は「補償=免責」が既定だが、予約時に『フル補償(NOC)』を任意選択できる。
--   → 予約で NOC が選ばれていれば NOC、無ければ免責（免責は必ず含まれる）。
--
-- 方針（LEDGER-ONE ドメイン制約トリガー＝出所非依存の class根治）:
--   * 3社(エアトリ/たびらい/RC) → INSERT/UPDATE 共通で「NOC以外は免責」。
--     NOC(パーサーが予約の補償選択を正しく検出)は維持し、なし/空/免責は 免責 へ floor。
--   * その他OTA(楽天/じゃらん/スカイ, source='ota') → 正規ティアを維持し、空/なしのみ免責へ（floor）
--   * タスク(bt_tasks."確定") → legタスク(お届け/回収)のみ floor（値は予約=正本からコピーされる）
--
-- 履歴:
--   2026-08-06 初版（floor: 空/なし→免責）
--   2026-08-07 3社は INSERT で NOC/フルも免責へ上書き（誤り・下記で訂正）
--   2026-08-07(訂正) 3社は NOC を任意選択可＝「NOC以外は免責」に統一（INSERTでもNOCを維持）
-- ============================================================

-- ---- 予約(正本)トリガー ---------------------------------------
CREATE OR REPLACE FUNCTION public._bt_ota_force_insurance()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- ★2026-08-07 媒体をまたいで補償値を BT正準3値(なし/免責/NOC)へ正規化してから媒体別ルールを適用。
  --   HP直販(site)が最上位を'安心ワイドパック'で保存する等の表記ゆれを吸収（app.js/guideの正準は'NOC'）。
  --   NOC を先に判定（'免責＋NOC'バンドル＝安心パックは NOC ティア）。
  IF NEW.insurance ~* '(NOC|ＮＯＣ|ノンオペ|安心パック|安心ワイド|フルカバー|フル補償)' THEN
    NEW.insurance := 'NOC';
  ELSIF NEW.insurance ~* '(免責|CDW)' THEN
    NEW.insurance := '免責';
  ELSIF NEW.insurance IS NULL OR NEW.insurance IN ('','なし','無し','未加入','無','no','none','0') THEN
    NEW.insurance := 'なし';
  END IF;
  IF COALESCE(NEW.ota,'') IN ('エアトリ','たびらい','レンタカードットコム','O') THEN
    -- ★2026-08-07(訂正) これら3社は『フル補償(NOC)』を任意選択できる。
    --   NOC が選ばれていれば維持し、それ以外(なし/空/免責)は 免責 へ。INSERT/UPDATE 共通＝出所非依存。
    --   旧版は INSERT で NOC も免責へ潰していた（誤り）→ 予約時のNOC選択を反映できるよう訂正。
    IF COALESCE(NEW.insurance,'') <> 'NOC' THEN
      NEW.insurance := '免責';
    END IF;
  ELSIF NEW.source = 'ota' THEN
    -- その他OTAは正規ティア維持。空/なしのみ免責へ
    IF NEW.insurance IS NULL OR NEW.insurance IN ('','なし','無し','未加入','無','no','none') THEN
      NEW.insurance := '免責';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_bt_ota_force_insurance ON public.bt_reservations;
CREATE TRIGGER trg_bt_ota_force_insurance
  BEFORE INSERT OR UPDATE ON public.bt_reservations
  FOR EACH ROW EXECUTE FUNCTION public._bt_ota_force_insurance();

-- ---- タスク(表示)トリガー: legタスクのみ floor ------------------
-- 値は予約(正本)からコピーされるため floor で十分（NOCは予約=正本のアップグレードを反映）
CREATE OR REPLACE FUNCTION public._bt_task_ota_force_insurance()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_ota text; v_src text;
BEGIN
  IF COALESCE(NEW."内容",'') NOT IN ('DEL','PU','PUB','来店','PUB来店','BD','BDB','COL','返却') THEN
    RETURN NEW;
  END IF;
  -- ★2026-08-07 legタスクの補償(確定)も正準3値へ正規化（'安心ワイドパック'等の表記ゆれ吸収）。
  IF NEW."確定" ~* '(NOC|ＮＯＣ|ノンオペ|安心パック|安心ワイド|フルカバー|フル補償)' THEN
    NEW."確定" := 'NOC';
  ELSIF NEW."確定" ~* '(免責|CDW)' THEN
    NEW."確定" := '免責';
  END IF;
  SELECT r.ota, r.source INTO v_ota, v_src
    FROM public.bt_reservations r WHERE r.id = NEW."予約番号";
  IF (v_src = 'ota')
     OR (COALESCE(v_ota,'') IN ('エアトリ','たびらい','レンタカードットコム','O')) THEN
    IF NEW."確定" IS NULL OR NEW."確定" IN ('','なし','無し','未加入','無') THEN
      NEW."確定" := '免責';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_bt_task_ota_force_insurance ON public.bt_tasks;
CREATE TRIGGER trg_bt_task_ota_force_insurance
  BEFORE INSERT OR UPDATE ON public.bt_tasks
  FOR EACH ROW EXECUTE FUNCTION public._bt_task_ota_force_insurance();

-- ---- 既存データ一括是正 ----
-- ① HP直販等の最上位補償の表記ゆれ('安心ワイドパック'/'安心パック'/'フル系')を正準'NOC'へ統一
UPDATE public.bt_reservations SET insurance='NOC'
 WHERE insurance ~* '(安心パック|安心ワイド|フルカバー|フル補償)';
UPDATE public.bt_tasks SET "確定"='NOC'
 WHERE "確定" ~* '(安心パック|安心ワイド|フルカバー|フル補償)';
-- ② 3社(エアトリ/たびらい/RC)の空/なし系のみ免責へ floor（NOCは任意選択＝維持する。潰さない）
--    ※旧版はここで NOC→免責 に一括上書きしていた（誤り・削除）。予約時のNOC選択を尊重する。
UPDATE public.bt_reservations SET insurance='免責'
 WHERE ota IN ('エアトリ','たびらい','レンタカードットコム')
   AND (insurance IS NULL OR insurance IN ('','なし','無し','未加入','無','no','none'));
UPDATE public.bt_tasks SET "確定"='免責'
 WHERE "OTA" IN ('エアトリ','たびらい','レンタカードットコム')
   AND ("確定" IS NULL OR "確定" IN ('','なし','無し','未加入','無'))
   AND COALESCE("内容",'') IN ('DEL','PU','PUB','来店','PUB来店','BD','BDB','COL','返却');
