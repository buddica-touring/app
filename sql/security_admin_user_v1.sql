-- ============================================================
-- BUDDICA TOURING 初期管理者ユーザー作成
-- 実行日: 2026-05-12
-- ============================================================
--
-- 【前提】 security_lockdown_v1.sql を先に実行していること
--
-- 【作成内容】
--   メール: oshita.touring@buddica.co.jp
--   パスワード: 下記 TEMP_PASSWORD を **必ず変更** してから実行
--
-- 【実行方法】
-- 1. 下記 TEMP_PASSWORD を任意のパスワード（8文字以上）に書き換え
-- 2. https://supabase.com/dashboard/project/ggqugvyskyiblxiycpci/sql/new
-- 3. このSQLを全コピペ → Run
--
-- 【セキュリティ注意】
-- このSQLを実行したら、TEMP_PASSWORD を含むSQLは破棄してください
-- ============================================================

DO $$
DECLARE
  v_email TEXT := 'oshita.touring@buddica.co.jp';
  v_password TEXT := 'CHANGE_ME_TO_REAL_PASSWORD_xxx';   -- ★ 必ず変更
  v_user_id UUID;
BEGIN
  -- 既存ユーザーチェック
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NOT NULL THEN
    RAISE NOTICE '⚠️ ユーザー % は既に存在します (id: %)', v_email, v_user_id;
    RAISE NOTICE 'パスワードを変更したい場合は、Dashboard → Authentication → Users から実行してください';
  ELSE
    -- ユーザー作成
    INSERT INTO auth.users (
      instance_id, id, aud, role,
      email, encrypted_password,
      email_confirmed_at, recovery_sent_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token,
      email_change, email_change_token_new, recovery_token
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      NOW(), NOW(),
      '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
      '{"name":"大下 典隆","role":"admin"}'::jsonb,
      NOW(), NOW(), '',
      '', '', ''
    )
    RETURNING id INTO v_user_id;

    RAISE NOTICE '✅ ユーザー作成完了: % (id: %)', v_email, v_user_id;
    RAISE NOTICE 'ログインURL: BT管理APPを開いてログイン画面で入力';
  END IF;
END $$;

-- 確認
SELECT id, email, email_confirmed_at, raw_user_meta_data
FROM auth.users
WHERE email = 'oshita.touring@buddica.co.jp';
