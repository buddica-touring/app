// ============================================================
// Square端末決済 → 会計自動取込
// 対象: 端末（Terminal）での対面決済のみ（PaymentLink決済は除外）
// 商品名「立替」「予約外売上」→ 科目判定
// メモ「NHA/SPK 予約番号 摘要」→ 店舗/予約番号/内容解析
// ============================================================

var SQ_TERMINAL_PROCESSED_KEY = 'sq_terminal_processed_ids';
var SQ_TERMINAL_SLACK_NHA = 'C0AP2S5B147'; // #payment_takamatsu
var SQ_TERMINAL_SLACK_SPK = 'C0AQL6HGG3E'; // #payment_sapporo

// ============================================================
// メイン: Square端末決済を取得→会計自動起票
// トリガー: 15分間隔
// ============================================================
function importSquareTerminalPayments() {
  var token = nhaGetSquareToken_();
  if (!token) {
    Logger.log('[SqTerminal] SQUARE_API_TOKEN未設定');
    return;
  }

  // 過去2時間の決済を取得（15分間隔なので余裕を持つ）
  var since = new Date(Date.now() - 2 * 60 * 60 * 1000);
  var sinceISO = since.toISOString();

  // 処理済みID取得
  var processed = getProcessedTerminalIds_();

  // Square Payments API: 直近の決済を取得
  var payments = fetchSquarePayments_(token, sinceISO);
  if (!payments || payments.length === 0) {
    Logger.log('[SqTerminal] 新規端末決済なし');
    return;
  }

  Logger.log('[SqTerminal] 取得: ' + payments.length + '件');

  // ★ 既存DB（accounting + failed）をクロスチェック用に取得
  // processed_terminal_ids の取りこぼし対策（過去の処理失敗で永久スキップされる事故を防ぐ）
  var existingInDb = {};
  try { existingInDb = fetchExistingSquarePaymentIds_(); } catch(e) { Logger.log('[SqTerminal] existing fetch err: ' + e.message); }

  var imported = 0;
  var skipped = 0;
  var errors = [];

  payments.forEach(function(payment) {
    var paymentId = payment.id;

    // COMPLETED のみ対象
    if (payment.status !== 'COMPLETED') {
      return;
    }

    // ★ 処理済みスキップ（ただし accounting/failed どちらにも無ければ再処理する）
    if (processed[paymentId] && existingInDb[paymentId]) {
      skipped++;
      return;
    }
    if (processed[paymentId] && !existingInDb[paymentId]) {
      Logger.log('[SqTerminal] 処理済みフラグあるがDB未登録 → 再処理: ' + paymentId);
    }

    // PaymentLink決済を除外（端末決済のみ対象）
    // source_type: CARD（端末）, EXTERNAL（外部）等
    // payment_link経由は order に payment_link フィールドがある
    // → order_id があれば Orders API で確認
    var isTerminal = false;

    // device_details がある = 端末決済
    if (payment.device_details) {
      isTerminal = true;
    }
    // application_details.application_id で判別（Terminal App）
    if (payment.application_details && payment.application_details.product_type === 'TERMINAL_API') {
      isTerminal = true;
    }
    // ★ ECOMMERCE_API = PaymentLink/オンライン決済 → 端末ではない → 除外
    if (payment.application_details && payment.application_details.square_product === 'ECOMMERCE_API') {
      Logger.log('[SqTerminal] ECOMMERCE_API決済スキップ（PaymentLink/オンライン）: ' + paymentId);
      processed[paymentId] = Date.now();
      return;
    }
    // source_type で判別
    if (payment.source_type === 'CARD' && !payment.payment_link_id) {
      // カード決済でPaymentLinkなし → 端末の可能性高い
      // ただし、PaymentLink経由のカード決済もsource_type=CARDになる
      // → order_idで追加判定
    }

    // order_id から注文詳細を取得して判定
    var orderInfo = null;
    if (payment.order_id) {
      orderInfo = fetchSquareOrder_(token, payment.order_id);
    }

    // PaymentLink経由の判定: orderにpayment_linkフィールドがある
    if (orderInfo && orderInfo.order) {
      var tenders = orderInfo.order.tenders || [];
      // line_items から商品名を取得
      var lineItems = (orderInfo.order.line_items || []);

      // PaymentLink経由チェック
      // PaymentLink作成のorderは通常 quick_pay で name が予約番号等
      // metadata や source で判別
      if (orderInfo.order.metadata && orderInfo.order.metadata.payment_link_id) {
        Logger.log('[SqTerminal] PaymentLink決済スキップ: ' + paymentId);
        processed[paymentId] = Date.now();
        return;
      }

      // ★ じゃらん事前決済 / 事前決済 → jalan_payments で管理済みのため除外
      // Square Payment Linkで決済されるが metadata に payment_link_id が入らないケースがある
      var allItemNames = (orderInfo.order.line_items || []).map(function(li){ return li.name || ''; }).join(' ');
      if (allItemNames.indexOf('じゃらん事前決済') !== -1 || allItemNames.indexOf('事前決済') !== -1) {
        Logger.log('[SqTerminal] じゃらん事前決済スキップ（jalan_payments管理）: ' + paymentId + ' / items: ' + allItemNames);
        processed[paymentId] = Date.now();
        return;
      }
    }

    // 金額
    var amount = 0;
    if (payment.amount_money) {
      amount = payment.amount_money.amount || 0;
    }
    if (amount === 0) {
      return;
    }

    // メモ（note）解析
    // 優先順: payment.note (取引メモ) > line_item.note (商品メモ)
    // スタッフは商品メモに入れがちなので、fallback で拾う
    var note = payment.note || '';
    if (!note && orderInfo && orderInfo.order && orderInfo.order.line_items) {
      var itemNotes = [];
      orderInfo.order.line_items.forEach(function(li) {
        if (li.note) itemNotes.push(li.note);
      });
      if (itemNotes.length > 0) {
        note = itemNotes.join(' ');
        Logger.log('[SqTerminal] line_item.note からメモ取得: "' + note + '"');
      }
    }
    var parsed = parseTerminalNote_(note);

    // 商品名から科目判定
    var category = detectCategory_(orderInfo, note);

    // 商品名抽出（失敗ログ用）
    var itemName = extractItemName_(orderInfo);

    // 店舗判定
    var store = parsed.store || 'UNKNOWN';

    // ★ SPK決済はSPK GASに委譲 → NHA GASはスキップ（processed に追加しない）
    if (store === 'SPK') {
      Logger.log('[SqTerminal] SPK決済はSPK GASに委譲: ' + paymentId);
      return;
    }

    // 会計テーブル判定
    var acctTable = '';
    if (store === 'NHA') {
      acctTable = 'bt_accounting';
    } else {
      // 店舗不明 → Slackアラート＋Supabase sq_terminal_failed に記録（APP TOPに赤バー表示）
      var reasonStore = '店舗コード不明（NHA/SPKをメモに記載してください）';
      saveFailedSqPayment_(payment, reasonStore, itemName);
      errors.push({
        paymentId: paymentId,
        amount: amount,
        note: note,
        reason: reasonStore
      });
      processed[paymentId] = Date.now();
      return;
    }

    // 会計タイプ判定
    var acctType = '';
    if (category === '立替') {
      acctType = 'advance';
    } else if (category === '予約外売上') {
      acctType = 'extra_sales';
    } else {
      // カテゴリ不明 → Slackアラート＋Supabase sq_terminal_failed に記録（APP TOPに赤バー表示）
      var reasonCat = '科目不明（「立替」か「予約外売上」商品を選択してください）';
      saveFailedSqPayment_(payment, reasonCat, itemName);
      errors.push({
        paymentId: paymentId,
        amount: amount,
        note: note,
        store: store,
        reason: reasonCat
      });
      processed[paymentId] = Date.now();
      return;
    }

    // 会計レコード生成
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    var acctId = 'SQ_' + paymentId.substring(0, 12) + '_' + Date.now();

    var acctRow = {
      id: acctId,
      date: dateStr,
      type: acctType,
      category: category === '立替' ? 'ガソリン代' : '追加売上', // デフォルト
      sub_category: '',
      description: parsed.description || note || '（Square端末決済）',
      amount: amount,
      input_by: 'Square自動',
      memo: 'Square決済ID: ' + paymentId,
      pay_method: 'カード',
      resv_no: parsed.resvNo || '',
      url: payment.receipt_url || '',
      paid: acctType === 'extra_sales' ? true : false, // 予約外売上は入金済、立替は回収確認待ち→でもSquare端末で回収してるから paid=true
      staff_name: '',
      user_name: parsed.resvNo ? '' : '', // 予約番号があれば後で紐付け可能
      created_at: now.toISOString()
    };

    // 立替もSquare端末で回収完了しているのでpaid=true
    acctRow.paid = true;

    // descriptionをカテゴリに昇格（メモから抽出した内容を科目として使う）
    if (parsed.description) {
      acctRow.category = parsed.description;
    }

    // Supabase INSERT
    var result = supabasePost_(acctTable, acctRow);
    if (result) {
      imported++;
      Logger.log('[SqTerminal] 起票: ' + acctTable + ' ¥' + amount + ' ' + category + ' ' + (parsed.resvNo || '-'));

      // Slack通知
      var slackCh = store === 'NHA' ? SQ_TERMINAL_SLACK_NHA : SQ_TERMINAL_SLACK_SPK;
      var emoji = acctType === 'advance' ? '💰' : '💳';
      var slackMsg = emoji + ' *Square端末決済 → 会計自動起票*\n'
        + '店舗: ' + store + '\n'
        + '科目: ' + category + '\n'
        + '金額: ¥' + amount.toLocaleString() + '\n'
        + '内容: ' + (parsed.description || '-') + '\n'
        + '予約番号: ' + (parsed.resvNo || 'なし') + '\n'
        + '決済ID: `' + paymentId.substring(0, 16) + '...`';
      try {
        nhaPostToSlackChannel_(slackCh, slackMsg);
      } catch (e) {
        Logger.log('[SqTerminal] Slack通知エラー: ' + e.message);
      }
    } else {
      // Supabase INSERT失敗 → sq_terminal_failed にも記録（APP TOPに赤バー表示）
      var reasonInsert = 'Supabase INSERT失敗（' + acctTable + '）';
      saveFailedSqPayment_(payment, reasonInsert, itemName);
      errors.push({
        paymentId: paymentId,
        amount: amount,
        note: note,
        store: store,
        reason: 'Supabase INSERT失敗'
      });
    }

    processed[paymentId] = Date.now();
  });

  // 処理済み保存
  saveProcessedTerminalIds_(processed);

  // エラーがあればSlackアラート
  if (errors.length > 0) {
    var alertMsg = '📋 *Square起票仕訳 ' + errors.length + '件（判断必要）*\n';
    errors.forEach(function(e) {
      alertMsg += '\n• ¥' + (e.amount || 0) + ' | メモ: `' + (e.note || '空') + '` | 理由: ' + e.reason;
    });
    alertMsg += '\n\nAPPの「Square起票仕訳」から店舗・科目を確認して起票してください。';
    try {
      nhaPostToSlackChannel_(SQ_TERMINAL_SLACK_NHA, alertMsg);
    } catch (ex) {
      Logger.log('[SqTerminal] アラート送信失敗: ' + ex.message);
    }
  }

  Logger.log('[SqTerminal] 完了: 起票=' + imported + '件, スキップ=' + skipped + '件, エラー=' + errors.length + '件');
}

