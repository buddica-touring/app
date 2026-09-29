-- ★ 2026-09-29 bt_handover のRLS封鎖（スタッフ間の申し送りを顧客(anon)から隠す）
-- 背景: bt_handover はRLS未設定で、公開anonキーでREST直読みできる状態だった。
--       他の業務テーブル(bt_reservations等)と同じく authenticated 限定にする。
-- アプリはsignInWithPasswordで認証(authenticatedロール)のため、スタッフ利用は影響なし。
-- 実行: Supabase SQL Editor（BTプロジェクト ggqugvyskyiblxiycpci）で流す。

-- ⚠️ 既存の緩いポリシー bt_handover_all (USING true = 全員許可) が残っていた。
--    RLSは複数ポリシーのOR評価のため、これを消さないとanonが素通りする（実際に素通りしていた）。
ALTER TABLE bt_handover ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bt_handover_all" ON bt_handover;   -- ← これが漏洩の直接原因
DROP POLICY IF EXISTS "auth_all" ON bt_handover;
CREATE POLICY "auth_all" ON bt_handover FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- 適用済(2026-09-29 Management API)。検証結果:
--   anon(顧客) → []（封鎖成功） / staff(authenticated) → 8件読取OK（影響なし）

-- 検証(実行後): 下記はanonキーで叩くと [] / 権限エラー になれば成功
--   curl "https://ggqugvyskyiblxiycpci.supabase.co/rest/v1/bt_handover?select=id&limit=1" \
--     -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>"
