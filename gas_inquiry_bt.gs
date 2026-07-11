/**
 * BUDDICA TOURISM 高松空港店 お問い合わせ管理 GAS v1.0(NHA/SPK移植)
 * ========================================
 * 機能:
 *   1. reserve.touring@buddica.co.jp 宛メールを自動取込（15分おき）
 *   2. Web App経由で返信メール送信（reserve.touring@buddica.co.jp から送信）
 *   3. 未対応2時間超アラート → Slack #operation（30分おき・Bot API）
 */

const INQUIRY_SB_URL  = 'https://ggqugvyskyiblxiycpci.supabase.co';
const REPLY_FROM_NAME = 'BUDDICA TOURISM 高松空港店';
const REPLY_FROM_ADDR = 'reserve.touring@buddica.co.jp';

// Slack 通知先（BUDDICA専用WS #operation）— Bot APIで投稿
const INQ_SLACK_CHANNEL = 'C0BFMBLEJGZ'; // #operation-高松空港店
function btInqSlack_(text){
  try{
    var tok=PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
    if(!tok){console.log('[Slack] SLACK_BOT_TOKEN未設定: '+text.substring(0,60));return;}
    UrlFetchApp.fetch('https://slack.com/api/chat.postMessage',{method:'post',headers:{'Authorization':'Bearer '+tok,'Content-Type':'application/json'},payload:JSON.stringify({channel:INQ_SLACK_CHANNEL,text:text}),muteHttpExceptions:true});
  }catch(e){console.error('[Slack] '+e.message);}
}

// 未対応アラートの閾値（時間）
const ALERT_THRESHOLD_HOURS = 2;
// 同じ問い合わせIDへの再通知抑制（時間）
const ALERT_COOLDOWN_HOURS  = 2;

// ========================================
// Web App エントリ（POST）
// ========================================
function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const action = params.action;

    if (action === 'send_reply')  return sendReply_(params);
    if (action === 'ai_analyze')  return analyzeInquiry_(params);
    if (action === 'sync_emails') {
      const count = importInquiryEmails_();
      return respond_({ success: true, imported: count });
    }
    return respond_({ success: false, error: 'unknown action' });
  } catch (err) {
    return respond_({ success: false, error: err.message });
  }
}