// ============================================================
// Square Payments API: 決済一覧取得
// ============================================================
function fetchSquarePayments_(token, sinceISO) {
  var allPayments = [];
  var cursor = '';

  for (var page = 0; page < 10; page++) {
    var url = 'https://connect.squareup.com/v2/payments?begin_time=' + encodeURIComponent(sinceISO)
      + '&sort_order=DESC&limit=100';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        muteHttpExceptions: true
      });

      if (resp.getResponseCode() >= 400) {
        Logger.log('[SqTerminal] Payments API error: ' + resp.getContentText());
        break;
      }

      var data = JSON.parse(resp.getContentText());
      var payments = data.payments || [];
      allPayments = allPayments.concat(payments);

      if (data.cursor) {
        cursor = data.cursor;
      } else {
        break;
      }
    } catch (e) {
      Logger.log('[SqTerminal] Payments API exception: ' + e.message);
      break;
    }
  }

  return allPayments;
}

// ============================================================
// Square Orders API: 注文詳細取得
// ============================================================
function fetchSquareOrder_(token, orderId) {
  try {
    var resp = UrlFetchApp.fetch('https://connect.squareup.com/v2/orders/' + orderId, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18'
      },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() >= 400) {
      Logger.log('[SqTerminal] Orders API error: ' + resp.getContentText());
      return null;
    }

    return JSON.parse(resp.getContentText());
  } catch (e) {
    Logger.log('[SqTerminal] Orders API exception: ' + e.message);
    return null;
  }
}

