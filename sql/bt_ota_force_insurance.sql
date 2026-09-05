-- ============================================================
-- BT (高松) 補償(insurance) 正準3値ルール（正本トリガー / class根治）
-- 正準3値 ＝ 『基本』 / 『免責』 / 『フル』（2026-08-07 オーナー確定・旧 なし/免責/NOC から改称）
--   * 基本 … 標準付帯のみ（追加補償なし）＝旧「なし」
--   * 免責 … 免責補償(CDW)加入
--   * フル … 免責＋NOC(ノンオペレーション)込みの最上位＝旧「NOC」/安心パック/安心ワイド/フルカバー/ブルサポート/フル補償_NOC 等
--
-- 対象OTA(3社): エアトリ / たびらい / レンタカードットコム（+ GAS内部コード 'O'=エアトリ）
--   これら3社は「補償=免責」が既定だが、予約時に『フル補償(NOC)』を任意選択できる。
--   → 予約で フル(NOC)が選ばれていれば フル、無ければ免責（免責は必ず含まれる）。
--
-- 方針（LEDGER-ONE ドメイン制約トリガー＝出所非依存の class根治）:
--   * まず媒体をまたいで補償値を正準3値(基本/免責/フル)へ正規化。
--   * 3社(エアトリ/たびらい/RC) → INSERT/UPDATE 共通で「フル以外は免責」（NOC選択=フルは維持）。
--   * その他OTA(楽天/じゃらん/スカイ, source='ota') → 正規ティア維持、基本のみ免責へ（floor）。
--   * タスク(bt_tasks."確定") → legタスク(お届け/回収)のみ floor（値は予約=正本からコピーされる）。
--
-- 履歴:
--   2026-08-06 初版（floor: 空/なし→免責）
--   2026-08-07 3社は INSERT で NOC/フルも免責へ上書き（誤り・下記で訂正）
--   2026-08-07(訂正) 3社は NOC を任意選択可＝「NOC以外は免責」に統一（INSERTでもNOCを維持）
--   2026-08-07(3値統一) 正準を『基本/免責/フル』へ改称。NOC/安心/ブルサポート/フル補償_NOC → フル、なし/空 → 基本。
-- ============================================================

-- ---- 予約(正本)トリガー ---------------------------------------
CREATE OR REPLACE FUNCTION public._bt_ota_force_insurance()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- ★2026-08-07 媒体をまたいで補償値を BT正準3値(基本/免責/フル)へ正規化してから媒体別ルールを適用。
  --   フルを先に判定（'免責＋NOC'バンドル＝安心パックは フル ティア）。
  --   フル語彙: フル / NOC / ＮＯＣ / ノンオペ / 安心(パック/ワイド) / フルカバー / フル補償 / フルサポート / ブルサポート
  IF NEW.insurance ~* '(フル|NOC|ＮＯＣ|ノンオペ|安心|フルカバー|フル補償|フルサポート|ブルサポート)' THEN
    NEW.insurance := 'フル';
  ELSIF NEW.insurance ~* '(免責|CDW)' THEN
    NEW.insurance := '免責';
  ELSE
    -- 上記以外(NULL/空/なし/無し/未加入/基本 等)はすべて 基本 へ集約（正準3値化）
    NEW.insurance := '基本';
  END IF;

  IF COALESCE(NEW.ota,'') IN ('エアトリ','たびらい','レンタカードットコム','O') THEN
    -- 3社は『フル補償(NOC)』を任意選択できる。フルなら維持し、それ以外(基本/免責)は 免責 へ floor。
    IF COALESCE(NEW.insurance,'') <> 'フル' THEN
      NEW.insurance := '免責';
    END IF;
  ELSIF NEW.source = 'ota' THEN
    -- その他OTAは正規ティア維持。基本のみ免責へ floor（免責は必ず含まれる）
    IF NEW.insurance = '基本' THEN
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