function doGet() {
  return ContentService.createTextOutput('BUDDICA TOURISM Inquiry Manager GAS v1.0: OK')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ========================================
// メール返信送信
// ========================================
function sendReply_(p) {
  const { to, subject, body, inquiry_id } = p;
  if (!to) return respond_({ success: false, error: 'to is required' });
  if (!body || !body.trim()) return respond_({ success: false, error: 'body is required' });

  const subj = subject || 'Re: お問い合わせについて【BUDDICA TOURISM 高松空港店】';

  try {
    const encodedName = `=?UTF-8?B?${Utilities.base64Encode(Utilities.newBlob(REPLY_FROM_NAME).getBytes())}?=`;
    const encodedSubj = `=?UTF-8?B?${Utilities.base64Encode(Utilities.newBlob(subj).getBytes())}?=`;
    const encodedBody = Utilities.base64Encode(Utilities.newBlob(body).getBytes());
    const rawMessage = [
      `From: ${encodedName} <${REPLY_FROM_ADDR}>`,
      `To: ${to}`,
      `Subject: ${encodedSubj}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      encodedBody,
    ].join('\r\n');

    const encoded = Utilities.base64EncodeWebSafe(rawMessage);
    const res = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ raw: encoded }),
      muteHttpExceptions: true,
    });

    const result = JSON.parse(res.getContentText());
    if (result.error) throw new Error(result.error.message);

    console.log(`✅ 返信送信完了: to=${to}, inquiry_id=${inquiry_id}`);
    return respond_({ success: true, sent: true, to, from: REPLY_FROM_ADDR });

  } catch (err) {
    console.error(`❌ 送信失敗: ${err.message}`);
    return respond_({ success: false, error: err.message });
  }
}

// ========================================
// メール自動取込
// ========================================

// ★★★ ホワイトリスト（最優先 — EXCLUDE_SENDERS/EXCLUDE_SUBJECTS より先に判定）★★★
// ここに該当するメールは、いかなる除外ルールも無視して必ず取り込む。
// 「必要なメールが除外されてしまう」事故の構造的再発防止策。
const ALWAYS_IMPORT = [
  // HPお問い合わせフォーム通知（noreply@buddica.co.jp から来る）
  { sender: 'noreply@buddica.co.jp', subject: 'お問い合わせ' },
  // お客様が直接 reserve@ に送ってくるメール（件名に「問い合わせ」「質問」等）
  { subject: 'お問い合わせ' },
  { subject: '問い合わせ' },
  { subject: '質問' },
  // 自社ドメインからのお客様起点メール（フォーム経由）
  { sender: 'buddica.co.jp', subject: 'ユーザからお問い合わせ' },
];

/**
 * ホワイトリスト判定: マッチすれば true（全除外ルールをバイパス）
 * - sender: fromL に含まれるか（部分一致）
 * - subject: subjectL に含まれるか（部分一致）
 * - 両方指定 → AND条件。片方のみ → その条件のみ
 */
function isWhitelisted_(fromL, subjectL) {
  return ALWAYS_IMPORT.some(rule => {
    const senderOk  = rule.sender  ? fromL.includes(rule.sender.toLowerCase())    : true;
    const subjectOk = rule.subject ? subjectL.includes(rule.subject.toLowerCase()) : true;
    return senderOk && subjectOk;
  });
}

const EXCLUDE_SENDERS = [
  'jalan.net', 'travel.rakuten.co.jp', 'rakuten.co.jp',
  'skyticket.com', 'adventure-inc.co.jp', 'airtrip.jp', 'gogoout',
  'no-reply@accounts.google.com',
  'mailer-daemon', 'postmaster',
  'lycorp.co.jp', 'line.me',
  'np-kakebarai.com', 'np-financials',
  'surveymonkey', 'survey',
  'squareup.com', 'square.com',
  'slack.com',
  'gmail.google.com',
  'coincheck.com',
  'warp.dev',
  'r.recruit.co.jp',
  'web-rentacar.com',
  'rentacar.com',
  'skygate.co.jp',
  'facebook.com', 'facebookmail.com',
];
const EXCLUDE_SUBJECTS = [
  // ★ OTA予約通知系は EXCLUDE_SENDERS で除外済みのためここには入れない
  // 「キャンセル」「予約変更」等はお客様からの問い合わせの可能性があるため除外しない
  '入金確認', '支払い', 'payment', 'receipt', '領収',
  '配送完了', 'Delivery Status', 'Auto-Reply', '自動返信',
  'ユーザの会員登録が完了しました',  // HP予約システムの自動通知
  'ご予約完了のお知らせ',            // HP予約完了の自動通知（noreply@buddica.co.jp）
];

function importInquiryEmails_() {
  const props  = PropertiesService.getScriptProperties().getProperties();
  const SB_KEY = props['SUPABASE_KEY'];
  if (!SB_KEY) { console.log('❌ SUPABASE_KEY 未設定'); return 0; }

  const STORE_KEY = 'INQUIRY_LIVE_MSG_IDS';
  const processed = JSON.parse(props[STORE_KEY] || '{}');
  const seen      = new Set(Object.keys(processed));

  const query = 'to:reserve.touring@buddica.co.jp newer_than:2d -in:sent -in:drafts -in:trash';
  let threads;
  try { threads = GmailApp.search(query, 0, 200); }
  catch(e) { console.error('Gmail検索エラー:', e.message); return 0; }
  console.log(`📂 スレッド数: ${threads.length}`);

  // ブロック済みドメイン取得
  const blockedDomains = new Set();
  try {
    const bRes = UrlFetchApp.fetch(`${INQUIRY_SB_URL}/rest/v1/bt_blocked_senders?select=domain`, {
      headers: sbHeaders_(SB_KEY), muteHttpExceptions: true
    });
    if (bRes.getResponseCode() === 200)
      JSON.parse(bRes.getContentText()).forEach(r => blockedDomains.add(r.domain));
  } catch(e) {}

  const toInsert = [];
  let skipSeen=0, skipBlocked=0, skipExcludeSender=0, skipExcludeSubject=0, skipShortBody=0;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (seen.has(msgId)) { skipSeen++; continue; }

      const from     = msg.getFrom() || '';
      const fromL    = from.toLowerCase();
      const subject  = msg.getSubject() || '';
      const subjectL = subject.toLowerCase();

      // ★ ホワイトリスト優先判定（全除外ルールをバイパス）
      const whitelisted = isWhitelisted_(fromL, subjectL);

      if (!whitelisted) {
        const senderDomain = (fromL.match(/@([\w.-]+)/) || [])[1] || '';
        if (senderDomain && blockedDomains.has(senderDomain)) { skipBlocked++; continue; }
        if (EXCLUDE_SENDERS.some(s => fromL.includes(s)))    { skipExcludeSender++; continue; }
        if (EXCLUDE_SUBJECTS.some(s => subjectL.includes(s.toLowerCase()))) { skipExcludeSubject++; continue; }
      }

      const body = (msg.getPlainBody() || '').trim();
      if (!body || body.length < 2) { skipShortBody++; continue; }

      // DB重複チェック
      try {
        const checkRes = UrlFetchApp.fetch(
          `${INQUIRY_SB_URL}/rest/v1/bt_inquiries?gmail_message_id=eq.${encodeURIComponent(msgId)}&select=id`,
          { headers: sbHeaders_(SB_KEY), muteHttpExceptions: true }
        );
        if (checkRes.getResponseCode() === 200) {
          const existing = JSON.parse(checkRes.getContentText());
          if (existing.length > 0) {
            seen.add(msgId);
            processed[msgId] = new Date().toISOString();
            continue;
          }
        }
      } catch(e) {}

      const senderName  = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || 'お客様';
      const senderEmail = (from.match(/<([^>]+)>/) || [])[1] || from.trim();

      const name    = extractField_(body, 'お名前')           || extractField_(body, '名前')   || senderName;
      const email   = extractField_(body, 'メールアドレス')   || extractField_(body, 'Email')  || senderEmail;
      const phone   = extractField_(body, 'お電話番号')       || extractField_(body, '電話番号') || '';
      const type    = extractField_(body, 'お問い合わせ種別') || extractField_(body, '種別')    || detectType_(body + ' ' + subject);
      const content = extractField_(body, 'お問い合わせ内容') || extractField_(body, '内容')    || body.substring(0, 3000);
      const store   = detectStore_(body + ' ' + subject + ' ' + senderEmail);

      toInsert.push({
        name:             name.substring(0, 100),
        email:            email.substring(0, 200),
        phone:            phone.substring(0, 50),
        inquiry_type:     type || 'その他',
        inquiry_content:  content,
        status:           'new',
        store:            store,
        source:           'gmail_live',
        received_at:      msg.getDate().toISOString(),
        gmail_message_id: msgId,
      });
    }
  }

  console.log(`📊 スキップ → 処理済:${skipSeen} ブロック:${skipBlocked} 送信元除外:${skipExcludeSender} 件名除外:${skipExcludeSubject} 本文短:${skipShortBody} | 取込候補:${toInsert.length}`);

  let insertedCount = 0;
  for (const item of toInsert) {
    try {
      const res = UrlFetchApp.fetch(`${INQUIRY_SB_URL}/rest/v1/bt_inquiries`, {
        method:  'POST',
        headers: { ...sbHeaders_(SB_KEY), 'Prefer': 'return=minimal' },
        payload: JSON.stringify(item),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 201) {
        insertedCount++;
        processed[item.gmail_message_id] = new Date().toISOString();
        console.log(`✅ 取込: ${item.name} <${item.email}>`);
      } else if (res.getResponseCode() === 409) {
        processed[item.gmail_message_id] = new Date().toISOString();
      } else {
        console.log(`⚠️ INSERT失敗 [${res.getResponseCode()}]: ${res.getContentText().substring(0,200)}`);
      }
    } catch(e) { console.error('INSERT エラー:', e.message); }
  }

  const keys = Object.keys(processed);
  if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(k => delete processed[k]);
  PropertiesService.getScriptProperties().setProperty(STORE_KEY, JSON.stringify(processed));

  console.log(`📬 取込完了: ${insertedCount}件`);
  return insertedCount;
}

// ========================================
// 未対応アラート（30分おき）
// ========================================
function checkUnrepliedAlert() {
  const props  = PropertiesService.getScriptProperties().getProperties();
  const SB_KEY = props['SUPABASE_KEY'];
  if (!SB_KEY) return;

  // 2時間前より古い status=new の問い合わせを取得
  const thresholdISO = new Date(Date.now() - ALERT_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString();
  let inquiries = [];
  try {
    const res = UrlFetchApp.fetch(
      `${INQUIRY_SB_URL}/rest/v1/bt_inquiries?status=eq.new&received_at=lt.${encodeURIComponent(thresholdISO)}&select=id,name,email,inquiry_type,received_at&order=received_at.asc`,
      { headers: sbHeaders_(SB_KEY), muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return;
    inquiries = JSON.parse(res.getContentText());
  } catch(e) { console.error('アラートチェックエラー:', e.message); return; }

  if (inquiries.length === 0) {
    console.log('✅ 未対応2時間超: なし');
    return;
  }

  // 既に通知済みのIDを取得（再通知抑制）
  const ALERTED_KEY = 'INQUIRY_ALERTED_IDS';
  const alertedRaw  = props[ALERTED_KEY] || '{}';
  const alerted     = JSON.parse(alertedRaw);
  const cooldownMs  = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const now         = Date.now();

  // 未通知 or クールダウン切れの件のみ抽出
  const newAlerts = inquiries.filter(inq => {
    const lastAlerted = alerted[inq.id];
    return !lastAlerted || (now - new Date(lastAlerted).getTime()) > cooldownMs;
  });

  if (newAlerts.length === 0) {
    console.log(`⏭ 未対応${inquiries.length}件あるが全て通知済み（クールダウン中）`);
    return;
  }

  // Slack メッセージ構築
  const lines = newAlerts.map(inq => {
    const elapsed = Math.floor((now - new Date(inq.received_at).getTime()) / 60000);
    const hours   = Math.floor(elapsed / 60);
    const mins    = elapsed % 60;
    const timeStr = hours > 0 ? `${hours}時間${mins}分` : `${mins}分`;
    return `• ${inq.name}（${inq.inquiry_type}）｜${timeStr}前受信`;
  });

  const text = [
    `🔔 *メール問い合わせ未対応通知（${newAlerts.length}件）*`,
    `2時間以上、未対応のままです。対応してください。`,
    ``,
    ...lines,
    ``,
    `▶ <https://buddica-touring.github.io/app/inquiry.html|対応画面を開く>`,
  ].join('\n');

  // Slack に送信（メールアドレス経由）
  try {
    btInqSlack_(text);
    console.log(`🔔 Slackアラート送信: ${newAlerts.length}件`);
    newAlerts.forEach(inq => { alerted[inq.id] = new Date().toISOString(); });
  } catch(e) { console.error('Slack送信エラー:', e.message); }

  // 古いクールダウン記録を削除（7日以上前）
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  Object.keys(alerted).forEach(id => {
    if (new Date(alerted[id]).getTime() < sevenDaysAgo) delete alerted[id];
  });
  PropertiesService.getScriptProperties().setProperty(ALERTED_KEY, JSON.stringify(alerted));
}

// ========================================
// デバッグ: 全メールを詳細ログ（INSERTなし）
// ========================================
function debugImport() {
  console.log('=== debugImport START ===');
  console.log('実行アカウント:', Session.getActiveUser().getEmail());

  const props  = PropertiesService.getScriptProperties().getProperties();
  const SB_KEY = props['SUPABASE_KEY'];
  console.log('SUPABASE_KEY:', SB_KEY ? '設定済み✅' : '未設定❌');

  const processed = JSON.parse(props['INQUIRY_LIVE_MSG_IDS'] || '{}');
  const seen = new Set(Object.keys(processed));
  console.log('処理済みID件数:', seen.size);

  const query = 'to:reserve.touring@buddica.co.jp newer_than:2d -in:sent -in:drafts -in:trash';
  let threads;
  try { threads = GmailApp.search(query, 0, 200); }
  catch(e) { console.error('Gmail検索エラー:', e.message); return; }
  console.log('スレッド数:', threads.length);

  let msgCount = 0;
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      msgCount++;
      const msgId    = msg.getId();
      const from     = msg.getFrom() || '';
      const subject  = msg.getSubject() || '';
      const body     = (msg.getPlainBody() || '').trim();
      const fromL    = from.toLowerCase();
      const subjectL = subject.toLowerCase();

      let reason = '→ 取込対象✅';
      if (seen.has(msgId))
        reason = '→ SKIP: 処理済みID';
      else if (isWhitelisted_(fromL, subjectL))
        reason = '→ 取込対象✅ (ホワイトリスト優先)';
      else if (EXCLUDE_SENDERS.some(s => fromL.includes(s)))
        reason = `→ SKIP: EXCLUDE_SENDERS (${EXCLUDE_SENDERS.find(s => fromL.includes(s))})`;
      else if (EXCLUDE_SUBJECTS.some(s => subjectL.includes(s.toLowerCase())))
        reason = `→ SKIP: EXCLUDE_SUBJECTS (${EXCLUDE_SUBJECTS.find(s => subjectL.includes(s.toLowerCase()))})`;
      else if (!body || body.length < 2)
        reason = `→ SKIP: 本文短い(${body.length}文字)`;

      console.log(`[${msgCount}] ${msg.getDate().toISOString().substring(0,16)} | From: ${from.substring(0,50)} | Subject: ${subject.substring(0,40)} | Body: ${body.length}文字 | ${reason}`);
    }
  }
  console.log(`=== 合計 ${msgCount} メッセージ ===`);
}