// ============================================================
// メモ解析: 「NHA R0IPN7SD ガソリン代」→ {store, resvNo, description}
// ============================================================
function parseTerminalNote_(note) {
  var result = { store: '', resvNo: '', description: '' };
  if (!note) return result;

  // 全角→半角、余分な空白除去
  var text = note
    .replace(/\u3000/g, ' ')  // 全角スペース→半角
    .replace(/：/g, ':')
    .replace(/\s+/g, ' ')
    .trim();

  // パターン: 店舗コード 予約番号 内容
  // 例: NHA R0IPN7SD ガソリン代
  // 例: SPK IEI40399 延長料金1日分
  // 例: NHA なし 備品購入
  var parts = text.split(/\s+/);

  if (parts.length >= 1) {
    var first = parts[0].toUpperCase();
    if (first === 'NHA' || first === 'SPK') {
      result.store = first;
      parts.shift();
    }
  }

  // ★ フォールバック判定: NHA/SPKが明示されていない場合もキーワードで推定
  if (!result.store) {
    // 「高松」「takamatsu」→ NHA
    if (/高松|takamatsu/i.test(text)) {
      result.store = 'NHA';
    }
    // 「札幌」「sapporo」→ SPK
    else if (/札幌|sapporo/i.test(text)) {
      result.store = 'SPK';
    }
    // *R0XXXXXX* パターン（高松予約番号がアスタリスク囲み）→ NHA
    else {
      var asteriskMatch = text.match(/\*([A-Z0-9]{4,})\*/i);
      if (asteriskMatch) {
        var resvCandidate = asteriskMatch[1].toUpperCase();
        if (/^R0/.test(resvCandidate)) {
          result.store = 'NHA';
          if (!result.resvNo) result.resvNo = resvCandidate;
        } else if (/^(DY|RC|KUI)/.test(resvCandidate)) {
          result.store = 'SPK';
          if (!result.resvNo) result.resvNo = resvCandidate;
        }
      }
    }
  }

  if (parts.length >= 1) {
    var second = parts[0];
    // 予約番号判定: 英数字混合で4文字以上、または「なし」
    if (second === 'なし' || second === 'ナシ' || second === 'nashi' || second === '-') {
      result.resvNo = '';
      parts.shift();
    } else if (/^[A-Za-z0-9\-]{4,}$/.test(second)) {
      result.resvNo = second;
      parts.shift();
    }
    // SP-YYYYMMDD-NNNN パターン
    else if (/^SP-\d{8}-\d+$/.test(second)) {
      result.resvNo = second;
      parts.shift();
    }
  }

  // 残りは摘要
  if (parts.length > 0) {
    result.description = parts.join(' ');
  }

  return result;
}

