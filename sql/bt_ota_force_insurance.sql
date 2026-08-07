-- ============================================================
-- BT (高松) OTA予約の補償=免責 恒久ルール（正本トリガー / class根治）
-- 対象OTA: エアトリ / たびらい / レンタカードットコム（+ GAS内部コード 'O'=エアトリ）
-- これら3社は「補償=免責」が確定（NOC/フル等の販売ティアなし）。
--
-- 方針（LEDGER-ONE ドメイン制約トリガー＝出所非依存の class根治）:
--   * 取込(INSERT) → 必ず insurance='免責'（NOC等の誤取込アーティファクトを上書き）
--   * 人手動編集(UPDATE) → 尊重。ただし免責を内包しない値(空/なし系)だけ免責へ引き上げ
--     → これにより「NOCは任意で選択可能（マイページ/OP編集で後付け）」を維持
--   * その他OTA(楽天/じゃらん/スカイ, source='ota') → 正規ティアを維持し、空/なしのみ免責へ（floor）
--   * タスク(bt_tasks."確定") → legタスク(お届け/回収)のみ floor（値は予約=正本からコピーされる）
--
-- 履歴:
--   2026-08-06 初版（floor: 空/なし→免責）
--   2026-08-07 3社は INSERT で NOC/フルも免責へ上書き（オーナー確定・恒久化）
-- ============================================================

-- ---- 予約(正本)トリガー ---------------------------------------
CREATE OR REPLACE FUNCTION public._bt_ota_force_insurance()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF COALESCE(NEW.ota,'') IN ('エアトリ','たびらい','レンタカードットコム','O') THEN
    IF TG_OP = 'INSERT' THEN
      -- 取込は必ず免責（誤取込のNOC/フルを上書き）
      IF COALESCE(NEW.insurance,'') <> '免責' THEN
        NEW.insurance := '免責';
      END IF;
    ELSE
      -- 人手動編集(UPDATE)は尊重。空/なし系だけ免責へ引き上げ（NOC任意選択を維持）
      IF NEW.insurance IS NULL OR NEW.insurance IN ('','なし','無し','未加入','無','no','none') THEN
        NEW.insurance := '免責';
      END IF;
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

-- ---- 既存データ一括是正（誤取込のNOC→免責。人手動編集は audit_log で保護済み確認） ----
UPDATE public.bt_reservations SET insurance='免責'
 WHERE ota IN ('エアトリ','たびらい','レンタカードットコム') AND insurance='NOC';
UPDATE public.bt_tasks SET "確定"='免責'
 WHERE "OTA" IN ('エアトリ','たびらい','レンタカードットコム') AND "確定"='NOC'
   AND COALESCE("内容",'') IN ('DEL','PU','PUB','来店','PUB来店','BD','BDB','COL','返却');