// ========================================
// ヘルパー
// ========================================
function sbHeaders_(key) {
  return {
    'Content-Type':  'application/json',
    'apikey':        key,
    'Authorization': `Bearer ${key}`,
  };
}

function extractField_(body, fieldName) {
  const patterns = [
    new RegExp(`【${fieldName}】[\\s\\n]*([\\s\\S]*?)(?=\\n【|\\n\\n|$)`),
    new RegExp(`${fieldName}[：:]\\s*([^\\n]+)`),
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return '';
}

function detectStore_(text) {
  return 'takamatsu'; // BUDDICA TOURISM 高松空港店 単一店
}

function detectType_(text) {
  const t = text.toLowerCase();
  if (t.includes('キャンセル') || t.includes('取消'))                              return 'キャンセル・変更';
  if (t.includes('延長') || t.includes('返却') || t.includes('遅'))               return '返却・延長';
  if (t.includes('料金') || t.includes('価格') || t.includes('いくら'))           return '料金';
  if (t.includes('デリバリー') || t.includes('配送') || t.includes('お迎え'))     return 'デリバリー';
  if (t.includes('予約') || t.includes('booking'))                                return '予約';
  if (t.includes('オプション') || t.includes('チャイルド') || t.includes('ナビ')) return 'オプション';
  return 'その他';
}

function respond_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========================================
// Claude API — 問い合わせ分析・回答生成
// ========================================
function analyzeInquiry_(p) {
  const props = PropertiesService.getScriptProperties().getProperties();
  const ANTHROPIC_KEY = props['ANTHROPIC_API_KEY'];
  const SB_KEY        = props['SUPABASE_KEY'];
  if (!ANTHROPIC_KEY) return respond_({ success: false, error: 'ANTHROPIC_API_KEY未設定。setupProperties()を実行してください' });
  if (!SB_KEY)        return respond_({ success: false, error: 'SUPABASE_KEY未設定' });

  const inquiryContent = (p.inquiry_content || '').trim();
  const inquiryType    = p.inquiry_type  || 'その他';
  const store          = p.store         || 'naha';
  if (!inquiryContent) return respond_({ success: false, error: '問い合わせ内容が空です' });

  // ナレッジ取得（store + both）
  let knowledge = [];
  try {
    const kRes = UrlFetchApp.fetch(
      `${INQUIRY_SB_URL}/rest/v1/bt_knowledge?select=id,category,question,answer,priority&store=in.(${encodeURIComponent(store)},both)&order=priority.asc&limit=150`,
      { headers: sbHeaders_(SB_KEY), muteHttpExceptions: true }
    );
    if (kRes.getResponseCode() === 200) knowledge = JSON.parse(kRes.getContentText());
  } catch(e) { console.error('ナレッジ取得エラー:', e.message); }

  const storeLabel = 'BUDDICA TOURISM 高松空港店';
  const lineId     = '@466dbckq';

  const knText = knowledge.length > 0
    ? knowledge.map((k, i) => `[K${i+1}] カテゴリ:${k.category}\nQ: ${k.question}\nA: ${k.answer}`).join('\n\n')
    : '（まだ知識が登録されていません）';

  const prompt = `あなたは${storeLabel}のカスタマーサポートAIです。
営業時間: 9:00〜19:00　LINE: ${lineId}

【問い合わせ種別】${inquiryType}
【お客様の問い合わせ全文】
${inquiryContent}

【ナレッジベース】
${knText}

【指示】
1. 問い合わせを1〜4個の独立した質問・要求に分解してください
2. 各質問に対してナレッジベースから最も適切な知識を1件選んでください（なければnull）
3. 全質問を網羅する自然な返信本文を生成してください（挨拶・署名不要、本文のみ）
4. 全質問に回答できた割合を0〜100で評価してください（80以上=自動返信可能）

必ずJSONのみで回答（前後に説明文不要）:
{
  "sub_questions": ["質問1の15字以内の要約", "質問2の要約"],
  "candidates": [
    {"knowledge_num": 1, "category": "営業時間", "question": "マッチしたQ", "answer": "回答本文", "score": 90, "sub_q_idx": 0},
    {"knowledge_num": null, "category": null, "question": null, "answer": null, "score": 0, "sub_q_idx": 1}
  ],
  "draft_body": "返信本文（挨拶署名不要。段落ごとに改行）",
  "overall_confidence": 85,
  "auto_reply_ok": false
}`;

  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify({
        model:      'claude-3-5-haiku-20241022',
        max_tokens: 1800,
        messages:   [{ role: 'user', content: prompt }],
      }),
      muteHttpExceptions: true,
    });

    const raw = JSON.parse(res.getContentText());
    if (raw.error) throw new Error(raw.error.message);
    const text = raw.content[0].text;

    // JSON部分を抽出（LLMが前後にテキストを付けた場合に対応）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON取得失敗: ' + text.substring(0, 200));
    const result = JSON.parse(jsonMatch[0]);

    // knowledge_num（1始まり）→ 実際のDB IDに変換
    if (result.candidates) {
      result.candidates = result.candidates.map(c => {
        if (c.knowledge_num !== null && c.knowledge_num !== undefined) {
          const idx = parseInt(c.knowledge_num) - 1;
          const kn = knowledge[idx];
          if (kn) {
            c.id = kn.id;
            if (!c.answer) c.answer = kn.answer;
          }
        }
        return c;
      });
    }

    console.log(`✅ AI分析完了: ${(result.sub_questions||[]).length}質問 / 信頼度${result.overall_confidence}%`);
    return respond_({ success: true, ...result });

  } catch(e) {
    console.error('Claude API エラー:', e.message);
    // フォールバック: キーワードマッチのみで返す（0件でも成功扱い）
    return respond_({ success: false, error: e.message });
  }
}