// ============================================================
// 商品名抽出: orderInfo.order.line_items の name を結合
// 失敗ログ表示用（APP sq_terminal_failed.item_name）
// ============================================================
function extractItemName_(orderInfo) {
  try {
    if (!orderInfo || !orderInfo.order || !orderInfo.order.line_items) return '';
    var items = orderInfo.order.line_items;
    var names = [];
    for (var i = 0; i < items.length; i++) {
      var n = (items[i].name || '').trim();
      if (n) names.push(n);
    }
    return names.join(' / ');
  } catch (e) {
    return '';
  }
}

// ============================================================
// 商品名から科目判定
// Orders APIのline_items.nameまたはメモから判定
// ============================================================
function detectCategory_(orderInfo, note) {
  // Orders APIから商品名を取得
  if (orderInfo && orderInfo.order && orderInfo.order.line_items) {
    var items = orderInfo.order.line_items;
    for (var i = 0; i < items.length; i++) {
      var name = (items[i].name || '').trim();
      if (name === '立替' || name.indexOf('立替') >= 0 || name.indexOf('tatekae') >= 0) {
        return '立替';
      }
      if (name === '予約外売上' || name.indexOf('予約外') >= 0 || name.indexOf('追加') >= 0) {
        return '予約外売上';
      }
    }
  }

  // メモからフォールバック判定
  if (note) {
    var n = note.toLowerCase();
    if (n.indexOf('立替') >= 0 || n.indexOf('ガソリン') >= 0 || n.indexOf('高速') >= 0 || n.indexOf('駐車') >= 0) {
      return '立替';
    }
    if (n.indexOf('予約外') >= 0 || n.indexOf('延長') >= 0 || n.indexOf('追加') >= 0 || n.indexOf('オプション') >= 0) {
      return '予約外売上';
    }
  }

  return ''; // 判定不能
}