-- ---- タスク(表示)トリガー: legタスクのみ正規化＋floor ------------------
-- 値は予約(正本)からコピーされるため floor で十分（フルは予約=正本のアップグレードを反映）。
-- 非legタスク(洗車/その他等 確定='')は触らない（空のまま）。
CREATE OR REPLACE FUNCTION public._bt_task_ota_force_insurance()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_ota text; v_src text;
BEGIN
  IF COALESCE(NEW."内容",'') NOT IN ('DEL','PU','PUB','来店','PUB来店','BD','BDB','COL','返却') THEN
    RETURN NEW;
  END IF;
  -- legタスクの補償(確定)を正準3値へ正規化（空はそのまま＝下の OTA floor で処理）
  IF NEW."確定" ~* '(フル|NOC|ＮＯＣ|ノンオペ|安心|フルカバー|フル補償|フルサポート|ブルサポート)' THEN
    NEW."確定" := 'フル';
  ELSIF NEW."確定" ~* '(免責|CDW)' THEN
    NEW."確定" := '免責';
  ELSIF NEW."確定" IN ('なし','無し','未加入','無','none','no') THEN
    NEW."確定" := '基本';
  END IF;
  SELECT r.ota, r.source INTO v_ota, v_src
    FROM public.bt_reservations r WHERE r.id = NEW."予約番号";
  IF (v_src = 'ota')
     OR (COALESCE(v_ota,'') IN ('エアトリ','たびらい','レンタカードットコム','O')) THEN
    -- OTA leg は 基本/空 を免責へ floor（フル/免責は維持）
    IF NEW."確定" IS NULL OR NEW."確定" IN ('','基本') THEN
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

-- ---- 既存データ一括是正（正準3値へ移行） ----
-- ① フルティア（NOC/安心/フルカバー/ブルサポート/フル補償系）→ 『フル』
UPDATE public.bt_reservations SET insurance='フル'
 WHERE insurance ~* '(フル|NOC|ＮＯＣ|ノンオペ|安心|フルカバー|フル補償|フルサポート|ブルサポート)'
   AND insurance <> 'フル';
UPDATE public.bt_tasks SET "確定"='フル'
 WHERE "確定" ~* '(フル|NOC|ＮＯＣ|ノンオペ|安心|フルカバー|フル補償|フルサポート|ブルサポート)'
   AND "確定" <> 'フル';
-- ② 免責ティア（免責/CDW）→ 『免責』（表記統一）
UPDATE public.bt_reservations SET insurance='免責'
 WHERE insurance ~* '(免責|CDW)' AND insurance <> '免責';
UPDATE public.bt_tasks SET "確定"='免責'
 WHERE "確定" ~* '(免責|CDW)' AND "確定" <> '免責';
-- ③ 旧「なし」系 → 『基本』（予約のみ。タスクは空''を保持したいので明示値のみ）
UPDATE public.bt_reservations SET insurance='基本'
 WHERE insurance IS NULL OR insurance IN ('','なし','無し','未加入','無','no','none','0');
UPDATE public.bt_tasks SET "確定"='基本'
 WHERE "確定" IN ('なし','無し','未加入','無','no','none');
-- ④ 4件の取りこぼし是正（安心パック/NOC/フル補償_NOC を旧パーサーが取りこぼし → 実補償=フル）
UPDATE public.bt_reservations SET insurance='フル'
 WHERE id IN ('UYQ64495','2608000517','C260800256','EXZ23394');
-- ⑤ 3社(エアトリ/たびらい/RC)の基本→免責 floor（免責は必ず含まれる）
UPDATE public.bt_reservations SET insurance='免責'
 WHERE ota IN ('エアトリ','たびらい','レンタカードットコム') AND insurance='基本';
UPDATE public.bt_tasks SET "確定"='免責'
 WHERE "OTA" IN ('エアトリ','たびらい','レンタカードットコム')
   AND ("確定" IS NULL OR "確定" IN ('','基本'))
   AND COALESCE("内容",'') IN ('DEL','PU','PUB','来店','PUB来店','BD','BDB','COL','返却');