// ========================================
// 自動返信（GAS内から呼び出す — Phase 2用）
// ========================================
function tryAutoReply_(inquiryId, result, inqRow) {
  if (!result.auto_reply_ok || result.overall_confidence < 85) return false;
  const props  = PropertiesService.getScriptProperties().getProperties();
  const SB_KEY = props['SUPABASE_KEY'];
  const name   = inqRow.name || 'お客様';
  const store  = 'BUDDICA TOURISM 高松空港店';
  const lineId = '@466dbckq';
  const fullReply = `${name} 様\n\nお問い合わせいただきありがとうございます。\n${store}でございます。\n\n${result.draft_body}\n\nご不明な点がございましたら、LINE（${lineId}）またはメールにてお気軽にお申し付けください。\n引き続きよろしくお願いいたします。\n\n──────────────────\n${store}\nreserve.touring@buddica.co.jp\nLINE: ${lineId}\n──────────────────`;

  try {
    // 返信メール送信
    sendReply_({ to: inqRow.email, inquiry_id: inquiryId, body: fullReply });
    // Supabase ステータス更新
    UrlFetchApp.fetch(`${INQUIRY_SB_URL}/rest/v1/bt_inquiries?id=eq.${inquiryId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders_(SB_KEY), 'Prefer': 'return=minimal' },
      payload: JSON.stringify({ status: 'replied', reply_content: fullReply, was_edited: false, auto_replied: true }),
      muteHttpExceptions: true,
    });
    // Slack通知
    btInqSlack_(`🤖 自動返信済み: ${name}様 / 信頼度${result.overall_confidence}%\n問い合わせ: ${(inqRow.inquiry_content||'').substring(0,100)}`);
    console.log(`🤖 自動返信: ${name} <${inqRow.email}> / 信頼度${result.overall_confidence}%`);
    return true;
  } catch(e) {
    console.error('自動返信エラー:', e.message);
    return false;
  }
}

// ========================================
// セットアップ・運用用関数
// ========================================

function setupProperties() {
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_KEY:      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdncXVndnlza3lpYmx4aXljcGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDc3NjksImV4cCI6MjA5MzY4Mzc2OX0.uNhWcBd_Dl5nzemZDQfJ8mQV6iY73MwystGGpTRPC18',
    ANTHROPIC_API_KEY: '<Anthropic APIキーをここに入力>',  // ★ 要設定
  });
  console.log('✅ プロパティ設定完了 — ANTHROPIC_API_KEY を実際のキーに書き換えてください');
}

function setupAnthropicKey() {
  // ANTHROPIC_API_KEYのみ個別設定用（SUPABASE_KEYを上書きしない）
  PropertiesService.getScriptProperties().setProperty(
    'ANTHROPIC_API_KEY', '<Anthropic APIキーをここに入力（任意・AI下書きを使う場合）>'
  );
  console.log('✅ ANTHROPIC_API_KEY 設定完了');
}

// トリガー設定（runImport: 15分おき / checkUnrepliedAlert: 30分おき）
function setupTriggers() {
  // 既存トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runImport').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('checkUnrepliedAlert').timeBased().everyMinutes(30).create();
  console.log('✅ トリガー設定完了');
  console.log('  - runImport: 15分おき');
  console.log('  - checkUnrepliedAlert: 30分おき');
}

function runImport() {
  importInquiryEmails_();
  hbWrite_('inquiry_import');
}

function hbWrite_(key) {
  return; // BTは心拍書込み不要（realWatchdogInquiry がDB鮮度で監視）。no-op。
  try {
    var SB_URL = 'https://ggqugvyskyiblxiycpci.supabase.co';
    var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdncXVndnlza3lpYmx4aXljcGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDc3NjksImV4cCI6MjA5MzY4Mzc2OX0.uNhWcBd_Dl5nzemZDQfJ8mQV6iY73MwystGGpTRPC18';
    UrlFetchApp.fetch(SB_URL + '/rest/v1/nha_app_settings', {
      method: 'post', muteHttpExceptions: true,
      headers: {'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'},
      payload: JSON.stringify({key:'heartbeat_'+key, value:JSON.stringify({last_run:new Date().toISOString(),status:'ok'})})
    });
  } catch(e) {}
}

function testImport() {
  const count = importInquiryEmails_();
  console.log(`テスト完了 - 取込件数: ${count}`);
}

// アラートの手動テスト（Slackに実際に送信されます）
function testAlert() {
  checkUnrepliedAlert();
  console.log('testAlert 完了');
}

function testSendReply() {
  sendReply_({
    to: 'noritaka.oshita@gmail.com',
    subject: 'テスト返信【HANDYMAN】',
    body: 'これはテスト送信です。',
    inquiry_id: 'test-001'
  });
}

function checkProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  console.log('SUPABASE_KEY:', props['SUPABASE_KEY'] ? '設定済み ✅' : '未設定 ❌');
  console.log('処理済みID件数:', Object.keys(JSON.parse(props['INQUIRY_LIVE_MSG_IDS'] || '{}')).length);
  console.log('通知済みID件数:', Object.keys(JSON.parse(props['INQUIRY_ALERTED_IDS'] || '{}')).length);
}

function clearProcessedIds() {
  PropertiesService.getScriptProperties().deleteProperty('INQUIRY_LIVE_MSG_IDS');
  console.log('✅ 処理済みIDをリセットしました');
}

function clearAlertedIds() {
  PropertiesService.getScriptProperties().deleteProperty('INQUIRY_ALERTED_IDS');
  console.log('✅ アラート済みIDをリセットしました');
}

function checkTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    console.log('❌ トリガーなし。setupTriggers()を実行してください');
  } else {
    triggers.forEach(t => {
      console.log(`✅ ${t.getHandlerFunction()} / ${t.getTriggerSource()} / ${t.getEventType()}`);
    });
  }
}


/* ========== ウォッチドッグ（DB鮮度監視・Gmailは異常時のみ最大3時間に1回） ========== */

/**
 * ============================================================
 * 問い合わせ取込 ウォッチドッグ（再発防止・2026-06-14 追加）
 * ============================================================
 * 背景:
 *   2026-06-09 21:28(UTC) を最後に importInquiryEmails_ が
 *   1件も取り込めていないのに、runImport 末尾の hbWrite_ が
 *   "別の埋め込みキー" で heartbeat を書くため監視は緑のまま＝
 *   偽陽性で4日間気づけなかった。
 *
 * 対策:
 *   1) realWatchdogInquiry() … 「関数が動いたか」ではなく
 *      「inquiries に新しい行が実際に増えているか」を見る。
 *      ・最新 created_at が STALE_MIN 分以上前
 *      ・かつ Gmail受信箱に未取込の問い合わせフォーム通知がある
 *      → Slack #operation に "取込停止" アラート。
 *   2) setupWatchdogInquiry() で独立トリガー(30分)を張る。
 *      runImport とは別トリガーなので、取込側が壊れても鳴る。
 *
 * 使い方(オーナー作業):
 *   ① このコードを GAS「HANDYMAN 問い合わせ管理」に新規ファイル
 *      または末尾へ貼り付け→保存
 *   ② setupWatchdogInquiry を1回だけ ▶ 実行（トリガー設定）
 *   ③ あわせて debugImport を1回 ▶ 実行し、取込が止まっている
 *      真因（SUPABASE_KEY 未設定 / Gmail認可切れ 等）をログで確認、
 *      SUPABASE_KEY を再設定 or 再認可 → setupTriggers 再実行
 */

// 何分新規が無ければ「停止」とみなすか
const INQ_STALE_MIN = 100;
// 異常時にGmailで裏取りする間隔の下限（Gmail1日上限の節約：最大3時間に1回だけ）
const INQ_GMAIL_THROTTLE_MIN = 180;

function realWatchdogInquiry() {
  const sp     = PropertiesService.getScriptProperties();
  const props  = sp.getProperties();
  const SB_KEY = props['SUPABASE_KEY'];
  const SB_URL = INQUIRY_SB_URL; // 既存定数

  // ── 1) 毎回はDBの鮮度だけで判定（Gmailを一切叩かない＝日常のGmail消費ゼロ）──
  if (!SB_KEY) {
    alertWatchdog_('⚠️ *問い合わせ取込 異常*\nSUPABASE_KEY 未設定。service_role キーを再設定してください。');
    return;
  }
  let lastCreated = null;
  try {
    const res = UrlFetchApp.fetch(
      `${SB_URL}/rest/v1/bt_inquiries?select=created_at&order=created_at.desc&limit=1`,
      { headers: sbHeaders_(SB_KEY), muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      alertWatchdog_(`⚠️ *問い合わせ取込 異常*\nSupabase読取に失敗 (HTTP ${res.getResponseCode()})\nSUPABASE_KEY が失効/未設定の可能性。debugImport で確認してください。`);
      return;
    }
    const rows = JSON.parse(res.getContentText());
    if (rows.length) lastCreated = new Date(rows[0].created_at);
  } catch(e) {
    alertWatchdog_(`⚠️ *問い合わせ取込 異常*\nSupabase接続エラー: ${e.message}`);
    return;
  }

  const ageMin = lastCreated ? Math.floor((Date.now() - lastCreated.getTime())/60000) : 99999;
  if (ageMin < INQ_STALE_MIN) {
    // 正常＝異常フラグを解除（次の障害時にまた裏取り＆通知できるように）
    sp.deleteProperty('INQ_WD_ALERTED');
    console.log(`✅ 取込 正常: 最新 ${ageMin}分前（Gmail未使用）`);
    return;
  }

  // ── 2) 鮮度切れのときだけ Gmail で裏取り。ただし最大3時間に1回（上限を食わない）──
  const lastG = parseInt(props['INQ_WD_LAST_GMAIL'] || '0', 10);
  if (Date.now() - lastG < INQ_GMAIL_THROTTLE_MIN * 60000) {
    console.log(`ℹ️ ${ageMin}分新規なし。Gmail裏取りはスロットル中（節約のためスキップ）`);
    return;
  }
  sp.setProperty('INQ_WD_LAST_GMAIL', String(Date.now()));

  let pending = 0, sample = '';
  try {
    const threads = GmailApp.search('from:noreply@buddica.co.jp subject:お問い合わせ newer_than:2d -in:trash', 0, 20);
    const processed = JSON.parse(props['INQUIRY_LIVE_MSG_IDS'] || '{}');
    threads.forEach(t => t.getMessages().forEach(m => {
      if (!processed[m.getId()]) { pending++; if(!sample) sample = (m.getPlainBody()||'').substring(0,80); }
    }));
  } catch(e) {
    alertWatchdog_(`⚠️ *問い合わせ取込 異常*\nGmail検索エラー(認可切れ/上限の可能性): ${e.message}`);
    return;
  }

  if (pending > 0) {
    // 同じ障害での重複通知を抑制（復旧でフラグ解除されるまで1回だけ鳴らす）
    if (props['INQ_WD_ALERTED'] === '1') { console.log('🔁 既にアラート済み（重複通知を抑制）'); return; }
    sp.setProperty('INQ_WD_ALERTED', '1');
    alertWatchdog_(
      `🚨 *問い合わせ取込が停止しています* 🚨\n` +
      `最新の取込から *${Math.floor(ageMin/60)}時間${ageMin%60}分* 新規ゼロ。\n` +
      `受信箱に未取込のフォーム問い合わせ *${pending}件* あり（例:「${sample}…」）。\n` +
      `→ GASで *debugImport* を実行し原因(SUPABASE_KEY/認可)を確認、` +
      `修正後 *setupTriggers* を再実行してください。\n` +
      `▶ <https://buddica-touring.github.io/app/inquiry.html|対応画面>`);
  } else {
    console.log(`ℹ️ ${ageMin}分新規なしだが未取込フォーム0件（単に問い合わせが無いだけ）`);
  }
}

function alertWatchdog_(text) {
  btInqSlack_(text);
  console.log(text);
}

function setupWatchdogInquiry() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'realWatchdogInquiry')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('realWatchdogInquiry').timeBased().everyMinutes(30).create();
  console.log('✅ realWatchdogInquiry 30分トリガー設定完了');
}


/* ========== 復旧用：SUPABASE_KEYだけ再設定（ANTHROPICは触らない） ========== */
function fixSupabaseKey() {
  PropertiesService.getScriptProperties().setProperty(
    'SUPABASE_KEY',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdncXVndnlza3lpYmx4aXljcGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDc3NjksImV4cCI6MjA5MzY4Mzc2OX0.uNhWcBd_Dl5nzemZDQfJ8mQV6iY73MwystGGpTRPC18'
  );
  console.log('✅ SUPABASE_KEY 再設定完了（service_role）。次に setupTriggers を実行してください。');
}