// ============================================================
// 処理済みID管理（ScriptProperties）
// ============================================================
function getProcessedTerminalIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SQ_TERMINAL_PROCESSED_KEY) || '{}';
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// 処理済みIDをクリア（リトライ用）
function clearProcessedTerminalIds() {
  PropertiesService.getScriptProperties().deleteProperty(SQ_TERMINAL_PROCESSED_KEY);
  Logger.log('[SqTerminal] 処理済みIDクリア完了');
}

function saveProcessedTerminalIds_(ids) {
  // 48時間以上前のエントリを削除（メモリ節約）
  var cutoff = Date.now() - 48 * 60 * 60 * 1000;
  var clean = {};
  for (var id in ids) {
    if (ids[id] > cutoff) clean[id] = ids[id];
  }
  PropertiesService.getScriptProperties().setProperty(SQ_TERMINAL_PROCESSED_KEY, JSON.stringify(clean));
}

// ============================================================
// セットアップ: トリガー登録
// ============================================================
function setupSquareTerminalImport() {
  // 既存トリガー削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'importSquareTerminalPayments') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 15分間隔トリガー
  ScriptApp.newTrigger('importSquareTerminalPayments')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('[SqTerminal] トリガー設定完了: importSquareTerminalPayments 15分間隔');
}

// ============================================================
// デバッグ: 直近の端末決済をログ出力（起票しない）
// ============================================================
function debugSquareTerminalPayments() {
  var token = nhaGetSquareToken_();
  if (!token) { Logger.log('SQUARE_API_TOKEN未設定'); return; }

  var since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 過去24時間
  var payments = fetchSquarePayments_(token, since.toISOString());

  Logger.log('=== 直近24時間のSquare決済: ' + payments.length + '件 ===');

  payments.forEach(function(p) {
    var amount = p.amount_money ? p.amount_money.amount : 0;
    var note = p.note || '';
    var hasDevice = p.device_details ? 'YES' : 'NO';
    var sourceType = p.source_type || '-';
    var status = p.status || '-';

    // Order詳細
    var itemNames = [];
    var itemNotes = [];
    if (p.order_id) {
      var orderInfo = fetchSquareOrder_(token, p.order_id);
      if (orderInfo && orderInfo.order && orderInfo.order.line_items) {
        orderInfo.order.line_items.forEach(function(li) {
          itemNames.push(li.name || '(名前なし)');
          if (li.note) itemNotes.push(li.note);
        });
      }
    }
    // payment.note が空なら line_item.note にフォールバック
    if (!note && itemNotes.length > 0) {
      note = itemNotes.join(' ');
    }

    var parsed = parseTerminalNote_(note);
    var category = detectCategory_(p.order_id ? fetchSquareOrder_(token, p.order_id) : null, note);

    Logger.log(
      '[' + status + '] ¥' + amount
      + ' | device=' + hasDevice
      + ' | source=' + sourceType
      + ' | payment.note="' + (p.note || '') + '"'
      + ' | line_item.note="' + itemNotes.join(' / ') + '"'
      + ' | 採用note="' + note + '"'
      + ' | items=[' + itemNames.join(', ') + ']'
      + ' | parsed={store:' + parsed.store + ', resv:' + parsed.resvNo + ', desc:' + parsed.description + '}'
      + ' | category=' + (category || '不明')
      + ' | id=' + p.id
    );
  });
}

// ============================================================
// 既存DB（accounting + failed）に存在する Square payment ID を取得
// ============================================================
function fetchExistingSquarePaymentIds_() {
  var ids = {};
  var SUPABASE_URL = (typeof SQF_SUPABASE_URL !== 'undefined') ? SQF_SUPABASE_URL : 'https://ggqugvyskyiblxiycpci.supabase.co';
  var SUPABASE_KEY = (typeof SQF_SUPABASE_KEY !== 'undefined') ? SQF_SUPABASE_KEY : '';
  var headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };

  // bt_accounting + spk_accounting の memo から Square payment_id を抽出
  // memo形式: "Square決済ID: xxxxx" or "Square payment_id: xxxxx"
  ['bt_accounting', 'spk_accounting'].forEach(function(tbl) {
    try {
      var resp = UrlFetchApp.fetch(
        SUPABASE_URL + '/rest/v1/' + tbl + '?select=memo&or=(memo.ilike.*Square*)',
        { method: 'get', headers: headers, muteHttpExceptions: true }
      );
      if (resp.getResponseCode() < 300) {
        var rows = JSON.parse(resp.getContentText());
        rows.forEach(function(r) {
          var m = (r.memo || '').match(/(?:Square[^A-Za-z0-9]*(?:決済ID|payment_id)[:：\s]+)([A-Za-z0-9]+)/i);
          if (m) ids[m[1]] = tbl;
        });
      }
    } catch (e) { Logger.log('[rescan] ' + tbl + ' fetch error: ' + e.message); }
  });

  // sq_terminal_failed の id（payment_id 直接）
  try {
    var resp2 = UrlFetchApp.fetch(
      SUPABASE_URL + '/rest/v1/sq_terminal_failed?select=id',
      { method: 'get', headers: headers, muteHttpExceptions: true }
    );
    if (resp2.getResponseCode() < 300) {
      var rows2 = JSON.parse(resp2.getContentText());
      rows2.forEach(function(r) { ids[r.id] = 'sq_terminal_failed'; });
    }
  } catch (e) { Logger.log('[rescan] failed fetch error: ' + e.message); }

  return ids;
}

// ============================================================
// 漏れた端末決済を再スキャンして sq_terminal_failed に投入
// 過去48時間の端末決済（device=YES）で accounting/failed どちらにも無いものを救済
// 手動実行用（GASエディタから1回叩く）
// ============================================================
function rescanMissingSquareTerminalPayments() {
  var token = nhaGetSquareToken_();
  if (!token) { Logger.log('SQUARE_API_TOKEN未設定'); return 0; }

  var since = new Date(Date.now() - 48 * 60 * 60 * 1000); // 過去48時間
  var payments = fetchSquarePayments_(token, since.toISOString());
  Logger.log('[rescan] 過去48hのSquare決済: ' + payments.length + '件');

  var existing = fetchExistingSquarePaymentIds_();
  Logger.log('[rescan] 既存DB登録済み: ' + Object.keys(existing).length + '件');

  var added = 0;
  var skipped = 0;
  payments.forEach(function(p) {
    if (p.status !== 'COMPLETED') return;

    // 端末決済のみ対象
    if (!p.device_details && !(p.application_details && p.application_details.product_type === 'TERMINAL_API')) {
      return;
    }

    // 既にDBに存在 → スキップ
    if (existing[p.id]) {
      skipped++;
      return;
    }

    // 商品名・メモ取得
    var orderInfo = p.order_id ? fetchSquareOrder_(token, p.order_id) : null;
    var itemName = extractItemName_(orderInfo);
    var note = p.note || '';
    if (!note && orderInfo && orderInfo.order && orderInfo.order.line_items) {
      var notes = [];
      orderInfo.order.line_items.forEach(function(li) { if (li.note) notes.push(li.note); });
      note = notes.join(' ');
    }

    // 失敗理由判定
    var category = detectCategory_(orderInfo, note);
    var parsed = parseTerminalNote_(note);
    var reason = '';
    if (!parsed.store && !category) reason = '店舗コード&科目どちらも不明（メモ「NHA/SPK 予約番号 内容」＋商品「立替/予約外売上」を）';
    else if (!parsed.store) reason = '店舗コード不明（メモ先頭にNHA/SPKを記載してください）';
    else if (!category) reason = '科目不明（商品「立替」or「予約外売上」を選択してください）';
    else reason = '【要調査】店舗・科目とも判定可能だが起票漏れ → 過去の処理失敗の可能性';

    // sq_terminal_failed に投入
    var ok = saveFailedSqPayment_(p, reason, itemName);
    if (ok) {
      added++;
      Logger.log('[rescan] +追加: ¥' + (p.amount_money ? p.amount_money.amount : 0) + ' ' + itemName + ' (' + reason + ') id=' + p.id);
    }

    // processed_terminal_ids にも記録（次回 importSquareTerminalPayments の二重ループを避ける）
    var processed = getProcessedTerminalIds_();
    processed[p.id] = Date.now();
    saveProcessedTerminalIds_(processed);
  });

  Logger.log('[rescan] 完了: 追加=' + added + '件, スキップ(既存)=' + skipped + '件');
  return added;
}

// ============================================================
// テスト: メモ解析の単体テスト
// ============================================================
function testParseTerminalNote() {
  var tests = [
    { input: 'NHA R0IPN7SD ガソリン代', expect: { store: 'NHA', resvNo: 'R0IPN7SD', description: 'ガソリン代' } },
    { input: 'SPK IEI40399 延長料金1日分', expect: { store: 'SPK', resvNo: 'IEI40399', description: '延長料金1日分' } },
    { input: 'NHA なし 備品購入', expect: { store: 'NHA', resvNo: '', description: '備品購入' } },
    { input: 'NHA SP-20260421-0001 追加オプション', expect: { store: 'NHA', resvNo: 'SP-20260421-0001', description: '追加オプション' } },
    { input: 'ガソリン代', expect: { store: '', resvNo: '', description: 'ガソリン代' } },
    { input: '', expect: { store: '', resvNo: '', description: '' } },
    { input: 'NHA　Ｒ０ＩＰＮ７ＳＤ　ガソリン代', expect: { store: 'NHA', resvNo: '', description: '' } }, // 全角は予約番号パターン不一致
  ];

  tests.forEach(function(t, i) {
    var result = parseTerminalNote_(t.input);
    var pass = result.store === t.expect.store && result.resvNo === t.expect.resvNo;
    Logger.log((pass ? '✅' : '❌') + ' Test ' + (i+1) + ': "' + t.input + '"'
      + ' → store=' + result.store + ', resv=' + result.resvNo + ', desc=' + result.description);
  });
}
