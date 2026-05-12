// ============================================================
// GAS - Reservation Email Import & Vehicle Auto-Assignment
// Gmail: reserve@rent-buddica-touring.jp
// Target: 高松空港 (NHA) store only
// OTA: 楽天(R), じゃらん(J), skyticket(S), エアトリ(O), オフィシャル(HP)
// ============================================================

// --- Supabase Config ---
var SUPABASE_URL = 'https://ggqugvyskyiblxiycpci.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdncXVndnlza3lpYmx4aXljcGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDc3NjksImV4cCI6MjA5MzY4Mzc2OX0.uNhWcBd_Dl5nzemZDQfJ8mQV6iY73MwystGGpTRPC18';
var LABEL_NAME = 'processed_takamatsu';
var SLACK_EMAIL = 'x-aaaatppttzyrldnhjt5el4jj3i@gl-oke5175.slack.com';
var SLACK_EMAIL_RESV = 'rent_car_notifaction-aaaamey56wdscatbyavjfrhyw4@gl-oke5175.slack.com'; // #kagawa_reservation_notification
var SLACK_EMAIL_OPS  = 'kagawa_operations-te-aaaamflljqqgaubhqstvolxnii@gl-oke5175.slack.com'; // #kagawa_operations-team

// --- OTA sender definitions ---
var OTA_SENDERS = {
  jalan:     'info@jalan-rentacar.jalan.net',
  rakuten:   'travel@mail.travel.rakuten.co.jp',
  skyticket: 'rentacar@skyticket.com',
  airtrip:   'info@rentacar-mail.airtrip.jp',
  airtrip_dp: 'info@skygate.co.jp',
  official:  'noreply@rent-buddica-touring.jp',
  gogoout:   'service@gogoout.com',
  rentacar_dc: 'info@rentacar.com',
  rentacar_dc2: 'info@web-rentacar.com'
};

// --- OTA reservation subject patterns ---
var OTA_RESERVE_SUBJECTS = {
  jalan:     'じゃらんnetレンタカー 予約通知',
  rakuten:   '【楽天トラベル】予約受付のお知らせ',
  skyticket: '【skyticket】 新規予約',
  airtrip:   '【予約確定】エアトリレンタカー',
  airtrip_dp: '【予約確定】エアトリプラス',
  official:  'ご予約完了のお知らせ',
  gogoout:   'gogoout - 予約のお知らせ',
  rentacar_dc: '予約登録のお知らせ',
  rentacar_dc2: '予約登録のお知らせ'
};

// --- Cancellation keywords in subject ---
var CANCEL_KEYWORDS = ['予約キャンセル受付', 'キャンセル', 'cancellation', 'cancelled'];

// ============================================================
// Setup & Trigger
// ============================================================
function setup() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processNewEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('processNewEmails')
    .timeBased()
    .everyMinutes(15)
    .create();

  getOrCreateLabel_(LABEL_NAME);
  Logger.log('Setup complete: 15-minute trigger created, label "' + LABEL_NAME + '" ensured.');
}

// ============================================================
// Main Entry Points
// ============================================================
function processNewEmails() {
  // ★ 2026-05-02: 早期return時もheartbeat更新するよう構造変更（メール0件で「停止」誤判定される問題対策）
  // try-finally で必ず最後にheartbeatを書く。Slack通知やDB更新でエラーが出ても "動いた" 記録は残す
  var successes = [];
  var failures = [];
  var cancellations = [];
  var skipped = [];

  try {
    var label = getOrCreateLabel_(LABEL_NAME);
    var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
    // ★ ラベルでフィルタしない（キャンセルメールが同スレッドに来てもスキップされない）
    // 代わりにメッセージID単位で処理済み管理する
    // ★ 2026-04-30: 2d → 7d に拡張（HGU20355 / NUI44639 取り込み失敗障害対策）
    // GASダウン・ScriptProperties初期化等で2日以上空いた場合、newer_than:2d だと永久スキップになる
    var query = '(' + fromClause + ') newer_than:7d';

    var threads = GmailApp.search(query, 0, 50);
    if (threads.length === 0) {
      Logger.log('No new reservation emails found.');
      return;  // finally で heartbeat 更新される
    }

    Logger.log('Found ' + threads.length + ' thread(s) to scan.');

    // メッセージID単位の処理済みセットを取得
    var processedMsgIds = getProcessedMsgIds_();
    var now = Date.now();
    // ★ 2026-05-02 修正: msgId保持期間 = メール検索範囲 + 余裕
    //   旧: 3日保持 / 検索 newer_than:7d → 3〜7日前メールが再処理されてキャンセル済み予約が
    //   「再有効化」される障害が発生 (R0J7YIGY 事例)
    //   新: 10日保持（検索7d + 余裕3d）。これで検索ウィンドウ内のメールは確実にスキップされる
    var MSG_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
    var pruneKeys = Object.keys(processedMsgIds);
    for (var p = 0; p < pruneKeys.length; p++) {
      if (now - processedMsgIds[pruneKeys[p]] > MSG_RETENTION_MS) {
        delete processedMsgIds[pruneKeys[p]];
      }
    }

    // 全メッセージを時系列順に収集（新規→CXL→取り直しの順序を保証）
    var allMessages = [];
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      for (var j = 0; j < messages.length; j++) {
        allMessages.push({msg: messages[j], thread: threads[i]});
      }
    }
    allMessages.sort(function(a, b) { return a.msg.getDate().getTime() - b.msg.getDate().getTime(); });

    var labeledThreads = {};
    for (var i = 0; i < allMessages.length; i++) {
      var msgId = allMessages[i].msg.getId();

      // ★ メッセージID単位でスキップ（ラベルではなくIDで判定）
      if (processedMsgIds[msgId]) {
        continue;
      }

      try {
        var result = processMessage_(allMessages[i].msg, false);
        if (result) {
          if (result.type === 'success') successes.push(result);
          else if (result.type === 'failure') failures.push(result);
          else if (result.type === 'cancel') cancellations.push(result);
          else if (result.type === 'skip') skipped.push(result);
        }
      } catch (e) {
        Logger.log('ERROR processing message ID ' + msgId + ': ' + e.message + '\n' + e.stack);
        failures.push({id: '不明', ota: '?', name: '', reason: 'エラー: ' + e.message});
      }

      // 処理結果に関わらずメッセージIDを記録（二重処理防止）
      processedMsgIds[msgId] = now;

      // ラベルは視覚目印として付与（機能的ゲートキーパーではない）
      var tid = allMessages[i].thread.getId();
      if (!labeledThreads[tid]) {
        allMessages[i].thread.addLabel(label);
        labeledThreads[tid] = true;
      }
    }

    // 処理済みメッセージIDを保存
    saveProcessedMsgIds_(processedMsgIds);

    if (successes.length > 0) sendSlackSuccess_(successes);
    if (failures.length > 0) sendSlackFailure_(failures);
    if (cancellations.length > 0) sendSlackCancel_(cancellations);

    // 未知送信元チェック: reserve@宛の予約系メールでOTA未登録の送信元を検知
    checkUnknownSenders_();
  } catch (e) {
    Logger.log('[processNewEmails] FATAL: ' + e.message + '\n' + e.stack);
    failures.push({id:'-', ota:'?', name:'', reason:'processNewEmails fatal: '+e.message});
  } finally {
    // ハートビート: 成功・失敗に関わらず実行完了をDBに記録（メール0件でも記録する）
    updateHeartbeat_('bt_gas_email', {
      success: successes.length,
      failure: failures.length,
      cancel: cancellations.length,
      skip: skipped.length
    });
  }
}

function testProcessLatest() {
  var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
  var query = '(' + fromClause + ') newer_than:7d';
  var threads = GmailApp.search(query, 0, 10);
  if (threads.length === 0) {
    Logger.log('No emails found for test.');
    return;
  }
  Logger.log('[TEST] Found ' + threads.length + ' thread(s).');
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      try {
        processMessage_(messages[j], true);
      } catch (e) {
        Logger.log('[TEST] ERROR: ' + e.message + '\n' + e.stack);
      }
    }
  }
}

// ============================================================
// HP店舗判定 動作確認テスト（2026-04-30 追加）
// parseOfficial_ の店舗検出ロジック（札幌GAS版に統一）が
// 実メールで機能するか検証する。dryRunのみ・DB変更なし。
// ============================================================
function testParseOfficialStoreDetection() {
  var TARGET_IDS = ['HGU20355', 'NUI44639'];  // 必要なら他のHP予約IDに変更
  Logger.log('[StoreTest] === HP店舗判定 動作確認 ===');
  for (var ti = 0; ti < TARGET_IDS.length; ti++) {
    var rid = TARGET_IDS[ti];
    var query = '"' + rid + '" newer_than:60d';
    var threads = GmailApp.search(query, 0, 5);
    if (threads.length === 0) { Logger.log('[StoreTest] ' + rid + ' Gmail未検出'); continue; }
    var found = false;
    for (var i = 0; i < threads.length && !found; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length && !found; j++) {
        var body = msgs[j].getPlainBody();
        if (body.indexOf(rid) === -1) continue;
        if (msgs[j].getFrom().indexOf('noreply@rent-buddica-touring.jp') === -1) continue;
        try {
          var parsed = parseOfficial_(body);
          if (parsed) {
            var takamatsuJudge = isTakamatsuReservation_(parsed);
            Logger.log('[StoreTest] ' + rid + ': _store="' + parsed._store + '" vehicle=' + parsed.vehicle +
              ' del_place="' + parsed.del_place + '" col_place="' + parsed.col_place + '"');
            Logger.log('[StoreTest] ' + rid + ': isTakamatsuReservation_=' + takamatsuJudge +
              ' (' + (takamatsuJudge ? '高松DB登録対象' : '札幌DB登録対象=NHA-GASスキップ') + ')');
          } else {
            Logger.log('[StoreTest] ' + rid + ': parseOfficial_ returned null');
          }
          found = true;
        } catch (e) {
          Logger.log('[StoreTest] ' + rid + ' ERROR: ' + e.message);
          found = true;
        }
      }
    }
  }
  Logger.log('[StoreTest] === 完了 ===');
}

// ============================================================
// 取り込み漏れ救済（2026-04-30 緊急対応）
// HGU20355 / NUI44639 等、newer_than:2d を超過した予約メールを
// 個別に検索して本番取込する。dryRun=false で実DB登録される。
// 関数を実行する前に TARGET_IDS を編集すること。
// ============================================================
function backfillSpecificReservations() {
  var TARGET_IDS = ['HGU20355', 'NUI44639'];
  var SEARCH_DAYS = 30;  // 30日まで遡る

  var processedMsgIds = getProcessedMsgIds_();
  var now = Date.now();
  var successes = [];
  var failures = [];
  var skipped = [];

  Logger.log('[Backfill] Target IDs: ' + TARGET_IDS.join(', '));

  for (var ti = 0; ti < TARGET_IDS.length; ti++) {
    var rid = TARGET_IDS[ti];
    Logger.log('[Backfill] === Searching: ' + rid + ' ===');

    // 全送信元 OR 全件名 で予約番号文字列を Gmail全文検索
    var query = '"' + rid + '" newer_than:' + SEARCH_DAYS + 'd';
    var threads = GmailApp.search(query, 0, 20);
    Logger.log('[Backfill] ' + rid + ': ' + threads.length + ' thread(s) hit');

    if (threads.length === 0) {
      Logger.log('[Backfill] ' + rid + ': NOT FOUND in Gmail (newer_than:' + SEARCH_DAYS + 'd)');
      failures.push({id:rid, ota:'?', name:'', reason:'Gmail未検出'});
      continue;
    }

    var processedThisId = false;
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      for (var j = 0; j < messages.length; j++) {
        var msg = messages[j];
        var msgId = msg.getId();
        var subject = msg.getSubject();
        var from = msg.getFrom();
        var body = msg.getPlainBody();

        // 該当予約IDを含むメールのみ
        if (body.indexOf(rid) === -1 && subject.indexOf(rid) === -1) continue;

        Logger.log('[Backfill] ' + rid + ' processing msg: from=' + from + ', subject=' + subject);

        try {
          var result = processMessage_(msg, false);  // dryRun=false → 本番登録

          // メッセージIDを処理済みに記録（オブジェクト形式: msgId → timestamp）
          processedMsgIds[msgId] = now;

          if (result) {
            Logger.log('[Backfill] ' + rid + ' result: ' + JSON.stringify(result));
            if (result.type === 'success') successes.push(result);
            else if (result.type === 'failure') failures.push(result);
            else if (result.type === 'skip') skipped.push(result);
          } else {
            Logger.log('[Backfill] ' + rid + ' result: null (skipped by router)');
          }
          processedThisId = true;
        } catch (e) {
          Logger.log('[Backfill] ' + rid + ' ERROR: ' + e.message + '\n' + e.stack);
          failures.push({id:rid, ota:'?', name:'', reason:'処理エラー: ' + e.message});
        }
      }
    }

    if (!processedThisId) {
      Logger.log('[Backfill] ' + rid + ': hit Gmail but no parseable message');
      failures.push({id:rid, ota:'?', name:'', reason:'メールあるがparseable無し'});
    }
  }

  // 処理済みメッセージIDを保存
  saveProcessedMsgIds_(processedMsgIds);

  Logger.log('');
  Logger.log('[Backfill] === SUMMARY ===');
  Logger.log('  Success:  ' + successes.length + ' / Skip: ' + skipped.length + ' / Failure: ' + failures.length);
  if (successes.length > 0) Logger.log('  ✅ ' + successes.map(function(x){return x.id;}).join(', '));
  if (skipped.length > 0)   Logger.log('  ⏭️ ' + skipped.map(function(x){return x.id+'('+x.reason+')';}).join(', '));
  if (failures.length > 0)  Logger.log('  ❌ ' + failures.map(function(x){return x.id+'('+x.reason+')';}).join(', '));

  if (successes.length > 0) sendSlackSuccess_(successes);
  if (failures.length > 0) sendSlackFailure_(failures);
}

// ============================================================
// Message Router
// ============================================================
function processMessage_(message, dryRun) {
  var from = message.getFrom();
  var subject = message.getSubject();
  var body = message.getPlainBody();

  var ota = null;
  var otaKeys = Object.keys(OTA_SENDERS);
  for (var i = 0; i < otaKeys.length; i++) {
    if (from.indexOf(OTA_SENDERS[otaKeys[i]]) !== -1) {
      ota = otaKeys[i];
      break;
    }
  }
  if (!ota) return null;

  var otaCode = {jalan:'J',rakuten:'R',skyticket:'S',airtrip:'O',airtrip_dp:'O',official:'HP',gogoout:'G',rentacar_dc:'RC',rentacar_dc2:'RC'}[ota] || ota;

  // Check for cancellation
  var isCancellation = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });

  if (isCancellation) {
    // キャンセル: DB存在チェック（1回のDB呼出しで判定）
    var tmpId = (ota === 'rakuten') ? extractField_(body, '・予約番号') : extractField_(body, '予約番号');
    if (tmpId) {
      var existing = reservationExists_(tmpId);
      if (!existing) {
        Logger.log('Skipping cancel (not in NHA DB): ' + tmpId);
        return {type:'skip', id:tmpId, reason:'DB未登録(札幌)'};
      }
      if (existing.status === 'cancelled') {
        Logger.log('Already cancelled: ' + tmpId);
        return {type:'skip', id:tmpId, reason:'既にキャンセル済み'};
      }
    }
    var cancelId = handleCancellation_(ota, body, dryRun);
    return cancelId ? {type:'cancel', id:cancelId, ota:otaCode} : null;
  }

  // Check subject matches reservation notification
  if (subject.indexOf(OTA_RESERVE_SUBJECTS[ota]) === -1) {
    Logger.log('Skipping non-reservation email (' + ota + '): ' + subject);
    return null;
  }

  // Parse reservation
  var reservation = null;
  switch (ota) {
    case 'jalan':      reservation = parseJalan_(body); break;
    case 'rakuten':    reservation = parseRakuten_(body); break;
    case 'skyticket':  reservation = parseSkyticket_(body); break;
    case 'airtrip':    reservation = parseAirtrip_(body); break;
    case 'airtrip_dp': reservation = parseAirtrip_(body); break;
    case 'official':   reservation = parseOfficial_(body); break;
    case 'gogoout':    reservation = parseGogoout_(body); break;
    case 'rentacar_dc': reservation = parseRentacarDC_(body); break;
    case 'rentacar_dc2': reservation = parseRentacarDC_(body); break;
  }

  if (!reservation) {
    Logger.log('Failed to parse reservation from ' + ota);
    return {type:'failure', id:'不明', ota:otaCode, name:'', reason:'パース失敗'};
  }

  // ★ メール受信日時を予約日時として記録（LT計算の正確性のため）
  reservation._booked_at = message.getDate().toISOString();

  // Filter: 高松 only
  if (!isTakamatsuReservation_(reservation)) {
    Logger.log('Skipping non-Takamatsu: ' + reservation.id +
      ' (store=' + (reservation._store || '') + ', rawClass=' + (reservation._rawClass || '') + ')');
    return {type:'skip', id:reservation.id, reason:'札幌店'};
  }

  Logger.log('Parsed: ' + reservation.id + ' (' + reservation.ota + ') ' +
    reservation.lend_date + '~' + reservation.return_date + ' class=' + reservation.vehicle);

  if (dryRun) {
    Logger.log('[DRY RUN] Would insert: ' + JSON.stringify(reservation));
    return null;
  }

  // Duplicate check（キャンセル済み同一IDの取り直し対応）
  var existing = reservationExists_(reservation.id);
  if (existing) {
    if (existing.status === 'cancelled') {
      // ★ 2026-05-02 ガード追加: 古い予約メールの再処理による誤再有効化を防止
      //   メール日付が既存行の created_at 以前なら、これは「古い予約メールの再取込」
      //   = キャンセル済み予約を勝手に復活させてはいけない (R0J7YIGY 事例)
      //   genuine な「同一ID取り直し」の場合は新しい予約メール = 日付が created_at より後になる
      try {
        var msgDate = message.getDate();
        if (existing.created_at) {
          var existingCreated = new Date(existing.created_at);
          if (msgDate.getTime() <= existingCreated.getTime() + 60000) {  // 1分の誤差許容
            Logger.log('SKIP reactivation (stale booking email): ' + reservation.id +
              ' msg=' + msgDate.toISOString() + ' existing.created_at=' + existing.created_at);
            return {type:'skip', id:reservation.id, reason:'キャンセル済み（古い予約メール再取込・再有効化抑止）'};
          }
        }
      } catch (e) {
        Logger.log('[Reactivate guard] Date check error: ' + e.message);
      }
      // キャンセル済み → 再有効化（同一IDで取り直し・新しい予約メール）
      Logger.log('Reactivating cancelled reservation: ' + reservation.id);
      deleteFromFleet_(reservation.id);
      deleteFromTasks_(reservation.id);
      if (!reactivateReservation_(reservation.id, reservation)) {
        return {type:'failure', id:reservation.id, ota:otaCode, name:reservation.name, reason:'再有効化失敗'};
      }
    } else {
      Logger.log('Reservation already exists (active): ' + reservation.id);
      return {type:'skip', id:reservation.id, reason:'登録済み'};
    }
  } else {
    // Insert
    var insertResult = insertReservation_(reservation);
    if (!insertResult) {
      return {type:'failure', id:reservation.id, ota:otaCode, name:reservation.name, reason:'DB登録失敗'};
    }
  }

  // Auto-assign vehicle
  var assigned = autoAssignVehicle_(reservation);

  // ★ じゃらん予約 → 事前決済フロー起動
  if (otaCode === 'J') {
    try { nhaHandleJalanPayment_(reservation); } catch (e) { Logger.log('[JalanPayment] Error: ' + e.message); }
  }

  if (assigned) {
    return {type:'success', id:reservation.id, ota:otaCode, name:reservation.name,
      dates:reservation.lend_date+'~'+reservation.return_date,
      vehicle:reservation.vehicle, assignedTo:assigned.name+' ('+assigned.plate_no+')'};
  } else {
    var failReason = reservation._vehicleModel
      ? '車種指定「' + reservation._vehicleModel + '」空車なし（' + reservation.vehicle + 'クラス）'
      : '配車不可（' + reservation.vehicle + 'クラス空車なし）';
    return {type:'failure', id:reservation.id, ota:otaCode, name:reservation.name,
      reason:failReason,
      dates:reservation.lend_date+'~'+reservation.return_date};
  }
}

// ============================================================
// Store / Class Filter
// ============================================================
// ★ 2026-05-10 強化: 札幌住所キーワードを大幅追加（AEU53482「北12条駅周辺」誤取込対応）
//   旧: 「札幌|千歳|北海道」のみ → 「北12条」「すすきの」「中央区」等の細かい地名で札幌判定漏れ
//   新: 「北○条」「南○条」「すすきの」「大通」「区名」「主要北海道地名」を網羅
var SAPPORO_KEYWORDS = /北海道|札幌|千歳|新千歳|小樽|函館|旭川|釧路|帯広|室蘭|苫小牧|北見|江別|登別|稚内|根室|すすきの|薄野|大通公園|札幌駅|北\d+条|南\d+条|手稲|真駒内|月寒|麻生|環状通東|福住|平岸|学園前|円山|琴似|八軒|発寒|苗穂|二十四軒|新札幌|南郷|平和通|藻岩|Hokkaido|Sapporo|Hakodate|Kushiro|Otaru/i;
var OKINAWA_KEYWORDS = /香川県|高松市|香川市|高松|香川|豊見城|宜野湾|浦添|北谷|うるま|読谷|糸満|南風原|与那原|西原|中城|北中城|嘉手納|恩納|名護|本部|今帰仁|国頭|大宜味|東村|伊江|伊是名|伊平屋|久米島|座間味|渡嘉敷|古宇利|赤嶺|首里|国際通り|Kagawa|Tomigusuku|Takamatsu|Ginowan/i;

function isTakamatsuReservation_(res) {
  var store = res._store || '';
  var rawClass = res._rawClass || '';
  var address = res._address || '';
  var delPlace = res.del_place || '';
  var colPlace = res.col_place || '';
  var places = delPlace + ' ' + colPlace;

  // 住所判定: 香川 → true, 北海道 → false（強化版）
  if (OKINAWA_KEYWORDS.test(address)) return true;
  if (SAPPORO_KEYWORDS.test(address)) return false;

  // 営業所名判定: 高松 → true, 札幌 → false
  if (store.indexOf('高松') !== -1 || store.indexOf('香川') !== -1) return true;
  if (store.indexOf('札幌') !== -1) return false;

  // お届け/回収場所判定（HP予約で_storeが空の場合に有効・強化版）
  if (OKINAWA_KEYWORDS.test(places)) return true;
  if (SAPPORO_KEYWORDS.test(places)) return false;

  // クラスコード判定: OKA/OKI → true, SPK → false
  if (/_OKA/i.test(rawClass) || /_OKI/i.test(rawClass)) return true;
  if (/_SPK/i.test(rawClass)) return false;

  // 高松専用クラス（D, A2, B2）なら高松確定
  if (res.vehicle === 'D' || res.vehicle === 'A2' || res.vehicle === 'B2') return true;

  // ★ 判定不能 → 高松として取り込む（札幌GASが除外ロジックを持つため、両方で漏れるリスクを回避）
  Logger.log('WARNING: Store undetermined, defaulting to NAHA: ' + (res.id || '?') +
    ' vehicle=' + (res.vehicle || '') + ' store=' + store + ' address=' + address +
    ' places=' + places + ' rawClass=' + rawClass);
  return true;
}

function extractVehicleClass_(rawClass) {
  if (!rawClass) return '';
  // A2/B2を先にチェック
  if (/A2/i.test(rawClass)) return 'A2';
  if (/B2/i.test(rawClass)) return 'B2';

  // クラス名 + 車種名 マッピング
  var officialMap = {
    'アルファードHクラス': 'A', 'アルファードH': 'A',
    'アルファードMクラス': 'B', 'アルファードM': 'B',
    'アルファード': 'A',
    'ワンボックスB': 'B', 'ヴェルファイア': 'B',
    'セレナHクラス': 'B', 'セレナH': 'B', 'セレナ': 'B',
    'ヴォクシー': 'B',
    'ノアHクラス': 'B', 'ノアH': 'B', 'ノア': 'B',
    'コンパクトSUV': 'C', 'ヤリスクロス': 'C', 'ライズ': 'C',
    'ワンボックスD': 'D', 'エスクァイア': 'D',
    'コンパクト': 'F', 'ヴィッツ': 'F', 'ノート': 'F', 'アクア': 'F',
    'ハイブリッド': 'H', 'プリウスアルファ': 'H', 'プリウスα': 'H', 'プリウス': 'H',
    'ハリアー': 'S'
  };
  var omKeys = Object.keys(officialMap).sort(function(a,b){return b.length-a.length;});
  for (var i = 0; i < omKeys.length; i++) {
    if (rawClass.indexOf(omKeys[i]) !== -1) return officialMap[omKeys[i]];
  }

  // _F★ や _F_ や _F(末尾) パターン — ★等の記号も許容
  var m = rawClass.match(/[_]([ABCDSFH])(?:[_★☆\s\)]|$)/i);
  if (m) return m[1].toUpperCase();
  // 先頭パターン: A_xxx
  var m2 = rawClass.match(/^([ABCDSFH])[_]/i);
  if (m2) return m2[1].toUpperCase();
  // スペース後: xxx F_xxx
  var m3 = rawClass.match(/\s([ABCDSFH])[_]/i);
  if (m3) return m3[1].toUpperCase();
  // 末尾: xxx_F
  var m4 = rawClass.match(/[_]([ABCDSFH])$/i);
  if (m4) return m4[1].toUpperCase();
  // 「Xクラス」パターン
  var m5 = rawClass.match(/([ABCDSFH])クラス/i);
  if (m5) return m5[1].toUpperCase();
  return '';
}

// ============================================================
// Field Extraction Helpers
// ============================================================
function extractField_(body, label) {
  var escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var patterns = [
    new RegExp(escaped + '[：:]\\s*(.+)', 'm'),
    new RegExp(escaped + '\\s+(.+)', 'm')
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = body.match(patterns[i]);
    if (m) { var val = m[1].trim(); val = val.replace(/^[：:]+\s*/, ''); return val; }
  }
  return '';
}

// --- 補償種類の統一判定 ---
// 優先度: フル > NOC > 免責 > なし
// 全OTA共通で使う。メール本文または補償フィールドの文字列を渡す
// ★ 2026-05-03 fix #1: 旧ロジックは「安心パック」という単語が登場するだけで NOC を返していた
//                     HP予約「レンタカー安心パック: なし」も NOC と誤判定していたため、
//                     各オプションの「: あり」を明示確認する形に修正
// ★ 2026-05-03 fix #2: 楽天形式「免責補償別 N」「NOC補償 N」のパターン認識追加
//                     両方加入(N>0) → フル / NOC補償のみ → NOC / 免責補償別のみ → 免責
//                     既存の「免責」を含む判定だけだと「免責補償別 1」だけマッチして NOC を見逃していた
function detectInsurance_(text) {
  if (!text) return 'なし';
  // フル補償（明示キーワード）
  if (/フルカバー|フル補償|安心フル|あんしんフル/i.test(text)) return 'フル';
  // ★ 楽天形式: 「免責補償別 N」「NOC補償 N」両方検出して組み合わせ判定
  // 「N」は1以上の数字（「免責補償別 0」=未加入は除外）
  var hasNocRakuten = /NOC補償\s*[1-9]/i.test(text);
  var hasCdwRakuten = /免責補償別\s*[1-9]/i.test(text);
  if (hasNocRakuten && hasCdwRakuten) return 'フル';  // 両方加入 = フル相当
  if (hasNocRakuten) return 'NOC';                    // NOCのみ
  // NOC/安心パック「あり」を明示的に確認
  if (/レンタカー安心パック[：:\s]*あり/i.test(text)) return 'NOC';
  if (/安心パック[：:\s]*あり/i.test(text)) return 'NOC';
  if (/NOC[補償]*[：:\s]*あり/i.test(text)) return 'NOC';
  if (/ノンオペレーション[補償料金]*[：:\s]*あり|ノンオペ[：:\s]*あり/i.test(text)) return 'NOC';
  // 免責「あり」を明示的に確認
  if (/免責補償制度\(CDW\)[：:\s]*あり/i.test(text)) return '免責';
  if (/免責補償[：:\s]*あり|免責補償制度[：:\s]*あり|免責[：:\s]*加入|免責補償料/i.test(text)) return '免責';
  if (hasCdwRakuten) return '免責';  // 楽天 CDW のみ
  if (/免責/.test(text) && !/免責[：:\s]*(なし|未加入|無し|加入しない|0円)/i.test(text)) return '免責';
  return 'なし';
}

// ★ 2026-04-26 複数行フィールド抽出
// extractField_ は同じ行の続きしか取れない。オプション欄など複数行に渡る項目用。
// label開始位置から「次のラベル行（・■□始まり or 空行）」までを返す。
// ★ 2026-04-27 ラベルとコロンの間に半角/全角スペース許容（楽天「・オプション/車両の特徴　：」対策）
//   旧パターン `[：:]\s*` は直結のみ許容 → 楽天/じゃらん等のパディング形式で
//   オプション欄取得が完全失敗し、ETC/シート/デリバリー全部取りこぼし。
function extractFieldMultiline_(body, label) {
  var labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var startMatch = body.match(new RegExp(labelEsc + '[\\s　]*[：:][\\s　]*'));
  if (!startMatch) return '';
  var startIdx = startMatch.index + startMatch[0].length;
  var rest = body.substring(startIdx);
  // 次のラベル位置（・/■/□で始まる行 or 空行）
  var endMatch = rest.match(/\n[\s　]*[・■□]|\n\s*\n/);
  var endIdx = endMatch ? endMatch.index : rest.length;
  return rest.substring(0, endIdx).trim();
}

function parseDateTime_(str) {
  if (!str) return { date: '', time: '' };
  // 2026年4月22日 15:00 or 2026年4月22日 15時00分
  var m = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})[時:](\d{2})/);
  if (m) {
    return {
      date: m[1] + '-' + padZero_(m[2]) + '-' + padZero_(m[3]),
      time: padZero_(m[4]) + ':' + m[5]
    };
  }
  // 2026-04-22 15:00
  m = str.match(/(\d{4})-(\d{1,2})-(\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (m) {
    return {
      date: m[1] + '-' + padZero_(m[2]) + '-' + padZero_(m[3]),
      time: padZero_(m[4]) + ':' + m[5]
    };
  }
  // 2026/06/20 (土) 09:55 — エアトリプラスDP形式
  m = str.match(/(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (m) {
    return {
      date: m[1] + '-' + padZero_(m[2]) + '-' + padZero_(m[3]),
      time: padZero_(m[4]) + ':' + m[5]
    };
  }
  return { date: '', time: '' };
}

/**
 * 車両名が指定車種に厳密マッチするか判定
 * 「プリウス」→「プリウス①」OK、「プリウスα①」NG
 * 「プリウスα」→「プリウスα①」OK、「プリウス①」NG
 * 「アルファード」→「アルファード①」OK、「アルファードM①」NG
 */
// ★ 2026-04-25 車種エイリアス辞書（HP予約フォーム表記揺れ対応）
// キー = DB側の車両名表記（正） / 値 = 同義として扱う表記（HP予約等で出現する変種）
// 追加方針: 新たな表記揺れが見つかったらここに追加するだけで isModelMatch_ が対応
var MODEL_ALIASES = {
  'プリウスα':   ['プリウスアルファ'],
  'アルファード': ['ALPHARD', 'アルファ-ド', 'アルファ―ド'],
  'アルファードM': ['ALPHARD M', 'アルファードm'],
  'ヴェルファイア': ['VELLFIRE', 'ベルファイア'],
  'セレナ':      ['SERENA'],
  'ノア':        ['NOAH', 'ノアｈ'],
  'ヴォクシー':   ['VOXY', 'ボクシー'],
  'ハリアー':    ['HARRIER'],
  'プリウス':    ['PRIUS'],
  'アクア':      ['AQUA'],
  'ヤリスクロス': ['YARIS CROSS', 'ヤリスX', 'ヤリスクロスHV'],
  'ライズ':      ['RAIZE'],
  'ヴィッツ':    ['VITZ', 'ビッツ'],
  'ノート':      ['NOTE']
};

/**
 * 車種名を正規化（エイリアス → 正規表記）
 * DB側の車両名表記（マスター）と HP予約フォームの表記揺れを吸収
 */
function normalizeModelName_(s) {
  if (!s) return '';
  var result = String(s);
  for (var canonical in MODEL_ALIASES) {
    var aliases = MODEL_ALIASES[canonical];
    for (var i = 0; i < aliases.length; i++) {
      // エスケープしてグローバル置換
      var pattern = aliases[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(pattern, 'g'), canonical);
    }
  }
  return result;
}

function isModelMatch_(vehicleName, preferredModel) {
  // ★ 2026-04-25 fix: エイリアス辞書を使った同義表記の正規化
  // DB側「プリウスα①」、HP予約「プリウスアルファ」のような表記揺れに対応
  // → 旧実装は indexOf でマッチ失敗 → HP予約「車種指定優先」ルールにより未配車になる致命バグ
  vehicleName = normalizeModelName_(vehicleName);
  preferredModel = normalizeModelName_(preferredModel);
  var idx = vehicleName.indexOf(preferredModel);
  if (idx === -1) return false;
  // マッチ位置の直後の文字を確認
  var afterChar = vehicleName.charAt(idx + preferredModel.length);
  // 直後が空 or 数字 or 丸数字(①-⑳) or スペース → 正しいマッチ
  // 直後がアルファベットやカタカナ → 別車種（例: プリウス→プリウスα、アルファード→アルファードM）
  if (!afterChar) return true;  // 完全一致
  if (/[\d①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳\s\/]/.test(afterChar)) return true;
  return false;
}

function padZero_(n) { return ('0' + parseInt(n, 10)).slice(-2); }
// ★ 2026-05-06 fix: ¥/￥/全角空白等の装飾文字が parseInt の先頭に残ると NaN→0 になる
//    旧実装は [,，円\s] のみ除去 → 「¥32,350円」→「¥32350」→ NaN
//    新実装は数字とマイナス以外を全除去（先頭マイナス保持）
//    バグ事例: RC32461165750981411 (price=350 / 正解32350)
//             RC62461161767839218 (price=449 / 正解11610)
function parsePrice_(str) {
  if (!str) return 0;
  // 先頭にマイナスがあれば保持。それ以外は数字以外を全除去
  var s = String(str);
  var negative = /^[\s　]*-/.test(s);
  var digits = s.replace(/[^\d]/g, '');
  if (!digits) return 0;
  var n = parseInt(digits, 10);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}
function cleanPhone_(str) { if (!str) return ''; return str.replace(/[^\d-]/g, '').trim(); }
function cleanName_(str) { if (!str) return ''; return str.replace(/\s*様\s*$/, '').trim(); }

/**
 * HP予約のクラス行から実際の車種名を抽出
 * 「アルファードHクラス(TOYOTA)」→「アルファード」
 * 「コンパクト(TOYOTA)」→ ''（クラス名であり車種名ではない）
 * 「ハリアー(TOYOTA)」→「ハリアー」
 */
function extractModelName_(classLine) {
  if (!classLine) return '';
  // 括弧・メーカー名を除去（全角・半角両方対応）
  var cleaned = classLine.replace(/[（(].*?[）)]/g, '').replace(/[_](ハイブリッド|HYBRID|hybrid|ガソリン|ディーゼル)$/,'').trim();
  // クラス名パターン → 車種名ではないので空を返す
  var classPatterns = [
    /^アルファード[HM]クラス/, /^(ノア|セレナ|ヴォクシー)[HM]クラス/,  // ★M クラスも対応（ノアMクラス/セレナMクラス）
    /^ワンボックス[BD]2?/, /^コンパクトSUV/,
    /^コンパクト$/, /^ハイブリッド$/, /^[ABCDSFH]2?クラス$/
  ];
  for (var i = 0; i < classPatterns.length; i++) {
    if (classPatterns[i].test(cleaned)) {
      // クラス名の中に車種名が含まれるケースを抽出
      // 例: 「アルファードHクラス」→「アルファード」, 「アルファードMクラス」→「アルファードM」
      // 例: 「ノアMクラス」→「ノアM」, 「ノアHクラス」→「ノアH」
      var modelMap = {
        'アルファードM': 'アルファードM',  // ★Bクラスのアルファード（Mを先にマッチ）
        'アルファード': 'アルファード', 'ヴェルファイア': 'ヴェルファイア',
        // ★ M系（ガソリン）/H系（ハイブリッド）両対応。長い名前を先にマッチ
        'セレナM': 'セレナM', 'セレナH': 'セレナH',
        'ノアM': 'ノアM', 'ノアH': 'ノアH',
        'ヴォクシー': 'ヴォクシー',
        'ヤリスクロス': 'ヤリスクロス', 'ライズ': 'ライズ',
        'エスクァイア': 'エスクァイア',
        'ヴィッツ': 'ヴィッツ', 'ノート': 'ノート', 'アクア': 'アクア',
        'プリウスα': 'プリウスα', 'プリウスアルファ': 'プリウスアルファ', 'プリウス': 'プリウス',
        'ハリアー': 'ハリアー'
      };
      // 長い名前から優先マッチ
      var mKeys = Object.keys(modelMap).sort(function(a,b){return b.length-a.length;});
      for (var j = 0; j < mKeys.length; j++) {
        if (cleaned.indexOf(mKeys[j]) !== -1) return modelMap[mKeys[j]];
      }
      return ''; // クラス名だけで車種名なし（例: 「コンパクト」「ハイブリッド」）
    }
  }
  // ★ 再発防止: 「車種名クラス」→「クラス」を除去して車種名を返す
  // 例: 「ノアHクラス」→「ノアH」、「ステップワゴンHクラス」→「ステップワゴンH」
  // 単なる「Hクラス」「Bクラス」等（カタカナなし）は除外
  if (/クラス$/.test(cleaned)) {
    var stripped = cleaned.replace(/クラス$/, '');
    if (stripped.length >= 2 && /[ァ-ヴー]/.test(stripped)) return stripped;
  }
  // クラス名パターンに該当しない → そのまま車種名として返す（例: 「ハリアー」）
  return cleaned;
}

// ============================================================
// Parsers
// ============================================================

// ★ OTAメール「オプション」欄から デリバリー（お届け／回収）を検出
// 全OTA共通フォーマット: 「デリバリー（お届け）」「デリバリー（回収）」（全角括弧）
// 半角括弧表記にも対応。「デリバリーサービス」等の一般語にもマッチしないよう
// 「（お届け／回収）」を必須としている。
// 注意: extractField_ は1行しか拾わないため optionsStr では「オプション：」直後の
// 1行目しか含まれない → ここでは body 全体を渡して全文検索する。
// 検出時は del_place / col_place にプレースホルダ「★OTAデリバリー希望（場所未確定）」を
// 埋め、APP側の デリバリ判定（isDeliveryPlace）が拾えるようにする。
function detectOtaDelivery_(text) {
  var s = String(text || '');
  var hasDel = /デリバリー\s*[（(]\s*お届け\s*[）)]/.test(s);
  var hasCol = /デリバリー\s*[（(]\s*回収\s*[）)]/.test(s);
  return { has_del: hasDel, has_col: hasCol };
}

var OTA_DELIVERY_PLACEHOLDER = '★OTAデリバリー希望（場所未確定）';

// ★ 2026-05-08 全OTA共通: USB 数抽出ヘルパー
// メール本文の「オプション」欄から USB 数を抽出（USBポート/USB充電器/USB-Cポート 等の表記揺れ対応）
// 0個も「明示的に0」として返す（メール記載があれば最低0、なければ0）
// 例:
//   "USBポート: 0 個"        → 0
//   "USB充電器 x 2"          → 2
//   "USB-Cポート×1"          → 1
//   "USBあり"                → 1
//   "オプションなし"          → 0
function detectUsbCount_(text) {
  if (!text) return 0;
  var s = String(text);
  // パターン1: 「USB...: N 個/台/本」（HP形式・0も拾う）
  var m1 = s.match(/USB[^\n]*?[：:]\s*(\d+)\s*(?:個|台|本)?/);
  if (m1) return parseInt(m1[1], 10) || 0;
  // パターン2: 「USB... × N」「USB... x N」（RC/じゃらん/skyticket形式）
  var m2 = s.match(/USB[^\n]*?[xX×]\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10) || 0;
  // パターン3: 「USB... N 個/台/本」
  var m3 = s.match(/USB[^\n0-9]*(\d+)\s*(?:個|台|本)/);
  if (m3) return parseInt(m3[1], 10) || 0;
  // パターン4: 「USB... 数字」（末尾近く・楽天形式）
  var m4 = s.match(/USB[^\n]*?\s+(\d+)\b/);
  if (m4) return parseInt(m4[1], 10) || 0;
  // パターン5: USB の記載のみ（数字なし）→ 1扱い
  if (/USB/i.test(s)) return 1;
  return 0;
}

// ============================================================
// 便名 正規化ヘルパー (2026-05-02 追加)
// ============================================================
// メールパース時に extractField_ の戻り値が便名以外のノイズを含むことがある:
//   - エアトリ「出発便: / ご確認の程を…」 → 後続のテキストを拾う
//   - 楽天「航空便利用なし」 → 顧客が便名なしを選択
//   - skyticket「ANA995 / ■お問い合せ」 → boilerplate混入
//   - HP「It230」「jx302」 → 大文字小文字の揺れ
//   - 「JAL」「EHD2DC」 → 不完全入力
//
// この関数で「2-3文字英 + 1-5桁数字」のフライト番号パターンだけ抽出して正規化。
// 抽出できない/なしの場合は空文字を返す。
//
// 例:
//   "ANA995 / ■お問い合せ"          → "ANA995"
//   "出発便: / ご確認の程を…"        → ""
//   "航空便利用なし"                 → ""
//   "MM501 / MM504"                  → "MM501 / MM504"
//   "It230"                          → "IT230"
//   "ANA995 / ANA994"                → "ANA995 / ANA994"
//   "JAL"                            → ""（数字なし不完全）
// ============================================================
// ★ 便名が「便利用なし/未指定」かを判定するヘルパー
// 来店判定（送迎なし＋デリバリーなし＝来店）で使用
// 全OTA共通: 楽天「航空便利用なし」 / じゃらん・skyticket・エアトリ 到着便+出発便両方なし
function isNoFlightSpecified_(s) {
  if (!s) return true;  // 空 = 便名なし扱い
  var str = String(s).trim();
  if (!str) return true;
  // 明示的に「なし」を表す文字列
  if (/^航空便利用なし$|^なし$|^無し$|^未定$|^-+$|^N\/A$|^空$/i.test(str)) return true;
  // 「便名なし」を含むパターン
  if (/航空便利用なし|便利用なし/.test(str)) return true;
  return false;
}

function cleanFlightNumber_(s) {
  if (!s) return '';
  var str = String(s).trim();
  if (!str) return '';
  // 明示的になしを表現する文字列を弾く
  if (/^航空便利用なし$|^なし$|^無し$|^未定$|^-+$|^N\/A$/i.test(str)) return '';
  // 2-3文字の英字（大文字小文字混在可）+ 1-5桁の数字 のパターンを抽出
  // 楽天/JAL等の3文字エアラインコードも許容（IATA は 2文字、ICAO は 3文字、便名は数字 1-5桁）
  var matches = str.match(/[A-Z]{2,3}\s*[0-9]{1,5}/gi);
  if (!matches || !matches.length) return '';
  // 重複排除しつつ大文字化
  var seen = {};
  var result = [];
  matches.forEach(function(m) {
    var norm = m.replace(/\s+/g, '').toUpperCase();
    if (!seen[norm]) { seen[norm] = true; result.push(norm); }
  });
  return result.join(' / ');
}

// ============================================================
// Visit/Return Type 推論ヘルパー (2026-04-30 確立)
// ============================================================
// del_place / col_place の値から visit_type / return_type を推論する
//
// ★ 値の体系（オーナー確定 2026-04-30）:
//   基本運用       : PUB / BDB（バス送迎） + DEL / COL（デリバリーOP）
//   例外運用       : PU / BD（ハイエース送迎）— バスに人数的に乗れない場合の手動切替のみ
//   手動値（保護）   : 来店 / 返却（=送迎を希望しない顧客 / オンライン判定不可）
//
// ★ 自動推論で出すのは PUB/BDB と DEL/COL のみ。
//   PU/BD（ハイエース）は手動修正でしか発生しない例外運用なので、自動推論では出さない。
//   既存値が PU/BD の場合は isAutoVisitReturnValue_ で保護対象とする。
//
// 推論ルール:
//   送迎キーワード（送迎バス/14番のりば/11番/レンタカー送迎バス/高松空港/空港）→ PUB / BDB
//   ホテル/住所/施設名/OTAデリバリー → DEL / COL
//   来店/店舗/店頭/ヤード/営業所/BUDDICA TOURING → 空（手動入力で確定させる）
// ============================================================
function derivePlaceType_(place, kind) {
  if (!place) return '';
  var s = String(place).trim();
  if (!s) return '';
  // ★ 「来店」相当 → 推論しない（オンライン判定不可・最優先で除外）
  //   送迎を希望しない自力来店顧客 = 手動入力で確定させる
  if (/来店|店舗|店頭|ヤード|営業所|BUDDICA TOURING/.test(s)) {
    return '';
  }
  // 空港送迎 = バスが基本 → PUB / BDB
  // バス指定（送迎バス/14番のりば/11番/レンタカー送迎バス）と
  // 空港単独（高松空港/空港）はいずれもバス前提で推論する。
  // ハイエース運用（PU/BD）はバス満員時の手動切替のみ → 自動推論では出さない。
  if (/送迎バス|14番のりば|11番|レンタカー送迎バス|高松空港|空港/.test(s)) {
    return kind === 'return' ? 'BDB' : 'PUB';
  }
  // OTA デリバリー プレースホルダ → DEL/COL で確定
  if (s.indexOf('★OTAデリバリー希望') === 0) {
    return kind === 'return' ? 'COL' : 'DEL';
  }
  // それ以外 = ホテル/住所/施設名等 → DEL/COL
  return kind === 'return' ? 'COL' : 'DEL';
}

// reservation オブジェクトに visit_type / return_type を埋める（INSERT時用）
// 既存値（パーサーで設定済みの 'DEL' 等）があれば触らない
// 空のときのみ del_place / col_place から推論
// ★ 「来店」「返却」は手動入力値として保護される（既存値あり扱い）
//
// ★ 2026-05-02 fix: del_place が空でも del_flight (便名) があれば PUB/BDB と推論する
//   旧ロジックは del_place のキーワード判定だけだったため、OTA予約 (J/R/S/O) で
//   「お届け場所」フィールドが無いメール由来の予約は visit_type が空のままになり、
//   APP データタブ「種別」列で空白表示されていた。便名がある = 空港送迎希望なので
//   PUB/BDB を補完する。
function inferVisitReturnType_(reservation) {
  if (!reservation.visit_type || reservation.visit_type === '') {
    var v = derivePlaceType_(reservation.del_place, 'visit');
    // del_place で推論不可 + del_flight (便名) あり → PUB（空港送迎希望と推定）
    if (!v && reservation.flight) {
      var flight = cleanFlightNumber_(reservation.flight);
      if (flight) v = 'PUB';
    }
    if (v) reservation.visit_type = v;
  }
  if (!reservation.return_type || reservation.return_type === '') {
    var r = derivePlaceType_(reservation.col_place, 'return');
    // col_place で推論不可 + del_flight があれば対の BDB を推定
    //   (返却便は col_flight にあれば優先、無ければ del_flight ベースで推定)
    if (!r) {
      var rFlight = cleanFlightNumber_(reservation.col_flight || reservation.flight || '');
      if (rFlight) r = 'BDB';
    }
    if (r) reservation.return_type = r;
  }
  return reservation;
}

// 「来店」「返却」「PU」「BD」は手動入力扱いで自動補正対象外
//   - 来店 / 返却 = 送迎を希望しない顧客（オンライン判定不可）
//   - PU / BD = バス満員時のハイエース手動切替（自動推論では出さない）
// 自動推論で置けるのは空 or 自動系（DEL/COL/PUB/BDB）+ 旧表記 PU(バス)/BD(バス) のみ
function isAutoVisitReturnValue_(v) {
  if (!v || v === '') return true;
  return ['DEL', 'COL', 'PUB', 'BDB', 'PU(バス)', 'BD(バス)'].indexOf(v) !== -1;
}

// 単体テスト関数（GASエディタで手動実行）
function testDerivePlaceType() {
  var cases = [
    // [place, kind, expected]
    ['', 'visit', ''],
    [null, 'visit', ''],
    ['高松空港', 'visit', 'PUB'],            // 空港送迎=バスが基本
    ['高松空港', 'return', 'BDB'],
    ['高松空港', 'visit', 'PUB'],            // 空港キーワード
    ['高松空港/レンタカー送迎バス14番のりば', 'visit', 'PUB'],
    ['高松空港/レンタカー送迎バス14番のりば', 'return', 'BDB'],
    ['送迎バス11番', 'visit', 'PUB'],
    ['レンタカー送迎バス11番のりば', 'return', 'BDB'],
    // ★「○○空港店」も「空港」キーワードで PUB/BDB（オーナー判断 B案 / 来店は手動のみ）
    ['BUDDICA TOURING 高松店', 'visit', 'PUB'],
    ['BUDDICA TOURING 高松店', 'return', 'BDB'],
    ['ホテルJALシティ高松', 'visit', 'DEL'],
    ['香川県高松市旭町123', 'visit', 'DEL'],
    ['香川県高松市旭町123', 'return', 'COL'],
    ['来店', 'visit', ''],
    ['店頭', 'visit', ''],
    ['ヤード', 'visit', ''],
    ['BUDDICA TOURING', 'visit', ''],
    ['★OTAデリバリー希望（場所未確定）', 'visit', 'DEL'],
    ['★OTAデリバリー希望（場所未確定）', 'return', 'COL']
  ];
  var pass = 0, fail = 0;
  cases.forEach(function(c) {
    var actual = derivePlaceType_(c[0], c[1]);
    if (actual === c[2]) {
      pass++;
      Logger.log('✅ ' + JSON.stringify(c[0]) + ' (' + c[1] + ') → "' + actual + '"');
    } else {
      fail++;
      Logger.log('❌ ' + JSON.stringify(c[0]) + ' (' + c[1] + ') → "' + actual + '" (expected: "' + c[2] + '")');
    }
  });
  Logger.log('=== ' + pass + ' pass / ' + fail + ' fail ===');
}

function parseJalan_(body) {
  var id = extractField_(body, '予約番号');
  if (!id) return null;
  var name = cleanName_(extractField_(body, '予約者氏名'));
  var nameKana = cleanName_(extractField_(body, '運転者氏名カナ'));
  var tel = cleanPhone_(extractField_(body, '運転者電話番号'));
  var mail = extractField_(body, '予約者メールアドレス');
  var lend = parseDateTime_(extractField_(body, '貸出日時'));
  var ret  = parseDateTime_(extractField_(body, '返却日時'));
  var store = extractField_(body, '貸出営業所');
  var rawClass = extractField_(body, '車両クラス');
  var vehicleClass = extractVehicleClass_(rawClass);
  if (!vehicleClass) {
    var plan = extractField_(body, '料金プラン');
    vehicleClass = extractVehicleClass_(plan);
    if (!rawClass) rawClass = plan;
  }
  var insuranceStr = extractField_(body, '補償（任意加入）');
  var insurance = detectInsurance_(insuranceStr);
  var peopleStr = extractField_(body, '乗車人数');
  var people = 0;
  var pM = peopleStr.match(/大人\s*(\d+)/);
  if (pM) people += parseInt(pM[1], 10);
  // ★ 修正: /子供.*?(\d+)/ は「子供（12歳未満）0人」の12を誤パースする
  //    → 閉じカッコ [）)] の後の数字を取る
  var cM = peopleStr.match(/子供.*?[）)]\s*(\d+)/);
  if (cM) people += parseInt(cM[1], 10);
  // ★ 再発防止: people は最大8人にクランプ（CSV/メールの異常値侵入対策）
  if (people > 8) { Logger.log('[PEOPLE-CLAMP] J id=' + id + ' raw=' + people + ' → 8'); people = 8; }
  if (people < 0) people = 0;
  // ★ 料金内訳パース（基本料金/オプション/補償/割引）
  var basePriceJ = parsePrice_(extractField_(body, '基本料金合計'));
  var optionPriceJ = parsePrice_(extractField_(body, 'オプション料金'));
  var insurancePriceJ = parsePrice_(extractField_(body, '補償（任意加入）料金'));
  var dropOffFeeJ = parsePrice_(extractField_(body, '乗捨料金'));
  var nightFeeJ = parsePrice_(extractField_(body, '深夜手数料'));
  var couponJ = parsePrice_(extractField_(body, '利用クーポン'));
  var pointStrJ = extractField_(body, '利用ポイント');
  var pointJ = 0;
  var pointMatchJ = (pointStrJ || '').match(/(\d[\d,]*)/);
  if (pointMatchJ) pointJ = parsePrice_(pointMatchJ[1]);
  var discountJ = couponJ + pointJ;
  var base_price_j = basePriceJ;
  var option_price_j = optionPriceJ + insurancePriceJ + dropOffFeeJ + nightFeeJ;
  // ★ 利用者への請求額（クーポン・ポイント差引後）を優先。なければ合計金額
  var billingPrice = parsePrice_(extractField_(body, '利用者への請求額'));
  var price = billingPrice > 0 ? billingPrice : parsePrice_(extractField_(body, '合計金額'));
  var arrFlight = extractField_(body, '到着便');
  var depFlight = extractField_(body, '出発便');
  var flight = [arrFlight, depFlight].filter(Boolean).join(' / ');
  // ★ オプション抽出（B/C/J）— じゃらん形式: 「チャイルドシートx1」「ジュニアシートx1」
  // 2026-04-26 複数行版（旧 extractField_ は1行のみ → 複数オプション取りこぼし）
  var optionsStrJ = extractFieldMultiline_(body, 'オプション') || '';
  var optBJ = 0, optCJ = 0, optJJ = 0;
  var bMJ = optionsStrJ.match(/ベビーシート\s*[xX×]?\s*(\d*)/);
  if (bMJ) optBJ = parseInt(bMJ[1], 10) || 1;
  var cMJ = optionsStrJ.match(/チャイルドシート\s*[xX×]?\s*(\d*)/);
  if (cMJ) optCJ = parseInt(cMJ[1], 10) || 1;
  var jMJ = optionsStrJ.match(/ジュニアシート\s*[xX×]?\s*(\d*)/);
  if (jMJ) optJJ = parseInt(jMJ[1], 10) || 1;
  // ★ 2026-05-08 USB 数抽出（全OTA共通仕様）
  var optUsbJ = detectUsbCount_(optionsStrJ);
  // ★ デリバリーオプション検出（じゃらん） — オプション欄のみで判定（boilerplate誤検知防止）
  var delJ = detectOtaDelivery_(optionsStrJ);
  // ★ 2026-05-02 オーナー再再確定: OTAでも「送迎なし＋デリバリーなし＝来店/返却」を許可
  //   到着便なし → 来店、出発便なし → 返却、デリバリーあり → DEL/COL
  var noArrFlightJ = isNoFlightSpecified_(arrFlight);
  var noDepFlightJ = isNoFlightSpecified_(depFlight);
  var delPlaceJ = delJ.has_del ? '場所未確定' : '';
  var colPlaceJ = delJ.has_col ? '場所未確定' : '';
  var visitTypeJ, returnTypeJ;
  if (delJ.has_del) visitTypeJ = 'DEL';
  else if (noArrFlightJ) visitTypeJ = '来店';
  else visitTypeJ = 'PUB';
  if (delJ.has_col) returnTypeJ = 'COL';
  else if (noDepFlightJ) returnTypeJ = '返却';
  else returnTypeJ = 'BDB';
  return {
    id: id, ota: 'J', name: nameKana || name,
    lend_date: lend.date, lend_time: lend.time,
    return_date: ret.date, return_time: ret.time,
    vehicle: vehicleClass, people: people, insurance: insurance,
    price: price, base_price: base_price_j, option_price: option_price_j, discount: discountJ,
    status: '確定', tel: tel, mail: mail,
    flight: flight, visit_type: visitTypeJ, return_type: returnTypeJ, del_place: delPlaceJ, col_place: colPlaceJ,
    opt_b: optBJ, opt_c: optCJ, opt_j: optJJ, opt_usb: optUsbJ,
    _store: store, _rawClass: rawClass
  };
}

function parseRakuten_(body) {
  var id = extractField_(body, '・予約番号');
  if (!id) return null;
  var nameKana = cleanName_(extractField_(body, '・予約者氏名（カナ）'));
  // ★ 2026-05-02: カナが「ーー」「-」等のダミー値の場合は予約者氏名（漢字）にフォールバック
  if (!nameKana || /^[ー\-\s]+$/.test(nameKana)) {
    var nameKanji = cleanName_(extractField_(body, '・予約者氏名'));
    if (nameKanji && !/^[ー\-\s]+$/.test(nameKanji)) nameKana = nameKanji;
  }
  // 利用者氏名 fallback もチェック
  if (!nameKana || /^[ー\-\s]+$/.test(nameKana)) {
    var nameUser = cleanName_(extractField_(body, '・利用者氏名（カナ）')) || cleanName_(extractField_(body, '・利用者氏名'));
    if (nameUser && !/^[ー\-\s]+$/.test(nameUser)) nameKana = nameUser;
  }
  var lend = parseDateTime_(extractField_(body, '□貸出日時'));
  var ret  = parseDateTime_(extractField_(body, '□返却日時'));
  var store = extractField_(body, '・貸渡営業所名');
  var detailClass = extractField_(body, '・詳細車両クラス');
  var rawClass = detailClass;
  var vehicleClass = extractVehicleClass_(detailClass);
  if (!vehicleClass) {
    var planMatch = detailClass.match(/プラン[_]([ABCDSFH])/i);
    if (planMatch) {
      vehicleClass = planMatch[1].toUpperCase();
      rawClass = planMatch[1] + '_OKA';
    }
  }
  // ★ 2026-04-26 複数行版で取得（旧 extractField_ は1行のみ → ETC/シート/デリバリー取りこぼし）
  var optionsStr = extractFieldMultiline_(body, '・オプション/車両の特徴');
  var insurance = detectInsurance_(optionsStr);
  // ★ 料金内訳パース（楽天）
  var basePriceR = parsePrice_(extractField_(body, '・基本料金'));
  if (!basePriceR) basePriceR = parsePrice_(extractField_(body, '基本料金'));
  var insurancePriceR = parsePrice_(extractField_(body, '・免責補償料金'));
  if (!insurancePriceR) insurancePriceR = parsePrice_(extractField_(body, '免責補償料金'));
  var optionPriceR = parsePrice_(extractField_(body, '・オプション料金'));
  if (!optionPriceR) optionPriceR = parsePrice_(extractField_(body, 'オプション料金'));
  // ★ クーポン割引
  //   事業者クーポン = 弊社負担 → 売上から差し引く（discount + price両方に反映）
  //   楽天クーポン / 楽天ポイント = 楽天負担 → 売上から引かない（後精算で弊社収入になる）
  //   オーナー方針確定 2026-05-07:
  //     計上売上 = 合計 − 事業者クーポン（弊社負担分のみ差引）
  //     楽天クーポン・楽天ポイントは楽天が後精算するため売上に含める
  //   検算例:
  //     RC32461165750981411: 42,350 − 10,000 = 32,350 (ポイント32,000は楽天負担→計上に含む)
  //     RC42461166775818704: 30,900 − 9,270  = 21,630
  //     RC52461167082270259: 13,950 − 1,395  = 12,555
  //     RC62461161767839218: 12,900 − 1,290  = 11,610 (楽天クーポン1,161は除外)
  var couponR = parsePrice_(extractField_(body, '（レンタカー事業者クーポン利用）'));
  var discountR = couponR; // 事業者クーポンのみ
  var totalR = parsePrice_(extractField_(body, '（合計）'));
  var billingR = parsePrice_(extractField_(body, '（差引支払金額）'));
  // 計上売上 = 合計 − 事業者クーポン（楽天クーポン・楽天ポイントは売上に含める）
  var price = totalR > 0 ? (totalR - couponR) : billingR;
  var option_price_r = insurancePriceR + optionPriceR;
  // base_price が取れない場合のフォールバック（合計-事業者クーポン-オプション）
  var base_price_r = basePriceR > 0 ? basePriceR : Math.max(0, totalR - couponR - option_price_r);
  var optB = 0, optC = 0, optJ = 0;
  var bMatch = optionsStr.match(/ベビーシート\s*(\d*)/);
  if (bMatch) optB = parseInt(bMatch[1], 10) || 1;
  var cMatch = optionsStr.match(/チャイルドシート\s*(\d*)/);
  if (cMatch) optC = parseInt(cMatch[1], 10) || 1;
  var jMatch = optionsStr.match(/ジュニアシート\s*(\d*)/);
  if (jMatch) optJ = parseInt(jMatch[1], 10) || 1;
  // ★ 2026-05-08 USB 数抽出
  var optUsbR = detectUsbCount_(optionsStr);
  // ★ デリバリーオプション検出（楽天） — オプション欄のみで判定
  // 旧バグ: body全体検索 → 「(2) デリバリー（お届け）オプション」boilerplateを誤検知
  var delR = detectOtaDelivery_(optionsStr);
  // ★ 2026-05-02: 便名抽出を visit_type 判定より前に移動
  // 楽天は「ご利用便名」フィールド（じゃらん/エアトリの「到着便/出発便」と別形式）
  // オーナー方針 C案: 顧客入力をそのまま保持（「航空便利用なし」等もそのまま表示）
  var flightR = extractField_(body, '・ご利用便名') || extractField_(body, 'ご利用便名') || '';
  // ★ 2026-05-02 オーナー再再確定: OTAでも「送迎なし＋デリバリーなし＝来店/返却」を許可
  //   楽天「航空便利用なし」 = 顧客が空港送迎不要を明示 → 来店/返却
  //   オプションにデリバリーなし = デリバリー不要
  //   この2条件揃ったときのみ来店/返却出力
  var noFlightR = isNoFlightSpecified_(flightR);
  var delPlaceR = delR.has_del ? '場所未確定' : '';
  var colPlaceR = delR.has_col ? '場所未確定' : '';
  var visitTypeR, returnTypeR;
  if (delR.has_del) visitTypeR = 'DEL';
  else if (noFlightR) visitTypeR = '来店';   // 便名なし→自力来店
  else visitTypeR = 'PUB';                   // 便名あり→空港バス送迎
  if (delR.has_col) returnTypeR = 'COL';
  else if (noFlightR) returnTypeR = '返却';
  else returnTypeR = 'BDB';
  return {
    id: id, ota: 'R', name: nameKana,
    lend_date: lend.date, lend_time: lend.time,
    return_date: ret.date, return_time: ret.time,
    vehicle: vehicleClass, people: 0, insurance: insurance,
    price: price, base_price: base_price_r, option_price: option_price_r, discount: discountR,
    status: '確定', tel: '', mail: '',
    flight: flightR, visit_type: visitTypeR, return_type: returnTypeR, del_place: delPlaceR, col_place: colPlaceR,
    opt_b: optB, opt_c: optC, opt_j: optJ, opt_usb: optUsbR,
    _store: store, _rawClass: rawClass
  };
}

function parseSkyticket_(body) {
  var id = extractField_(body, '予約番号');
  if (!id) return null;
  var nameKana = cleanName_(extractField_(body, 'ご利用者名'));
  var tel = cleanPhone_(extractField_(body, '電話番号'));
  var mail = extractField_(body, 'メールアドレス');
  var lend = parseDateTime_(extractField_(body, '受取日時'));
  var ret  = parseDateTime_(extractField_(body, '返却日時'));
  var store = extractField_(body, '受取店舗');
  var rawClass = extractField_(body, '車両タイプ / クラス');
  if (!rawClass) rawClass = extractField_(body, 'プラン名');
  var vehicleClass = extractVehicleClass_(rawClass);
  var peopleStr = extractField_(body, 'ご利用人数');
  var people = 0;
  var pM = peopleStr.match(/大人\s*(\d+)/);
  if (pM) people += parseInt(pM[1], 10);
  // ★ 再発防止: people は最大8人にクランプ
  if (people > 8) { Logger.log('[PEOPLE-CLAMP] S id=' + id + ' raw=' + people + ' → 8'); people = 8; }
  if (people < 0) people = 0;
  var totalPrice = parsePrice_(extractField_(body, '合計料金'));
  var insurancePriceStr = extractField_(body, '免責補償料金');
  var insurancePrice = parsePrice_(insurancePriceStr);
  var insurance = detectInsurance_(body);
  if (insurance === 'なし' && insurancePrice > 0) insurance = '免責';
  // ★ 料金内訳パース（skyticket）
  var basePriceS = parsePrice_(extractField_(body, '基本料金'));
  var optionPriceS = parsePrice_(extractField_(body, 'オプション料金'));
  var base_price_s = basePriceS;
  var option_price_s = insurancePrice + optionPriceS;
  // ★ オプション抽出（B/C/J）— skyticket形式 / 2026-04-26 複数行版
  var optionsStrS = extractFieldMultiline_(body, 'オプション項目') || extractFieldMultiline_(body, 'オプション') || '';
  var optBS = 0, optCS = 0, optJS = 0;
  var bMS = optionsStrS.match(/ベビーシート\s*[xX×]?\s*(\d*)/);
  if (bMS) optBS = parseInt(bMS[1], 10) || 1;
  var cMS = optionsStrS.match(/チャイルドシート\s*[xX×]?\s*(\d*)/);
  if (cMS) optCS = parseInt(cMS[1], 10) || 1;
  var jMS = optionsStrS.match(/ジュニアシート\s*[xX×]?\s*(\d*)/);
  if (jMS) optJS = parseInt(jMS[1], 10) || 1;
  // ★ 2026-05-08 USB 数抽出
  var optUsbS = detectUsbCount_(optionsStrS);
  // ★ デリバリーオプション検出（skyticket） — オプション欄のみ（boilerplate誤検知防止）
  var delS = detectOtaDelivery_(optionsStrS);
  // ★ 2026-05-02: 便名抽出（skyticket形式 ■航空便情報「到着便」「出発便」）
  // ★ オーナー方針 C案: 顧客入力をそのまま保持
  var arrFlightS = extractField_(body, '到着便');
  var depFlightS = extractField_(body, '出発便');
  var flightS = [arrFlightS, depFlightS].filter(Boolean).join(' / ');
  // ★ 2026-05-02 オーナー再再確定: OTAでも「送迎なし＋デリバリーなし＝来店/返却」を許可
  var noArrFlightS = isNoFlightSpecified_(arrFlightS);
  var noDepFlightS = isNoFlightSpecified_(depFlightS);
  var delPlaceS = delS.has_del ? '場所未確定' : '';
  var colPlaceS = delS.has_col ? '場所未確定' : '';
  var visitTypeS, returnTypeS;
  if (delS.has_del) visitTypeS = 'DEL';
  else if (noArrFlightS) visitTypeS = '来店';
  else visitTypeS = 'PUB';
  if (delS.has_col) returnTypeS = 'COL';
  else if (noDepFlightS) returnTypeS = '返却';
  else returnTypeS = 'BDB';
  return {
    id: id, ota: 'S', name: nameKana,
    lend_date: lend.date, lend_time: lend.time,
    return_date: ret.date, return_time: ret.time,
    vehicle: vehicleClass, people: people, insurance: insurance,
    price: totalPrice, base_price: base_price_s, option_price: option_price_s, discount: 0,
    status: '確定', tel: tel, mail: mail,
    flight: flightS, visit_type: visitTypeS, return_type: returnTypeS, del_place: delPlaceS, col_place: colPlaceS,
    opt_b: optBS, opt_c: optCS, opt_j: optJS, opt_usb: optUsbS,
    _store: store, _rawClass: rawClass
  };
}

function parseAirtrip_(body) {
  var id = extractField_(body, '予約番号');
  if (!id) return null;
  var nameKana = cleanName_(extractField_(body, '予約者名'));
  var tel = cleanPhone_(extractField_(body, '電話番号'));
  var mail = extractField_(body, 'メールアドレス');
  var lend = parseDateTime_(extractField_(body, '貸出日時'));
  var ret  = parseDateTime_(extractField_(body, '返却日時'));
  var store = extractField_(body, '出発営業所');
  var rawClass = extractField_(body, '詳細車両クラス');
  if (!rawClass) rawClass = extractField_(body, 'プラン名');
  var vehicleClass = extractVehicleClass_(rawClass);
  var price = parsePrice_(extractField_(body, '合計金額'));
  // ★ 料金内訳パース（エアトリ）
  var basePriceA = parsePrice_(extractField_(body, '基本料金'));
  if (!basePriceA) basePriceA = parsePrice_(extractField_(body, 'レンタカー料金'));
  var optionPriceA = parsePrice_(extractField_(body, 'オプション料金'));
  var insurancePriceA = parsePrice_(extractField_(body, '補償料金'));
  if (!insurancePriceA) insurancePriceA = parsePrice_(extractField_(body, '免責補償料金'));
  var base_price_a = basePriceA;
  var option_price_a = optionPriceA + insurancePriceA;
  var insuranceStr = extractField_(body, '補償オプション');
  var insurance = detectInsurance_(insuranceStr || body);
  var arrFlight = extractField_(body, '到着便');
  var depFlight = extractField_(body, '出発便');
  var flight = [arrFlight, depFlight].filter(Boolean).join(' / ');
  // ★ オプション抽出（B/C/J）— エアトリ形式 / 2026-04-26 複数行版
  var optionsStrA = extractFieldMultiline_(body, 'オプション') || '';
  var optBA = 0, optCA = 0, optJA = 0;
  var bMA = optionsStrA.match(/ベビーシート\s*[xX×]\s*(\d+)/);
  if (bMA) optBA = parseInt(bMA[1], 10);
  else if (/ベビーシート/.test(optionsStrA)) optBA = 1;
  var cMA = optionsStrA.match(/チャイルドシート\s*[xX×]\s*(\d+)/);
  if (cMA) optCA = parseInt(cMA[1], 10);
  else if (/チャイルドシート/.test(optionsStrA)) optCA = 1;
  var jMA = optionsStrA.match(/ジュニアシート\s*[xX×]\s*(\d+)/);
  if (jMA) optJA = parseInt(jMA[1], 10);
  else if (/ジュニアシート/.test(optionsStrA)) optJA = 1;
  // ★ 2026-05-08 USB 数抽出
  var optUsbA = detectUsbCount_(optionsStrA);
  // ★ デリバリーオプション検出（エアトリ） — オプション欄のみ（boilerplate誤検知防止）
  var delA = detectOtaDelivery_(optionsStrA);
  // ★ 2026-05-02 オーナー再再確定: OTAでも「送迎なし＋デリバリーなし＝来店/返却」を許可
  var noArrFlightA = isNoFlightSpecified_(arrFlight);
  var noDepFlightA = isNoFlightSpecified_(depFlight);
  var delPlaceA = delA.has_del ? '場所未確定' : '';
  var colPlaceA = delA.has_col ? '場所未確定' : '';
  var visitTypeA, returnTypeA;
  if (delA.has_del) visitTypeA = 'DEL';
  else if (noArrFlightA) visitTypeA = '来店';
  else visitTypeA = 'PUB';
  if (delA.has_col) returnTypeA = 'COL';
  else if (noDepFlightA) returnTypeA = '返却';
  else returnTypeA = 'BDB';
  return {
    id: id, ota: 'O', name: nameKana,
    lend_date: lend.date, lend_time: lend.time,
    return_date: ret.date, return_time: ret.time,
    vehicle: vehicleClass, people: 0, insurance: insurance,
    price: price, base_price: base_price_a, option_price: option_price_a, discount: 0,
    status: '確定', tel: tel, mail: mail,
    flight: flight, visit_type: visitTypeA, return_type: returnTypeA, del_place: delPlaceA, col_place: colPlaceA,
    opt_b: optBA, opt_c: optCA, opt_j: optJA, opt_usb: optUsbA,
    _store: store, _rawClass: rawClass
  };
}

function parseOfficial_(body) {
  var idMatch = body.match(/【予約番号】\s*\n\s*(\S+)/);
  if (!idMatch) return null;
  var id = idMatch[1].trim();
  var nameMatch = body.match(/^(.+?)様/m);
  var name = nameMatch ? nameMatch[1].trim() : '';
  var lendMatch = body.match(/ご利用開始日時\s*\n\s*(\d{4}\/\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})/);
  var lend = { date: '', time: '' };
  if (lendMatch) { lend.date = lendMatch[1].replace(/\//g, '-'); lend.time = lendMatch[2]; }
  var retMatch = body.match(/ご利用終了日時\s*\n\s*(\d{4}\/\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})/);
  var ret = { date: '', time: '' };
  if (retMatch) { ret.date = retMatch[1].replace(/\//g, '-'); ret.time = retMatch[2]; }
  var people = 0;
  var adultMatch = body.match(/大人:\s*(\d+)/);
  if (adultMatch) people += parseInt(adultMatch[1], 10);
  var childMatch = body.match(/子ども:\s*(\d+)/);
  if (childMatch) people += parseInt(childMatch[1], 10);
  // ★ 再発防止: people は最大8人にクランプ
  if (people > 8) { Logger.log('[PEOPLE-CLAMP] HP raw=' + people + ' → 8'); people = 8; }
  if (people < 0) people = 0;
  // オフィシャル予約: 車種名指定 → クラスコード変換
  // ★ HP予約はクラス指定ではなく車種指定。車種名を最優先でマッチさせる
  // 優先順: 1.具体的車種名 → 2.クラス名パターン → 3.単純文字マッチ
  var modelToClass = {
    // Tier1: 具体的な車種名（最優先 — カテゴリ名より先にマッチさせる）
    // ★ HP予約は車種指定。ここでの車種名がそのまま _vehicleModel になり配車先を決める
    'アルファードHクラス(A2)': 'A2', 'アルファードH(A2)': 'A2',  // A2は車種名扱い（Tier1に入れる）
    'アルファードMクラス': 'B', 'アルファードM': 'B',  // ★アルファードMは必ずBクラス（Aより先に判定）
    'プリウスアルファ': 'H', 'プリウスα': 'H', 'プリウス': 'H',
    'アルファードHクラス': 'A', 'アルファードH': 'A',
    'アルファード': 'A',
    'ヴェルファイア': 'B',
    // ★ M系（ガソリン）は D クラス、H系（ハイブリッド）は B クラス
    // 'ノア'/'セレナ' 単体マッチは危険（'ノアM'を取り違える）→ 必ず M/H サフィックス必須
    'ノアMクラス': 'D', 'ノアM': 'D',
    'セレナMクラス': 'D', 'セレナM': 'D',
    'ノアHクラス': 'B', 'ノアH': 'B',
    'セレナHクラス': 'B', 'セレナH': 'B',
    'ヴォクシー': 'B',
    'ヤリスクロス': 'C', 'ライズ': 'C',
    'エスクァイア': 'D',
    'ヴィッツ': 'F', 'ノート': 'F', 'アクア': 'F',
    'ハリアー': 'S'
  };
  var classNameToClass = {
    // Tier2: クラス名パターン（車種名で見つからなかった場合のみ使用）
    'アルファードHクラス(A2)': 'A2', 'アルファードH(A2)': 'A2',
    'アルファードMクラス': 'B', 'アルファードM': 'B',  // ★Mは必ずB
    'アルファードHクラス': 'A', 'アルファードH': 'A',
    // ★ M系=D / H系=B の対比を明示（モデル名Mクラス・Hクラス両表記対応）
    'ノアMクラス': 'D', 'セレナMクラス': 'D',
    'ノアHクラス': 'B', 'セレナHクラス': 'B',
    'ワンボックスB2': 'B2', 'ワンボックスB': 'B',
    'コンパクトSUV': 'C', 'ワンボックスD': 'D',
    'コンパクト': 'F', 'ハイブリッド': 'H', 'ハリアー': 'S'
  };
  var vehicleClass = '';
  var classLineMatch = body.match(/ご予約車両クラス\s*\n\s*(.+)/);
  if (classLineMatch) {
    var classLine = classLineMatch[1].trim();
    // Tier1: 車種名を優先マッチ（長い名前から）
    var modelKeys = Object.keys(modelToClass).sort(function(a,b){return b.length - a.length;});
    for (var ci = 0; ci < modelKeys.length; ci++) {
      if (classLine.indexOf(modelKeys[ci]) !== -1) {
        vehicleClass = modelToClass[modelKeys[ci]];
        break;
      }
    }
    // Tier2: 車種名で見つからなければクラス名パターン
    if (!vehicleClass) {
      var classKeys = Object.keys(classNameToClass).sort(function(a,b){return b.length - a.length;});
      for (var ci2 = 0; ci2 < classKeys.length; ci2++) {
        if (classLine.indexOf(classKeys[ci2]) !== -1) {
          vehicleClass = classNameToClass[classKeys[ci2]];
          break;
        }
      }
    }
    // Tier3: どちらでも見つからなければ従来のregex
    if (!vehicleClass) {
      var simpleMatch = classLine.match(/^(A2|B2|[ABCDSFH])クラス/i);
      if (simpleMatch) vehicleClass = simpleMatch[1].toUpperCase();
    }
  }
  // さらにフォールバック
  if (!vehicleClass) {
    var planMatch = body.match(/([ABCDSFH]2?)クラス/i);
    if (planMatch) vehicleClass = planMatch[1].toUpperCase();
  }
  var insurance = detectInsurance_(body);
  var optB = 0, optC = 0, optJ = 0;
  // ★ 2026-05-07 fix: ベビーシート抽出が完全に欠落していたバグ修正
  //   メール「チャイルドシート(ベビー): 1 台」が無視され opt_b=0 でDB登録されていた
  //   バグ事例: WHB20426 (木之瀬様) ベビー1指定 → opt_b=0 になっていた
  var bbMatch = body.match(/チャイルドシート\(ベビー\):\s*(\d+)\s*台/);
  if (bbMatch) optB = parseInt(bbMatch[1], 10);
  if (!bbMatch) { var bbAlt = body.match(/チャイルドシート\(ベビー\):\s*あり\s*(\d*)/); if (bbAlt) optB = parseInt(bbAlt[1], 10) || 1; }
  var cbMatch = body.match(/チャイルドシート\(チャイルド\):\s*(\d+)\s*台/);
  if (cbMatch) optC = parseInt(cbMatch[1], 10);
  if (!cbMatch) { var cbAlt = body.match(/チャイルドシート\(チャイルド\):\s*あり\s*(\d*)/); if (cbAlt) optC = parseInt(cbAlt[1], 10) || 1; }
  var jbMatch = body.match(/チャイルドシート\(ジュニア\):\s*(\d+)\s*台/);
  if (jbMatch) optJ = parseInt(jbMatch[1], 10);
  if (!jbMatch) { var jbAlt = body.match(/チャイルドシート\(ジュニア\):\s*あり\s*(\d*)/); if (jbAlt) optJ = parseInt(jbAlt[1], 10) || 1; }
  // ★ 2026-05-08 USB 数抽出（HP形式: 「USBポート: N 個」）
  var optUsbHP = 0;
  var usbHpMatch = body.match(/USBポート:\s*(\d+)\s*個/);
  if (usbHpMatch) optUsbHP = parseInt(usbHpMatch[1], 10);
  else optUsbHP = detectUsbCount_(body); // フォールバック
  var priceMatch = body.match(/料金\s*\n\s*(\d[\d,]*)\s*円/);
  var price = priceMatch ? parsePrice_(priceMatch[1]) : 0;
  var telMatch = body.match(/【電話番号】\s*\n\s*(\S+)/);
  var tel = telMatch ? cleanPhone_(telMatch[1]) : '';
  var mailMatch = body.match(/【メールアドレス】\s*\n\s*(\S+)/);
  var mail = mailMatch ? mailMatch[1].trim() : '';
  // ★ HTMLエンティティデコード（getPlainBody が一部メールで HTML 化された値を返すバグ対策）
  // 例: "community&spa" が "community&amp;spa" になる現象を解消
  var decodeHtml_ = function(s) {
    if (!s) return '';
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  };
  var delPlaceMatch = body.match(/【お届け場所名】\s*\n\s*(.+)/);
  var delPlace = delPlaceMatch ? decodeHtml_(delPlaceMatch[1].trim()) : '';
  var colPlaceMatch = body.match(/【回収場所名】\s*\n\s*(.+)/);
  var colPlace = colPlaceMatch ? decodeHtml_(colPlaceMatch[1].trim()) : '';
  var addressMatch = body.match(/【お届け場所住所】\s*\n\s*(.+)/);
  var address = addressMatch ? decodeHtml_(addressMatch[1].trim()) : '';

  // ★ 2026-04-30: 店舗判定ロジック追加（札幌GAS版と統一）
  // 旧コードは _store: '' 固定で isTakamatsuReservation_ の defaulting に頼っていたため、
  // 札幌のお客様HP予約が高松DBに誤登録されるリスクがあった。
  // 1. 【ご利用店舗】等のフィールドを優先抽出
  // 2. body本文中の「高松店/香川店/高松空港」「札幌店/札幌デリバリー」キーワード
  // 3. お届け先住所の都道府県名 fallback
  var hpStore = '';
  var storeMatch = body.match(/【(?:ご利用|利用)?店舗[名]?】\s*\n?\s*(.+)/);
  if (storeMatch) {
    hpStore = storeMatch[1].trim();
  } else {
    if (/高松店|香川店|高松空港/.test(body)) hpStore = '高松';
    else if (/札幌店|札幌デリバリー/.test(body)) hpStore = '札幌';
    if (!hpStore && /香川県|高松市/.test(address + delPlace + colPlace)) hpStore = '高松';
    if (!hpStore && /北海道|札幌市/.test(address + delPlace + colPlace)) hpStore = '札幌';
  }
  if (hpStore) Logger.log('[Official] Store detected: ' + hpStore + ' for ' + id);

  // ★ 2026-05-02: 送迎方法の正確な判定
  // HPフォームの選択を解析して visit_type / return_type を確定する
  // 問題: 従来 visit_type:'' で返し inferVisitReturnType_() に委ねていたため
  //       「デリバリー希望しない＋バス送迎希望する」ケースで誤DELタスクが生成された
  var checkWants_ = function(lbl) {
    var idx = body.indexOf(lbl);
    if (idx === -1) return false;
    // ★ 2026-05-02 fix: 次の【まで or 80文字以内に限定
    //   従来は120文字固定で、【ご出発時送迎】の後に隣接する【デリバリー（回収）】希望しない を
    //   誤って同じスコープに含めて判定していたため、希望する送迎を「来店」と誤判定していた
    var startIdx = idx + lbl.length;
    var nextLabel = body.indexOf('【', startIdx);
    var endIdx = (nextLabel === -1 || nextLabel > startIdx + 80) ? startIdx + 80 : nextLabel;
    var ctx = body.slice(startIdx, endIdx);
    return /希望する/.test(ctx) && !/希望しない/.test(ctx);
  };
  var wantsDelivery      = checkWants_('【デリバリー（お届け）】');
  var wantsPickupShuttle = checkWants_('【ご出発時送迎】');
  var wantsCollection    = checkWants_('【デリバリー（回収）】');
  var wantsReturnShuttle = checkWants_('【返却時の空港送迎】');

  var hpVisitType  = '';
  var hpReturnType = '';

  // ★ 2026-05-02 オーナー再確定: HPフォームのみ「両方希望しない → 来店/返却」を許可
  //   理由: HPフォームは顧客が4項目（デリバリー2 + 送迎2）を明示的に「希望しない」と選択するため
  //         オンライン判定可能 = 自力来店・返却の意思が確実
  //   - デリバリー希望  → DEL / COL（場所は【お届け/回収場所名】から取得、なければ「場所未確定」）
  //   - 送迎希望        → PUB / BDB（場所は高松空港 or 赤嶺駅 が記載されていれば転記、なければ空）
  //   - 両方とも「希望しない」→ 来店 / 返却（自力来店顧客）
  //   ※ OTAパーサー（J/R/S/O/G/RC）では「来店/返却」は引き続き出さない（オンライン判定不可）
  // ★ HP送迎場所抽出（高松空港/赤嶺駅 の2択）
  var extractShuttlePlace_ = function(text) {
    if (/赤嶺駅/.test(text)) return '赤嶺駅';
    // 「【迎車場所】 高松空港」「【送迎場所】 高松空港」等の明示フィールド
    var m = text.match(/【\s*(?:迎車|送迎|お迎え)\s*場所?\s*】\s*\n?\s*(高松空港|赤嶺駅)/);
    if (m) return m[1];
    return '';
  };
  // 送迎ブロックのみで場所抽出（boilerplate「高松空港到着」誤検知回避）
  var pickupBlock = '';
  var pkIdx = body.indexOf('【ご出発時送迎】');
  if (pkIdx !== -1) {
    var pkEnd = body.indexOf('【デリバリー（回収）】', pkIdx);
    pickupBlock = body.slice(pkIdx, pkEnd === -1 ? pkIdx + 400 : pkEnd);
  }
  var returnBlock = '';
  var rtIdx = body.indexOf('【返却時の空港送迎】');
  if (rtIdx !== -1) returnBlock = body.slice(rtIdx, rtIdx + 400);

  if (wantsDelivery) {
    hpVisitType = 'DEL';
    if (!delPlace) delPlace = '場所未確定';
  } else if (wantsPickupShuttle) {
    hpVisitType = 'PUB';
    delPlace = extractShuttlePlace_(pickupBlock);  // 高松空港 or 赤嶺駅 or 空
  } else {
    // 両方なし（明示「希望しない」）→ 来店（自力来店顧客 / オンライン判定可）
    hpVisitType = '来店';
    delPlace = '';
  }

  if (wantsCollection) {
    hpReturnType = 'COL';
    if (!colPlace) colPlace = '場所未確定';
  } else if (wantsReturnShuttle) {
    hpReturnType = 'BDB';
    colPlace = extractShuttlePlace_(returnBlock);
  } else {
    // 両方なし（明示「希望しない」）→ 返却（自力返却顧客 / オンライン判定可）
    hpReturnType = '返却';
    colPlace = '';
  }

  Logger.log('[Official] 送迎判定: ' + id +
    ' delivery=' + wantsDelivery + ' shuttle=' + wantsPickupShuttle +
    ' collection=' + wantsCollection + ' retShuttle=' + wantsReturnShuttle +
    ' → vt=' + hpVisitType + ' rt=' + hpReturnType);

  // ★ 2026-05-02: 便名抽出（HP/オフィシャル形式）
  // メール本文の「【飛行機便名（高松空港到着）】」直後の行から抽出
  // 全角/半角括弧の揺れに対応
  // ★ オーナー方針 C案: 顧客入力をそのまま保持（"It230" "jx302" 等の小文字もそのまま）
  // ★ 2026-05-03 fix: (\S+) は空白で止まる → 「SKY 553」が「SKY」のみで切れていた
  //                   ([^\n]+) で改行までの全文字を取得（複数語の便名対応）
  var hpFlight = '';
  var hpFlightMatch = body.match(/【\s*飛行機便名\s*[（(][^）)]*[）)]\s*】\s*\n\s*([^\n]+)/);
  if (hpFlightMatch) hpFlight = hpFlightMatch[1].trim();

  return {
    id: id, ota: 'HP', name: name,
    lend_date: lend.date, lend_time: lend.time,
    return_date: ret.date, return_time: ret.time,
    vehicle: vehicleClass, people: people, insurance: insurance,
    price: price, base_price: price, option_price: 0, discount: 0,
    status: '確定', tel: tel, mail: mail,
    flight: hpFlight, visit_type: hpVisitType, return_type: hpReturnType, del_place: delPlace, col_place: colPlace,
    opt_b: optB, opt_c: optC, opt_j: optJ, opt_usb: optUsbHP,
    _store: hpStore, _rawClass: vehicleClass, _address: address,
    _vehicleModel: classLineMatch ? extractModelName_(classLineMatch[1]) : ''
  };
}

// ============================================================
// GoGoOut Parser
// ============================================================
function parseGogoout_(body) {
  // 予約番号
  var idMatch = body.match(/予約番号[：:]\s*\n?\s*(\S+)/);
  if (!idMatch) return null;
  var id = idMatch[1].trim();

  // 利用時間・返却時間（フォーマット: 2026-07-24 18:00）
  var lendMatch = body.match(/利用時間[：:]\s*\n?\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  var retMatch  = body.match(/返却時間[：:]\s*\n?\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!lendMatch || !retMatch) return null;

  // 氏名
  var nameMatch = body.match(/氏名[：:]\s*\n?\s*(.+)/);
  var name = nameMatch ? nameMatch[1].trim() : '';

  // 電話番号
  var telMatch = body.match(/携帯番号[：:]\s*\n?\s*(\S+)/);
  var tel = telMatch ? cleanPhone_(telMatch[1]) : '';

  // Email
  var mailMatch = body.match(/Email[：:]\s*\n?\s*(\S+)/);
  var mail = mailMatch ? mailMatch[1].trim() : '';

  // 車種（トヨタ｜ALPHARD → ALPHARD）
  var carMatch = body.match(/車種[：:]\s*\n?\s*(.+)/);
  var rawClass = carMatch ? carMatch[1].trim() : '';
  // 車種名からクラス判定
  var vehicleClass = '';
  if (/ALPHARD|アルファード/i.test(rawClass)) vehicleClass = 'A';
  else if (/VELLFIRE|ヴェルファイア/i.test(rawClass)) vehicleClass = 'B';
  else if (/SERENA|セレナ/i.test(rawClass)) vehicleClass = 'B';
  else if (/VOXY|ヴォクシー/i.test(rawClass)) vehicleClass = 'B';
  else if (/NOAH|ノア/i.test(rawClass)) vehicleClass = 'B';
  else if (/YARIS\s*CROSS|ヤリスクロス/i.test(rawClass)) vehicleClass = 'C';
  else if (/RAIZE|ライズ/i.test(rawClass)) vehicleClass = 'C';
  else if (/ESQUIRE|エスクァイア/i.test(rawClass)) vehicleClass = 'D';
  else if (/VITZ|ヴィッツ|NOTE|ノート|AQUA|アクア/i.test(rawClass)) vehicleClass = 'F';
  else if (/PRIUS\s*ALPHA|プリウスアルファ|プリウスα/i.test(rawClass)) vehicleClass = 'H';
  else if (/PRIUS|プリウス/i.test(rawClass)) vehicleClass = 'H';
  else if (/HARRIER|ハリアー/i.test(rawClass)) vehicleClass = 'S';
  else vehicleClass = extractVehicleClass_(rawClass);

  // 座席数
  var seatMatch = body.match(/(\d+)座席数/);
  var people = seatMatch ? parseInt(seatMatch[1], 10) : 0;
  // ★ 再発防止: people は最大8人にクランプ
  if (people > 8) { Logger.log('[PEOPLE-CLAMP] G raw=' + people + ' → 8'); people = 8; }
  if (people < 0) people = 0;

  // フライト情報
  var arrFlightMatch = body.match(/到着フライト番号[：:]\s*\n?\s*(\S+)/);
  var depFlightMatch = body.match(/復路フライト番号[：:]\s*\n?\s*(\S+)/);
  var flight = [arrFlightMatch ? arrFlightMatch[1] : '', depFlightMatch ? depFlightMatch[1] : ''].filter(Boolean).join(' / ');

  // チャイルドシート
  var optB = 0, optC = 0, optJ = 0;
  var csMatch = body.match(/チャイルドシート[^：:]*[：:]\s*\n?\s*(\d+)/);
  if (csMatch) optC = parseInt(csMatch[1], 10);
  else if (/チャイルドシート/i.test(body)) optC = 1;
  var bsMatch = body.match(/ベビーシート[^：:]*[：:]\s*\n?\s*(\d+)/);
  if (bsMatch) optB = parseInt(bsMatch[1], 10);
  var jsMatch = body.match(/ジュニアシート[^：:]*[：:]\s*\n?\s*(\d+)/);
  if (jsMatch) optJ = parseInt(jsMatch[1], 10);

  // ★ 2026-05-08 USB 数抽出
  var optUsbG = detectUsbCount_(body);

  // 免責
  var insurance = detectInsurance_(body);

  // 送迎場所（高松空港など）
  var deliveryMatch = body.match(/送迎サービス[^：:]*[：:]\s*\n?\s*(.+)/);
  var delPlace = deliveryMatch ? deliveryMatch[1].trim().replace(/\s*TWD\d+.*/, '') : '';

  // 店舗名から高松判定用
  var storeMatch = body.match(/店舗名[：:]\s*\n?\s*(.+)/);
  var store = storeMatch ? storeMatch[1].trim() : '';
  var addrMatch = body.match(/店舗住所[：:]\s*\n?\s*(.+)/);
  var address = addrMatch ? addrMatch[1].trim() : '';

  // ★ 2026-05-02 マスター値統一: PUB/BDB or DEL/COL 必須
  //   GoGoOut の送迎場所が「高松空港」のみ = PUB扱い、それ以外 = DEL扱い
  var visitTypeG = 'PUB', returnTypeG = 'BDB';
  var delPlaceG = '', colPlaceG = '';
  if (delPlace && !/高松空港|空港/.test(delPlace)) {
    visitTypeG = 'DEL';
    delPlaceG = delPlace || '場所未確定';
  } else if (delPlace && /赤嶺/.test(delPlace)) {
    delPlaceG = '赤嶺駅';
  }
  return {
    id: id, ota: 'G', name: name,
    lend_date: lendMatch[1], lend_time: lendMatch[2],
    return_date: retMatch[1], return_time: retMatch[2],
    vehicle: vehicleClass, people: people, insurance: insurance,
    price: 0, base_price: 0, option_price: 0, discount: 0,
    status: '確定', tel: tel, mail: mail,
    flight: flight, visit_type: visitTypeG, return_type: returnTypeG,
    del_place: delPlaceG, col_place: colPlaceG,
    opt_b: optB, opt_c: optC, opt_j: optJ, opt_usb: optUsbG,
    _store: store, _rawClass: rawClass, _address: address
  };
}

// ============================================================
// レンタカードットコム Parser
// ============================================================
function parseRentacarDC_(body) {
  // 予約番号
  var idMatch = body.match(/予約番号\s*[：:]\s*(\S+)/);
  if (!idMatch) return null;
  var id = idMatch[1].trim();

  // 予約者名（カナ優先）
  var kanaMatch = body.match(/予約者カナ[：:]\s*(.+)/);
  var nameMatch = body.match(/予約者名\s*[：:]\s*(.+)/);
  var name = (kanaMatch ? kanaMatch[1] : nameMatch ? nameMatch[1] : '').trim();

  // 連絡先
  var telMatch = body.match(/電話番号\s*[：:]\s*([\d-]+)/);
  var tel = telMatch ? cleanPhone_(telMatch[1]) : '';
  var mailMatch = body.match(/メールアドレス[：:]\s*(\S+)/);
  var mail = mailMatch ? mailMatch[1].trim() : '';

  // 貸出日・時間（別フィールド: 「貸出日：」「貸出時間：」）
  var ldMatch = body.match(/貸出日[^時]*[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
  var ltMatch = body.match(/貸出時間\s*[：:]\s*(\d{1,2}:\d{2})/);
  if (!ldMatch) return null;
  var lendDate = ldMatch[1].replace(/\//g, '-');
  var lendTime = ltMatch ? ltMatch[1] : '';

  // 返却日・時間
  var rdMatch = body.match(/返却日\s*[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
  var rtMatch = body.match(/返却時間\s*[：:]\s*(\d{1,2}:\d{2})/);
  if (!rdMatch) return null;
  var returnDate = rdMatch[1].replace(/\//g, '-');
  var returnTime = rtMatch ? rtMatch[1] : '';

  // 店舗名（高松判定用）
  var storeMatch = body.match(/貸出店舗名[：:]\s*(.+)/);
  var store = storeMatch ? storeMatch[1].trim() : '';

  // 車両クラス判定（プラン名 + 車種名）
  var planMatch = body.match(/プラン名\s*[：:]\s*(.+)/);
  var carMatch = body.match(/車種名\s*[：:]\s*(.+)/);
  var rawPlan = planMatch ? planMatch[1].trim() : '';
  var rawCar = carMatch ? carMatch[1].trim() : '';
  var rawClass = rawPlan + ' ' + rawCar;

  var vehicleClass = '';
  // ALPHARD / アルファード → A
  if (/ALPHARD|アルファード/i.test(rawClass)) vehicleClass = 'A';
  else if (/VELLFIRE|ヴェルファイア/i.test(rawClass)) vehicleClass = 'B';
  else if (/SERENA|セレナ/i.test(rawClass)) vehicleClass = 'B';
  else if (/VOXY|ヴォクシー/i.test(rawClass)) vehicleClass = 'B';
  else if (/NOAH|ノア/i.test(rawClass)) vehicleClass = 'B';
  else if (/YARIS\s*CROSS|ヤリスクロス/i.test(rawClass)) vehicleClass = 'C';
  else if (/RAIZE|ライズ/i.test(rawClass)) vehicleClass = 'C';
  else if (/ESQUIRE|エスクァイア/i.test(rawClass)) vehicleClass = 'D';
  else if (/VITZ|ヴィッツ|NOTE|ノート|AQUA|アクア/i.test(rawClass)) vehicleClass = 'F';
  else if (/PRIUS\s*ALPHA|プリウスアルファ|プリウスα/i.test(rawClass)) vehicleClass = 'H';
  else if (/PRIUS|プリウス/i.test(rawClass)) vehicleClass = 'H';
  else if (/HARRIER|ハリアー/i.test(rawClass)) vehicleClass = 'S';
  else vehicleClass = extractVehicleClass_(rawClass);

  // 人数
  // ★ 2026-05-10 fix: 子供が「0名(1歳未満) 1名(1歳以上4歳未満) 1名(4歳以上5歳未満)」のように
  //    複数表記される場合に対応。同一行内の全 N名 を合計する。
  //    旧バグ: var childMatch = body.match(/子供\s*[：:]\s*(\d+)\s*名/) は最初の「0名」のみ取得
  //    バグ事例: 2603000565 (HUNG JHIH CHENG) DB people=0 / 正解5
  var adultMatch = body.match(/大人\s*[：:]\s*(\d+)\s*名/);
  var adultCount = adultMatch ? parseInt(adultMatch[1], 10) : 0;
  var childCount = 0;
  var childLineMatch = body.match(/子供\s*[：:]([^\n]+)/);
  if (childLineMatch) {
    var childNums = childLineMatch[1].match(/(\d+)\s*名/g);
    if (childNums) {
      childNums.forEach(function(_n) {
        var _m = _n.match(/(\d+)/);
        if (_m) childCount += parseInt(_m[1], 10);
      });
    }
  }
  var people = adultCount + childCount;
  // ★ 再発防止: people は最大8人にクランプ
  if (people > 8) { Logger.log('[PEOPLE-CLAMP] RC raw=' + people + ' → 8'); people = 8; }
  if (people < 0) people = 0;

  // 料金（￥35.500 形式: ピリオドが千区切り）
  var priceMatch = body.match(/合計料金\s*[：:]\s*[￥¥]?([\d.]+)/);
  var price = 0;
  if (priceMatch) {
    price = parseInt(priceMatch[1].replace(/\./g, ''), 10) || 0;
  }

  // 免責
  var cdwMatch = body.match(/免責料金\s*[：:]\s*[￥¥]?([\d.]+)/);
  var cdwPrice = cdwMatch ? parseInt(cdwMatch[1].replace(/\./g, ''), 10) : 0;
  var insurance = detectInsurance_(body);
  if (insurance === 'なし' && cdwPrice > 0) insurance = '免責';

  // フライト情報（「現地到着 ： : 【到着】直接來店CI120」から抽出）
  var arrFlight = '';
  var depFlight = '';
  var arrMatch2 = body.match(/現地到着[^：:]*[：:]+\s*.*?([A-Z]{2}\d{2,5})/i);
  var depMatch2 = body.match(/現地出発[^：:]*[：:]+\s*.*?([A-Z]{2}\d{2,5})/i);
  if (arrMatch2) arrFlight = arrMatch2[1];
  if (depMatch2) depFlight = depMatch2[1];
  var flight = [arrFlight, depFlight].filter(Boolean).join(' / ');

  // チャイルドシート
  var optB = 0, optC = 0, optJ = 0;
  // ★ 2026-05-08 fix: extractField_ は1行のみ取得 → RC本文の「オプション： USB充電器 x 2」が
  //   複数行にわたる場合に取りこぼし。extractFieldMultiline_ で確実に取る
  var optsStr = extractFieldMultiline_(body, 'オプション') || '';
  if (!optsStr) {
    var optsText = body.match(/オプション[：:]\s*(.+)/);
    optsStr = optsText ? optsText[1] : '';
  }
  var csMatch = optsStr.match(/チャイルドシート[^：:]*[：:]?\s*(\d+)/);
  if (csMatch) optC = parseInt(csMatch[1], 10);
  var bsMatch = optsStr.match(/ベビーシート[^：:]*[：:]?\s*(\d+)/);
  if (bsMatch) optB = parseInt(bsMatch[1], 10);
  var jsMatch = optsStr.match(/ジュニアシート[^：:]*[：:]?\s*(\d+)/);
  if (jsMatch) optJ = parseInt(jsMatch[1], 10);
  // ★ 2026-05-08 USB 数抽出（RC形式: 「USB充電器 x 2」）
  var optUsbRC = detectUsbCount_(optsStr);

  // ★ 2026-05-02 マスター値統一: PUB/BDB or DEL/COL 必須
  //   レンタカードットコムは送迎オプションのフィールドが明示されないので、
  //   メールに「直接來店」記載がある場合は PUB（実体は来店だが、来店はスタッフ手動上書き対象）
  //   デリバリーオプションが本文にあれば DEL/COL、なければ PUB/BDB をデフォルト
  var hasDelivery = /デリバリー\s*[（(]\s*お届け\s*[）)]|配達|お届け場所/.test(body);
  var hasCollection = /デリバリー\s*[（(]\s*回収\s*[）)]|回収場所/.test(body);
  var visitType  = hasDelivery   ? 'DEL' : 'PUB';
  var returnType = hasCollection ? 'COL' : 'BDB';

  Logger.log('[RC-PARSE] id=' + id + ' name=' + name + ' class=' + vehicleClass +
    ' plan=' + rawPlan + ' car=' + rawCar + ' price=' + price + ' flight=' + flight);

  // ★ 料金内訳パース（レンタカードットコム）
  var basePriceRC = parsePrice_(extractField_(body, '基本料金'));
  var optionPriceRC = parsePrice_(extractField_(body, 'オプション料金'));
  var base_price_rc = basePriceRC || price;
  var option_price_rc = cdwPrice + optionPriceRC;
  return {
    id: id, ota: 'RC', name: name,
    lend_date: lendDate, lend_time: lendTime,
    return_date: returnDate, return_time: returnTime,
    vehicle: vehicleClass, people: people, insurance: insurance,
    price: price, base_price: base_price_rc, option_price: option_price_rc, discount: 0,
    status: '確定', tel: tel, mail: mail,
    flight: flight, visit_type: visitType, return_type: returnType,
    del_place: hasDelivery ? '場所未確定' : '', col_place: hasCollection ? '場所未確定' : '',
    opt_b: optB, opt_c: optC, opt_j: optJ, opt_usb: optUsbRC,
    _store: store, _rawClass: rawClass
  };
}

// ============================================================
// Cancellation Handler
// ============================================================
function handleCancellation_(ota, body, dryRun) {
  var reservationId = '';
  if (ota === 'rakuten') {
    reservationId = extractField_(body, '・予約番号');
  } else {
    reservationId = extractField_(body, '予約番号');
  }

  if (!reservationId) {
    Logger.log('Cancellation: could not extract reservation ID (' + ota + ')');
    return;
  }

  Logger.log('Cancellation detected: ' + reservationId + ' (' + ota + ')');

  if (dryRun) {
    Logger.log('[DRY RUN] Would cancel: ' + reservationId);
    return;
  }

  // Delete fleet + tasks, update reservation status to キャンセル
  deleteFromFleet_(reservationId);
  deleteFromTasks_(reservationId);
  supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(reservationId), {status: 'cancelled'});

  // ★ じゃらん決済キャンセル連動
  var otaCode = {jalan:'J',rakuten:'R',skyticket:'S',airtrip:'O',airtrip_dp:'O',official:'HP',gogoout:'G',rentacar_dc:'RC',rentacar_dc2:'RC'}[ota] || '';
  if (otaCode === 'J') {
    try { nhaHandleJalanPaymentCancel_(reservationId); } catch (e) { Logger.log('[JalanPaymentCancel] Error: ' + e.message); }
  }

  Logger.log('Cancelled reservation: ' + reservationId);
  return reservationId;
}

// ============================================================
// Supabase API
// ============================================================
function supabaseHeaders_() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

function supabaseGet_(table, queryParams) {
  // ★ Supabase REST APIはデフォルト1000件制限。必要に応じてlimitを明示的に付与
  var sep = queryParams ? '&' : '';
  if (queryParams.indexOf('limit=') === -1) {
    queryParams += sep + 'limit=5000';
  }
  var url = SUPABASE_URL + '/rest/v1/' + table + '?' + queryParams;
  var resp = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: supabaseHeaders_(),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('Supabase GET error (' + table + '): ' + resp.getContentText());
    return [];
  }
  return JSON.parse(resp.getContentText());
}

function supabasePost_(table, data) {
  var url = SUPABASE_URL + '/rest/v1/' + table;
  var resp = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: supabaseHeaders_(),
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('Supabase POST error (' + table + '): ' + resp.getContentText());
    return null;
  }
  return JSON.parse(resp.getContentText());
}

function supabaseUpdate_(table, queryParams, data) {
  var url = SUPABASE_URL + '/rest/v1/' + table + '?' + queryParams;
  var resp = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders_(),
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });
  return resp.getResponseCode() < 400;
}

function supabaseDelete_(table, queryParams) {
  var url = SUPABASE_URL + '/rest/v1/' + table + '?' + queryParams;
  var resp = UrlFetchApp.fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders_(),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('Supabase DELETE error (' + table + '): ' + resp.getContentText());
    return false;
  }
  return true;
}

// ============================================================
// Reservation DB Operations
// ============================================================
function reservationExists_(reservationId) {
  // ★ 2026-05-02: created_at も取得（古い予約メールの再処理ガードで使用）
  var rows = supabaseGet_('bt_reservations', 'id=eq.' + encodeURIComponent(reservationId) + '&select=id,status,created_at');
  return rows.length > 0 ? rows[0] : null;
}

// GAS内部フィールド → bt_reservationsカラム名変換
function toDbRow_(reservation) {
  // ★ 2026-04-30: del_place / col_place から visit_type / return_type を自動推論
  // 既存値（パーサー設定済み 'DEL' 等、手動入力 '来店'/'返却'）は保護される。
  // 空フィールドのみ place ベースで埋める。
  inferVisitReturnType_(reservation);

  var row = {
    id: reservation.id,
    name: reservation.name || '',
    ota: reservation.ota || '',
    start_date: reservation.lend_date || '',
    end_date: reservation.return_date || '',
    start_time: reservation.lend_time || '',
    end_time: reservation.return_time || '',
    col_time: reservation.return_time || '',
    del_time: reservation.lend_time || '',
    vehicle_class: reservation.vehicle || '',
    people: reservation.people || 0,
    insurance: reservation.insurance || '',
    amount: reservation.price || 0,
    price: reservation.price || 0,
    base_price: reservation.base_price || 0,
    option_price: reservation.option_price || 0,
    discount: reservation.discount || 0,
    tel: reservation.tel || '',
    mail: reservation.mail || '',
    del_flight: reservation.flight || '',
    del_place: reservation.del_place || '',
    col_place: reservation.col_place || '',
    opt_b: +(reservation.opt_b || 0),
    opt_c: +(reservation.opt_c || 0),
    opt_j: +(reservation.opt_j || 0),
    opt_usb: +(reservation.opt_usb || 0),
    visit_type: reservation.visit_type || '',
    return_type: reservation.return_type || '',
    vehicle_name: reservation._vehicleModel || '',
    status: 'confirmed',
    booked_at: reservation._booked_at || null
  };
  return row;
}

// キャンセル済み予約を再有効化（同一IDで取り直しされた場合）
function reactivateReservation_(reservationId, reservation) {
  var row = toDbRow_(reservation);
  row.status = 'confirmed';
  var ok = supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(reservationId), row);
  if (ok) Logger.log('Reactivated cancelled reservation: ' + reservationId);
  return ok;
}

function insertReservation_(reservation) {
  var row = toDbRow_(reservation);
  var result = supabasePost_('bt_reservations', row);
  if (result) Logger.log('Inserted reservation: ' + reservation.id);
  return result;
}

function deleteReservation_(reservationId) {
  return supabaseDelete_('bt_reservations', 'id=eq.' + encodeURIComponent(reservationId));
}

function deleteFromFleet_(reservationId) {
  return supabaseDelete_('bt_fleet', 'reservation_id=eq.' + encodeURIComponent(reservationId));
}

function deleteFromTasks_(reservationId) {
  // ★ 2026-04-26 fix: bt_tasks の予約番号カラムは日本語「予約番号」（reservation_id ではない）
  return supabaseDelete_('bt_tasks', encodeURIComponent('予約番号') + '=eq.' + encodeURIComponent(reservationId));
}

// ============================================================
// Vehicle Auto-Assignment
// ============================================================
function autoAssignVehicle_(reservation) {
  var vehicleClass = reservation.vehicle;
  if (!vehicleClass) {
    Logger.log('No vehicle class for ' + reservation.id + '. Will be 未配車.');
    return;
  }

  // A2→A, B2→Bフォールバック（同じ車種構成のため）
  var searchClass = vehicleClass;
  if (vehicleClass === 'A2') searchClass = 'A';
  if (vehicleClass === 'B2') searchClass = 'B';

  var vehicles = supabaseGet_('bt_vehicles',
    'type=eq.' + encodeURIComponent(searchClass) + '&insurance_veh=eq.false&select=code,name,plate_no,seats');
  if (vehicles.length === 0) {
    Logger.log('No vehicles of class ' + searchClass + ' (original: ' + vehicleClass + '). ' + reservation.id + ' will be 未配車.');
    return;
  }

  // ★ 2026-04-26 OTA予約（車種指定なし）の場合、派生車種を後回しにする
  // 例: Hクラス → プリウスα は HP予約「プリウスアルファ」明示指定のみ。
  //     OTAクラス指定のみは プリウス を優先配車。
  // 同様に他クラスでも将来派生車が増えた時のために汎用化。
  var preferredModelEarly = reservation._vehicleModel || '';
  if (!preferredModelEarly) {
    // 派生車種パターン: α / プリウスα / ハイブリッド系
    vehicles = vehicles.slice().sort(function(a, b) {
      var aDeriv = /α|アルファ/.test(a.name) ? 1 : 0;
      var bDeriv = /α|アルファ/.test(b.name) ? 1 : 0;
      return aDeriv - bDeriv;  // 派生車（α）を後ろへ
    });
  }

  var lendDate = reservation.lend_date;
  var returnDate = reservation.return_date;

  var busyVehicleCodes = {};
  var overlappingFleet = getOverlappingFleetVehicles_(lendDate, returnDate);
  for (var i = 0; i < overlappingFleet.length; i++) {
    busyVehicleCodes[overlappingFleet[i]] = true;
  }

  var overlappingMaint = getOverlappingMaintenance_(lendDate, returnDate);
  for (var i = 0; i < overlappingMaint.length; i++) {
    busyVehicleCodes[overlappingMaint[i].vehicle_code] = true;
  }

  // 車種名指定がある場合、指定車種のみ検索
  // ★ 「プリウス」と「プリウスα」を区別するため、車種名の後に数字/記号が来るか確認
  var preferredModel = reservation._vehicleModel || '';
  var assignedVehicle = null;
  if (preferredModel) {
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (busyVehicleCodes[v.code]) continue;
      if (isModelMatch_(v.name, preferredModel)) {
        assignedVehicle = v;
        break;
      }
    }
    if (assignedVehicle) {
      Logger.log('Preferred model match: ' + preferredModel + ' → ' + assignedVehicle.code);
    } else {
      // ★ HP予約の車種指定車両が全て塞がっている → 未配車にする（フォールバック禁止）
      // 先約優先: 別車種に勝手に配車すると顧客の車種指定を無視することになる
      Logger.log('Preferred model "' + preferredModel + '" not available for ' + reservation.id +
        '. Will be 未配車 (車種指定優先).');
      return null;
    }
  }
  // 指定車種なし（OTA予約 or クラス名のみ指定）→ クラス内の先頭空車
  if (!assignedVehicle) {
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (busyVehicleCodes[v.code]) continue;
      assignedVehicle = v;
      break;
    }
  }

  if (!assignedVehicle) {
    Logger.log('No available vehicle for class ' + vehicleClass +
      ' (' + lendDate + '~' + returnDate + '). ' + reservation.id + ' will be 未配車.');
    return null;
  }

  // ★ INSERT直前の最終重複チェック（二重配車防止ガード）
  // getOverlappingFleetVehicles_ の結果はキャッシュされている可能性があるため、
  // INSERT直前に再度DBを直接確認する
  var finalCheck = getOverlappingFleetVehicles_(lendDate, returnDate);
  if (finalCheck.indexOf(assignedVehicle.code) >= 0) {
    Logger.log('🚨 FINAL GUARD: ' + assignedVehicle.code + ' has become busy between check and insert. ' +
      reservation.id + ' will be 未配車.');
    return null;
  }

  var fleetRow = { reservation_id: reservation.id, vehicle_code: assignedVehicle.code };
  var result = supabasePost_('bt_fleet', fleetRow);
  if (result) {
    Logger.log('Assigned ' + assignedVehicle.code + ' (' + assignedVehicle.name + ') to ' + reservation.id);
    return assignedVehicle;
  }
  return null;
}

function getOverlappingFleetVehicles_(lendDate, returnDate) {
  // ★ DB側で期間重複を絞り込む（全件取得を避ける）
  // bt_reservations.start_date <= returnDate AND bt_reservations.end_date >= lendDate
  var query = 'select=vehicle_code,reservation_id,bt_reservations!inner(start_date,end_date)' +
    '&bt_reservations.start_date=lte.' + encodeURIComponent(returnDate) +
    '&bt_reservations.end_date=gte.' + encodeURIComponent(lendDate);
  var overlapping = supabaseGet_('bt_fleet', query);
  var busyCodes = [];
  for (var i = 0; i < overlapping.length; i++) {
    busyCodes.push(overlapping[i].vehicle_code);
  }
  return busyCodes;
}

function getOverlappingMaintenance_(lendDate, returnDate) {
  var query = 'start_date=lte.' + encodeURIComponent(returnDate) +
    '&end_date=gte.' + encodeURIComponent(lendDate) +
    '&select=vehicle_code';
  return supabaseGet_('bt_maintenance', query);
}

// ============================================================
// Slack Notifications (メール転送方式 → #新規予約登録_bot)
// ============================================================
function sendSlackSuccess_(items) {
  var lines = ['✅ 高松店新規予約取込完了通知', ''];
  items.forEach(function(r) {
    lines.push('【' + r.ota + '】' + r.id);
    lines.push('  ' + r.name + ' / ' + r.dates + ' / ' + r.vehicle + 'クラス');
    lines.push('  → 配車: ' + r.assignedTo);
    lines.push('');
  });
  lines.push('合計: ' + items.length + '件');
  try { MailApp.sendEmail(SLACK_EMAIL, lines[0], lines.join('\n')); } catch (e) { Logger.log('[Slack] Send error: ' + e.message); }
}

function sendSlackFailure_(items) {
  var lines = ['❌ 高松店新規予約取込失敗通知', ''];
  items.forEach(function(r) {
    lines.push('【' + r.ota + '】' + (r.id || '不明'));
    if (r.name) lines.push('  ' + r.name + (r.dates ? ' / ' + r.dates : ''));
    lines.push('  理由: ' + r.reason);
    lines.push('');
  });
  lines.push('合計: ' + items.length + '件 ※手動対応が必要です');
  try { MailApp.sendEmail(SLACK_EMAIL, lines[0], lines.join('\n')); } catch (e) { Logger.log('[Slack] Send error: ' + e.message); }
}

function sendSlackCancel_(items) {
  var lines = ['🔄 高松店予約キャンセル処理通知', ''];
  items.forEach(function(r) {
    lines.push('【' + r.ota + '】' + r.id + ' → キャンセル処理完了');
  });
  lines.push('');
  lines.push('合計: ' + items.length + '件');
  try { MailApp.sendEmail(SLACK_EMAIL, lines[0], lines.join('\n')); } catch (e) { Logger.log('[Slack] Send error: ' + e.message); }
}

// ============================================================
// 立替金 未回収アラート（発行から3日経過で Slack 通知）
// ============================================================
/**
 * bt_accounting から type='advance' / paid=false の行を取得し、
 * date が3日以上前のものを Slack に通知する。
 * 日次トリガー（朝9時など）で実行する想定。
 */
function checkUnpaidAdvances() {
  var THRESHOLD_DAYS = 3;
  try {
    // type=advance かつ paid=false を取得
    var rows = supabaseGet_('bt_accounting',
      'select=id,date,category,description,amount,staff_name,user_name,resv_no,url,paid,type' +
      '&type=eq.advance&paid=eq.false&order=date.asc');

    if (!rows || !rows.length) {
      Logger.log('[UnpaidAdvances] 未回収なし');
      return;
    }

    var today = new Date();
    today.setHours(0,0,0,0);
    var threshold = new Date(today.getTime() - THRESHOLD_DAYS * 86400000);

    var overdue = rows.filter(function(r) {
      if (!r.date) return false;
      var d = new Date(r.date);
      if (isNaN(d.getTime())) return false;
      d.setHours(0,0,0,0);
      return d.getTime() <= threshold.getTime();
    });

    if (!overdue.length) {
      Logger.log('[UnpaidAdvances] 3日経過の未回収なし（候補' + rows.length + '件）');
      return;
    }

    var totalAmount = 0;
    var lines = ['🚨 立替金 未回収アラート（発行から' + THRESHOLD_DAYS + '日以上経過）', '', '回収せよ！', ''];
    overdue.forEach(function(r) {
      var d = new Date(r.date);
      var elapsed = Math.floor((today.getTime() - d.getTime()) / 86400000);
      var amt = Number(r.amount || 0);
      totalAmount += amt;
      lines.push('・' + r.date + '（' + elapsed + '日経過） ' +
                 (r.category || '立替') +
                 ' ¥' + amt.toLocaleString() +
                 ' / 担当:' + (r.staff_name || '-') +
                 ' / 利用者:' + (r.user_name || '-') +
                 ' / 予約番号:' + (r.resv_no || '-'));
      if (r.url) lines.push('  発行URL: ' + r.url);
      lines.push('');
    });
    lines.push('────────────');
    lines.push('合計: ' + overdue.length + '件 / ¥' + totalAmount.toLocaleString());

    var subject = '🚨 立替金未回収 ' + overdue.length + '件 (¥' + totalAmount.toLocaleString() + ') — 回収せよ';
    try {
      MailApp.sendEmail(SLACK_EMAIL_OPS, subject, lines.join('\n'));
      Logger.log('[UnpaidAdvances] Slack通知送信: ' + overdue.length + '件');
    } catch (e) {
      Logger.log('[UnpaidAdvances] Slack送信エラー: ' + e.message);
    }
  } catch (e) {
    Logger.log('[UnpaidAdvances] エラー: ' + e.message);
  }
  updateHeartbeat_('bt_advance_alert', {success: 1});
}

// ============================================================
// 予約外売上 未回収アラート（3日経過 → Slack通知）
// ============================================================
function checkUnpaidExtraSales() {
  var THRESHOLD_DAYS = 3;
  try {
    var rows = supabaseGet_('bt_accounting',
      'select=id,date,category,description,amount,staff_name,user_name,resv_no,url,paid,type' +
      '&type=eq.extra_sales&paid=eq.false&order=date.asc');

    if (!rows || !rows.length) {
      Logger.log('[UnpaidExtra] 未回収なし');
      return;
    }

    var today = new Date();
    today.setHours(0,0,0,0);
    var threshold = new Date(today.getTime() - THRESHOLD_DAYS * 86400000);

    var overdue = rows.filter(function(r) {
      if (!r.date) return false;
      var d = new Date(r.date);
      if (isNaN(d.getTime())) return false;
      d.setHours(0,0,0,0);
      return d.getTime() <= threshold.getTime();
    });

    if (!overdue.length) {
      Logger.log('[UnpaidExtra] 3日経過の未回収なし（候補' + rows.length + '件）');
      return;
    }

    var totalAmount = 0;
    var lines = ['🚨 予約外売上 未回収アラート（' + THRESHOLD_DAYS + '日以上経過）', '', '回収せよ！', ''];
    overdue.forEach(function(r) {
      var d = new Date(r.date);
      var elapsed = Math.floor((today.getTime() - d.getTime()) / 86400000);
      var amt = Number(r.amount || 0);
      totalAmount += amt;
      lines.push('・' + r.date + '（' + elapsed + '日経過） ' +
                 (r.category || '予約外') +
                 ' ¥' + amt.toLocaleString() +
                 ' / 担当:' + (r.staff_name || '-') +
                 ' / 利用者:' + (r.user_name || '-') +
                 ' / 予約番号:' + (r.resv_no || '-'));
      if (r.url) lines.push('  請求URL: ' + r.url);
      lines.push('');
    });
    lines.push('────────────');
    lines.push('合計: ' + overdue.length + '件 / ¥' + totalAmount.toLocaleString());

    var subject = '🚨 予約外売上 未回収 ' + overdue.length + '件 (¥' + totalAmount.toLocaleString() + ') — 回収せよ';
    try {
      MailApp.sendEmail(SLACK_EMAIL_OPS, subject, lines.join('\n'));
      Logger.log('[UnpaidExtra] Slack通知送信: ' + overdue.length + '件');
    } catch (e) {
      Logger.log('[UnpaidExtra] Slack送信エラー: ' + e.message);
    }
  } catch (e) {
    Logger.log('[UnpaidExtra] エラー: ' + e.message);
  }
}

// ============================================================
// Heartbeat & Monitoring
// ============================================================

// ハートビート書込み: 実行のたびにapp_settingsに記録
function updateHeartbeat_(key, stats) {
  // ★ 2026-05-03: URL Fetchクォータ節約のため無効化
  // heartbeatは監視用途のみ。業務に影響なし。
  Logger.log('[heartbeat] ' + key + ' ' + JSON.stringify(stats));
  return;
  try {
    var payload = {
      key: 'heartbeat_' + key,
      value: JSON.stringify({
        last_run: new Date().toISOString(),
        status: (stats.failure || 0) > 0 ? 'warning' : 'ok',
        processed: (stats.success || 0) + (stats.cancel || 0) + (stats.skip || 0),
        errors: stats.failure || 0,
        details: stats
      })
    };
    var options = {
      method: 'post',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/bt_app_settings', options);
    Logger.log('[Heartbeat] Updated: ' + key);
  } catch (e) {
    Logger.log('[Heartbeat] Error: ' + e.message);
  }
}

// 監視チェック: 30分間隔で実行。ハートビートが途絶えていたらSlack通知
function checkHeartbeats() {
  var checks = [
    { key: 'bt_gas_email', label: '高松GAS予約取込', thresholdMin: 30 }
  ];

  checks.forEach(function(check) {
    try {
      var url = SUPABASE_URL + '/rest/v1/app_settings?key=eq.heartbeat_' + check.key + '&select=value';
      var options = {
        method: 'get',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        },
        muteHttpExceptions: true
      };
      var res = UrlFetchApp.fetch(url, options);
      var data = JSON.parse(res.getContentText());
      var props = PropertiesService.getScriptProperties();

      if (!data || data.length === 0) {
        var initKey = 'alert_init_' + check.key;
        if (!props.getProperty(initKey)) {
          sendSlackAlert_('⚠️ ' + check.label + ': ハートビート未登録（初回実行待ち）');
          props.setProperty(initKey, 'true');
        }
        return;
      }

      var hb = JSON.parse(data[0].value);
      var lastRun = new Date(hb.last_run);
      var now = new Date();
      var diffMin = Math.round((now - lastRun) / 60000);

      // ScriptProperties で通知済みフラグ管理（同じ障害で連続通知しない）
      var props = PropertiesService.getScriptProperties();
      var alertKey = 'alert_sent_' + check.key;
      var alertSent = props.getProperty(alertKey);

      if (diffMin > check.thresholdMin) {
        if (!alertSent) {
          var timeStr = Utilities.formatDate(lastRun, 'Asia/Tokyo', 'MM/dd HH:mm');
          sendSlackAlert_('🚨 ' + check.label + ' が' + diffMin + '分間停止中\n最終実行: ' + timeStr + '\n処理数: ' + (hb.processed || 0) + '件 / エラー: ' + (hb.errors || 0) + '件');
          props.setProperty(alertKey, 'true');
        }
      } else {
        // 復旧検知
        if (alertSent) {
          sendSlackAlert_('✅ ' + check.label + ' 復旧しました（停止' + diffMin + '分）');
          props.deleteProperty(alertKey);
        }
      }
    } catch (e) {
      Logger.log('[checkHeartbeats] Error for ' + check.key + ': ' + e.message);
    }
  });
}

function sendSlackAlert_(message) {
  try {
    MailApp.sendEmail(SLACK_EMAIL, message.split('\n')[0], message);
    Logger.log('[Alert] Sent: ' + message.split('\n')[0]);
  } catch (e) {
    Logger.log('[Alert] Send error: ' + e.message);
  }
}

// ============================================================
// 未知送信元監視: OTA_SENDERSに未登録の予約メールを検知
// ============================================================
function checkUnknownSenders_() {
  var knownSenders = Object.values(OTA_SENDERS);
  // 予約系キーワードを含むreserve@宛メールを直近2日で検索
  var reserveKeywords = ['予約確定', '予約通知', '予約受付', '新規予約', 'ご予約完了', '予約を受け付け', '予約登録'];
  var query = 'to:reserve@rent-buddica-touring.jp newer_than:2d -label:' + LABEL_NAME;
  var threads;
  try {
    threads = GmailApp.search(query, 0, 50);
  } catch (e) {
    Logger.log('checkUnknownSenders_ search error: ' + e.message);
    return;
  }
  if (threads.length === 0) return;

  var unknowns = [];
  var checkedKey = 'bt_unknown_senders_alerted';
  var alerted = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(checkedKey);
    if (raw) alerted = JSON.parse(raw);
  } catch (e) {}

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var from = msgs[j].getFrom();
      var subject = msgs[j].getSubject();
      var msgId = msgs[j].getId();

      // 既にアラート済みならスキップ
      if (alerted[msgId]) continue;

      // 既知の送信元ならスキップ
      var isKnown = knownSenders.some(function(s) { return from.indexOf(s) !== -1; });
      if (isKnown) continue;

      // 件名に予約キーワードが含まれるか
      var hasReserveKeyword = reserveKeywords.some(function(kw) { return subject.indexOf(kw) !== -1; });
      if (!hasReserveKeyword) continue;

      // 未知の予約メール発見
      unknowns.push({
        from: from,
        subject: subject,
        date: msgs[j].getDate().toLocaleString('ja-JP'),
        msgId: msgId
      });
      alerted[msgId] = true;
    }
  }

  if (unknowns.length > 0) {
    // Slack警告送信
    var lines = ['⚠️ 高松店 未知の予約メール検知 ' + unknowns.length + '件', ''];
    for (var u = 0; u < unknowns.length; u++) {
      lines.push('From: ' + unknowns[u].from);
      lines.push('件名: ' + unknowns[u].subject);
      lines.push('日時: ' + unknowns[u].date);
      lines.push('---');
    }
    lines.push('');
    lines.push('※ GASのOTA_SENDERSに未登録の送信元です。');
    lines.push('※ 自動取込されていない可能性があります。要確認。');
    sendSlackAlert_(lines.join('\n'));
    Logger.log('Unknown sender alert sent: ' + unknowns.length + ' email(s)');

    // アラート済みを記録（同じメールで重複通知しない）
    try {
      PropertiesService.getScriptProperties().setProperty(checkedKey, JSON.stringify(alerted));
    } catch (e) {}
  }
}

// セットアップ: 監視トリガー追加（30分間隔）
function setupMonitoring() {
  // 既存の監視トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkHeartbeats') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('checkHeartbeats')
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('Monitoring setup complete: 30-minute heartbeat check trigger created.');
}

// ============================================================
// Message-Level Processed ID Management
// ============================================================
var PROCESSED_MSG_KEY = 'bt_processed_msg_ids';

function getProcessedMsgIds_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_MSG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    Logger.log('[ProcessedMsgIds] Read error: ' + e.message);
    return {};
  }
}

function saveProcessedMsgIds_(ids) {
  try {
    PropertiesService.getScriptProperties().setProperty(PROCESSED_MSG_KEY, JSON.stringify(ids));
  } catch (e) {
    Logger.log('[ProcessedMsgIds] Save error: ' + e.message);
  }
}

/**
 * 一括再スキャン: processed_takamatsuラベル済みスレッドから未処理のキャンセルを検出・処理
 * コード更新後に1回だけGASエディタから手動実行する
 */
function rescanLabeledForMissedCancellations() {
  var label = getOrCreateLabel_(LABEL_NAME);
  var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
  var query = '(' + fromClause + ') label:' + LABEL_NAME + ' newer_than:7d';
  var threads = GmailApp.search(query, 0, 100);
  Logger.log('[Rescan] Found ' + threads.length + ' labeled thread(s) to scan.');

  var fixed = [];
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      var subject = msg.getSubject();

      // キャンセルメールのみ対象
      var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
      if (!isCxl) continue;

      var body = msg.getPlainBody();
      var from = msg.getFrom();

      // OTA判定
      var ota = null;
      var otaKeys = Object.keys(OTA_SENDERS);
      for (var k = 0; k < otaKeys.length; k++) {
        if (from.indexOf(OTA_SENDERS[otaKeys[k]]) !== -1) { ota = otaKeys[k]; break; }
      }
      if (!ota) continue;

      // 予約ID取得
      var resId = (ota === 'rakuten') ? extractField_(body, '・予約番号') : extractField_(body, '予約番号');
      if (!resId) continue;

      // DB確認: confirmed のままなら未処理キャンセル
      var existing = reservationExists_(resId);
      if (!existing || existing.status === 'cancelled') continue;

      // キャンセル処理実行
      Logger.log('[Rescan] Found missed cancellation: ' + resId + ' (' + ota + ')');
      deleteFromFleet_(resId);
      deleteFromTasks_(resId);
      supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(resId), {status: 'cancelled'});
      fixed.push(resId);
      Logger.log('[Rescan] Cancelled: ' + resId);
    }
  }

  if (fixed.length > 0) {
    var msg = '🔄 [再スキャン] 未処理キャンセル ' + fixed.length + '件を修正\n' + fixed.join(', ');
    sendSlackAlert_(msg);
    Logger.log('[Rescan] Fixed ' + fixed.length + ' missed cancellations: ' + fixed.join(', '));
  } else {
    Logger.log('[Rescan] No missed cancellations found.');
  }
}

// ============================================================
// Gmail Helpers
// ============================================================
// 既存メール全てにprocessed_takamatsuラベルを付与（初回セットアップ用・1回だけ実行）
function markAllExistingAsProcessed() {
  var label = getOrCreateLabel_(LABEL_NAME);
  var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
  var query = '(' + fromClause + ') -label:' + LABEL_NAME;
  var threads = GmailApp.search(query, 0, 500);
  Logger.log('Marking ' + threads.length + ' threads as processed_takamatsu');
  for (var i = 0; i < threads.length; i++) {
    threads[i].addLabel(label);
  }
  Logger.log('Done. All existing emails marked as processed_takamatsu.');
}

function getOrCreateLabel_(labelName) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
    Logger.log('Created Gmail label: ' + labelName);
  }
  return label;
}

// ============================================================
// Reprocess: 特定予約IDの再処理（手動実行用）
// ============================================================
/**
 * 指定予約IDのDB+配車状態をSlackに通知する（手動確認用）
 * 「既に配車済みだがSlack通知が来ていない」案件のリカバリ用
 */
function notifyReservations() {
  var targetIds = ['2604001235'];
  var items = [];
  var failures = [];
  for (var i = 0; i < targetIds.length; i++) {
    var id = targetIds[i];
    var res = supabaseGet_('bt_reservations', 'id=eq.' + encodeURIComponent(id) + '&select=*');
    if (res.length === 0) {
      failures.push({id: id, ota: '?', name: '', reason: 'DB未登録'});
      continue;
    }
    var r = res[0];
    var fleet = supabaseGet_('bt_fleet', 'reservation_id=eq.' + encodeURIComponent(id) + '&select=vehicle_code');
    var assignedTo = '未配車';
    if (fleet.length > 0) {
      var veh = supabaseGet_('bt_vehicles', 'code=eq.' + encodeURIComponent(fleet[0].vehicle_code) + '&select=name,plate_no');
      if (veh.length > 0) {
        assignedTo = veh[0].name + ' (' + veh[0].plate_no + ')';
      } else {
        assignedTo = fleet[0].vehicle_code;
      }
    }
    items.push({
      id: id, ota: r.ota, name: r.name,
      dates: r.start_date + '~' + r.end_date,
      vehicle: r.vehicle_class,
      assignedTo: assignedTo
    });
  }
  if (items.length > 0) sendSlackSuccess_(items);
  if (failures.length > 0) sendSlackFailure_(failures);
  Logger.log('notifyReservations: ' + items.length + ' sent, ' + failures.length + ' failed');
}

/**
 * 指定した予約IDのメールを再検索し、再処理する。
 * - DB未登録 → メールを再パース → insert → 自動配車
 * - DB登録済み＆vehicle_class空 → メールからクラス取得 → DB更新 → 自動配車
 * GASエディタから手動実行する。
 */
function reprocessByIds() {
  // ⚠️ 2026-04-27 教訓: targetIds は空配列で保持すること。
  // 「DBに無い」状態 = キャンセル済み予約をAPPで物理削除した正常状態かもしれない。
  // 復元前に必ず Gmail でキャンセルメール有無を verifyMissingRakutenCancelStatus で確認すること。
  // 過去に独断で復元してキャンセル済み顧客10件を復活させる重大インシデントを起こした。
  var targetIds = [];
  var FORCE_REPARSE = true; // DB登録済みだがbase_price/option_price未設定 → 再パース→内訳更新
  var label = getOrCreateLabel_(LABEL_NAME);
  var successes = [];
  var failures = [];

  for (var t = 0; t < targetIds.length; t++) {
    var targetId = targetIds[t];
    Logger.log('=== Reprocessing: ' + targetId + ' (FORCE=' + FORCE_REPARSE + ') ===');

    // 1. DB状態チェック
    var existing = reservationExists_(targetId);

    if (existing && existing.status !== 'cancelled') {
      // DB登録済み
      var fullRes = supabaseGet_('bt_reservations', 'id=eq.' + encodeURIComponent(targetId) + '&select=*');
      if (fullRes.length === 0) {
        failures.push({id: targetId, ota: '?', name: '', reason: 'DB参照失敗'});
        continue;
      }
      var dbRow = fullRes[0];

      // ★FORCE_REPARSE モード: fleet削除→メール再パース→DB更新→再配車
      if (FORCE_REPARSE) {
        Logger.log(targetId + ' FORCE mode: deleting fleet and re-parsing email...');
        deleteFromFleet_(targetId);
        var emailDataF = findEmailByReservationId_(targetId);
        if (!emailDataF) {
          failures.push({id: targetId, ota: dbRow.ota || '?', name: dbRow.name || '', reason: 'メール検索失敗(FORCE)'});
          continue;
        }
        var parsedF = emailDataF.parsed;
        if (!parsedF || !parsedF.vehicle) {
          failures.push({id: targetId, ota: dbRow.ota || '?', name: dbRow.name || '', reason: 'クラス抽出失敗(FORCE)'});
          continue;
        }
        Logger.log(targetId + ' re-parsed class: ' + parsedF.vehicle + ' (was: ' + dbRow.vehicle_class + ')');
        // DB更新（クラス・車種モデル・料金内訳・保険・オプション）
        var updateFields = {vehicle_class: parsedF.vehicle};
        if (parsedF.base_price > 0 || parsedF.option_price > 0) {
          updateFields.base_price = parsedF.base_price || 0;
          updateFields.option_price = parsedF.option_price || 0;
          updateFields.discount = parsedF.discount || 0;
          updateFields.price = parsedF.price || dbRow.price;
          updateFields.amount = parsedF.price || dbRow.price;
        }
        if (parsedF.insurance) updateFields.insurance = parsedF.insurance;
        if (parsedF.opt_b !== undefined) updateFields.opt_b = +(parsedF.opt_b || 0);
        if (parsedF.opt_c !== undefined) updateFields.opt_c = +(parsedF.opt_c || 0);
        if (parsedF.opt_j !== undefined) updateFields.opt_j = +(parsedF.opt_j || 0);
        if (parsedF.flight) updateFields.del_flight = parsedF.flight;
        supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(targetId), updateFields);
        // 再配車
        var fakeResF = {
          id: targetId, vehicle: parsedF.vehicle,
          lend_date: dbRow.start_date, return_date: dbRow.end_date,
          name: dbRow.name, ota: dbRow.ota,
          _vehicleModel: parsedF._vehicleModel || ''
        };
        var assignedF = autoAssignVehicle_(fakeResF);
        if (assignedF) {
          successes.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
            dates: dbRow.start_date + '~' + dbRow.end_date,
            vehicle: parsedF.vehicle, assignedTo: assignedF.name + ' (' + assignedF.plate_no + ')'});
        } else {
          failures.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
            reason: '配車不可（' + parsedF.vehicle + 'クラス空車なし）',
            dates: dbRow.start_date + '~' + dbRow.end_date});
        }
        continue;
      }

      if (dbRow.vehicle_class && dbRow.vehicle_class !== '') {
        // 既にクラスがある → 配車だけ確認
        Logger.log(targetId + ' already has vehicle_class=' + dbRow.vehicle_class + '. Checking fleet...');
        var fleetCheck = supabaseGet_('bt_fleet', 'reservation_id=eq.' + encodeURIComponent(targetId) + '&select=vehicle_code');
        if (fleetCheck.length > 0) {
          Logger.log(targetId + ' already assigned to ' + fleetCheck[0].vehicle_code + '. Skipping.');
          continue;
        }
        // 配車なし → 自動配車を試行
        var fakeRes = {
          id: targetId, vehicle: dbRow.vehicle_class,
          lend_date: dbRow.start_date, return_date: dbRow.end_date, name: dbRow.name, ota: dbRow.ota
        };
        var assigned = autoAssignVehicle_(fakeRes);
        if (assigned) {
          successes.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
            dates: dbRow.start_date + '~' + dbRow.end_date,
            vehicle: dbRow.vehicle_class, assignedTo: assigned.name + ' (' + assigned.plate_no + ')'});
        } else {
          failures.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
            reason: '配車不可（' + dbRow.vehicle_class + 'クラス空車なし）',
            dates: dbRow.start_date + '~' + dbRow.end_date});
        }
        continue;
      }

      // vehicle_class が空 → メールから再取得
      Logger.log(targetId + ' has empty vehicle_class. Searching email...');
      var emailData = findEmailByReservationId_(targetId);
      if (!emailData) {
        failures.push({id: targetId, ota: dbRow.ota || '?', name: dbRow.name || '', reason: 'メール検索失敗'});
        continue;
      }
      var parsed = emailData.parsed;
      if (!parsed || !parsed.vehicle) {
        failures.push({id: targetId, ota: dbRow.ota || '?', name: dbRow.name || '', reason: 'クラス抽出失敗'});
        continue;
      }
      // DB更新
      supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(targetId),
        {vehicle_class: parsed.vehicle});
      Logger.log('Updated vehicle_class=' + parsed.vehicle + ' for ' + targetId);

      // 自動配車
      var fakeRes2 = {
        id: targetId, vehicle: parsed.vehicle,
        lend_date: dbRow.start_date, return_date: dbRow.end_date, name: dbRow.name, ota: dbRow.ota
      };
      var assigned2 = autoAssignVehicle_(fakeRes2);
      if (assigned2) {
        successes.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
          dates: dbRow.start_date + '~' + dbRow.end_date,
          vehicle: parsed.vehicle, assignedTo: assigned2.name + ' (' + assigned2.plate_no + ')'});
      } else {
        failures.push({id: targetId, ota: dbRow.ota, name: dbRow.name,
          reason: '配車不可（' + parsed.vehicle + 'クラス空車なし）',
          dates: dbRow.start_date + '~' + dbRow.end_date});
      }
      continue;
    }

    // 2. DB未登録またはキャンセル済み（OPX93188, C260301451のケース）→ メール再取得＆処理
    Logger.log(targetId + ' not in DB (or cancelled). Searching email...');
    var emailData2 = findEmailByReservationId_(targetId);
    if (!emailData2) {
      failures.push({id: targetId, ota: '?', name: '', reason: 'メール未発見'});
      continue;
    }

    // processed_takamatsuラベルを除去（再処理のため）
    try {
      emailData2.thread.removeLabel(label);
      Logger.log('Removed processed_takamatsu label from thread for ' + targetId);
    } catch (e) {
      Logger.log('Label removal warning: ' + e.message);
    }

    // processMessage_で処理
    var result = processMessage_(emailData2.message, false);

    // 処理後ラベルを再付与
    try { emailData2.thread.addLabel(label); } catch (e) {}

    if (result) {
      if (result.type === 'success') successes.push(result);
      else if (result.type === 'failure') failures.push(result);
      else Logger.log(targetId + ' result: ' + result.type + ' - ' + (result.reason || ''));
    } else {
      failures.push({id: targetId, ota: '?', name: '', reason: 'processMessage_がnullを返した'});
    }
  }

  // 結果通知
  Logger.log('=== Reprocess complete ===');
  Logger.log('Success: ' + successes.length + ', Failure: ' + failures.length);
  if (successes.length > 0) sendSlackSuccess_(successes);
  if (failures.length > 0) sendSlackFailure_(failures);
}

/**
 * 予約番号でGmailを検索し、該当メッセージとパース結果を返す
 */
function findEmailByReservationId_(reservationId) {
  // まずOTA送信元フィルター付きで検索
  var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
  var query = '(' + fromClause + ') ' + reservationId;
  var threads = GmailApp.search(query, 0, 10);

  // 見つからなければ予約番号のみで再検索（from制約を外す）
  if (threads.length === 0) {
    Logger.log('Retry search without from filter: ' + reservationId);
    threads = GmailApp.search('"' + reservationId + '"', 0, 10);
  }

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      var body = msg.getPlainBody();
      if (body.indexOf(reservationId) === -1) continue;

      var subject = msg.getSubject();
      // キャンセルメールはスキップ
      if (CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; })) continue;

      // OTA判定
      var from = msg.getFrom();
      var ota = null;
      var otaKeys = Object.keys(OTA_SENDERS);
      for (var k = 0; k < otaKeys.length; k++) {
        if (from.indexOf(OTA_SENDERS[otaKeys[k]]) !== -1) { ota = otaKeys[k]; break; }
      }
      if (!ota) continue;

      // パース
      var parsed = null;
      switch (ota) {
        case 'jalan':      parsed = parseJalan_(body); break;
        case 'rakuten':    parsed = parseRakuten_(body); break;
        case 'skyticket':  parsed = parseSkyticket_(body); break;
        case 'airtrip':    parsed = parseAirtrip_(body); break;
        case 'airtrip_dp': parsed = parseAirtrip_(body); break;
        case 'official':   parsed = parseOfficial_(body); break;
        case 'gogoout':    parsed = parseGogoout_(body); break;
        case 'rentacar_dc': parsed = parseRentacarDC_(body); break;
        case 'rentacar_dc2': parsed = parseRentacarDC_(body); break;
      }

      if (parsed) {
        Logger.log('Found email for ' + reservationId + ': OTA=' + ota + ' class=' + (parsed.vehicle || 'empty'));
        return {message: msg, thread: threads[i], parsed: parsed, ota: ota};
      }
    }
  }

  Logger.log('Email not found for: ' + reservationId);
  return null;
}

// ============================================================
// booked_at バックフィル（一回限り手動実行）
// bt_reservations.booked_at が null の行をGmailメール受信日時で埋める
// ============================================================
function backfillBookedAt() {
  var fromClause = Object.values(OTA_SENDERS).map(function(s) { return 'from:' + s; }).join(' OR ');
  var query = '(' + fromClause + ')';

  // Gmail全件取得（100件ずつ）
  var allMessages = [];
  var start = 0;
  var batchSize = 100;
  while (true) {
    var threads = GmailApp.search(query, start, batchSize);
    if (threads.length === 0) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        allMessages.push(msgs[j]);
      }
    }
    if (threads.length < batchSize) break;
    start += batchSize;
  }

  Logger.log('[backfill] Total messages: ' + allMessages.length);

  var updated = 0, skipped = 0, errors = 0;

  for (var k = 0; k < allMessages.length; k++) {
    var msg = allMessages[k];
    var from = msg.getFrom();
    var subject = msg.getSubject();
    var body = msg.getPlainBody();
    var msgDate = msg.getDate();

    // キャンセルメールはスキップ
    var isCancellation = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
    if (isCancellation) continue;

    // OTA判定
    var ota = null;
    var otaKeys = Object.keys(OTA_SENDERS);
    for (var oi = 0; oi < otaKeys.length; oi++) {
      if (from.indexOf(OTA_SENDERS[otaKeys[oi]]) !== -1) { ota = otaKeys[oi]; break; }
    }
    if (!ota) continue;

    // 予約通知メールのみ
    if (!OTA_RESERVE_SUBJECTS[ota] || subject.indexOf(OTA_RESERVE_SUBJECTS[ota]) === -1) continue;

    // 予約ID抽出
    var reservationId = extractReservationId_(ota, body);
    if (!reservationId) continue;

    // booked_at が null の行のみ UPDATE（冪等）
    var bookedAtStr = Utilities.formatDate(msgDate, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
    var patchUrl = SUPABASE_URL + '/rest/v1/bt_reservations'
      + '?id=eq.' + encodeURIComponent(reservationId)
      + '&booked_at=is.null';
    var options = {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      payload: JSON.stringify({ booked_at: bookedAtStr }),
      muteHttpExceptions: true
    };

    try {
      var resp = UrlFetchApp.fetch(patchUrl, options);
      var arr = JSON.parse(resp.getContentText());
      if (arr && arr.length > 0) {
        Logger.log('[backfill] Updated: ' + reservationId + ' → ' + bookedAtStr);
        updated++;
      } else {
        skipped++; // already set or not in DB
      }
    } catch (e) {
      Logger.log('[backfill] Error ' + reservationId + ': ' + e.message);
      errors++;
    }

    // 50件ごとに1秒スリープ（レート制限対策）
    if (k > 0 && k % 50 === 0) Utilities.sleep(1000);
  }

  Logger.log('[backfill] Done. updated=' + updated + ' skipped=' + skipped + ' errors=' + errors);
}

// 予約IDを本文から抽出（バックフィル用）
function extractReservationId_(ota, body) {
  if (ota === 'rakuten') {
    return extractField_(body, '・予約番号');
  }
  return extractField_(body, '予約番号');
}

// ============================================================
// Slack → 予約登録 & 自動配車
// チャンネル: #kagawa_reservation_notification (C06KZ56NTDF)
// ============================================================

var SLACK_CHANNEL_RESV_ID = 'C06KZ56NTDF';
var SLACK_RESV_MARKER = '【新規予約】';
var PROCESSED_SLACK_KEY = 'bt_processed_slack_ts';

// --- Slack API ラッパー ---
function slackGet_(endpoint, params) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) { Logger.log('SLACK_BOT_TOKEN not set'); return null; }
  var qs = '';
  if (params) {
    var parts = [];
    for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    qs = '?' + parts.join('&');
  }
  var resp = UrlFetchApp.fetch('https://slack.com/api/' + endpoint + qs, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText());
}

function slackPostApi_(endpoint, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) { Logger.log('SLACK_BOT_TOKEN not set'); return null; }
  var resp = UrlFetchApp.fetch('https://slack.com/api/' + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText());
}

function replySlackThread_(channelId, threadTs, text) {
  return slackPostApi_('chat.postMessage', {
    channel: channelId,
    thread_ts: threadTs,
    text: text
  });
}

// --- 処理済みts管理 ---
function getProcessedSlackTs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_SLACK_KEY) || '{}';
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveProcessedSlackTs_(tsMap) {
  // 3日以上前のエントリを削除
  var cutoff = (Date.now() / 1000) - 3 * 86400;
  var clean = {};
  for (var ts in tsMap) {
    if (Number(ts) > cutoff) clean[ts] = tsMap[ts];
  }
  PropertiesService.getScriptProperties().setProperty(PROCESSED_SLACK_KEY, JSON.stringify(clean));
}

// --- 予約番号自動採番 SP-YYYYMMDD-NNNN ---
function generateSlackReservationId_() {
  var now = new Date();
  var ds = now.getFullYear() + padZero_(now.getMonth() + 1) + padZero_(now.getDate());
  var prefix = 'SP-' + ds + '-';
  var existing = supabaseGet_('bt_reservations', 'id=like.' + encodeURIComponent(prefix + '%') + '&select=id');
  var maxN = 0;
  for (var i = 0; i < existing.length; i++) {
    var n = parseInt(existing[i].id.replace(prefix, ''), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return prefix + ('0000' + (maxN + 1)).slice(-4);
}

// --- Slackメッセージパーサー ---
function parseSlackReservation_(text) {
  var errors = [];
  var lines = text.split('\n');

  function getVal(label) {
    for (var i = 0; i < lines.length; i++) {
      // 全角半角コロン・全角半角スペースすべて対応
      var line = lines[i].replace(/\u3000/g, ' ').trim();
      var m = line.match(new RegExp(label + '[：:][\\s\u3000]*(.+)'));
      if (m) return m[1].replace(/\u3000/g, ' ').trim();
    }
    return '';
  }

  var name = getVal('名前');
  var route = getVal('経路') || 'SP';
  var cls = getVal('クラス');
  var model = getVal('車種');
  var lendRaw = getVal('貸出');
  var returnRaw = getVal('返却');
  var delPlace = getVal('届先') || '高松空港';
  var colPlace = getVal('回収') || '高松空港';
  var priceRaw = getVal('料金');
  var insRaw = getVal('補償');
  var flight = getVal('便名');
  var tel = getVal('TEL') || getVal('電話');
  var basePriceRaw = getVal('基本料金');
  var optionPriceRaw = getVal('オプション');
  var discountRaw = getVal('割引');

  // 必須チェック
  if (!name) errors.push('名前が未入力です');
  if (!cls) errors.push('クラスが未入力です（A/A2/B/B2/C/D/F/H/S）');
  if (!lendRaw) errors.push('貸出日時が未入力です（例: 2026-04-25 09:00）');
  if (!returnRaw) errors.push('返却日時が未入力です（例: 2026-04-28 18:00）');

  // クラスバリデーション
  var validClasses = ['A', 'A2', 'B', 'B2', 'C', 'D', 'F', 'H', 'S'];
  if (cls && validClasses.indexOf(cls.toUpperCase()) === -1) {
    errors.push('クラス「' + cls + '」は無効です。' + validClasses.join('/') + ' から選んでください');
  }
  cls = cls ? cls.toUpperCase() : '';

  // 経路（OTA）バリデーション
  var validRoutes = ['SP', 'HP', 'J', 'R', 'S', 'O', 'RC', 'G'];
  route = route.toUpperCase();
  if (validRoutes.indexOf(route) === -1) {
    errors.push('経路「' + route + '」は無効です。' + validRoutes.join('/') + ' から選んでください');
    route = 'SP';
  }

  // HP/オフィシャル予約で車種未指定チェック
  if (route === 'HP' && !model) {
    errors.push('HP（オフィシャル）予約は車種指定が必須です（例: 車種: アルファード）');
  }

  // 日時パース YYYY-MM-DD HH:MM or YYYY/MM/DD HH:MM or M/D HH:MM
  function parseDateTime(raw) {
    if (!raw) return { date: '', time: '' };
    raw = raw.replace(/\u3000/g, ' ').replace(/\//g, '-').trim();
    // YYYY-MM-DD HH:MM
    var m = raw.match(/(\d{4}-\d{1,2}-\d{1,2})[\s\u3000]+(\d{1,2}:\d{2})/);
    if (m) {
      var parts = m[1].split('-');
      return { date: parts[0] + '-' + padZero_(parts[1]) + '-' + padZero_(parts[2]), time: padZero_(m[2].split(':')[0]) + ':' + m[2].split(':')[1] };
    }
    // M/D HH:MM (年省略→今年)
    m = raw.match(/(\d{1,2})-(\d{1,2})[\s\u3000]+(\d{1,2}:\d{2})/);
    if (m) {
      var yr = new Date().getFullYear();
      return { date: yr + '-' + padZero_(m[1]) + '-' + padZero_(m[2]), time: padZero_(m[3].split(':')[0]) + ':' + m[3].split(':')[1] };
    }
    return { date: '', time: '' };
  }

  var lend = parseDateTime(lendRaw);
  var ret = parseDateTime(returnRaw);
  if (lendRaw && !lend.date) errors.push('貸出日時の形式が不正です（例: 2026-04-25 09:00）');
  if (returnRaw && !ret.date) errors.push('返却日時の形式が不正です（例: 2026-04-28 18:00）');
  if (lend.date && ret.date && lend.date > ret.date) errors.push('返却日が貸出日より前です');

  // 料金パース
  var price = parsePrice_(priceRaw);
  var basePrice = parsePrice_(basePriceRaw);
  var optionPrice = parsePrice_(optionPriceRaw);
  var discount = parsePrice_(discountRaw);
  // 基本料金/オプション/割引が全て0で合計料金があれば、基本料金=合計料金
  if (price > 0 && basePrice === 0 && optionPrice === 0) basePrice = price;

  // 補償
  var insurance = 'なし';
  if (insRaw) {
    var insLower = insRaw.toLowerCase();
    if (insLower.indexOf('フル') >= 0) insurance = 'フル';
    else if (insLower.indexOf('安心') >= 0) insurance = '安心パック';
    else if (insLower.indexOf('noc') >= 0) insurance = 'NOC';
    else if (insLower.indexOf('免責') >= 0 || insLower.indexOf('cdw') >= 0) insurance = '免責';
    else insurance = insRaw;
  }

  // ★ 2026-05-02 マスター値統一: PUB/BDB or DEL/COL 必須
  //   送迎場所キーワード(空港/赤嶺駅) → PUB/BDB
  //   それ以外の場所明記 → DEL/COL
  //   場所空 → PUB/BDB(デフォルト)
  var visitType  = 'PUB';
  var returnType = 'BDB';
  if (delPlace && !/来店|店舗|店頭|ヤード|営業所|高松空港|赤嶺駅|空港/.test(delPlace)) visitType = 'DEL';
  if (colPlace && !/来店|店舗|店頭|ヤード|営業所|高松空港|赤嶺駅|空港/.test(colPlace)) returnType = 'COL';

  var reservation = {
    id: '',  // processSlackReservations で採番
    ota: route,
    name: cleanName_(name),
    lend_date: lend.date,
    lend_time: lend.time,
    return_date: ret.date,
    return_time: ret.time,
    vehicle: cls,
    people: 0,
    insurance: insurance,
    price: price || (basePrice + optionPrice - discount),
    base_price: basePrice,
    option_price: optionPrice,
    discount: discount,
    tel: cleanPhone_(tel),
    mail: '',
    flight: flight,
    del_place: delPlace,
    col_place: colPlace,
    visit_type: visitType,
    return_type: returnType,
    opt_c: 0, opt_j: 0, opt_b: 0,
    _store: '高松',
    _vehicleModel: model,  // HP予約は車種指定配車、その他は空
    _booked_at: new Date().toISOString()
  };

  return { reservation: reservation, errors: errors };
}

// --- メインエントリーポイント ---
function processSlackReservations() {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) {
    Logger.log('[SlackResv] SLACK_BOT_TOKEN not set. Skipping.');
    return;
  }

  var processed = getProcessedSlackTs_();
  var processedKeys = Object.keys(processed);

  // 差分取得: 最新の処理済みts or 24時間前
  var oldest = '0';
  if (processedKeys.length > 0) {
    oldest = processedKeys.sort().pop();
  } else {
    oldest = String((Date.now() / 1000) - 86400);
  }

  // Slack conversations.history
  var result = slackGet_('conversations.history', {
    channel: SLACK_CHANNEL_RESV_ID,
    oldest: oldest,
    limit: '50'
  });

  if (!result || !result.ok) {
    Logger.log('[SlackResv] Slack API error: ' + JSON.stringify(result));
    return;
  }

  var messages = result.messages || [];
  Logger.log('[SlackResv] Fetched ' + messages.length + ' messages since ts=' + oldest);

  var success = 0, failed = 0, skipped = 0;

  for (var i = messages.length - 1; i >= 0; i--) {  // 古い順に処理
    var msg = messages[i];
    var ts = msg.ts;

    // 処理済みスキップ
    if (processed[ts]) { skipped++; continue; }

    // マーカーチェック
    if (!msg.text || msg.text.indexOf(SLACK_RESV_MARKER) === -1) {
      processed[ts] = 'skip';
      continue;
    }

    Logger.log('[SlackResv] Processing ts=' + ts);

    // パース
    var parsed = parseSlackReservation_(msg.text);

    // バリデーションエラー
    if (parsed.errors.length > 0) {
      var errMsg = '❌ 予約登録できません。以下を修正して再投稿してください:\n' +
        parsed.errors.map(function(e) { return '・' + e; }).join('\n');
      replySlackThread_(SLACK_CHANNEL_RESV_ID, ts, errMsg);
      processed[ts] = 'error';
      failed++;
      continue;
    }

    var resv = parsed.reservation;

    // 予約番号採番
    resv.id = generateSlackReservationId_();
    Logger.log('[SlackResv] Generated ID: ' + resv.id);

    // DB登録
    var insertResult = insertReservation_(resv);
    if (!insertResult) {
      replySlackThread_(SLACK_CHANNEL_RESV_ID, ts, '❌ 予約登録失敗: DB登録エラー（' + resv.id + '）');
      processed[ts] = 'db_error';
      failed++;
      continue;
    }

    // 自動配車
    var assigned = autoAssignVehicle_(resv);
    var replyText = '';
    if (assigned) {
      replyText = '✅ 予約登録 + 配車完了\n' +
        '予約番号: ' + resv.id + '\n' +
        '予約者: ' + resv.name + '\n' +
        '経路: ' + resv.ota + '\n' +
        'クラス: ' + resv.vehicle + ' → ' + assigned.name + ' (' + (assigned.plate_no || '') + ')\n' +
        '期間: ' + resv.lend_date + ' ' + resv.lend_time + ' ～ ' + resv.return_date + ' ' + resv.return_time + '\n' +
        '届先: ' + resv.del_place + ' / 回収: ' + resv.col_place;
      if (resv.price > 0) replyText += '\n料金: ¥' + resv.price.toLocaleString();
      if (resv._vehicleModel) replyText += '\n車種指定: ' + resv._vehicleModel;
    } else {
      var reason = resv._vehicleModel ?
        resv.vehicle + 'クラスの「' + resv._vehicleModel + '」に空車がありません' :
        resv.vehicle + 'クラスに空車がありません';
      replyText = '⚠️ 予約登録完了（配車は手動で）\n' +
        '予約番号: ' + resv.id + '\n' +
        '予約者: ' + resv.name + '\n' +
        '経路: ' + resv.ota + '\n' +
        'クラス: ' + resv.vehicle + '\n' +
        '期間: ' + resv.lend_date + ' ' + resv.lend_time + ' ～ ' + resv.return_date + ' ' + resv.return_time + '\n' +
        '配車不可: ' + reason + '\n配車表から手動で配車してください';
    }

    replySlackThread_(SLACK_CHANNEL_RESV_ID, ts, replyText);
    processed[ts] = resv.id;
    success++;
    Logger.log('[SlackResv] Done: ' + resv.id + ' assigned=' + (assigned ? assigned.code : 'none'));
  }

  saveProcessedSlackTs_(processed);
  Logger.log('[SlackResv] Summary: success=' + success + ' failed=' + failed + ' skipped=' + skipped);
  updateHeartbeat_('bt_slack_resv', {success: success, failure: failed, processed: success + failed + skipped});
}

// --- トリガー設定 ---
function setupSlackImport() {
  // 既存の processSlackReservations トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processSlackReservations') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 1分間隔トリガー作成
  ScriptApp.newTrigger('processSlackReservations')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('Slack予約取込トリガー設定完了（1分間隔）');
}

// --- テスト・デバッグ ---
function testSlackParse() {
  var sample = '【新規予約】\n名前: タケモト ショウタ\n経路: HP\nクラス: A\n車種: アルファード\n貸出: 2026-04-25 09:00\n返却: 2026-04-28 18:00\n届先: 高松空港\n回収: 高松空港\n料金: 15000\n補償: NOC\n便名: ANA123\nTEL: 090-1234-5678';
  var result = parseSlackReservation_(sample);
  Logger.log('Errors: ' + JSON.stringify(result.errors));
  Logger.log('Reservation: ' + JSON.stringify(result.reservation));
}

function testSlackParseOta() {
  var sample = '【新規予約】\n名前: ヤマダ タロウ\n経路: SP\nクラス: F\n貸出: 2026-05-01 10:00\n返却: 2026-05-03 17:00\n届先: 高松空港\n回収: 高松空港\n料金: 8000\n補償: 免責';
  var result = parseSlackReservation_(sample);
  Logger.log('Errors: ' + JSON.stringify(result.errors));
  Logger.log('Reservation: ' + JSON.stringify(result.reservation));
  Logger.log('vehicleModel(should be empty): "' + result.reservation._vehicleModel + '"');
}

// ============================================================
// Square 入金ステータス自動チェック（bt_accounting）
// 15分間隔トリガーで実行
// bt_accounting の url 付き＆paid=false のレコードを
// Square Payment Links API → Orders API で入金確認し、
// 入金済みなら paid=true に自動更新する
// ============================================================

function checkNhaAccountingPayments() {
  try {
    // 1. bt_accounting から url付き＆未入金レコードを取得
    var rows = supabaseGet_('bt_accounting',
      'select=id,resv_no,url,paid,amount,type,user_name,date' +
      '&paid=eq.false&url=neq.&order=date.desc&limit=100');

    // url が空文字列の行も除外
    var unpaid = (rows || []).filter(function(r) {
      return r.url && String(r.url).trim().length > 5;
    });

    if (unpaid.length === 0) {
      Logger.log('[NhaPayCheck] No unpaid rows with URL');
      return;
    }
    Logger.log('[NhaPayCheck] Checking ' + unpaid.length + ' unpaid rows');

    // 2. Square API Token取得
    var token = PropertiesService.getScriptProperties().getProperty('SQUARE_API_TOKEN');
    if (!token) {
      Logger.log('[NhaPayCheck] SQUARE_API_TOKEN not set in ScriptProperties');
      try {
        nhaPostToSlackChannel_('C0AP2S5B147', '🔴 *高松会計 入金確認障害*\nSQUARE_API_TOKEN が ScriptProperties に未設定です。\nGASエディタ > プロジェクトの設定 > スクリプトプロパティ から設定してください。');
      } catch(e2) {}
      return;
    }

    // 3. Square Payment Links → order_id マップ取得
    var linkMap = nhaFetchPaymentLinkMap_(token);
    var linkMapSize = linkMap ? Object.keys(linkMap).length : 0;
    if (linkMapSize === 0) {
      Logger.log('[NhaPayCheck] Payment Links map is empty');
      try {
        nhaPostToSlackChannel_('C0AP2S5B147', '🔴 *高松会計 入金確認障害*\nSquare Payment Links APIが0件を返しました。\nトークン期限切れまたはAPI障害の可能性があります。');
      } catch(e2) {}
      return;
    }
    Logger.log('[NhaPayCheck] Payment Links map: ' + linkMapSize + ' entries');

    // 4. URL→order_id マッチング
    var orderIdsToCheck = [];
    for (var i = 0; i < unpaid.length; i++) {
      var normalizedUrl = nhaNormalizeSquareUrl_(unpaid[i].url);
      var orderId = linkMap[normalizedUrl];
      if (orderId) {
        unpaid[i]._orderId = orderId;
        orderIdsToCheck.push(orderId);
      } else {
        Logger.log('[NhaPayCheck] No URL match: id=' + unpaid[i].id + ' url=' + unpaid[i].url);
      }
    }

    if (orderIdsToCheck.length === 0) {
      Logger.log('[NhaPayCheck] No order IDs matched');
      return;
    }

    // 5. Square Orders API で入金確認
    var orderMap = nhaBatchRetrieveOrders_(token, orderIdsToCheck);
    if (!orderMap || Object.keys(orderMap).length === 0) {
      Logger.log('[NhaPayCheck] Orders retrieval returned 0');
      return;
    }

    // 6. 入金済みなら bt_accounting を paid=true に更新
    var paidCount = 0;
    var paidDetails = [];
    for (var i = 0; i < unpaid.length; i++) {
      var row = unpaid[i];
      if (!row._orderId) continue;
      try {
        var paidInfo = nhaIsOrderPaid_(orderMap[row._orderId]);
        if (paidInfo) {
          var ok = supabaseUpdate_('bt_accounting',
            'id=eq.' + encodeURIComponent(row.id),
            { paid: true }
          );
          if (ok) {
            paidCount++;
            paidDetails.push({
              resv_no: row.resv_no || 'なし',
              amount: row.amount || 0,
              user_name: row.user_name || '-',
              type: row.type || '-',
              date: row.date || '-'
            });
            Logger.log('[NhaPayCheck] ✅ Paid: id=' + row.id + ' resv=' + (row.resv_no || '-') + ' ¥' + (row.amount || 0));
          } else {
            Logger.log('[NhaPayCheck] ⚠️ Update failed: id=' + row.id);
          }
        }
      } catch (e) {
        Logger.log('[NhaPayCheck] Error checking id=' + row.id + ': ' + e.message);
      }
    }
    Logger.log('[NhaPayCheck] Done. ' + paidCount + '/' + unpaid.length + ' confirmed paid');

    // 入金があれば #payment_takamatsu にSlack詳細通知
    if (paidCount > 0) {
      try {
        var totalAmount = 0;
        var lines = [];
        paidDetails.forEach(function(d) {
          totalAmount += Number(d.amount) || 0;
          var typeLabel = d.type === 'advance' ? '立替' : d.type === 'extra_sales' ? '予約外売上' : d.type;
          lines.push('• ¥' + Number(d.amount).toLocaleString() + ' | ' + typeLabel + ' | 予約: ' + d.resv_no + ' | ' + d.user_name + ' | ' + d.date);
        });
        var msg = '✅ *高松会計 入金自動確認 ' + paidCount + '件*\n'
          + '合計: ¥' + totalAmount.toLocaleString() + '\n\n'
          + lines.join('\n');
        nhaPostToSlackChannel_('C0AP2S5B147', msg); // #payment_takamatsu
      } catch(e2) {
        Logger.log('[NhaPayCheck] Slack通知エラー: ' + e2.message);
      }
    }
  } catch (e) {
    Logger.log('[NhaPayCheck] Fatal error: ' + e.message);
  }
  updateHeartbeat_('bt_accounting', {success: 1});
}

// --- Square API ヘルパー（高松専用、SPK GASと名前空間分離） ---

function nhaNormalizeSquareUrl_(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function nhaFetchPaymentLinkMap_(token) {
  var map = {}, cursor = null, fetched = 0;
  do {
    var apiUrl = 'https://connect.squareup.com/v2/online-checkout/payment-links?limit=100';
    if (cursor) apiUrl += '&cursor=' + encodeURIComponent(cursor);
    try {
      var resp = UrlFetchApp.fetch(apiUrl, {
        method: 'get',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) {
        Logger.log('[NhaPayLinks] API error ' + resp.getResponseCode());
        break;
      }
      var data = JSON.parse(resp.getContentText());
      (data.payment_links || []).forEach(function(link) {
        if (link.order_id) {
          if (link.url) map[nhaNormalizeSquareUrl_(link.url)] = link.order_id;
          if (link.long_url) map[nhaNormalizeSquareUrl_(link.long_url)] = link.order_id;
        }
      });
      fetched += (data.payment_links || []).length;
      cursor = data.cursor;
    } catch (e) {
      Logger.log('[NhaPayLinks] Fetch error: ' + e.message);
      break;
    }
  } while (cursor && fetched < 300);
  Logger.log('[NhaPayLinks] Total map entries: ' + Object.keys(map).length);
  return map;
}

function nhaBatchRetrieveOrders_(token, orderIds) {
  var map = {}, unique = [], seen = {};
  orderIds.forEach(function(id) {
    if (!seen[id]) { unique.push(id); seen[id] = true; }
  });
  for (var i = 0; i < unique.length; i += 100) {
    try {
      var resp = UrlFetchApp.fetch('https://connect.squareup.com/v2/orders/batch-retrieve', {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Square-Version': '2024-01-18'
        },
        payload: JSON.stringify({
          location_id: 'L8N7J9RKPN3WH',
          order_ids: unique.slice(i, i + 100)
        }),
        muteHttpExceptions: true
      });
      (JSON.parse(resp.getContentText()).orders || []).forEach(function(o) {
        map[o.id] = o;
      });
    } catch (e) {
      Logger.log('[NhaBatchOrders] Error: ' + e.message);
    }
  }
  Logger.log('[NhaBatchOrders] Retrieved ' + Object.keys(map).length + '/' + unique.length + ' orders');
  return map;
}

function nhaIsOrderPaid_(order) {
  if (!order || !order.tenders || order.tenders.length === 0) return null;
  var netDue = order.net_amount_due_money;
  if (netDue && netDue.amount !== 0) return null;
  return { paid_at: order.tenders[0].created_at, order_id: order.id };
}

// --- トリガー設定 ---
function setupNhaPaymentCheck() {
  // 既存トリガー削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkNhaAccountingPayments') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 15分間隔トリガー作成
  ScriptApp.newTrigger('checkNhaAccountingPayments')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✅ 高松会計 入金チェックトリガー設定完了（15分間隔）');
}

// --- デバッグ: 手動実行で全件確認 ---
function debugNhaPaymentCheck() {
  var rows = supabaseGet_('bt_accounting',
    'select=id,resv_no,url,paid,amount,type,user_name' +
    '&url=neq.&limit=50&order=date.desc');

  var withUrl = (rows || []).filter(function(r) {
    return r.url && String(r.url).trim().length > 5;
  });

  Logger.log('=== bt_accounting URL付き全件 ===');
  Logger.log('件数: ' + withUrl.length);
  withUrl.forEach(function(r) {
    Logger.log((r.paid ? '✅' : '⏳') + ' id=' + r.id + ' resv=' + (r.resv_no || '-') + ' ¥' + (r.amount || 0) + ' url=' + r.url);
  });

  // Square Payment Links マップ取得テスト
  var token = PropertiesService.getScriptProperties().getProperty('SQUARE_API_TOKEN');
  if (!token) { Logger.log('⚠️ SQUARE_API_TOKEN未設定'); return; }
  var linkMap = nhaFetchPaymentLinkMap_(token);
  Logger.log('Payment Links マップ: ' + Object.keys(linkMap).length + '件');

  // マッチングテスト
  var matched = 0, unmatched = 0;
  withUrl.forEach(function(r) {
    var norm = nhaNormalizeSquareUrl_(r.url);
    if (linkMap[norm]) {
      matched++;
      Logger.log('✅ MATCH: id=' + r.id + ' → orderId=' + linkMap[norm]);
    } else {
      unmatched++;
      Logger.log('❌ NO MATCH: id=' + r.id + ' url=' + r.url);
    }
  });
  Logger.log('マッチ: ' + matched + '件, 不一致: ' + unmatched + '件');
}

// ============================================================
// じゃらん事前決済システム（高松店）
// ============================================================
var NAHA_JALAN_PAY_CHANNEL = 'C0AP2S5B147'; // #payment_takamatsu
var NHA_SQUARE_LOCATION_ID = 'L8N7J9RKPN3WH';

function nhaGetSquareToken_() {
  return PropertiesService.getScriptProperties().getProperty('SQUARE_API_TOKEN');
}

function nhaGetSlackBotToken_() {
  return PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
}

// --- Slack Bot API投稿（ts返却）---
function nhaPostToSlackChannel_(channel, text) {
  var token = nhaGetSlackBotToken_();
  if (!token) { Logger.log('[NhaSlack] No SLACK_BOT_TOKEN'); return null; }
  try {
    var resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
      payload: JSON.stringify({channel: channel, text: text}),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data.ok) return data.ts;
    Logger.log('[NhaSlack] Post error: ' + data.error);
    return null;
  } catch (e) { Logger.log('[NhaSlack] Exception: ' + e.message); return null; }
}

// --- Square決済リンク作成 ---
function nhaCreateSquarePaymentLink_(itemName, amount) {
  var token = nhaGetSquareToken_();
  if (!token) { Logger.log('[NhaSquare] No SQUARE_API_TOKEN'); return null; }
  try {
    var resp = UrlFetchApp.fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'post',
      headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Square-Version': '2024-01-18'},
      payload: JSON.stringify({
        idempotency_key: Utilities.getUuid(),
        quick_pay: {
          name: itemName,
          price_money: {amount: amount, currency: 'JPY'},
          location_id: NHA_SQUARE_LOCATION_ID
        }
      }),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data.payment_link && data.payment_link.url) {
      Logger.log('[NhaSquare] Link created: ' + data.payment_link.url);
      return data.payment_link.url;
    }
    Logger.log('[NhaSquare] API error: ' + resp.getContentText());
    return null;
  } catch (e) { Logger.log('[NhaSquare] Exception: ' + e.message); return null; }
}

// --- じゃらん新規予約 → 決済リンク生成＋DB保存＋Slack通知 ---
function nhaHandleJalanPayment_(reservation) {
  var resId = reservation.id;

  // 重複チェック
  var existing = supabaseGet_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(resId) + '&select=id');
  if (existing && existing.length > 0) { Logger.log('[NhaJalanPay] Already exists: ' + resId); return; }

  // 1. Square決済リンク作成
  var lendShort = (reservation.lend_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
  var retShort = (reservation.return_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
  var itemName = 'BUDDICA TOURING 高松店 ' + (reservation.name || '') + '様（' + resId + '） じゃらん事前決済 ' + lendShort + '-' + retShort;
  var payUrl = nhaCreateSquarePaymentLink_(itemName, reservation.price || 0);

  if (!payUrl) {
    // Square API失敗 → status='new'で保存（nhaCheckSquareLinksでリトライ）
    var payData = {reservation_id: resId, customer_name: reservation.name, customer_email: reservation.mail || '', amount: reservation.price || 0, status: 'new', lend_date: reservation.lend_date, return_date: reservation.return_date, vehicle_class: reservation.vehicle || ''};
    supabasePost_('bt_jalan_payments', payData);
    nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *Squareリンク作成失敗*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + resId + '\n宛名： ' + reservation.name + '\n金額： ¥' + (reservation.price || 0) + '\n→ nhaCheckSquareLinksトリガーでリトライします');
    Logger.log('[NhaJalanPay] Square link failed, saved as new: ' + resId);
    return;
  }

  // 2. DB保存
  var now = new Date().toISOString();
  var payData = {reservation_id: resId, customer_name: reservation.name, customer_email: reservation.mail || '', amount: reservation.price || 0, status: 'link_created', square_payment_url: payUrl, link_created_at: now, lend_date: reservation.lend_date, return_date: reservation.return_date, vehicle_class: reservation.vehicle || ''};
  var inserted = supabasePost_('bt_jalan_payments', payData);
  if (!inserted) { Logger.log('[NhaJalanPay] DB insert failed: ' + resId); return; }
  Logger.log('[NhaJalanPay] Created: ' + resId + ' ¥' + reservation.price + ' → ' + payUrl);

  // 3. Slack投稿
  var slackText = '💳 *じゃらん事前決済*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + resId + '\n宛名： ' + reservation.name + '\n品目： じゃらん事前決済(' + lendShort + '-' + retShort + ')\n金額： ¥' + (reservation.price || 0).toLocaleString() + '\nSquareリンク： ' + payUrl;
  var slackTs = nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, slackText);
  if (slackTs) {
    supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(resId), {slack_ts: slackTs});
  }

  // 4. スプレッドシートに記録
  nhaAppendToPaymentSheet_({reservation_id: resId, customer_name: reservation.name, amount: reservation.price || 0, lend_date: reservation.lend_date, return_date: reservation.return_date, slack_ts: slackTs || ''}, payUrl);
}

// --- じゃらんキャンセル → 決済状態更新 ---
function nhaHandleJalanPaymentCancel_(reservationId) {
  var rows = supabaseGet_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(reservationId) + '&select=id,status,amount,customer_name');
  if (!rows || rows.length === 0) return;
  var pay = rows[0];
  var prevStatus = pay.status;
  if (prevStatus === 'cancelled' || prevStatus === 'refund' || prevStatus === 'refunded') { Logger.log('[NhaJalanPayCancel] Already cancelled/refunded: ' + reservationId); return; }
  var now = new Date().toISOString();
  if (prevStatus === 'paid') {
    supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(reservationId), {status: 'refund', cancelled_at: now});
    nhaUpdatePaymentSheetStatus_(reservationId, '⚠️ 要返金', '');
    nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '⚠️ *返金対応必要*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + reservationId + '\n宛名： ' + (pay.customer_name || '') + '\n金額： ¥' + (pay.amount || 0) + '\n状態： 入金済みキャンセル → *要Square返金*');
  } else {
    supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(reservationId), {status: 'cancelled', cancelled_at: now});
    nhaUpdatePaymentSheetStatus_(reservationId, '❌ キャンセル', '');
    nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔄 *キャンセル（決済前）*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + reservationId + '\n宛名： ' + (pay.customer_name || '') + '\n金額： ¥' + (pay.amount || 0) + '\n状態： 未入金キャンセル・対応不要');
  }
  Logger.log('[NhaJalanPayCancel] Done: ' + reservationId + ' → ' + (prevStatus === 'paid' ? 'refund' : 'cancelled'));
}

// --- Squareリンクリトライ + メール送信（5分トリガー）---
function nhaCheckSquareLinks() {
  var rows = supabaseGet_('bt_jalan_payments', 'status=in.(new,link_created)&select=reservation_id,customer_name,customer_email,amount,status,slack_ts,lend_date,return_date,square_payment_url,vehicle_class');
  // ★ FIX 2026-05-01: 0件でもハートビートを更新する。
  //   旧コード: 0件 early return → updateHeartbeat 呼ばれず → 監視画面で「停止」誤検知
  if (!rows || rows.length === 0) {
    updateHeartbeat_('bt_jalan_links', {success: 0, processed: 0});
    return;
  }

  for (var i = 0; i < rows.length; i++) {
    var pay = rows[i];

    // status=new: Squareリンク作成リトライ
    if (pay.status === 'new') {
      var lendShort = (pay.lend_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
      var retShort = (pay.return_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
      var itemName = 'BUDDICA TOURING 高松店 ' + (pay.customer_name || '') + '様（' + pay.reservation_id + '） じゃらん事前決済 ' + lendShort + '-' + retShort;
      var payUrl = nhaCreateSquarePaymentLink_(itemName, pay.amount || 0);
      if (!payUrl) { Logger.log('[NhaCheckLinks] Retry failed: ' + pay.reservation_id); continue; }
      var now = new Date().toISOString();
      supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {square_payment_url: payUrl, status: 'link_created', link_created_at: now});
      Logger.log('[NhaCheckLinks] Retry success: ' + pay.reservation_id + ' → ' + payUrl);
      var slackText = '💳 *じゃらん事前決済（リトライ成功）*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + pay.reservation_id + '\n宛名： ' + pay.customer_name + '\n金額： ¥' + (pay.amount || 0).toLocaleString() + '\nSquareリンク： ' + payUrl;
      var slackTs = nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, slackText);
      if (slackTs && !pay.slack_ts) { supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {slack_ts: slackTs}); }
      nhaAppendToPaymentSheet_(pay, payUrl);
      pay.square_payment_url = payUrl;
      pay.status = 'link_created';
    }

    // status=link_created: メール送信
    if (pay.status === 'link_created' && pay.square_payment_url && pay.customer_email) {
      var sent = nhaSendJalanPaymentEmail_(pay);
      if (sent) {
        supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {status: 'email_sent', email_sent_at: new Date().toISOString()});
        nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '📧 *メール送信完了*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + pay.reservation_id + '\n宛名： ' + pay.customer_name + '\n金額： ¥' + pay.amount);
        Logger.log('[NhaCheckLinks] Email sent: ' + pay.reservation_id);
      }
    }
  }
  updateHeartbeat_('bt_jalan_links', {success: 1});
}

// --- 決済案内メール送信（高松テンプレート）---
function nhaSendJalanPaymentEmail_(pay) {
  if (!pay || !pay.customer_email || !pay.square_payment_url) { Logger.log('[NhaJalanEmail] BLOCKED: missing data'); return false; }
  try {
    var subject = '【レンタカー BUDDICA TOURING BUDDICA TOURING 高松店】事前決済・LINE登録のお願い（予約番号: ' + pay.reservation_id + '）';
    var body = (pay.customer_name || '') + ' 様\n\n'
      + 'この度はBUDDICA TOURING BUDDICA TOURING 高松店をご予約いただき、誠にありがとうございます。\n'
      + '予約番号: ' + pay.reservation_id + '\n'
      + '貸出日: ' + (pay.lend_date || '') + '\n'
      + '返却日: ' + (pay.return_date || '') + '\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ STEP1: LINE登録（必須）\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '送迎/デリバリー共に当日のご連絡はLINEで行います。\n'
      + '下記リンクから友だち追加をお願いいたします。\n\n'
      + 'LINE公式👉 https://lin.ee/jMU6xdJ\n'
      + 'LINE ID👉 @466dbckq\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ STEP2: 事前決済（BUDDICA TOURINGではご出発までの「待ち時間」「待機時間」を解消するため事前決済をお願いしております。）\n'
      + '・現金決済をご希望の場合は大変お手数ですが事前にお問い合わせをお願い申しあげます。\n'
      + '・詳細はLINEにてご案内いたします。\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + 'お支払い金額: ¥' + (pay.amount || 0).toLocaleString() + '\n'
      + '下記リンクよりお支払いをお願いいたします。\n'
      + pay.square_payment_url + '\n\n'
      + '※ ご出発3日前の19:00までにお支払いください。\n'
      + '※ 期限を過ぎた場合、ご予約をキャンセルさせていただく場合がございます。\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ ご利用当日の流れ\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '高松空港到着後、レンタカー送迎バス乗り場【11番】にお越しください。\n'
      + 'BUDDICA TOURINGのシャトルバスで営業所までお送りいたします。\n'
      + 'デリバリーサービスをご利用の場合はご指定場所に「お届け」「回収」させていただきます。\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ ご注意事項\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '・現金決済をご希望の場合は大変お手数ですが事前にお問い合わせをお願い申しあげます。\n'
      + '・詳細はLINEにてご案内いたします。\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + 'BUDDICA TOURING BUDDICA TOURING 高松店\n'
      + 'TEL: 050-1724-6197（9:00〜19:00）\n'
      + 'LINE ID👉 @466dbckq\n';
    GmailApp.sendEmail(pay.customer_email, subject, body, {name: 'BUDDICA TOURING BUDDICA TOURING 高松店', from: 'reserve@rent-buddica-touring.jp', replyTo: 'reserve@rent-buddica-touring.jp'});
    return true;
  } catch (e) { Logger.log('[NhaJalanEmail] Error: ' + e.message); return false; }
}

// --- じゃらん決済 入金確認（15分トリガー）---
function nhaCheckJalanPaymentStatus() {
  // email_sent の行を対象（link_createdも念のため含める）
  var rows = supabaseGet_('bt_jalan_payments', 'status=in.(email_sent,link_created)&select=id,reservation_id,customer_name,amount,square_payment_url,lend_date,return_date,vehicle_class');
  // ★ FIX 2026-05-01: 0件でもハートビートを更新する（監視画面で誤停止検知防止）
  if (!rows || rows.length === 0) {
    Logger.log('[NhaJalanPayStatus] No pending rows');
    updateHeartbeat_('bt_jalan_payment', {success: 0, processed: 0});
    return;
  }
  Logger.log('[NhaJalanPayStatus] Checking ' + rows.length + ' rows');

  var token = nhaGetSquareToken_();
  if (!token) { Logger.log('[NhaJalanPayStatus] No SQUARE_API_TOKEN'); nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *じゃらん決済 入金確認障害*\nSQUARE_API_TOKENが未設定です。'); return; }

  var linkMap = nhaFetchPaymentLinkMap_(token);
  var linkMapSize = linkMap ? Object.keys(linkMap).length : 0;
  if (linkMapSize === 0) { Logger.log('[NhaJalanPayStatus] Payment Links map empty'); nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *じゃらん決済 入金確認障害*\nSquare Payment Links APIが0件を返しました。'); return; }

  var orderIdsToCheck = [];
  for (var i = 0; i < rows.length; i++) {
    var normalizedUrl = nhaNormalizeSquareUrl_(rows[i].square_payment_url);
    var orderId = linkMap[normalizedUrl];
    if (orderId) { rows[i]._orderId = orderId; orderIdsToCheck.push(orderId); }
    else { Logger.log('[NhaJalanPayStatus] No URL match: ' + rows[i].reservation_id); }
  }
  if (orderIdsToCheck.length === 0) { Logger.log('[NhaJalanPayStatus] No order IDs matched'); return; }

  var orderMap = nhaBatchRetrieveOrders_(token, orderIdsToCheck);
  if (!orderMap || Object.keys(orderMap).length === 0) { Logger.log('[NhaJalanPayStatus] Orders retrieval 0'); return; }

  var paidCount = 0;
  for (var i = 0; i < rows.length; i++) {
    var pay = rows[i];
    if (!pay._orderId) continue;
    try {
      var paidInfo = nhaIsOrderPaid_(orderMap[pay._orderId]);
      if (paidInfo) {
        supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {status: 'paid', paid_at: paidInfo.paid_at});
        nhaUpdatePaymentSheetStatus_(pay.reservation_id, '✅ 入金済み', paidInfo.paid_at);
        nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '✅ *入金確認完了*\n店舗： BUDDICA TOURING 高松店\n予約番号： ' + pay.reservation_id + '\n宛名： ' + pay.customer_name + '\n金額： ¥' + (pay.amount || 0).toLocaleString());
        Logger.log('[NhaJalanPayStatus] ✅ Paid: ' + pay.reservation_id);
        paidCount++;
      }
    } catch (e) { Logger.log('[NhaJalanPayStatus] Error: ' + pay.reservation_id + ': ' + e.message); }
  }
  Logger.log('[NhaJalanPayStatus] Done. ' + paidCount + '/' + rows.length + ' confirmed paid');
  updateHeartbeat_('bt_jalan_payment', {success: paidCount, processed: rows.length});
}

// ============================================================
// 【1重目】入金確認 — nhaCheckJalanPaymentStatus（15分間隔）
//   → DB(bt_jalan_payments)のemail_sent/link_created → Square API → paid更新
//   ↑ 既に上に実装済み
// ============================================================

// ============================================================
// 【2重目】DB↔スプシ突合パトロール（1時間間隔）
//   - DB=paid なのにシート=未払い → シート自動修正 + Slack警告
//   - シート=入金済み なのにDB≠paid → DB自動修正 + Slack警告
// ★ 2026-05-05: 「メール送信後24時間以上未入金」エスカレーション通知は不要のため削除
//   （日次9時の nhaCheckJalanUnpaidAlert で「出発3日前以内」のみ通知する設計に集約）
// ============================================================
function nhaReconcilePaymentSheet() {
  try {
    var sheetId = '1-QU8JwrGgwp9CcZT6QieYQH0y112Hb4I5GoobrrM6tc';
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('支払い管理');
    if (!sheet) { Logger.log('[Reconcile] Sheet not found'); return; }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    // スプシ全行取得（高松のみ対象）
    var data = sheet.getRange(2, 1, lastRow - 1, 14).getValues();
    var takamatsuRows = [];
    for (var i = 0; i < data.length; i++) {
      var store = String(data[i][2] || '');
      if (store.indexOf('高松') >= 0) {
        takamatsuRows.push({rowIndex: i + 2, reservationId: String(data[i][3] || '').trim(), sheetStatus: String(data[i][8] || ''), url: String(data[i][7] || '').trim()});
      }
    }
    if (takamatsuRows.length === 0) { Logger.log('[Reconcile] No takamatsu rows'); return; }

    // DB全件取得
    var dbRows = supabaseGet_('bt_jalan_payments', 'select=reservation_id,status,paid_at,created_at,lend_date,customer_name,amount&limit=500');
    var dbMap = {};
    (dbRows || []).forEach(function(r) { dbMap[r.reservation_id] = r; });

    var fixes = [];
    var now = new Date();

    for (var i = 0; i < takamatsuRows.length; i++) {
      var sr = takamatsuRows[i];
      var db = dbMap[sr.reservationId];
      if (!db) continue;

      var sheetIsPaid = sr.sheetStatus.indexOf('済') >= 0;
      var dbIsPaid = db.status === 'paid';

      // 不整合1: DB=paid, シート≠paid → シート自動修正
      if (dbIsPaid && !sheetIsPaid) {
        sheet.getRange(sr.rowIndex, 9).setValue('✅ 入金済み');
        if (db.paid_at) sheet.getRange(sr.rowIndex, 10).setValue(Utilities.formatDate(new Date(db.paid_at), 'Asia/Tokyo', 'yyyy/MM/dd'));
        fixes.push('📋→✅ ' + sr.reservationId + '（DB=paid, シート=' + sr.sheetStatus + '→自動修正）');
      }

      // 不整合2: シート=入金済み, DB≠paid → DB自動修正
      if (sheetIsPaid && !dbIsPaid && db.status !== 'cancelled' && db.status !== 'refund' && db.status !== 'refunded') {
        supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(sr.reservationId), {status: 'paid', paid_at: now.toISOString()});
        fixes.push('🗄→✅ ' + sr.reservationId + '（シート=入金済み, DB=' + db.status + '→自動修正）');
      }
    }

    // 不整合修正通知（自動修正があった場合のみ）
    if (fixes.length > 0) {
      nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔧 *DB↔シート不整合 自動修正（高松）*\n' + fixes.join('\n'));
      Logger.log('[Reconcile] Fixed ' + fixes.length + ' inconsistencies');
    }

    Logger.log('[Reconcile] Done. Takamatsu rows: ' + takamatsuRows.length + ', Fixes: ' + fixes.length);
  } catch (e) { Logger.log('[Reconcile] Error: ' + e.message); }
}

// ============================================================
// 【3重目】Square直接照合 + 日次サマリー（毎日18時）
//   - Square APIで全Payment Links→入金済みOrders検出
//   - DB側でpaidになっていない行があれば自動修正
//   - 日次サマリーを#payment_takamatsuに投稿
// ============================================================
function nhaSquareDirectAudit() {
  try {
    var token = nhaGetSquareToken_();
    if (!token) { nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *Square監査障害*\nSQUARE_API_TOKEN未設定'); return; }

    // DB全件取得（cancelled/refunded以外）
    var dbRows = supabaseGet_('bt_jalan_payments', 'status=neq.cancelled&status=neq.refunded&select=reservation_id,status,amount,customer_name,square_payment_url,lend_date&limit=500');
    if (!dbRows || dbRows.length === 0) { Logger.log('[Audit] No rows to audit'); return; }

    // URL付きの行だけ対象
    var urlRows = dbRows.filter(function(r) { return r.square_payment_url && r.square_payment_url.length > 5; });
    if (urlRows.length === 0) { Logger.log('[Audit] No rows with URLs'); return; }

    // Square Payment Links → order_id マップ
    var linkMap = nhaFetchPaymentLinkMap_(token);
    if (!linkMap || Object.keys(linkMap).length === 0) { nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *Square監査障害*\nPayment Links API 0件'); return; }

    // order_id収集
    var orderIdsToCheck = [];
    for (var i = 0; i < urlRows.length; i++) {
      var normalizedUrl = nhaNormalizeSquareUrl_(urlRows[i].square_payment_url);
      var orderId = linkMap[normalizedUrl];
      if (orderId) { urlRows[i]._orderId = orderId; orderIdsToCheck.push(orderId); }
    }

    if (orderIdsToCheck.length === 0) { Logger.log('[Audit] No order IDs matched'); return; }

    // Square Orders API で入金状態チェック
    var orderMap = nhaBatchRetrieveOrders_(token, orderIdsToCheck);
    if (!orderMap) orderMap = {};

    var autoFixed = [], confirmed = [], unpaidList = [];

    for (var i = 0; i < urlRows.length; i++) {
      var pay = urlRows[i];
      if (!pay._orderId) { unpaidList.push(pay); continue; }

      var paidInfo = nhaIsOrderPaid_(orderMap[pay._orderId]);
      if (paidInfo) {
        if (pay.status === 'paid') {
          confirmed.push(pay); // 正常: DB=paid, Square=paid
        } else {
          // 【自動修正】Square=paid なのに DB≠paid → 見逃し検知！
          supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {status: 'paid', paid_at: paidInfo.paid_at});
          nhaUpdatePaymentSheetStatus_(pay.reservation_id, '✅ 入金済み', paidInfo.paid_at);
          autoFixed.push(pay);
          nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔍 *Square直接検知で入金確認*\n予約番号： ' + pay.reservation_id + '\n宛名： ' + pay.customer_name + '\n金額： ¥' + (pay.amount || 0).toLocaleString() + '\n⚠️ 1重目チェックで見逃されていた入金を3重目で検知しました');
        }
      } else {
        unpaidList.push(pay);
      }
    }

    // 日次サマリー
    var summaryLines = [
      '📊 *じゃらん決済 日次サマリー（高松 ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd') + '）*',
      '',
      '✅ 入金済: ' + (confirmed.length + autoFixed.length) + '件',
      '⏳ 未入金: ' + unpaidList.length + '件'
    ];
    if (autoFixed.length > 0) {
      summaryLines.push('🔍 本日自動修正: ' + autoFixed.length + '件（見逃し検知）');
      autoFixed.forEach(function(p) { summaryLines.push('  → ' + p.reservation_id + ' ' + p.customer_name + ' ¥' + p.amount); });
    }
    if (unpaidList.length > 0) {
      summaryLines.push('');
      summaryLines.push('*未入金一覧:*');
      var now = new Date();
      unpaidList.forEach(function(p) {
        var diffDays = p.lend_date ? Math.floor((new Date(p.lend_date + 'T00:00:00+09:00') - now) / 86400000) : 999;
        var urgency = diffDays <= 0 ? '🔴超過' : diffDays <= 1 ? '🟠明日' : diffDays <= 3 ? '🟡' + diffDays + '日' : diffDays + '日';
        summaryLines.push('• ' + p.reservation_id + ' ' + (p.customer_name || '') + ' ¥' + (p.amount || 0) + '（' + urgency + '）');
      });
    }
    nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, summaryLines.join('\n'));

    Logger.log('[Audit] Done. Confirmed: ' + confirmed.length + ', AutoFixed: ' + autoFixed.length + ', Unpaid: ' + unpaidList.length);
  } catch (e) {
    Logger.log('[Audit] Error: ' + e.message);
    nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, '🔴 *Square監査エラー*\n' + e.message);
  }
}

// ============================================================
// 未入金アラート強化版（日次9時）— エスカレーション階層
//   - 出発3日前: #payment_takamatsu
//   - 出発1日前/当日: #payment_takamatsu + #kagawa_operations-team
// ============================================================
function nhaCheckJalanUnpaidAlert() {
  var SLACK_OPS = 'C06L91W6T08'; // #kagawa_operations-team
  var rows = supabaseGet_('bt_jalan_payments', 'status=in.(new,link_created,email_sent)&select=reservation_id,customer_name,amount,lend_date,status,square_payment_url');
  if (!rows || rows.length === 0) return;

  var now = new Date(), normalAlerts = [], urgentAlerts = [];
  for (var i = 0; i < rows.length; i++) {
    var pay = rows[i];
    if (!pay.lend_date) continue;
    var diffDays = Math.floor((new Date(pay.lend_date + 'T00:00:00+09:00') - now) / 86400000);
    if (diffDays <= 3) {
      var item = {reservationId: pay.reservation_id, customerName: pay.customer_name, amount: pay.amount, lendDate: pay.lend_date, daysLeft: diffDays, status: pay.status, url: pay.square_payment_url || ''};
      if (diffDays <= 1) { urgentAlerts.push(item); } else { normalAlerts.push(item); }
    }
  }

  var allAlerts = urgentAlerts.concat(normalAlerts);
  if (allAlerts.length === 0) return;

  // #payment_takamatsu に全件通知
  var lines = ['🚨 *じゃらん未入金アラート（高松）* ' + allAlerts.length + '件\n'];
  allAlerts.forEach(function(a) {
    var urgency = a.daysLeft <= 0 ? '🔴期限超過' : a.daysLeft <= 1 ? '🟠明日出発' : '🟡' + a.daysLeft + '日後';
    var statusLabel = a.status === 'new' ? '(リンク未作成)' : a.status === 'link_created' ? '(メール未送信)' : '';
    lines.push('• ' + a.reservationId + ' ' + a.customerName + ' ¥' + a.amount + '（出発: ' + a.lendDate + ' ' + urgency + '）' + statusLabel);
  });
  lines.push('\n期限超過・要電話確認');
  nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, lines.join('\n'));

  // 🔴 緊急: 出発1日前/当日 → #kagawa_operations-team にもエスカレーション
  if (urgentAlerts.length > 0) {
    var urgLines = ['🚨🚨 *【緊急】じゃらん未入金（高松）* ' + urgentAlerts.length + '件\n出発当日または明日の未入金です。即座に電話確認してください。\n'];
    urgentAlerts.forEach(function(a) {
      var urgency = a.daysLeft <= 0 ? '🔴本日出発' : '🟠明日出発';
      urgLines.push('• ' + a.reservationId + ' ' + a.customerName + ' ¥' + a.amount + ' ' + urgency);
      if (a.url) urgLines.push('  Square: ' + a.url);
    });
    nhaPostToSlackChannel_(SLACK_OPS, urgLines.join('\n'));
  }

  Logger.log('[NhaUnpaidAlert] ' + allAlerts.length + '件通知（緊急: ' + urgentAlerts.length + '件）');
}

// --- スプレッドシート連携（BUDDICA TOURING 支払い管理シートに高松店として記録）---
function nhaAppendToPaymentSheet_(pay, payUrl) {
  try {
    var sheetId = '1-QU8JwrGgwp9CcZT6QieYQH0y112Hb4I5GoobrrM6tc';
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('支払い管理');
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var existingIds = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
      for (var i = 0; i < existingIds.length; i++) { if (String(existingIds[i][0]).trim() === pay.reservation_id) { Logger.log('[NhaSheet] Already exists: ' + pay.reservation_id); return; } }
    }
    var lendShort = (pay.lend_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
    var retShort = (pay.return_date || '').replace(/^\d{4}-/, '').replace(/-/g, '/');
    sheet.appendRow([lastRow, Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd'), 'BUDDICA TOURING 高松店', pay.reservation_id, (pay.customer_name || '') + '様', 'じゃらん事前決済(' + lendShort + '-' + retShort + ')', pay.amount || 0, payUrl || pay.square_payment_url || '', '⏳ 未払い', '', '', pay.slack_ts || '', NAHA_JALAN_PAY_CHANNEL || '', 'じゃらん']);
    Logger.log('[NhaSheet] Appended: ' + pay.reservation_id);
  } catch (e) { Logger.log('[NhaSheet] Append error: ' + e.message); }
}

function nhaUpdatePaymentSheetStatus_(reservationId, newStatus, paidDate) {
  try {
    var sheetId = '1-QU8JwrGgwp9CcZT6QieYQH0y112Hb4I5GoobrrM6tc';
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('支払い管理');
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var resIds = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
    for (var i = 0; i < resIds.length; i++) {
      if (String(resIds[i][0]).trim() === reservationId) {
        sheet.getRange(i + 2, 9).setValue(newStatus);
        if (paidDate) sheet.getRange(i + 2, 10).setValue(Utilities.formatDate(new Date(paidDate), 'Asia/Tokyo', 'yyyy/MM/dd'));
        Logger.log('[NhaSheet] Status updated: ' + reservationId + ' → ' + newStatus);
        return;
      }
    }
  } catch (e) { Logger.log('[NhaSheet] Status update error: ' + e.message); }
}

// --- トリガー一括設定（3重パトロール対応）---
function setupNhaJalanPayment() {
  // 既存トリガー削除
  var targets = ['nhaCheckSquareLinks', 'nhaCheckJalanPaymentStatus', 'nhaCheckJalanUnpaidAlert', 'nhaReconcilePaymentSheet', 'nhaSquareDirectAudit'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 【メール送信】nhaCheckSquareLinks: 5分間隔（リンクリトライ + メール送信）
  ScriptApp.newTrigger('nhaCheckSquareLinks')
    .timeBased()
    .everyMinutes(5)
    .create();

  // 【1重目】nhaCheckJalanPaymentStatus: 15分間隔（DB→Square API入金確認）
  ScriptApp.newTrigger('nhaCheckJalanPaymentStatus')
    .timeBased()
    .everyMinutes(15)
    .create();

  // 【2重目】nhaReconcilePaymentSheet: 1時間間隔（DB↔スプシ突合 + エスカレーション）
  ScriptApp.newTrigger('nhaReconcilePaymentSheet')
    .timeBased()
    .everyHours(1)
    .create();

  // 【3重目】nhaSquareDirectAudit: 日次18時（Square直接照合 + 日次サマリー）
  ScriptApp.newTrigger('nhaSquareDirectAudit')
    .timeBased()
    .atHour(18)
    .everyDays(1)
    .create();

  // 未入金アラート: 日次9時（エスカレーション階層付き）
  ScriptApp.newTrigger('nhaCheckJalanUnpaidAlert')
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .create();

  Logger.log('✅ 高松じゃらん決済 3重パトロール設定完了（5分/15分/1時間/日次9時/日次18時）');
}

// --- デバッグ用 ---
// --- テスト: 自分宛にメール送信して差出人名・件名・本文を確認 ---
function testNhaJalanEmail() {
  nhaSendJalanPaymentEmail_({
    reservation_id: 'TEST-001',
    customer_name: 'テスト太郎',
    customer_email: 'noritaka.oshita@gmail.com',
    amount: 10000,
    lend_date: '2026-05-01',
    return_date: '2026-05-03',
    square_payment_url: 'https://square.link/u/TEST'
  });
  Logger.log('✅ テストメール送信完了 → noritaka.oshita@gmail.com を確認してください');
}

function debugNhaJalanPayment() {
  var rows = supabaseGet_('bt_jalan_payments', 'select=*&order=created_at.desc&limit=20');
  Logger.log('=== bt_jalan_payments 全件 ===');
  Logger.log('件数: ' + (rows || []).length);
  (rows || []).forEach(function(r) {
    Logger.log(r.status + ' | ' + r.reservation_id + ' | ' + r.customer_name + ' | ¥' + (r.amount || 0) + ' | ' + (r.square_payment_url || 'no-link'));
  });
}

// ============================================================
// Square端末決済 自動取込失敗 → Supabase sq_terminal_failed 記録
// SquareTerminal.js から呼ばれる（APP TOPに「Square未起票」赤バー表示）
// 自己完結型: SUPABASE_URL/KEY を独自定数で持つ
// ============================================================
var SQF_SUPABASE_URL = 'https://ggqugvyskyiblxiycpci.supabase.co';
var SQF_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdncXVndnlza3lpYmx4aXljcGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDc3NjksImV4cCI6MjA5MzY4Mzc2OX0.uNhWcBd_Dl5nzemZDQfJ8mQV6iY73MwystGGpTRPC18';

function saveFailedSqPayment_(payment, reason, itemName) {
  try {
    var payload = {
      id: payment.id,
      payment_at: payment.created_at || new Date().toISOString(),
      amount: Math.round((payment.amount_money && payment.amount_money.amount) || 0),
      note: (payment.note || '').toString(),
      item_name: itemName || '',
      reason: reason || '',
      raw_data: (function(){ try { return JSON.stringify(payment).slice(0, 8000); } catch(e){ return ''; } })()
    };
    var resp = UrlFetchApp.fetch(SQF_SUPABASE_URL + '/rest/v1/sq_terminal_failed', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': SQF_SUPABASE_KEY,
        'Authorization': 'Bearer ' + SQF_SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('[saveFailedSq] OK: ' + payment.id + ' ¥' + payload.amount + ' (' + reason + ')');
      return true;
    } else {
      Logger.log('[saveFailedSq] FAIL ' + code + ': ' + resp.getContentText());
      return false;
    }
  } catch (e) {
    Logger.log('[saveFailedSq] 例外: ' + e.message);
    return false;
  }
}

function testSaveFailedSqPayment() {
  var dummy = {
    id: 'TEST_' + new Date().getTime(),
    created_at: new Date().toISOString(),
    amount_money: { amount: 300, currency: 'JPY' },
    note: ''
  };
  var ok = saveFailedSqPayment_(dummy, '店舗コード不明（テスト投入）', '立替');
  Logger.log(ok ? '✅ 投入成功。APPのTOPに赤バーが出るか確認してください。' : '❌ 投入失敗。ログを確認してください。');
}

function cleanupTestSqFailed() {
  try {
    var resp = UrlFetchApp.fetch(SQF_SUPABASE_URL + '/rest/v1/sq_terminal_failed?id=like.TEST_%25', {
      method: 'delete',
      headers: {
        'apikey': SQF_SUPABASE_KEY,
        'Authorization': 'Bearer ' + SQF_SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      muteHttpExceptions: true
    });
    Logger.log('[cleanup] ' + resp.getResponseCode() + ': ' + resp.getContentText());
  } catch (e) {
    Logger.log('[cleanup] 例外: ' + e.message);
  }
}

// ============================================================
// OTA デリバリーオプション バックフィル（一回限り手動実行）
// v3.2.95 で detectOtaDelivery_ を修正する前に取込された OTA 予約は
// del_place / col_place / visit_type が空のまま → APP の デリバリ判定で
// カウントされない。Gmail に残っている過去メールを再パースして埋め直す。
//
// 既に値が入っている行は上書きしない（冪等・手動編集保護）
// 対象OTA: jalan, rakuten, skyticket, airtrip, airtrip_dp のみ
//  （official/gogoout/rentacar_dc は del_place を別ロジックで埋めている）
// ============================================================
function backfillOtaDeliveryFlags() {
  var OTA_TARGETS = ['jalan', 'rakuten', 'skyticket', 'airtrip', 'airtrip_dp'];
  var fromClause = OTA_TARGETS.map(function(k) { return 'from:' + OTA_SENDERS[k]; }).join(' OR ');
  // 90日分スキャン（Gmail 保持と GAS 実行時間上限のバランス）
  var query = '(' + fromClause + ') newer_than:90d';

  // Gmail全件取得（100件ずつ）
  var allMessages = [];
  var start = 0;
  var batchSize = 100;
  while (true) {
    var threads = GmailApp.search(query, start, batchSize);
    if (threads.length === 0) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        allMessages.push(msgs[j]);
      }
    }
    if (threads.length < batchSize) break;
    start += batchSize;
  }

  Logger.log('[backfillDel] Total messages: ' + allMessages.length);

  var stats = { J:0, R:0, S:0, O:0, skipNoFlag:0, skipNoId:0, skipCxl:0, skipNotReserve:0, alreadySet:0, notInDb:0, errors:0 };
  var updated = 0;

  for (var k = 0; k < allMessages.length; k++) {
    var msg = allMessages[k];
    var from = msg.getFrom();
    var subject = msg.getSubject();
    var body = msg.getPlainBody();

    // キャンセルメールはスキップ
    var isCancellation = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
    if (isCancellation) { stats.skipCxl++; continue; }

    // OTA判定
    var ota = null;
    for (var oi = 0; oi < OTA_TARGETS.length; oi++) {
      if (from.indexOf(OTA_SENDERS[OTA_TARGETS[oi]]) !== -1) { ota = OTA_TARGETS[oi]; break; }
    }
    if (!ota) continue;

    // 予約通知メールのみ
    if (!OTA_RESERVE_SUBJECTS[ota] || subject.indexOf(OTA_RESERVE_SUBJECTS[ota]) === -1) {
      stats.skipNotReserve++;
      continue;
    }

    // デリバリー検出（先にフラグ判定して無駄なパースを省く）
    var del = detectOtaDelivery_(body);
    if (!del.has_del && !del.has_col) { stats.skipNoFlag++; continue; }

    // パースして店舗判定（札幌予約は除外）
    var parsed = null;
    switch (ota) {
      case 'jalan':      parsed = parseJalan_(body); break;
      case 'rakuten':    parsed = parseRakuten_(body); break;
      case 'skyticket':  parsed = parseSkyticket_(body); break;
      case 'airtrip':    parsed = parseAirtrip_(body); break;
      case 'airtrip_dp': parsed = parseAirtrip_(body); break;
    }
    if (!parsed || !parsed.id) { stats.skipNoId++; continue; }
    if (!isTakamatsuReservation_(parsed)) { stats.skipSapporo = (stats.skipSapporo || 0) + 1; continue; }

    var reservationId = parsed.id;

    // OTAコード（APPと同じ1文字）
    var otaCode = (ota === 'jalan') ? 'J'
      : (ota === 'rakuten') ? 'R'
      : (ota === 'skyticket') ? 'S'
      : (ota === 'airtrip' || ota === 'airtrip_dp') ? 'O'
      : '';

    // 更新ペイロード
    var payload = {};
    if (del.has_del) payload.del_place = OTA_DELIVERY_PLACEHOLDER;
    if (del.has_col) payload.col_place = OTA_DELIVERY_PLACEHOLDER;
    if (del.has_del) payload.visit_type = 'DEL';

    // del_place / col_place が既に入っている行は上書きしない（手動編集保護）
    // PostgREST の or= フィルタで「del_place が空 OR null」を表現
    // (del_place.is.null,del_place.eq.) はネストが効かないので、まず del_place で絞る
    var filters = [];
    if (del.has_del) {
      // del_place が NULL または 空文字 の行のみ更新
      filters.push('or=(del_place.is.null,del_place.eq.)');
    } else if (del.has_col) {
      filters.push('or=(col_place.is.null,col_place.eq.)');
    }
    var patchUrl = SUPABASE_URL + '/rest/v1/bt_reservations'
      + '?id=eq.' + encodeURIComponent(reservationId)
      + (filters.length ? '&' + filters.join('&') : '');

    var options = {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      var resp = UrlFetchApp.fetch(patchUrl, options);
      var code = resp.getResponseCode();
      var arr = [];
      try { arr = JSON.parse(resp.getContentText()); } catch (e2) { arr = []; }
      if (code >= 200 && code < 300 && arr && arr.length > 0) {
        updated++;
        if (otaCode === 'J') stats.J++;
        else if (otaCode === 'R') stats.R++;
        else if (otaCode === 'S') stats.S++;
        else if (otaCode === 'O') stats.O++;
        Logger.log('[backfillDel] ' + otaCode + ' ' + reservationId + ' → del=' + del.has_del + ' col=' + del.has_col);
      } else if (code >= 200 && code < 300) {
        // 200だが0件返却 → 既に設定済みか DB に存在しない
        // DB存在確認
        var checkUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(reservationId) + '&select=id,del_place,col_place';
        var checkResp = UrlFetchApp.fetch(checkUrl, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
          muteHttpExceptions: true
        });
        var checkArr = [];
        try { checkArr = JSON.parse(checkResp.getContentText()); } catch (e3) { checkArr = []; }
        if (checkArr.length === 0) stats.notInDb++;
        else stats.alreadySet++;
      } else {
        stats.errors++;
        Logger.log('[backfillDel] HTTP ' + code + ' ' + reservationId + ': ' + resp.getContentText());
      }
    } catch (e) {
      stats.errors++;
      Logger.log('[backfillDel] Exception ' + reservationId + ': ' + e.message);
    }

    // 50件ごとに1秒スリープ（レート制限対策）
    if (k > 0 && k % 50 === 0) Utilities.sleep(1000);
  }

  Logger.log('[backfillDel] ==================== DONE ====================');
  Logger.log('[backfillDel] Updated: ' + updated + ' (J:' + stats.J + ' R:' + stats.R + ' S:' + stats.S + ' O:' + stats.O + ')');
  Logger.log('[backfillDel] Skip (no delivery flag): ' + stats.skipNoFlag);
  Logger.log('[backfillDel] Skip (not reserve mail): ' + stats.skipNotReserve);
  Logger.log('[backfillDel] Skip (cancellation): ' + stats.skipCxl);
  Logger.log('[backfillDel] Skip (no reservation id): ' + stats.skipNoId);
  Logger.log('[backfillDel] Skip (Sapporo / not Takamatsu): ' + (stats.skipSapporo || 0));
  Logger.log('[backfillDel] Already set (protected): ' + stats.alreadySet);
  Logger.log('[backfillDel] Not in DB: ' + stats.notInDb);
  Logger.log('[backfillDel] Errors: ' + stats.errors);
}

// ============================================================
// 楽天専用バックフィル（2026-04-27 extractFieldMultiline_ 修正対応）
// 旧 extractFieldMultiline_ は楽天「ラベル　：」(全角スペース+全角コロン)
// にマッチしないバグ → 楽天オプション欄が完全に取れず、ETC/シート/デリバリー
// すべて取りこぼし。312件規模の影響。
//
// この関数は楽天予約のみを対象に、Gmail から再パースして
// del_place / col_place / visit_type / opt_b / opt_c / opt_j を埋める。
// 既存値が入っている項目は上書きしない（手動編集保護）。
//
// 手動実行: GASエディタから1回だけ実行。10分のタイムアウト目安。
// ============================================================
function backfillRakutenOptions() {
  var query = 'from:' + OTA_SENDERS.rakuten + ' newer_than:90d';

  var allMessages = [];
  var start = 0;
  var batchSize = 100;
  while (true) {
    var threads = GmailApp.search(query, start, batchSize);
    if (threads.length === 0) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        allMessages.push(msgs[j]);
      }
    }
    if (threads.length < batchSize) break;
    start += batchSize;
  }

  Logger.log('[backfillR] Total Rakuten messages: ' + allMessages.length);

  var stats = {
    scanned: 0, updated: 0, skipCxl: 0, skipNotReserve: 0,
    skipNoId: 0, skipSapporo: 0, skipNoChange: 0, notInDb: 0, errors: 0,
    setDel: 0, setCol: 0, setOptB: 0, setOptC: 0, setOptJ: 0, setFlight: 0
  };

  var seenIds = {};

  for (var k = 0; k < allMessages.length; k++) {
    var msg = allMessages[k];
    var subject = msg.getSubject();
    var body = msg.getPlainBody();

    // キャンセル除外
    var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
    if (isCxl) { stats.skipCxl++; continue; }

    // 楽天の予約通知のみ
    if (subject.indexOf(OTA_RESERVE_SUBJECTS.rakuten) === -1) {
      stats.skipNotReserve++;
      continue;
    }

    // 修正版 parseRakuten_ で再パース
    var parsed = parseRakuten_(body);
    if (!parsed || !parsed.id) { stats.skipNoId++; continue; }

    // 同一予約IDを2度処理しない（取消メールに新規メールが続く等）
    if (seenIds[parsed.id]) continue;
    seenIds[parsed.id] = true;

    if (!isTakamatsuReservation_(parsed)) { stats.skipSapporo++; continue; }

    stats.scanned++;
    var resvId = parsed.id;

    // DB の現在値を取得（既存値保護のため）
    var checkUrl = SUPABASE_URL + '/rest/v1/bt_reservations'
      + '?id=eq.' + encodeURIComponent(resvId)
      + '&select=id,del_place,col_place,visit_type,opt_b,opt_c,opt_j,del_flight,status';
    var checkResp;
    try {
      checkResp = UrlFetchApp.fetch(checkUrl, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        muteHttpExceptions: true
      });
    } catch (e) {
      stats.errors++;
      Logger.log('[backfillR] CheckErr ' + resvId + ': ' + e.message);
      continue;
    }
    var checkArr = [];
    try { checkArr = JSON.parse(checkResp.getContentText()); } catch (e2) { checkArr = []; }
    if (checkArr.length === 0) { stats.notInDb++; continue; }

    var current = checkArr[0];
    if (current.status === 'cancelled') { stats.skipNoChange++; continue; }

    // 差分を計算: 「現在値が空 OR 0」かつ「再パース値が有意」のフィールドだけ更新
    var payload = {};
    var changes = [];

    // del_place: 現在NULL/空 かつ 再パースで埋まる
    if ((!current.del_place || current.del_place === '') && parsed.del_place) {
      payload.del_place = parsed.del_place;
      changes.push('del_place');
      stats.setDel++;
    }
    // col_place: 同上
    if ((!current.col_place || current.col_place === '') && parsed.col_place) {
      payload.col_place = parsed.col_place;
      changes.push('col_place');
      stats.setCol++;
    }
    // visit_type: 現在空 かつ 再パースで'DEL'
    if ((!current.visit_type || current.visit_type === '') && parsed.visit_type) {
      payload.visit_type = parsed.visit_type;
      changes.push('visit_type');
    }
    // opt_b: 現在0/NULL かつ 再パースで >=1
    if (!current.opt_b && parsed.opt_b > 0) {
      payload.opt_b = parsed.opt_b;
      changes.push('opt_b=' + parsed.opt_b);
      stats.setOptB++;
    }
    if (!current.opt_c && parsed.opt_c > 0) {
      payload.opt_c = parsed.opt_c;
      changes.push('opt_c=' + parsed.opt_c);
      stats.setOptC++;
    }
    if (!current.opt_j && parsed.opt_j > 0) {
      payload.opt_j = parsed.opt_j;
      changes.push('opt_j=' + parsed.opt_j);
      stats.setOptJ++;
    }
    // ★ 2026-05-02: del_flight 補正（楽天「ご利用便名」）
    if ((!current.del_flight || current.del_flight === '') && parsed.flight) {
      payload.del_flight = parsed.flight;
      changes.push('del_flight=' + parsed.flight);
      stats.setFlight++;
    }

    // 変更なし → スキップ
    if (Object.keys(payload).length === 0) { stats.skipNoChange++; continue; }

    // UPDATE 実行
    var patchUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(resvId);
    try {
      var resp = UrlFetchApp.fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        stats.updated++;
        Logger.log('[backfillR] R ' + resvId + ' (' + (parsed.name || '') + ') → ' + changes.join(', '));
      } else {
        stats.errors++;
        Logger.log('[backfillR] HTTP ' + code + ' ' + resvId + ': ' + resp.getContentText());
      }
    } catch (e) {
      stats.errors++;
      Logger.log('[backfillR] PatchErr ' + resvId + ': ' + e.message);
    }

    // レート制限対策
    if (k > 0 && k % 50 === 0) Utilities.sleep(1000);
  }

  Logger.log('[backfillR] ==================== DONE ====================');
  Logger.log('[backfillR] スキャンしたユニーク楽天予約: ' + stats.scanned + ' 件');
  Logger.log('[backfillR] DB UPDATE 成功: ' + stats.updated + ' 件');
  Logger.log('[backfillR]   うち del_place 埋めた: ' + stats.setDel + ' 件');
  Logger.log('[backfillR]   うち col_place 埋めた: ' + stats.setCol + ' 件');
  Logger.log('[backfillR]   うち opt_b(ベビーシート) 埋めた: ' + stats.setOptB + ' 件');
  Logger.log('[backfillR]   うち opt_c(チャイルドシート) 埋めた: ' + stats.setOptC + ' 件');
  Logger.log('[backfillR]   うち opt_j(ジュニアシート) 埋めた: ' + stats.setOptJ + ' 件');
  Logger.log('[backfillR]   うち del_flight(便名) 埋めた: ' + stats.setFlight + ' 件');
  Logger.log('[backfillR] スキップ（変更不要・既に正しい値）: ' + stats.skipNoChange + ' 件');
  Logger.log('[backfillR] スキップ（札幌予約）: ' + stats.skipSapporo + ' 件');
  Logger.log('[backfillR] スキップ（キャンセルメール）: ' + stats.skipCxl + ' 件');
  Logger.log('[backfillR] スキップ（予約通知でない）: ' + stats.skipNotReserve + ' 件');
  Logger.log('[backfillR] スキップ（予約番号取得失敗）: ' + stats.skipNoId + ' 件');
  Logger.log('[backfillR] DBに無い: ' + stats.notInDb + ' 件');
  Logger.log('[backfillR] エラー: ' + stats.errors + ' 件');
}

// ============================================================
// 楽天予約「Gmailにあるが DB に無い」一覧調査（2026-04-27 緊急調査用）
// backfillRakutenOptions() で「DBに無い 39件」がカウントされた件の特定。
// 取り込み失敗（=高松DBに入っていない高松予約）なら緊急リカバリ必須。
//
// 出力:
//   1. 高松判定の「DBに無い」予約一覧（要リカバリ候補）
//   2. 札幌判定の「DBに無い」予約一覧（札幌GASに任せる/OK）
//   3. それぞれにメール受信日、予約ID、宛名、貸出日、ステータス
// ============================================================
function inspectMissingRakutenReservations() {
  var query = 'from:' + OTA_SENDERS.rakuten + ' newer_than:90d';

  var allMessages = [];
  var start = 0;
  var batchSize = 100;
  while (true) {
    var threads = GmailApp.search(query, start, batchSize);
    if (threads.length === 0) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        allMessages.push(msgs[j]);
      }
    }
    if (threads.length < batchSize) break;
    start += batchSize;
  }

  Logger.log('[inspectMissing] 楽天メール総数: ' + allMessages.length);

  var seenIds = {};
  var missingTakamatsu = [];   // 高松判定だがDBに無い → 要リカバリ
  var missingSapporo = []; // 札幌判定でDBに無い → OK
  var missingCancelled = []; // キャンセル済みっぽいID
  var dbExists = 0;

  for (var k = 0; k < allMessages.length; k++) {
    var msg = allMessages[k];
    var subject = msg.getSubject();
    var body = msg.getPlainBody();
    var msgDate = msg.getDate();

    // キャンセル除外
    var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
    if (isCxl) continue;

    // 楽天の予約通知のみ
    if (subject.indexOf(OTA_RESERVE_SUBJECTS.rakuten) === -1) continue;

    var parsed = parseRakuten_(body);
    if (!parsed || !parsed.id) continue;

    if (seenIds[parsed.id]) continue;
    seenIds[parsed.id] = true;

    // DB存在チェック（status問わず）
    var checkUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.'
      + encodeURIComponent(parsed.id) + '&select=id,status';
    var checkResp;
    try {
      checkResp = UrlFetchApp.fetch(checkUrl, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        muteHttpExceptions: true
      });
    } catch (e) {
      continue;
    }
    var checkArr = [];
    try { checkArr = JSON.parse(checkResp.getContentText()); } catch (e2) { checkArr = []; }

    if (checkArr.length > 0) {
      dbExists++;
      continue;
    }

    // DBに無い → 高松/札幌判定
    var isTakamatsu = isTakamatsuReservation_(parsed);
    var info = {
      id: parsed.id,
      name: parsed.name || '',
      lend_date: parsed.lend_date || '',
      vehicle: parsed.vehicle || '',
      msg_date: Utilities.formatDate(msgDate, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
      store: parsed._store || '',
      rawClass: parsed._rawClass || ''
    };
    if (isTakamatsu) {
      missingTakamatsu.push(info);
    } else {
      missingSapporo.push(info);
    }

    if (k > 0 && k % 50 === 0) Utilities.sleep(500);
  }

  Logger.log('[inspectMissing] ==================== SUMMARY ====================');
  Logger.log('[inspectMissing] DB存在: ' + dbExists + ' 件');
  Logger.log('[inspectMissing] DBに無い 高松判定（🚨要リカバリ）: ' + missingTakamatsu.length + ' 件');
  Logger.log('[inspectMissing] DBに無い 札幌判定（✅札幌GAS担当）: ' + missingSapporo.length + ' 件');
  Logger.log('[inspectMissing] ');
  Logger.log('[inspectMissing] ========== 🚨高松 要リカバリ一覧 ==========');
  missingTakamatsu.sort(function(a, b) { return a.lend_date < b.lend_date ? -1 : 1; });
  missingTakamatsu.forEach(function(r) {
    var alert = '';
    var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    if (r.lend_date >= today) alert = ' 🔴未来予約';
    Logger.log('  ' + r.id + ' / ' + r.name + ' / 貸出=' + r.lend_date +
      ' / クラス=' + r.vehicle + ' / 営業所=' + r.store + alert);
  });
  Logger.log('[inspectMissing] ');
  Logger.log('[inspectMissing] ========== ✅札幌 (OK) 一覧 ==========');
  missingSapporo.forEach(function(r) {
    Logger.log('  ' + r.id + ' / ' + r.name + ' / 貸出=' + r.lend_date +
      ' / 営業所=' + r.store);
  });
}

// ============================================================
// 「DBに無い 39件」の真因特定: キャンセルメール存在チェック（2026-04-27 緊急）
// 「DBに無い」予約について Gmail に楽天からのキャンセルメールが
// 届いているかチェックする。
//   キャンセルメールあり → お客様キャンセル済み（=DB物理削除は意図的 or APP手動削除）
//   キャンセルメールなし → 純粋な取込失敗（=要復元）
//
// これで先ほど reprocessByIds で復元した10件のうち
// 「実はキャンセル済みだった予約」を炙り出す。
// ============================================================
function verifyMissingRakutenCancelStatus() {
  // ★ 検証対象: backfillRakutenOptions で「DBに無い」と判定された39件全て
  // inspectMissingRakutenReservations のロジックを再利用しつつ、
  // 各予約IDについて Gmail に対応するキャンセルメールがあるかチェック
  var query = 'from:' + OTA_SENDERS.rakuten + ' newer_than:90d';

  var allMessages = [];
  var start = 0;
  var batchSize = 100;
  while (true) {
    var threads = GmailApp.search(query, start, batchSize);
    if (threads.length === 0) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        allMessages.push(msgs[j]);
      }
    }
    if (threads.length < batchSize) break;
    start += batchSize;
  }

  // フェーズ1: DBに無い予約IDをリスト化（キャンセル除外）
  var missingIds = {};   // id → {name, lend_date, vehicle, ...}
  var seenIds = {};
  var cancelMailIds = {};  // id → キャンセルメール受信日時

  // 第1パス: 全メールを走査して、新規予約 と キャンセル のIDをそれぞれ収集
  for (var k = 0; k < allMessages.length; k++) {
    var msg = allMessages[k];
    var subject = msg.getSubject();
    var body = msg.getPlainBody();
    var msgDate = msg.getDate();

    var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });

    if (isCxl) {
      // キャンセルメール → 予約番号だけ抽出
      var cxlId = extractField_(body, '・予約番号');
      if (cxlId) {
        cancelMailIds[cxlId] = Utilities.formatDate(msgDate, 'Asia/Tokyo', 'MM/dd HH:mm');
      }
      continue;
    }

    // 新規予約のみ
    if (subject.indexOf(OTA_RESERVE_SUBJECTS.rakuten) === -1) continue;
    var parsed = parseRakuten_(body);
    if (!parsed || !parsed.id) continue;
    if (seenIds[parsed.id]) continue;
    seenIds[parsed.id] = true;

    // DB存在チェック
    var checkUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.'
      + encodeURIComponent(parsed.id) + '&select=id,status';
    try {
      var checkResp = UrlFetchApp.fetch(checkUrl, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        muteHttpExceptions: true
      });
      var checkArr = JSON.parse(checkResp.getContentText());
      if (checkArr.length > 0) continue;  // DB存在 → 対象外
    } catch (e) {
      continue;
    }

    // DBに無い + 高松判定
    if (!isTakamatsuReservation_(parsed)) continue;

    missingIds[parsed.id] = {
      name: parsed.name || '',
      lend_date: parsed.lend_date || '',
      vehicle: parsed.vehicle || ''
    };

    if (k > 0 && k % 50 === 0) Utilities.sleep(500);
  }

  // フェーズ2: 各 missing予約 についてキャンセルメール有無を判定
  Logger.log('[verifyCxl] DBに無い 高松 楽天予約: ' + Object.keys(missingIds).length + ' 件');
  Logger.log('[verifyCxl] Gmailで検出されたキャンセルメール総数: ' + Object.keys(cancelMailIds).length + ' 件');
  Logger.log('[verifyCxl] ');

  var withCancel = [];    // キャンセルメールあり → 復元すべきでない
  var withoutCancel = []; // キャンセルメールなし → 純粋な取込失敗

  Object.keys(missingIds).forEach(function(id) {
    var info = missingIds[id];
    info.id = id;
    if (cancelMailIds[id]) {
      info.cancel_at = cancelMailIds[id];
      withCancel.push(info);
    } else {
      withoutCancel.push(info);
    }
  });

  withCancel.sort(function(a, b) { return a.lend_date < b.lend_date ? -1 : 1; });
  withoutCancel.sort(function(a, b) { return a.lend_date < b.lend_date ? -1 : 1; });

  Logger.log('[verifyCxl] ========== 🔴キャンセル済み予約（復元すべきでない）: ' + withCancel.length + ' 件 ==========');
  withCancel.forEach(function(r) {
    var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var future = r.lend_date >= today ? ' 🚨未来予約' : '';
    Logger.log('  ' + r.id + ' / ' + r.name + ' / 貸出=' + r.lend_date +
      ' / クラス=' + r.vehicle + ' / キャンセルメール=' + r.cancel_at + future);
  });

  Logger.log('[verifyCxl] ');
  Logger.log('[verifyCxl] ========== ⚠️キャンセルメールなし（純粋な取込失敗）: ' + withoutCancel.length + ' 件 ==========');
  withoutCancel.forEach(function(r) {
    var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var future = r.lend_date >= today ? ' 🚨未来予約' : '';
    Logger.log('  ' + r.id + ' / ' + r.name + ' / 貸出=' + r.lend_date +
      ' / クラス=' + r.vehicle + future);
  });
}

// 診断用: 直近7日の高松OTAデリバリー検出の「実メール本文の該当箇所」を前後行つきで出力
// ハード判定が本当に顧客選択したデリバリーを拾ってるか、FAQ/案内文を拾ってるか目視検証する
function inspectOtaDeliveryMatches7Days() {
  var OTA_TARGETS = ['jalan', 'rakuten', 'skyticket', 'airtrip', 'airtrip_dp'];
  var fromClause = OTA_TARGETS.map(function(k) { return 'from:' + OTA_SENDERS[k]; }).join(' OR ');
  var query = '(' + fromClause + ') newer_than:7d';
  var threads = GmailApp.search(query, 0, 100);
  Logger.log('[inspectDel] threads: ' + threads.length);

  var seenIds = {};

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var msg = msgs[j];
      var from = msg.getFrom();
      var subject = msg.getSubject();
      var body = msg.getPlainBody();

      var del = detectOtaDelivery_(body);
      if (!del.has_del && !del.has_col) continue;

      // キャンセル除外
      var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
      if (isCxl) continue;

      // OTA判定
      var ota = null;
      for (var oi = 0; oi < OTA_TARGETS.length; oi++) {
        if (from.indexOf(OTA_SENDERS[OTA_TARGETS[oi]]) !== -1) { ota = OTA_TARGETS[oi]; break; }
      }
      if (!ota) continue;
      if (!OTA_RESERVE_SUBJECTS[ota] || subject.indexOf(OTA_RESERVE_SUBJECTS[ota]) === -1) continue;

      var parsed = null;
      switch (ota) {
        case 'jalan':      parsed = parseJalan_(body); break;
        case 'rakuten':    parsed = parseRakuten_(body); break;
        case 'skyticket':  parsed = parseSkyticket_(body); break;
        case 'airtrip':    parsed = parseAirtrip_(body); break;
        case 'airtrip_dp': parsed = parseAirtrip_(body); break;
      }
      if (!parsed || !parsed.id) continue;
      if (!isTakamatsuReservation_(parsed)) continue;
      if (seenIds[parsed.id]) continue;
      seenIds[parsed.id] = true;

      var otaCode = (ota === 'jalan') ? 'J'
        : (ota === 'rakuten') ? 'R'
        : (ota === 'skyticket') ? 'S'
        : (ota === 'airtrip' || ota === 'airtrip_dp') ? 'O' : '?';

      Logger.log('=============================================================');
      Logger.log('[inspectDel] ' + otaCode + ' ' + parsed.id + ' / 宛名=' + (parsed.name || '') + ' / 貸出=' + (parsed.lend_at || ''));
      Logger.log('=============================================================');

      // 本文を行分割
      var lines = body.split(/\r?\n/);
      // 「デリバリー」を含む行を探して前後3行を出力
      for (var L = 0; L < lines.length; L++) {
        if (/デリバリー/.test(lines[L])) {
          var from_ = Math.max(0, L - 3);
          var to_   = Math.min(lines.length - 1, L + 3);
          Logger.log('--- 該当箇所（行' + (L + 1) + '）---');
          for (var M = from_; M <= to_; M++) {
            var marker = (M === L) ? '★ ' : '   ';
            Logger.log(marker + '[' + (M + 1) + '] ' + lines[M]);
          }
          Logger.log('');
        }
      }
    }
  }
  Logger.log('[inspectDel] 終了。上記を目視してください。');
}

// テスト用: 直近7日分 / 予約IDで重複排除 + 高松店判定フィルタ
// reserve@rent-buddica-touring.jp は高松/札幌共通インボックスのため isTakamatsuReservation_ で絞る
function backfillOtaDeliveryFlagsTest7Days() {
  var OTA_TARGETS = ['jalan', 'rakuten', 'skyticket', 'airtrip', 'airtrip_dp'];
  var fromClause = OTA_TARGETS.map(function(k) { return 'from:' + OTA_SENDERS[k]; }).join(' OR ');
  var query = '(' + fromClause + ') newer_than:7d';
  var threads = GmailApp.search(query, 0, 100);
  Logger.log('[backfillDel-test] threads: ' + threads.length);

  var mailCount = { total:0, cxl:0, notReserve:0, notTakamatsu:0, noId:0 };
  var uniqTakamatsu = {}; // id → {ota, subject, hasDel, hasCol}
  var uniqSapporo = {};
  var byOtaTakamatsu = { J:0, R:0, S:0, O:0 };
  var byOtaSapporo = { J:0, R:0, S:0, O:0 };

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var msg = msgs[j];
      var from = msg.getFrom();
      var subject = msg.getSubject();
      var body = msg.getPlainBody();

      var del = detectOtaDelivery_(body);
      if (!del.has_del && !del.has_col) continue;
      mailCount.total++;

      // キャンセル除外
      var isCxl = CANCEL_KEYWORDS.some(function(kw) { return subject.indexOf(kw) !== -1; });
      if (isCxl) { mailCount.cxl++; continue; }

      // OTA判定
      var ota = null;
      for (var oi = 0; oi < OTA_TARGETS.length; oi++) {
        if (from.indexOf(OTA_SENDERS[OTA_TARGETS[oi]]) !== -1) { ota = OTA_TARGETS[oi]; break; }
      }
      if (!ota) continue;

      // 予約通知のみ
      if (!OTA_RESERVE_SUBJECTS[ota] || subject.indexOf(OTA_RESERVE_SUBJECTS[ota]) === -1) {
        mailCount.notReserve++;
        continue;
      }

      // パースして店舗判定
      var parsed = null;
      switch (ota) {
        case 'jalan':      parsed = parseJalan_(body); break;
        case 'rakuten':    parsed = parseRakuten_(body); break;
        case 'skyticket':  parsed = parseSkyticket_(body); break;
        case 'airtrip':    parsed = parseAirtrip_(body); break;
        case 'airtrip_dp': parsed = parseAirtrip_(body); break;
      }
      if (!parsed || !parsed.id) { mailCount.noId++; continue; }

      var otaCode = (ota === 'jalan') ? 'J'
        : (ota === 'rakuten') ? 'R'
        : (ota === 'skyticket') ? 'S'
        : (ota === 'airtrip' || ota === 'airtrip_dp') ? 'O' : '?';

      var isTakamatsu = isTakamatsuReservation_(parsed);

      if (isTakamatsu) {
        if (!uniqTakamatsu[parsed.id]) {
          uniqTakamatsu[parsed.id] = { ota: otaCode, subject: subject, hasDel: del.has_del, hasCol: del.has_col };
          byOtaTakamatsu[otaCode] = (byOtaTakamatsu[otaCode] || 0) + 1;
        }
      } else {
        mailCount.notTakamatsu++;
        if (!uniqSapporo[parsed.id]) {
          uniqSapporo[parsed.id] = { ota: otaCode };
          byOtaSapporo[otaCode] = (byOtaSapporo[otaCode] || 0) + 1;
        }
      }
    }
  }

  Logger.log('[backfillDel-test] ==================== SUMMARY ====================');
  Logger.log('[backfillDel-test] デリバリー検出メール: ' + mailCount.total + ' 件（うちキャンセル ' + mailCount.cxl + ' 件 / 非予約通知 ' + mailCount.notReserve + '）');
  Logger.log('[backfillDel-test] ');
  Logger.log('[backfillDel-test] 【高松】ユニーク予約: ' + Object.keys(uniqTakamatsu).length + ' 件');
  Logger.log('[backfillDel-test]   じゃらん J: ' + byOtaTakamatsu.J);
  Logger.log('[backfillDel-test]   楽天     R: ' + byOtaTakamatsu.R);
  Logger.log('[backfillDel-test]   skyticket S: ' + byOtaTakamatsu.S);
  Logger.log('[backfillDel-test]   エアトリ O: ' + byOtaTakamatsu.O);
  Logger.log('[backfillDel-test] ');
  Logger.log('[backfillDel-test] 【札幌】ユニーク予約（除外）: ' + Object.keys(uniqSapporo).length + ' 件');
  Logger.log('[backfillDel-test]   じゃらん J: ' + byOtaSapporo.J);
  Logger.log('[backfillDel-test]   楽天     R: ' + byOtaSapporo.R);
  Logger.log('[backfillDel-test]   skyticket S: ' + byOtaSapporo.S);
  Logger.log('[backfillDel-test]   エアトリ O: ' + byOtaSapporo.O);
  Logger.log('[backfillDel-test] ');
  Logger.log('[backfillDel-test] ---------- 高松 ユニーク予約一覧 ----------');
  var ids = Object.keys(uniqTakamatsu);
  for (var x = 0; x < ids.length; x++) {
    var u = uniqTakamatsu[ids[x]];
    Logger.log('[backfillDel-test]   ' + u.ota + ' ' + ids[x] + ' / del=' + u.hasDel + ' col=' + u.hasCol);
  }
}

/* ========================================================================
 * 高松 再発防止: opts自動パトロール (2026-04-30 追加)
 * ========================================================================
 * 背景: bt_reservations.opt_b/c/j (int) と bt_tasks.B/C/J (string数値)
 *       のズレが時々発生。NHA は札幌と異なり bt_tasks のカラムが
 *       日本語まじり (B/C/J/USB は ASCII / 「予約番号」「クラス」等は日本語)。
 *
 * 対策3層:
 *  1) nightlyOptsPatrolNha — 毎晩2:30 に自動でPattern A検出+修正+Slack通知
 *  2) bulkReprocessByResvNosNha(resvNos) — Gmail から再パース
 *  3) bulkReprocessPatternBNha — Pattern B 未来日を全件再パース
 *
 * NHA GAS の processMessage_ は札幌と異なり bt_tasks 同期関数が無い。
 * APP側の updateReservation→tasks sync (index.html.bak L17445) に依存。
 * GAS でreservationsを更新したらUSアパートで取得するのは APP起動時のフェッチ依存。
 * よって `patchTaskOptsNha_` を新設して GAS 側でも bt_tasks を直接更新する。
 * ======================================================================== */

/**
 * patchTaskOptsNha_: bt_tasks の B/C/J を文字列で更新
 */
function patchTaskOptsNha_(reservationId, optB, optC, optJ) {
  var nb = +(optB || 0), nc = +(optC || 0), nj = +(optJ || 0);
  // bt_tasks の予約番号カラムは日本語「予約番号」
  var encId = encodeURIComponent(reservationId);
  var query = encodeURIComponent('予約番号') + '=eq.' + encId + '&select=_id,B,C,J,changed_json';
  var tasks = supabaseGet_('bt_tasks', query);
  if (!tasks || !tasks.length) {
    Logger.log('[patchTaskOptsNha_] No tasks for ' + reservationId);
    return false;
  }
  var ok = 0, fail = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var body = { B: String(nb), C: String(nc), J: String(nj) };
    try {
      var resp = supabaseUpdate_('bt_tasks', '_id=eq.' + encodeURIComponent(t._id), body);
      if (resp && resp.length) ok++; else fail++;
      Logger.log('[patchTaskOptsNha_] ' + t._id + ' B/C/J=' + nb + '/' + nc + '/' + nj);
    } catch (e) {
      fail++;
      Logger.log('[patchTaskOptsNha_] error ' + t._id + ': ' + e.toString());
    }
  }
  return ok > 0;
}

/**
 * 毎晩自動パトロール (高松)
 * トリガー: setupNightlyOptsPatrolNhaTrigger() で毎晩2:30 設定
 */
function nightlyOptsPatrolNha() {
  var startTime = new Date();
  Logger.log('[nightlyOptsPatrolNha] 開始: ' + startTime.toISOString());

  var rows = supabaseGet_(
    'bt_reservations',
    'status=eq.confirmed&select=id,name,ota,start_date,end_date,opt_b,opt_c,opt_j,option_price,base_price,price,discount,insurance'
  );
  if (!rows.length) { Logger.log('[nightlyOptsPatrolNha] 対象予約なし'); return; }

  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  // Step 1: Pattern A 自動修正
  var patternA_fixed = 0;
  var patternA_examples = [];
  var patternC_clamped = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rb = +(r.opt_b||0), rc = +(r.opt_c||0), rj = +(r.opt_j||0);

    // Pattern C: 異常値クランプ (max 8)
    if (rb > 8 || rc > 8 || rj > 8) {
      var nb = Math.min(8, rb), nc = Math.min(8, rc), nj = Math.min(8, rj);
      try {
        supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(r.id), { opt_b: nb, opt_c: nc, opt_j: nj });
        rb = nb; rc = nc; rj = nj;
        patternC_clamped++;
      } catch (e) {
        Logger.log('[nightlyOptsPatrolNha] Pattern C clamp エラー ' + r.id + ': ' + e.toString());
      }
    }

    // Pattern A: tasks 同期確認
    var encId = encodeURIComponent(r.id);
    var query = encodeURIComponent('予約番号') + '=eq.' + encId + '&select=_id,B,C,J';
    var tasks = supabaseGet_('bt_tasks', query);
    if (!tasks || !tasks.length) continue;

    var needSync = false;
    for (var ti = 0; ti < tasks.length; ti++) {
      var t = tasks[ti];
      var tb = +(String(t.B||'0')), tc = +(String(t.C||'0')), tj = +(String(t.J||'0'));
      if (tb !== rb || tc !== rc || tj !== rj) { needSync = true; break; }
    }
    if (needSync) {
      try {
        patchTaskOptsNha_(r.id, rb, rc, rj);
        patternA_fixed++;
        if (patternA_examples.length < 5) {
          patternA_examples.push(r.id + ' (' + r.name + ' ' + r.start_date + ')');
        }
      } catch (e) {
        Logger.log('[nightlyOptsPatrolNha] Pattern A error ' + r.id + ': ' + e.toString());
      }
    }
  }

  // Step 2: Pattern B 検出 (未来日)
  var patternB_list = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.start_date < today) continue;
    var rb = +(r.opt_b||0), rc = +(r.opt_c||0), rj = +(r.opt_j||0);
    if (rb > 0 || rc > 0 || rj > 0) continue;
    var optPrice = +(r.option_price||0);
    if (optPrice <= 0) continue;

    var insurance = (r.insurance||'').trim();
    var days = 1;
    try {
      if (r.end_date && r.start_date) {
        var d1 = new Date(r.start_date + 'T00:00:00');
        var d2 = new Date(r.end_date + 'T00:00:00');
        days = Math.max(1, Math.round((d2 - d1) / 86400000));
      }
    } catch(e){}
    var perDay = optPrice / days;

    if (insurance === '' || insurance === 'なし' || perDay > 1200) {
      patternB_list.push({
        id: r.id, name: r.name, ota: r.ota, lend: r.start_date,
        opt_price: optPrice, per_day: Math.round(perDay), insurance: insurance
      });
    }
  }

  // Step 3: Slack 通知
  var endTime = new Date();
  var duration = ((endTime - startTime) / 1000).toFixed(1);
  var slackMsg = ':robot_face: *NHA opts パトロール結果* (' + duration + '秒)\n';
  slackMsg += '対象: ' + rows.length + '件 / 日付: ' + today + '\n';
  if (patternC_clamped > 0) {
    slackMsg += ':warning: Pattern C 異常値クランプ: *' + patternC_clamped + '件*\n';
  }
  slackMsg += ':white_check_mark: Pattern A 自動修正: *' + patternA_fixed + '件*\n';
  if (patternA_examples.length > 0) {
    slackMsg += '  例: ' + patternA_examples.join(', ') + '\n';
  }
  slackMsg += ':warning: Pattern B (要目視・未来日): *' + patternB_list.length + '件*';
  if (patternB_list.length > 0) {
    var first10 = patternB_list.slice(0, 10).map(function(x){
      return x.id + ' ' + x.name + ' ' + x.ota + ' ' + x.lend +
             ' ¥' + x.opt_price + '=¥' + x.per_day + '/日 "' + x.insurance + '"';
    }).join('\n');
    slackMsg += '\n```\n' + first10;
    if (patternB_list.length > 10) slackMsg += '\n... 他 ' + (patternB_list.length - 10) + '件';
    slackMsg += '\n```';
    slackMsg += '\n→ GASエディタで `bulkReprocessPatternBNha()` 実行で一括再パース';
  }

  Logger.log(slackMsg);

  try {
    if (typeof sendSlackAlert_ === 'function') {
      sendSlackAlert_(slackMsg);
    }
  } catch (e) {
    Logger.log('[nightlyOptsPatrolNha] Slack送信エラー: ' + e.toString());
  }
}

/**
 * setupNightlyOptsPatrolNhaTrigger: 毎晩2:30 トリガー設定
 */
function setupNightlyOptsPatrolNhaTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'nightlyOptsPatrolNha') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('nightlyOptsPatrolNha').timeBased().atHour(2).nearMinute(30).everyDays(1).create();
  Logger.log('[setupNightlyOptsPatrolNhaTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー設定: 毎晩2:30');
}

/**
 * bulkReprocessByResvNosNha: 引数の予約番号を Gmail から再パースして DB+bt_tasks 同期
 */
function bulkReprocessByResvNosNha(resvNos) {
  if (!resvNos || !resvNos.length) {
    Logger.log('[bulkReprocessByResvNosNha] 引数 resvNos が空'); return;
  }
  Logger.log('[bulkReprocessByResvNosNha] 開始: ' + resvNos.length + '件');

  var ok = 0, fail = 0, notFound = 0;
  var query = 'after:' + Utilities.formatDate(new Date(Date.now() - 60*86400000), 'Asia/Tokyo', 'yyyy/MM/dd');

  for (var i = 0; i < resvNos.length; i++) {
    var resvNo = resvNos[i];
    Logger.log('[' + (i+1) + '/' + resvNos.length + '] ' + resvNo);

    try {
      var threads = GmailApp.search(query, 0, 500);
      var found = false;
      for (var t = 0; t < threads.length && !found; t++) {
        var msgs = threads[t].getMessages();
        for (var m = 0; m < msgs.length && !found; m++) {
          var msg = msgs[m];
          if (msg.getPlainBody().indexOf(resvNo) === -1) continue;
          Logger.log('  メール発見: ' + msg.getSubject());
          try {
            var result = processMessage_(msg, false);
            if (result) {
              Logger.log('  ' + (result.type || 'ok') + ' ' + (result.id || ''));
              // reservations 更新後 tasks も同期する
              var resvCheck = supabaseGet_('bt_reservations', 'id=eq.' + encodeURIComponent(resvNo) + '&select=opt_b,opt_c,opt_j');
              if (resvCheck && resvCheck.length) {
                patchTaskOptsNha_(resvNo, resvCheck[0].opt_b, resvCheck[0].opt_c, resvCheck[0].opt_j);
              }
              ok++;
            } else {
              fail++;
            }
            found = true;
          } catch (e) {
            Logger.log('  処理エラー: ' + e.toString());
            fail++;
            found = true;
          }
        }
      }
      if (!found) {
        Logger.log('  メール未発見 (60日以内に存在しない)');
        notFound++;
      }
    } catch (e) {
      fail++;
      Logger.log('  例外: ' + e.toString());
    }
    Utilities.sleep(200);
  }

  Logger.log('=== bulkReprocessByResvNosNha 完了 ===');
  Logger.log('成功=' + ok + ' / 失敗=' + fail + ' / メール未発見=' + notFound + ' / 合計=' + resvNos.length);
}

/**
 * bulkReprocessPatternBNha: Pattern B 未来日を全件再パース
 */
function bulkReprocessPatternBNha() {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var rows = supabaseGet_(
    'bt_reservations',
    'status=eq.confirmed&start_date=gte.' + today +
    '&option_price=gt.0&opt_b=eq.0&opt_c=eq.0&opt_j=eq.0' +
    '&select=id,name,start_date,end_date,option_price,insurance'
  );
  if (!rows.length) { Logger.log('[bulkReprocessPatternBNha] 対象予約なし'); return; }

  var targets = rows.filter(function(r){
    var insurance = (r.insurance||'').trim();
    var optPrice = +(r.option_price||0);
    var days = 1;
    try {
      if (r.end_date && r.start_date) {
        var d1 = new Date(r.start_date + 'T00:00:00');
        var d2 = new Date(r.end_date + 'T00:00:00');
        days = Math.max(1, Math.round((d2 - d1) / 86400000));
      }
    } catch(e){}
    return insurance === '' || insurance === 'なし' || (optPrice / days) > 1200;
  });
  Logger.log('[bulkReprocessPatternBNha] 候補: ' + targets.length + '件 (全' + rows.length + '件中)');
  bulkReprocessByResvNosNha(targets.map(function(r){ return r.id; }));
}

// ============================================================
// visit_type / return_type バックフィル (2026-04-30)
// ============================================================
// 既存予約の visit_type / return_type を del_place / col_place から
// 推論し直して補正する。
//
// 動作ルール:
//  - 「来店」「返却」は手動入力扱い → 触らない
//  - 自動系（''/null/DEL/COL/PU/BD/PU(バス)/BD(バス)）→ place 由来で上書き
//  - 推論できない（place が空 or 来店等）→ そのまま残す
//
// 引数:
//   options.dryRun  : true で書き込みせずログのみ（既定 false）
//   options.fromDate: 'YYYY-MM-DD' 以降の start_date のみ対象（既定 '2026-04-30'）
//   options.allDates: true なら fromDate 無視で全件（既定 false）
//
// 利用例:
//   backfillVisitReturnType();                         // 5/1以降を補正
//   backfillVisitReturnType({dryRun:true});            // ドライラン
//   backfillVisitReturnType({allDates:true});          // 全期間
// ============================================================
function backfillVisitReturnType(options) {
  options = options || {};
  var dryRun = options.dryRun === true;
  var fromDate = options.fromDate || '2026-04-30';
  var allDates = options.allDates === true;

  var query = 'select=id,start_date,visit_type,return_type,del_place,col_place&order=start_date.asc&limit=5000';
  if (!allDates) query += '&start_date=gte.' + encodeURIComponent(fromDate);

  var rows = supabaseGet_('bt_reservations', query);
  Logger.log('[backfillVisitReturnType_] スキャン対象: ' + rows.length + '件 (dryRun=' + dryRun + ', from=' + (allDates ? '全期間' : fromDate) + ')');

  var stats = { updated: 0, skipped: 0, manual_visit: 0, manual_return: 0 };

  rows.forEach(function(r) {
    var changes = {};

    // visit_type 補正判定
    if (r.visit_type === '来店') {
      stats.manual_visit++;
    } else if (isAutoVisitReturnValue_(r.visit_type)) {
      var derivedV = derivePlaceType_(r.del_place, 'visit');
      if (derivedV && derivedV !== (r.visit_type || '')) {
        changes.visit_type = derivedV;
      }
    }

    // return_type 補正判定
    if (r.return_type === '返却') {
      stats.manual_return++;
    } else if (isAutoVisitReturnValue_(r.return_type)) {
      var derivedR = derivePlaceType_(r.col_place, 'return');
      if (derivedR && derivedR !== (r.return_type || '')) {
        changes.return_type = derivedR;
      }
    }

    if (Object.keys(changes).length === 0) {
      stats.skipped++;
      return;
    }

    var summary = r.id + ' (' + r.start_date + ') | ';
    if (changes.visit_type) summary += 'visit: "' + (r.visit_type || '') + '"→"' + changes.visit_type + '" ';
    if (changes.return_type) summary += 'return: "' + (r.return_type || '') + '"→"' + changes.return_type + '" ';
    summary += '| DEL=' + (r.del_place || '') + ' COL=' + (r.col_place || '');

    if (dryRun) {
      Logger.log('[DRY] ' + summary);
    } else {
      var ok = supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(r.id), changes);
      if (ok) {
        Logger.log('✅ ' + summary);
        stats.updated++;
      } else {
        Logger.log('❌ FAILED: ' + summary);
      }
    }
  });

  Logger.log('=== backfillVisitReturnType_ 完了 ===');
  Logger.log('  更新: ' + stats.updated);
  Logger.log('  スキップ（変更不要）: ' + stats.skipped);
  Logger.log('  手動値保護（来店）: ' + stats.manual_visit);
  Logger.log('  手動値保護（返却）: ' + stats.manual_return);
  Logger.log('  合計スキャン: ' + rows.length);
  return stats;
}

// バックフィル ドライラン（先に確認したい時用）
function backfillVisitReturnTypeDryRun() {
  return backfillVisitReturnType({ dryRun: true });
}

// 全期間バックフィル
function backfillVisitReturnTypeAll() {
  return backfillVisitReturnType({ allDates: true });
}

// ============================================================
// HP予約 visit_type/return_type/del_place/col_place バックフィル（2026-05-02 追加）
// ============================================================
// HP（オフィシャル）予約は「送迎 / デリバリー / 来店」の3択。
// parseOfficial_ がこれを判定するロジックを実装したので、過去に取り込んだ
// HP予約を Gmail から再パースして DB を更新する。
//
// 対象: ota='HP' かつ 未来日 (start_date >= today) かつ status != 'cancelled'
//
// ★ 手動値の保護（CLAUDE.md 絶対ルール）
//   visit_type / return_type が「PU」「BD」「来店」「返却」の場合は
//   スタッフ手動値とみなして絶対に上書きしない（保護対象）。
//   ただし以下の例外:
//     - DEL/COL/PUB/BDB/空文字 → メールから再パースした値で上書きする
//     - del_place/col_place は内容変化があれば常に上書きする（場所更新は許可）
//
// 手動実行: GAS エディタから `backfillHpVisitReturn` を1回だけ。
// ドライラン: `backfillHpVisitReturnDryRun`
// ============================================================
function backfillHpVisitReturn(options) {
  options = options || {};
  var dryRun = options.dryRun === true;
  var startTime = Date.now();
  var TIME_LIMIT_MS = 5 * 60 * 1000;
  // ★ 保護対象の手動値（これらは絶対に上書きしない）
  var PROTECTED_VALUES = { 'PU': 1, 'BD': 1, '来店': 1, '返却': 1 };

  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var dbQuery = 'select=id,name,visit_type,return_type,del_place,col_place,start_date'
    + '&ota=eq.HP'
    + '&start_date=gte.' + encodeURIComponent(today)
    + '&status=neq.cancelled'
    + '&order=start_date.asc&limit=1000';

  var rows = supabaseGet_('bt_reservations', dbQuery);
  Logger.log('[backfillHpVisitReturn] HP予約 ' + rows.length + '件 (dryRun=' + dryRun + ')');

  var stats = { updated: 0, unchanged: 0, notFound: 0, errors: 0, timedOut: false };
  var changedSamples = [];

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      Logger.log('[backfillHpVisitReturn] ⏱️ タイムアウト直前で中断 (' + i + '/' + rows.length + '処理済み)');
      stats.timedOut = true;
      break;
    }

    var r = rows[i];
    var rid = r.id;
    var query = '"' + rid + '"';
    var threads = GmailApp.search(query, 0, 5);
    if (threads.length === 0) {
      stats.notFound++;
      Logger.log('[NF ] ' + rid + ' (' + r.name + '): Gmail未検出');
      continue;
    }

    var parsed = null;
    for (var ti = 0; ti < threads.length && !parsed; ti++) {
      var msgs = threads[ti].getMessages();
      for (var mi = 0; mi < msgs.length && !parsed; mi++) {
        var msg = msgs[mi];
        var from = msg.getFrom();
        var body = msg.getPlainBody();
        // HP送信元のみ
        if (from.indexOf('reserve@rent-buddica-touring.jp') === -1
            && from.indexOf('noreply@rent-buddica-touring.jp') === -1) continue;
        if (body.indexOf(rid) === -1) continue;
        try {
          var p = parseOfficial_(body);
          if (p && p.id === rid) parsed = p;
        } catch (e) {
          Logger.log('[ERR] ' + rid + ': parseOfficial_ exception: ' + e.message);
        }
      }
    }

    if (!parsed) {
      stats.notFound++;
      Logger.log('[NF ] ' + rid + ' (' + r.name + '): parseable msg無し');
      continue;
    }

    var changes = {};
    var protectedNotes = [];

    // ★ visit_type は手動値（PU/BD/来店/返却）を絶対保護
    if (PROTECTED_VALUES[r.visit_type]) {
      if ((parsed.visit_type || '') !== r.visit_type) {
        protectedNotes.push('visit保護:"' + r.visit_type + '"(parser="' + parsed.visit_type + '")');
      }
    } else if ((parsed.visit_type || '') !== (r.visit_type || '')) {
      changes.visit_type = parsed.visit_type;
    }

    // ★ return_type も同様に保護
    if (PROTECTED_VALUES[r.return_type]) {
      if ((parsed.return_type || '') !== r.return_type) {
        protectedNotes.push('return保護:"' + r.return_type + '"(parser="' + parsed.return_type + '")');
      }
    } else if ((parsed.return_type || '') !== (r.return_type || '')) {
      changes.return_type = parsed.return_type;
    }

    // ★ del_place / col_place 更新ルール:
    //   visit_type / return_type が変化する時のみ場所を上書きする。
    //   同じタイプ（例: DEL→DEL）の場合、staff が顧客と確認して書き直した場所を
    //   メールの自動値で上書きしてしまうので保護する。
    //   - 手動値保護（PU/BD/来店/返却）の予約は何もしない
    //   - visit_type / return_type が変わる場合: parsed の値を採用（送迎→デリバリー切替等）
    if (!PROTECTED_VALUES[r.visit_type]
        && changes.visit_type !== undefined
        && (parsed.del_place || '') !== (r.del_place || '')) {
      changes.del_place = parsed.del_place;
    } else if (!PROTECTED_VALUES[r.visit_type]
        && (parsed.del_place || '') !== (r.del_place || '')
        && (r.visit_type === 'PUB' || r.visit_type === 'BDB' || r.visit_type === '')) {
      // PUB/空文字 で del_place が入っているのは旧バグの残骸 → 空にする
      if (!parsed.del_place && r.del_place) {
        changes.del_place = '';
      }
    }
    if (!PROTECTED_VALUES[r.return_type]
        && changes.return_type !== undefined
        && (parsed.col_place || '') !== (r.col_place || '')) {
      changes.col_place = parsed.col_place;
    } else if (!PROTECTED_VALUES[r.return_type]
        && (parsed.col_place || '') !== (r.col_place || '')
        && (r.return_type === 'BDB' || r.return_type === '')) {
      // BDB/空文字 で col_place が入っているのは旧バグの残骸 → 空にする
      if (!parsed.col_place && r.col_place) {
        changes.col_place = '';
      }
    }

    // 保護ログは変更有無に関わらず常に出す（混在パターンの可視化）
    if (protectedNotes.length > 0) {
      Logger.log('[PROTECT] ' + r.id + ' (' + r.name + ') | ' + protectedNotes.join(' / '));
    }

    if (Object.keys(changes).length === 0) {
      stats.unchanged++;
      continue;
    }

    // ★ 空文字も検出するため hasOwnProperty を使う（旧 if(changes.del_place) は '' を見逃す）
    var summary = rid + ' (' + r.name + ' / ' + r.start_date + ') | ';
    if (changes.hasOwnProperty('visit_type'))  summary += 'visit:"' + (r.visit_type || '') + '"→"' + changes.visit_type + '" ';
    if (changes.hasOwnProperty('return_type')) summary += 'return:"' + (r.return_type || '') + '"→"' + changes.return_type + '" ';
    if (changes.hasOwnProperty('del_place'))   summary += 'del:"' + (r.del_place || '') + '"→"' + (changes.del_place || '空') + '" ';
    if (changes.hasOwnProperty('col_place'))   summary += 'col:"' + (r.col_place || '') + '"→"' + (changes.col_place || '空') + '" ';

    if (dryRun) {
      Logger.log('[DRY] ' + summary);
      stats.updated++;
      if (changedSamples.length < 20) changedSamples.push(summary);
    } else {
      var ok = supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(rid), changes);
      if (ok) {
        Logger.log('✅ ' + summary);
        stats.updated++;

        // ★ 2026-05-02 bt_places との同期
        // del_place / col_place が空になる場合、bt_places の対応行を削除する。
        // APP の sheetPlaces (localStorage) は bt_places を真実として読み込むので、
        // ここで削除しないと古い場所情報が永久に表示され続ける。
        var clearDel = changes.hasOwnProperty('del_place') && !changes.del_place;
        var clearCol = changes.hasOwnProperty('col_place') && !changes.col_place;
        if (clearDel || clearCol) {
          syncNhaPlaces_(rid, changes, r);
        }
      } else {
        Logger.log('❌ FAILED: ' + summary);
        stats.errors++;
      }
    }
  }

  Logger.log('');
  Logger.log('=== backfillHpVisitReturn 完了 ===');
  Logger.log('  更新（または更新予定）: ' + stats.updated);
  Logger.log('  変更不要: ' + stats.unchanged);
  Logger.log('  Gmail未検出/parse失敗: ' + stats.notFound);
  Logger.log('  更新エラー: ' + stats.errors);
  if (stats.timedOut) Logger.log('  ⚠️ タイムアウトで途中終了。再実行してください。');
  return stats;
}

function backfillHpVisitReturnDryRun() {
  return backfillHpVisitReturn({ dryRun: true });
}

// ============================================================
// bt_places 同期ヘルパー (2026-05-02 追加)
// ============================================================
// bt_reservations.del_place / col_place が変更された時、
// bt_places テーブルの対応行も同期する。
//
// 動作:
//   - 両方空 → bt_places から行を削除
//   - 片方のみ空 → 残った場所値で UPSERT
//
// 背景:
//   APP の sheetPlaces (localStorage) は bt_places を真実として読み込むため、
//   bt_reservations だけ更新しても DEL場所/COL場所 セルは旧値が残る。
// ============================================================
function syncNhaPlaces_(reservationId, changes, currentRow) {
  // 最終的な del_place / col_place を計算（changes を currentRow に適用）
  var finalDel = changes.hasOwnProperty('del_place') ? changes.del_place : (currentRow.del_place || '');
  var finalCol = changes.hasOwnProperty('col_place') ? changes.col_place : (currentRow.col_place || '');

  if (!finalDel && !finalCol) {
    // 両方空 → bt_places の行を削除
    var ok = supabaseDelete_('bt_places', 'reservation_id=eq.' + encodeURIComponent(reservationId));
    Logger.log('  [places-sync] DELETE bt_places ' + reservationId + ' → ' + (ok ? 'OK' : 'FAIL'));
  } else {
    // 片方は値あり → UPSERT
    var url = SUPABASE_URL + '/rest/v1/bt_places?on_conflict=reservation_id';
    var headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    };
    var resp = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: headers,
      payload: JSON.stringify({ reservation_id: reservationId, del_place: finalDel, col_place: finalCol }),
      muteHttpExceptions: true
    });
    Logger.log('  [places-sync] UPSERT bt_places ' + reservationId + ' del="' + finalDel + '" col="' + finalCol + '" → ' + resp.getResponseCode());
  }
}

// ============================================================
// 全OTA 便名バックフィル（2026-05-02 追加）
// ============================================================
// 全 OTA (じゃらん/楽天/skyticket/エアトリ/HP/GoGoOut/レンタカードットコム) を対象に、
// del_flight が空の予約を Gmail 過去90日から再パースして埋める。
//
// 既存の del_flight が入っている予約は上書きしない（冪等・手動編集保護）。
// 高松店判定で札幌予約は除外。
//
// 各OTA向けの対象ラベル:
//   J (じゃらん):    extractField '到着便' / '出発便'
//   R (楽天):        extractField '・ご利用便名'
//   S (skyticket):   extractField '到着便' / '出発便'
//   O (エアトリ):    extractField '到着便' / '出発便'
//   HP (オフィシャル): regex 【飛行機便名（高松空港到着）】
//   G (GoGoOut):     extractField '到着フライト番号' / '復路フライト番号'
//   RC (レンタカードットコム): regex 現地到着 / 現地出発
//
// 手動実行: GAS エディタから1回だけ。タイムアウト6分以内。
// ============================================================
function backfillAllOtaFlights() {
  var startTime = Date.now();
  var TIME_LIMIT_MS = 5 * 60 * 1000;

  // ★ 方針: DB の「未来日 × del_flight空 × 非キャンセル」を対象に、
  //   予約番号で Gmail 直接検索する（newer_than 制限なし、何ヶ月前の予約でも検索可能）
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var dbQuery = 'select=id,del_flight,status,ota,name,start_date'
    + '&start_date=gte.' + encodeURIComponent(today)
    + '&or=(del_flight.is.null,del_flight.eq.)'
    + '&status=neq.cancelled'
    + '&limit=2000&order=start_date.asc';
  var emptyRows = supabaseGet_('bt_reservations', dbQuery);
  Logger.log('[backfillFlight] 対象（未来日・便名空）: ' + emptyRows.length + '件');
  if (!emptyRows.length) { Logger.log('[backfillFlight] 対象なし。完了。'); return; }

  var stats = {
    updated: 0, notFound: 0, noFlight: 0, errors: 0, timeLimit: false,
    byOta: { J: 0, R: 0, S: 0, O: 0, HP: 0, G: 0, RC: 0 }
  };

  for (var i = 0; i < emptyRows.length; i++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      stats.timeLimit = true;
      Logger.log('[backfillFlight] 5分経過。打切。残:' + (emptyRows.length - i) + '件 → 再実行で続きから');
      break;
    }
    var row = emptyRows[i];
    var resvId = row.id;
    var dbOta = row.ota || '';

    // 予約番号で Gmail 直接検索（期間制限なし）
    var threads;
    try {
      threads = GmailApp.search('"' + resvId + '"', 0, 5);
    } catch (e) {
      stats.errors++;
      Logger.log('[backfillFlight] SearchErr ' + resvId + ': ' + e.message);
      continue;
    }

    var foundFlight = '';
    var foundOta = '';
    outer: for (var t = 0; t < threads.length; t++) {
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length; m++) {
        var msg = msgs[m];
        var subject = msg.getSubject();
        var from = msg.getFrom();
        var body = msg.getPlainBody();

        // キャンセル除外
        if (CANCEL_KEYWORDS.some(function(kw){return subject.indexOf(kw)!==-1;})) continue;
        if (body.indexOf(resvId) === -1) continue;

        // OTA判定
        var ota = null;
        var otaKeys = Object.keys(OTA_SENDERS);
        for (var k = 0; k < otaKeys.length; k++) {
          if (from.indexOf(OTA_SENDERS[otaKeys[k]]) !== -1) { ota = otaKeys[k]; break; }
        }
        if (!ota) continue;

        // パース
        var parsed = null;
        switch (ota) {
          case 'jalan':       parsed = parseJalan_(body); break;
          case 'rakuten':     parsed = parseRakuten_(body); break;
          case 'skyticket':   parsed = parseSkyticket_(body); break;
          case 'airtrip':     parsed = parseAirtrip_(body); break;
          case 'airtrip_dp':  parsed = parseAirtrip_(body); break;
          case 'official':    parsed = parseOfficial_(body); break;
          case 'gogoout':     parsed = parseGogoout_(body); break;
          case 'rentacar_dc': parsed = parseRentacarDC_(body); break;
          case 'rentacar_dc2':parsed = parseRentacarDC_(body); break;
        }
        if (parsed && parsed.flight) {
          foundFlight = parsed.flight;
          foundOta = ota;
          break outer;
        }
      }
    }

    if (!foundFlight) {
      // メールが見つからない or 便名なし
      if (threads.length === 0) { stats.notFound++; }
      else { stats.noFlight++; }
      continue;
    }

    var otaCode = (foundOta === 'jalan') ? 'J'
      : (foundOta === 'rakuten') ? 'R'
      : (foundOta === 'skyticket') ? 'S'
      : (foundOta === 'airtrip' || foundOta === 'airtrip_dp') ? 'O'
      : (foundOta === 'official') ? 'HP'
      : (foundOta === 'gogoout') ? 'G'
      : (foundOta === 'rentacar_dc' || foundOta === 'rentacar_dc2') ? 'RC'
      : '?';

    // UPDATE
    var patchUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(resvId);
    try {
      var resp = UrlFetchApp.fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        payload: JSON.stringify({ del_flight: foundFlight }),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        stats.updated++;
        if (stats.byOta[otaCode] !== undefined) stats.byOta[otaCode]++;
        Logger.log('[backfillFlight] ' + otaCode + ' ' + resvId + ' (' + (row.name || '') + ' / ' + row.start_date + ') → ' + foundFlight);
      } else {
        stats.errors++;
        Logger.log('[backfillFlight] HTTP ' + code + ' ' + resvId);
      }
    } catch (e) {
      stats.errors++;
      Logger.log('[backfillFlight] PatchErr ' + resvId + ': ' + e.message);
    }
  }

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  Logger.log('[backfillFlight] ==================== DONE ' + elapsed + '秒 ====================');
  Logger.log('[backfillFlight] DB対象（未来日・便名空）: ' + emptyRows.length + ' 件');
  Logger.log('[backfillFlight] DB UPDATE 成功: ' + stats.updated + ' 件');
  Logger.log('[backfillFlight]   じゃらん     J: ' + stats.byOta.J + ' 件');
  Logger.log('[backfillFlight]   楽天         R: ' + stats.byOta.R + ' 件');
  Logger.log('[backfillFlight]   skyticket    S: ' + stats.byOta.S + ' 件');
  Logger.log('[backfillFlight]   エアトリ     O: ' + stats.byOta.O + ' 件');
  Logger.log('[backfillFlight]   HP/オフィシャル HP: ' + stats.byOta.HP + ' 件');
  Logger.log('[backfillFlight]   GoGoOut      G: ' + stats.byOta.G + ' 件');
  Logger.log('[backfillFlight]   レンタカードットコム RC: ' + stats.byOta.RC + ' 件');
  Logger.log('[backfillFlight] メール未発見: ' + stats.notFound + ' 件（Gmail検索でヒットなし）');
  Logger.log('[backfillFlight] 便名取得不可: ' + stats.noFlight + ' 件（メールに便名フィールドなし）');
  Logger.log('[backfillFlight] エラー: ' + stats.errors + ' 件');
  if (stats.timeLimit) Logger.log('[backfillFlight] ⚠️ タイムアウト → 再実行で残対象に対応します');
  return stats;
}

// ============================================================
// 便名 汚染データ一括クリーンアップ（2026-05-02 追加）
// ============================================================
// バックフィルで誤って混入したノイズ便名を一括正規化:
//   - 「航空便利用なし」「なし」 → 空文字
//   - 「ANA995 / ■お問い合せ」 → 「ANA995」
//   - 「It230」「jx302」 → 「IT230」「JX302」
//   - 「JAL」「EHD2DC」（数字なし不完全） → 空文字
//   - 「出発便: / ご確認の程を…」 → 空文字
//
// 動作: bt_reservations 全件スキャンして del_flight に cleanFlightNumber_ 適用
// 変化があれば PATCH（冪等）
// ============================================================
function cleanupDirtyFlightValues() {
  var startTime = Date.now();
  // del_flight が空でない予約を全件取得
  var dbQuery = 'select=id,name,start_date,del_flight'
    + '&del_flight=neq.'
    + '&order=start_date.asc&limit=5000';
  var rows = supabaseGet_('bt_reservations', dbQuery);
  Logger.log('[cleanupFlight] 対象（del_flight非空）: ' + rows.length + '件');
  if (!rows.length) return;

  var stats = { cleaned: 0, emptied: 0, unchanged: 0, errors: 0 };
  var examples = { cleaned: [], emptied: [] };

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var oldVal = row.del_flight || '';
    var newVal = cleanFlightNumber_(oldVal);

    if (newVal === oldVal) {
      stats.unchanged++;
      continue;
    }

    // PATCH
    var patchUrl = SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(row.id);
    try {
      var resp = UrlFetchApp.fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        payload: JSON.stringify({ del_flight: newVal }),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        if (newVal === '') {
          stats.emptied++;
          if (examples.emptied.length < 10) examples.emptied.push(row.id + ' "' + oldVal + '"→空');
        } else {
          stats.cleaned++;
          if (examples.cleaned.length < 10) examples.cleaned.push(row.id + ' "' + oldVal + '"→"' + newVal + '"');
        }
      } else {
        stats.errors++;
        Logger.log('[cleanupFlight] HTTP ' + code + ' ' + row.id);
      }
    } catch (e) {
      stats.errors++;
      Logger.log('[cleanupFlight] PatchErr ' + row.id + ': ' + e.message);
    }
  }

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  Logger.log('[cleanupFlight] ==================== DONE ' + elapsed + '秒 ====================');
  Logger.log('[cleanupFlight] スキャン: ' + rows.length + '件');
  Logger.log('[cleanupFlight] 正規化: ' + stats.cleaned + '件（ノイズ除去）');
  Logger.log('[cleanupFlight] 空文字化: ' + stats.emptied + '件（無効値）');
  Logger.log('[cleanupFlight] 変更なし: ' + stats.unchanged + '件');
  Logger.log('[cleanupFlight] エラー: ' + stats.errors + '件');
  if (examples.cleaned.length) {
    Logger.log('[cleanupFlight] === 正規化例 ===');
    examples.cleaned.forEach(function(e){ Logger.log('  ' + e); });
  }
  if (examples.emptied.length) {
    Logger.log('[cleanupFlight] === 空文字化例 ===');
    examples.emptied.forEach(function(e){ Logger.log('  ' + e); });
  }
  return stats;
}

// ============================================================
// 全OTA予約 メール再パース → DB上書き (2026-05-02 新設)
// ============================================================
// 全予約 (HP/J/R/S/O/RC/G) を Gmail から再パースして
// visit_type/return_type/del_place/col_place を最新値で上書きする。
//
// ★ 絶対ルール:
//   - パーサー結果は必ず PUB/BDB or DEL/COL のどちらか (マスター値統一)
//   - 既存値が「来店/PU/BD/返却」 → スタッフ手動値として保護 (上書きしない)
//   - 既存値が PUB/BDB/DEL/COL/空 → メール再パース値で上書き
//
// 手動実行: backfillAllOtaVisitReturn (本番) / backfillAllOtaVisitReturnDryRun (確認)
// 6分タイムアウト → 残りは再実行で続きから
// ============================================================
function backfillAllOtaVisitReturn(options) {
  options = options || {};
  var dryRun = options.dryRun === true;
  var since = options.since || '2026-04-01';
  var startTime = Date.now();
  var TIME_LIMIT_MS = 5 * 60 * 1000;

  var PROTECTED_VALUES = { 'PU': 1, 'BD': 1, '来店': 1, '返却': 1, 'PU(バス)': 1, 'BD(バス)': 1 };

  var rows = supabaseGet_('bt_reservations',
    'select=id,name,ota,visit_type,return_type,del_place,col_place,start_date,status' +
    '&start_date=gte.' + encodeURIComponent(since) +
    '&status=neq.cancelled' +
    '&order=start_date.asc&limit=2000');
  Logger.log('[backfillAllOTA] 対象: ' + rows.length + '件 (since=' + since + ', dryRun=' + dryRun + ')');

  var stats = {
    scanned: 0, updated: 0, unchanged: 0, notFound: 0, errors: 0, protected: 0, timedOut: false,
    byOta: { J: 0, R: 0, S: 0, O: 0, HP: 0, G: 0, RC: 0 }
  };

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      stats.timedOut = true;
      Logger.log('[backfillAllOTA] タイムアウト (' + i + '/' + rows.length + ' 処理済み) → 再実行で続きから');
      break;
    }

    var r = rows[i];
    var rid = r.id;
    stats.scanned++;

    var threads = GmailApp.search('"' + rid + '"', 0, 5);
    if (threads.length === 0) { stats.notFound++; continue; }

    var parsed = null, parsedOta = null;
    outer: for (var ti = 0; ti < threads.length; ti++) {
      var msgs = threads[ti].getMessages();
      for (var mi = 0; mi < msgs.length; mi++) {
        var msg = msgs[mi];
        var subject = msg.getSubject();
        var from = msg.getFrom();
        var body = msg.getPlainBody();

        if (CANCEL_KEYWORDS.some(function(kw){return subject.indexOf(kw)!==-1;})) continue;
        if (body.indexOf(rid) === -1) continue;

        var ota = null;
        var otaKeys = Object.keys(OTA_SENDERS);
        for (var k = 0; k < otaKeys.length; k++) {
          if (from.indexOf(OTA_SENDERS[otaKeys[k]]) !== -1) { ota = otaKeys[k]; break; }
        }
        if (!ota) continue;

        var p = null;
        try {
          switch (ota) {
            case 'jalan':       p = parseJalan_(body); break;
            case 'rakuten':     p = parseRakuten_(body); break;
            case 'skyticket':   p = parseSkyticket_(body); break;
            case 'airtrip':     p = parseAirtrip_(body); break;
            case 'airtrip_dp':  p = parseAirtrip_(body); break;
            case 'official':    p = parseOfficial_(body); break;
            case 'gogoout':     p = parseGogoout_(body); break;
            case 'rentacar_dc': p = parseRentacarDC_(body); break;
            case 'rentacar_dc2':p = parseRentacarDC_(body); break;
          }
        } catch (e) {
          Logger.log('[backfillAllOTA] parse exception ' + rid + ' (' + ota + '): ' + e.message);
        }
        if (p && p.id === rid) { parsed = p; parsedOta = ota; break outer; }
      }
    }

    if (!parsed) { stats.notFound++; continue; }

    var changes = {};
    var protectedNotes = [];

    // visit_type
    if (PROTECTED_VALUES[r.visit_type]) {
      protectedNotes.push('visit保護:"' + r.visit_type + '"');
    } else if (parsed.visit_type && parsed.visit_type !== (r.visit_type || '')) {
      changes.visit_type = parsed.visit_type;
    }

    // return_type
    if (PROTECTED_VALUES[r.return_type]) {
      protectedNotes.push('return保護:"' + r.return_type + '"');
    } else if (parsed.return_type && parsed.return_type !== (r.return_type || '')) {
      changes.return_type = parsed.return_type;
    }

    // del_place / col_place: visit_type/return_type 確定値に応じて
    //   - DEL/COL 確定 → メール場所転記 or 「場所未確定」
    //   - PUB/BDB 確定 → メール送迎場所(高松空港/赤嶺駅) or 空
    if (parsed.del_place !== undefined && parsed.del_place !== (r.del_place || '')) {
      // ただし手動値保護中は触らない
      if (!PROTECTED_VALUES[r.visit_type]) changes.del_place = parsed.del_place;
    }
    if (parsed.col_place !== undefined && parsed.col_place !== (r.col_place || '')) {
      if (!PROTECTED_VALUES[r.return_type]) changes.col_place = parsed.col_place;
    }

    if (protectedNotes.length > 0) stats.protected++;

    if (Object.keys(changes).length === 0) { stats.unchanged++; continue; }

    var summary = rid + ' (' + (r.name||'') + '/' + (r.ota||'') + ') | ';
    Object.keys(changes).forEach(function(k){
      summary += k + ':"' + (r[k] || '') + '"→"' + changes[k] + '" ';
    });

    if (dryRun) {
      Logger.log('[DRY] ' + summary + (protectedNotes.length ? ' [' + protectedNotes.join(',') + ']' : ''));
      stats.updated++;
    } else {
      var ok = supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(rid), changes);
      if (ok) {
        stats.updated++;
        var otaCode = (parsedOta === 'jalan') ? 'J'
          : (parsedOta === 'rakuten') ? 'R'
          : (parsedOta === 'skyticket') ? 'S'
          : (parsedOta === 'airtrip' || parsedOta === 'airtrip_dp') ? 'O'
          : (parsedOta === 'official') ? 'HP'
          : (parsedOta === 'gogoout') ? 'G'
          : (parsedOta === 'rentacar_dc' || parsedOta === 'rentacar_dc2') ? 'RC'
          : '?';
        if (stats.byOta[otaCode] !== undefined) stats.byOta[otaCode]++;
        Logger.log('✅ ' + summary);
        if (changes.hasOwnProperty('del_place') || changes.hasOwnProperty('col_place')) {
          syncNhaPlaces_(rid, changes, r);
        }
      } else {
        stats.errors++;
        Logger.log('❌ ' + summary);
      }
    }
  }

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  Logger.log('[backfillAllOTA] === DONE ' + elapsed + '秒 ===');
  Logger.log('  対象: ' + rows.length + ' / スキャン: ' + stats.scanned);
  Logger.log('  更新: ' + stats.updated + ' (J:' + stats.byOta.J + ' R:' + stats.byOta.R + ' S:' + stats.byOta.S + ' O:' + stats.byOta.O + ' HP:' + stats.byOta.HP + ' G:' + stats.byOta.G + ' RC:' + stats.byOta.RC + ')');
  Logger.log('  変更不要: ' + stats.unchanged);
  Logger.log('  Gmail未検出/parse失敗: ' + stats.notFound);
  Logger.log('  手動値保護: ' + stats.protected);
  Logger.log('  エラー: ' + stats.errors);
  if (stats.timedOut) Logger.log('  ⚠️ タイムアウト → 再実行で続きから');
  return stats;
}

function backfillAllOtaVisitReturnDryRun() {
  return backfillAllOtaVisitReturn({ dryRun: true });
}

// ============================================================
// 🔧 未来HP予約 保険値・便名 バックフィル
// ============================================================
// 2026-05-03 追加: detectInsurance_ バグ + 便名 (\S+) バグの過去データ修復
// 対象: ota='HP' AND start_date >= today (今日以降に出発する予約)
// 修正項目: insurance / del_flight (両方とも修正版パーサーで再判定)
// 既存値が「合ってる」場合は更新しない（dryRun で必ず確認推奨）
//
// 実行:
//   auditFutureHpReservationsDryRun()  ← まず実行して結果確認
//   auditFutureHpReservationsRun()     ← 確認後に本実行
// ============================================================
function auditFutureHpReservations_(dryRun) {
  var today = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');
  Logger.log('=== 未来HP予約 バックフィル ' + (dryRun ? '(DRY RUN)' : '(本実行)') + ' ===');
  Logger.log('対象: ota=HP かつ start_date >= ' + today);

  var resp = UrlFetchApp.fetch(
    SUPABASE_URL + '/rest/v1/bt_reservations?ota=eq.HP&start_date=gte.' + today +
      '&select=id,name,start_date,insurance,del_flight,col_flight,visit_type,return_type&order=start_date.asc',
    {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    }
  );
  if (resp.getResponseCode() !== 200) {
    Logger.log('Supabase fetch failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return;
  }
  var rows = JSON.parse(resp.getContentText());
  Logger.log('対象件数: ' + rows.length + '件');

  var updates = [];
  var notFound = [];
  var noChange = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    // Gmail から該当メールを検索（予約番号文字列で全文検索）
    var threads = GmailApp.search('"' + r.id + '"', 0, 10);
    var found = false;
    var parsed = null;

    for (var j = 0; j < threads.length && !found; j++) {
      var msgs = threads[j].getMessages();
      for (var k = 0; k < msgs.length && !found; k++) {
        var body = msgs[k].getPlainBody();
        if (body.indexOf(r.id) === -1) continue;
        // HP予約メールかチェック（BUDDICA TOURING件名 + 「予約番号」を含む）
        if (body.indexOf('予約番号') === -1) continue;
        if (body.indexOf('BUDDICA TOURING') === -1 && body.indexOf('レンタカーショップ') === -1) continue;
        var p = parseOfficial_(body);
        if (!p || p.id !== r.id) continue;
        parsed = p;
        found = true;
      }
    }

    if (!found) {
      notFound.push(r.id + ' (' + r.name + ')');
      Utilities.sleep(80);
      continue;
    }

    var changes = {};
    // insurance 比較（修正版で再判定した値が違うなら更新）
    if (parsed.insurance && parsed.insurance !== r.insurance) {
      changes.insurance = { old: r.insurance || '空', new: parsed.insurance };
    }
    // del_flight 比較（修正版は改行までを取得 → 既存値より長くなる場合のみ更新で安全）
    if (parsed.flight && parsed.flight !== r.del_flight) {
      // 既存値が修正版の prefix（「SKY」が「SKY 553」の prefix）なら確実に切れていた
      if (!r.del_flight || (parsed.flight.indexOf(r.del_flight) === 0 && parsed.flight.length > (r.del_flight || '').length)) {
        changes.del_flight = { old: r.del_flight || '空', new: parsed.flight };
      } else if (parsed.flight !== r.del_flight) {
        // 完全に違う値（手動編集の可能性）→ ログだけ残してスキップ
        Logger.log('  ⚠️ ' + r.id + ' del_flight 不一致(手動編集?): "' + r.del_flight + '" vs パース"' + parsed.flight + '" → スキップ');
      }
    }

    if (Object.keys(changes).length === 0) { noChange++; }
    else { updates.push({ id: r.id, name: r.name, start_date: r.start_date, changes: changes }); }

    // Gmail API クォータ対策
    Utilities.sleep(120);
  }

  Logger.log('--- 結果 ---');
  Logger.log('変更なし: ' + noChange + '件');
  Logger.log('修正対象: ' + updates.length + '件');
  Logger.log('Gmail未検出: ' + notFound.length + '件');

  if (updates.length > 0) {
    Logger.log('=== 修正一覧 ===');
    updates.forEach(function(u) {
      var s = [];
      Object.keys(u.changes).forEach(function(k) {
        s.push(k + ': "' + u.changes[k].old + '" → "' + u.changes[k].new + '"');
      });
      Logger.log('  ' + u.id + ' (' + u.name + ' / ' + u.start_date + '): ' + s.join(', '));
    });
  }
  if (notFound.length > 0) {
    Logger.log('=== Gmail未検出（手動確認推奨）===');
    notFound.forEach(function(s) { Logger.log('  ' + s); });
  }

  if (dryRun) {
    Logger.log('★ DRY RUN: 実際の更新はスキップしました');
    Logger.log('   本実行: auditFutureHpReservationsRun()');
    return;
  }

  // 本実行: PATCH で更新
  Logger.log('=== 本実行 開始 ===');
  var ok = 0, ng = 0;
  updates.forEach(function(u) {
    var patch = {};
    Object.keys(u.changes).forEach(function(k) { patch[k] = u.changes[k].new; });
    var presp = UrlFetchApp.fetch(
      SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(u.id),
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        payload: JSON.stringify(patch),
        muteHttpExceptions: true
      }
    );
    var code = presp.getResponseCode();
    var resArr = [];
    try { resArr = JSON.parse(presp.getContentText()); } catch(e) {}
    if (code === 200 && Array.isArray(resArr) && resArr.length > 0) {
      ok++;
      Logger.log('  ✓ ' + u.id);
    } else {
      ng++;
      Logger.log('  ✗ ' + u.id + ': HTTP ' + code + ' / 更新行数 ' + (resArr.length || 0));
    }
    Utilities.sleep(60);
  });
  Logger.log('=== 完了: ' + ok + '件成功 / ' + ng + '件失敗 ===');
}

function auditFutureHpReservationsDryRun() { auditFutureHpReservations_(true); }
function auditFutureHpReservationsRun() { auditFutureHpReservations_(false); }

// ============================================================
// 🔧 楽天 未来予約 保険値 バックフィル (2026-05-03 追加)
// ============================================================
// detectInsurance_ #2 fix（楽天「免責補償別 N」「NOC補償 N」両方検出）の過去データ修復
// 対象: ota='R' AND start_date >= today
// 修正項目: insurance（修正版パーサーで再判定）
// 既存値が「合ってる」場合は更新しない
//
// 実行:
//   auditFutureRakutenInsuranceDryRun()  ← まず実行して結果確認
//   auditFutureRakutenInsuranceRun()     ← 確認後に本実行
// ============================================================
function auditFutureRakutenInsurance_(dryRun) {
  var today = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');
  Logger.log('=== 楽天 未来予約 保険値 バックフィル ' + (dryRun ? '(DRY RUN)' : '(本実行)') + ' ===');
  Logger.log('対象: ota=R かつ start_date >= ' + today);

  var resp = UrlFetchApp.fetch(
    SUPABASE_URL + '/rest/v1/bt_reservations?ota=eq.R&start_date=gte.' + today +
      '&status=eq.confirmed&select=id,name,start_date,insurance&order=start_date.asc',
    {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    }
  );
  if (resp.getResponseCode() !== 200) {
    Logger.log('Supabase fetch failed: ' + resp.getResponseCode());
    return;
  }
  var rows = JSON.parse(resp.getContentText());
  Logger.log('対象件数: ' + rows.length + '件');

  var updates = [];
  var notFound = [];
  var noChange = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var threads = GmailApp.search('"' + r.id + '"', 0, 5);
    var found = false;
    var parsed = null;

    for (var j = 0; j < threads.length && !found; j++) {
      var msgs = threads[j].getMessages();
      for (var k = 0; k < msgs.length && !found; k++) {
        var body = msgs[k].getPlainBody();
        if (body.indexOf(r.id) === -1) continue;
        // 楽天予約メールかチェック
        if (body.indexOf('・予約番号') === -1) continue;
        if (body.indexOf('楽天トラベル') === -1) continue;
        var p = parseRakuten_(body);
        if (!p || p.id !== r.id) continue;
        parsed = p;
        found = true;
      }
    }

    if (!found) {
      notFound.push(r.id + ' (' + r.name + ')');
      Utilities.sleep(80);
      continue;
    }

    if (parsed.insurance && parsed.insurance !== r.insurance) {
      updates.push({ id: r.id, name: r.name, start_date: r.start_date,
        old: r.insurance || '空', new: parsed.insurance });
    } else {
      noChange++;
    }

    Utilities.sleep(120);
  }

  Logger.log('--- 結果 ---');
  Logger.log('変更なし: ' + noChange + '件');
  Logger.log('修正対象: ' + updates.length + '件');
  Logger.log('Gmail未検出: ' + notFound.length + '件');

  if (updates.length > 0) {
    Logger.log('=== 修正一覧 ===');
    updates.forEach(function(u) {
      Logger.log('  ' + u.id + ' (' + u.name + ' / ' + u.start_date + '): "' + u.old + '" → "' + u.new + '"');
    });
  }
  if (notFound.length > 0) {
    Logger.log('=== Gmail未検出（手動確認推奨）===');
    notFound.forEach(function(s) { Logger.log('  ' + s); });
  }

  if (dryRun) {
    Logger.log('★ DRY RUN: 実際の更新はスキップしました');
    Logger.log('   本実行: auditFutureRakutenInsuranceRun()');
    return;
  }

  Logger.log('=== 本実行 開始 ===');
  var ok = 0, ng = 0;
  updates.forEach(function(u) {
    var presp = UrlFetchApp.fetch(
      SUPABASE_URL + '/rest/v1/bt_reservations?id=eq.' + encodeURIComponent(u.id),
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        payload: JSON.stringify({ insurance: u.new }),
        muteHttpExceptions: true
      }
    );
    var code = presp.getResponseCode();
    var resArr = [];
    try { resArr = JSON.parse(presp.getContentText()); } catch(e) {}
    if (code === 200 && Array.isArray(resArr) && resArr.length > 0) {
      ok++;
      Logger.log('  ✓ ' + u.id);
    } else {
      ng++;
      Logger.log('  ✗ ' + u.id + ': HTTP ' + code);
    }
    Utilities.sleep(60);
  });
  Logger.log('=== 完了: ' + ok + '件成功 / ' + ng + '件失敗 ===');
}

function auditFutureRakutenInsuranceDryRun() { auditFutureRakutenInsurance_(true); }
function auditFutureRakutenInsuranceRun() { auditFutureRakutenInsurance_(false); }

// ============================================================
// 同カテゴリタスク重複 日次クリーンアップ（2026-05-09 案D 実装）
// ============================================================
// bt_tasks に「同一予約・同日・同カテゴリ」の重複行が積もるのを
// 毎日深夜2時に自動削除する。
// 
// なぜ必要か:
//   APP の DB.upsertTasks が onConflict:"_id" ベース UPSERT のため、
//   タスク再生成のたびに新しい _id で INSERT され重複が積もる。
//   表示時は sortedTasks の useMemo で排除しているが、DB は肥大化していく。
//   日次バッチで物理削除して肥大化を防ぐ。
//
// 削除ルール:
//   優先順: PUB > DEL > PU > 来店 / BDB > COL > BD > 返却
//   同優先度なら sort_order が大きい方を残す
//   最高優先度1件を残し、その他を削除
//
// 安全性:
//   - 異カテゴリ（PUB+BDB等）は1日レンタルの正常パターン → 触らない
//   - 独立タスク（洗車/点検/送り/迎え）は対象外
//   - 予約番号空タスク（手動入力）は対象外
//   - 削除ログを Logger に出力（監査用）
// ============================================================

function cleanupDuplicateTasksNha() {
  var startTime = new Date();
  Logger.log('[cleanupDup] 開始: ' + startTime.toISOString());

  var LEND_TYPES = ['PUB', 'DEL', 'PU', '来店'];
  var RET_TYPES  = ['BDB', 'COL', 'BD', '返却'];
  var PRIO = {'PUB':5, 'BDB':5, 'DEL':4, 'COL':4, 'PU':3, 'BD':3, '来店':2, '返却':2};

  // 全期間の bt_tasks を取得（直近30日 + 未来1年で限定）
  var fromDate = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'JST', 'yyyy-MM-dd');
  var rows = supabaseGet_('bt_tasks',
    'select=_id,date,%E5%86%85%E5%AE%B9,%E4%BA%88%E7%B4%84%E7%95%AA%E5%8F%B7,sort_order' +
    '&date=gte.' + fromDate);

  if (!rows || !rows.length) {
    Logger.log('[cleanupDup] 対象0件');
    return;
  }

  // (date, 予約番号, カテゴリ) で集約
  var groups = {};
  rows.forEach(function(r) {
    var rid = r['予約番号'] || '';
    var typ = r['内容'] || '';
    var cat = LEND_TYPES.indexOf(typ) >= 0 ? 'L' :
              RET_TYPES.indexOf(typ)  >= 0 ? 'R' : null;
    if (!cat || !rid) return;
    var key = r.date + '|' + rid + '|' + cat;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  // 削除候補抽出
  var deleteIds = [];
  var keepCount = 0, dupGroupCount = 0;
  Object.keys(groups).forEach(function(key) {
    var grp = groups[key];
    if (grp.length < 2) {
      keepCount++;
      return;
    }
    dupGroupCount++;
    // ★ 2026-05-11 fix: 担当ありを最優先にする（担当消失バグ対策）
    //   旧: 優先度 → sort_order大 → _id大 → 「担当あり」考慮なし → クリーンアップで担当ありが削除される
    //   新: 担当あり > 優先度 > sort_order大 > _id大
    grp.sort(function(a, b) {
      // 0. 担当あり優先（担当消失防止 - 最優先）
      var ha = (a['担当'] || '').trim() ? 1 : 0;
      var hb = (b['担当'] || '').trim() ? 1 : 0;
      if (ha !== hb) return hb - ha;
      // 1. 優先度
      var pa = PRIO[a['内容']] || 0;
      var pb = PRIO[b['内容']] || 0;
      if (pa !== pb) return pb - pa;
      // 2. sort_order大
      var soa = parseInt(a.sort_order, 10) || 0;
      var sob = parseInt(b.sort_order, 10) || 0;
      if (soa !== sob) return sob - soa;
      return (b._id || '').localeCompare(a._id || '');
    });
    // 先頭1件を残し、残りを削除候補へ
    for (var i = 1; i < grp.length; i++) {
      deleteIds.push({_id: grp[i]._id, date: grp[i].date, type: grp[i]['内容'], rid: grp[i]['予約番号']});
    }
  });

  if (!deleteIds.length) {
    var elapsed = ((new Date() - startTime) / 1000).toFixed(1);
    Logger.log('[cleanupDup] 重複なし。スキャン ' + rows.length + '件 / 経過 ' + elapsed + '秒');
    updateHeartbeat_('bt_cleanup_dup', {success: 1, processed: rows.length, deleted: 0});
    return;
  }

  Logger.log('[cleanupDup] 削除対象: ' + deleteIds.length + '件 / 重複グループ: ' + dupGroupCount);
  deleteIds.forEach(function(d) {
    Logger.log('  - ' + d.date + ' ' + d.rid + ' / ' + d.type + ' (_id=' + d._id + ')');
  });

  // 削除実行（PostgREST DELETE ?_id=in.(t1,t2,...)）
  // 100件ずつバッチ削除
  var deleted = 0, failed = 0;
  for (var i = 0; i < deleteIds.length; i += 100) {
    var batch = deleteIds.slice(i, i + 100);
    var idList = batch.map(function(d) { return d._id; }).join(',');
    var url = SUPABASE_URL + '/rest/v1/bt_tasks?_id=in.(' + idList + ')';
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Prefer': 'return=minimal'
        },
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        deleted += batch.length;
      } else {
        failed += batch.length;
        Logger.log('[cleanupDup] HTTP ' + code + ': ' + resp.getContentText());
      }
    } catch (e) {
      failed += batch.length;
      Logger.log('[cleanupDup] エラー: ' + e.message);
    }
  }

  var elapsed2 = ((new Date() - startTime) / 1000).toFixed(1);
  Logger.log('[cleanupDup] 完了: 削除 ' + deleted + '件 / 失敗 ' + failed + '件 / 経過 ' + elapsed2 + '秒');

  // ハートビート + Slack通知（5件以上削除時のみ）
  updateHeartbeat_('bt_cleanup_dup', {success: 1, processed: rows.length, deleted: deleted});
  if (deleted >= 5) {
    try {
      var msg = '[NHA タスク重複クリーンアップ] ' + deleted + '件削除\n対象: ' + dupGroupCount + 'グループ\n経過: ' + elapsed2 + '秒';
      sendSlackAlert_(msg);
    } catch (e) {
      Logger.log('[cleanupDup] Slack通知失敗: ' + e.message);
    }
  }
}

// dryRun 版（ログだけ出して削除しない）
function cleanupDuplicateTasksNhaDryRun() {
  var LEND_TYPES = ['PUB', 'DEL', 'PU', '来店'];
  var RET_TYPES  = ['BDB', 'COL', 'BD', '返却'];
  var PRIO = {'PUB':5, 'BDB':5, 'DEL':4, 'COL':4, 'PU':3, 'BD':3, '来店':2, '返却':2};
  var fromDate = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'JST', 'yyyy-MM-dd');
  var rows = supabaseGet_('bt_tasks',
    'select=_id,date,%E5%86%85%E5%AE%B9,%E4%BA%88%E7%B4%84%E7%95%AA%E5%8F%B7,sort_order' +
    '&date=gte.' + fromDate);
  Logger.log('[cleanupDryRun] 取得: ' + (rows ? rows.length : 0) + '件');
  var groups = {};
  (rows || []).forEach(function(r) {
    var rid = r['予約番号'] || '';
    var typ = r['内容'] || '';
    var cat = LEND_TYPES.indexOf(typ) >= 0 ? 'L' : RET_TYPES.indexOf(typ) >= 0 ? 'R' : null;
    if (!cat || !rid) return;
    var key = r.date + '|' + rid + '|' + cat;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  var dupGroups = Object.keys(groups).filter(function(k) { return groups[k].length >= 2; });
  Logger.log('[cleanupDryRun] 重複グループ: ' + dupGroups.length);
  dupGroups.forEach(function(key) {
    var grp = groups[key];
    // ★ 2026-05-11 fix: 担当ありを最優先（dryRunも本番と同じロジック）
    grp.sort(function(a, b) {
      var ha = (a['担当'] || '').trim() ? 1 : 0;
      var hb = (b['担当'] || '').trim() ? 1 : 0;
      if (ha !== hb) return hb - ha;
      var pa = PRIO[a['内容']] || 0;
      var pb = PRIO[b['内容']] || 0;
      if (pa !== pb) return pb - pa;
      return (parseInt(b.sort_order, 10) || 0) - (parseInt(a.sort_order, 10) || 0);
    });
    Logger.log('  ' + key + ': 残=' + grp[0]._id + '/' + grp[0]['内容'] +
               ' 削除=' + grp.slice(1).map(function(r) { return r._id + '/' + r['内容']; }).join(','));
  });
}

// トリガー設定（毎日深夜2時実行）
function setupCleanupDupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cleanupDuplicateTasksNha') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('cleanupDuplicateTasksNha').timeBased().atHour(2).everyDays(1).create();
  Logger.log('[setupCleanupDupTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー設定: 毎日 02:00 JST');
}

// ============================================================
// 置き去りタスク 日次クリーンアップ（2026-05-10 追加）
// ============================================================
// bt_tasks の date が予約の lend_date / return_date と一致しない
// 「置き去りタスク」を物理削除する。
//
// 発生原因:
//   APP/スタッフが予約の貸出日・返却日を変更した際、
//   APP は「新しい日付のタスクを追加」するだけで「古い日付のタスクを削除」しない。
//   結果、古い日付に同一予約のタスクが残り、その日のOPシートに表示される。
//
// 削除ルール:
//   - 貸出系タスク (PUB/DEL/PU/来店) で、date != reservation.lend_date → 削除
//   - 返却系タスク (BDB/COL/BD/返却) で、date != reservation.return_date → 削除
//   - 独立タスク (洗車/点検/送り/迎え/回収/入庫/その他/マニュアル入力) → 対象外
//   - 予約番号空のタスク → 対象外（手動入力）
//   - status=cancelled の予約のタスク → 対象外（キャンセル処理は別経路）
//
// バグ事例: 工藤様 HGU20355 (5/7貸出 - 5/11返却)
//   t82 が date=2026-05-10 内容='返却' で残存 → 5/10 OPシートに誤表示
//   修正版で date=5/10 != return_date=5/11 と判定して削除する
// ============================================================

function cleanupOrphanTasksNha_() {
  var startTime = new Date();
  Logger.log('[cleanupOrphan] 開始: ' + startTime.toISOString());

  var LEND_TYPES = ['PUB', 'DEL', 'PU', '来店'];
  var RET_TYPES  = ['BDB', 'COL', 'BD', '返却'];

  // 全タスク取得（直近30日 + 未来分）
  var fromDate = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'JST', 'yyyy-MM-dd');
  var tasks = supabaseGet_('bt_tasks',
    'select=_id,date,%E5%86%85%E5%AE%B9,%E4%BA%88%E7%B4%84%E7%95%AA%E5%8F%B7,%E4%BA%88%E7%B4%84%E8%80%85' +
    '&date=gte.' + fromDate);

  if (!tasks || !tasks.length) {
    Logger.log('[cleanupOrphan] 対象タスク0件');
    return 0;
  }

  // ★ 2026-05-10 fix: in.() フィルタは GAS URLFetch の URL長制限を超えるため、
  //   予約全件を1回で取得してメモリで照合する方式に変更
  var resvMap = {};
  var rs = supabaseGet_('bt_reservations',
    'select=id,start_date,end_date,status&limit=10000');
  (rs || []).forEach(function(r) { resvMap[r.id] = r; });
  Logger.log('[cleanupOrphan] 予約マスター取得: ' + Object.keys(resvMap).length + '件');

  // 不整合タスク検出
  var orphans = [];
  tasks.forEach(function(t) {
    var typ = t['内容'] || '';
    var rid = t['予約番号'] || '';
    if (!rid) return; // 手動タスクは対象外

    var isLend = LEND_TYPES.indexOf(typ) >= 0;
    var isRet  = RET_TYPES.indexOf(typ)  >= 0;
    if (!isLend && !isRet) return; // 洗車等は対象外

    var resv = resvMap[rid];
    if (!resv) return; // 予約自体がDBにない → 対象外（別経路でクリーンアップ）
    if (resv.status === 'cancelled') return; // キャンセル予約は対象外

    var expectedDate = isLend ? resv.start_date : resv.end_date;
    if (t.date !== expectedDate) {
      orphans.push({
        _id: t._id, task_date: t.date, expected: expectedDate,
        rid: rid, type: typ, name: t['予約者'] || '',
        cat: isLend ? 'L' : 'R'
      });
    }
  });

  if (!orphans.length) {
    Logger.log('[cleanupOrphan] 置き去りタスクなし。スキャン ' + tasks.length + '件');
    return 0;
  }

  Logger.log('[cleanupOrphan] 置き去りタスク: ' + orphans.length + '件');
  orphans.forEach(function(o) {
    Logger.log('  - _id=' + o._id + ' date=' + o.task_date + ' (期待=' + o.expected + ') ' +
               o.cat + '/' + o.type + ' ' + o.rid + ' ' + o.name);
  });

  // 削除実行（100件ずつバッチ）
  var deleted = 0, failed = 0;
  for (var j = 0; j < orphans.length; j += 100) {
    var batch2 = orphans.slice(j, j + 100);
    var idList = batch2.map(function(o) { return o._id; }).join(',');
    var url = SUPABASE_URL + '/rest/v1/bt_tasks?_id=in.(' + idList + ')';
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Prefer': 'return=minimal'
        },
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        deleted += batch2.length;
      } else {
        failed += batch2.length;
        Logger.log('[cleanupOrphan] HTTP ' + code + ': ' + resp.getContentText());
      }
    } catch (e) {
      failed += batch2.length;
      Logger.log('[cleanupOrphan] エラー: ' + e.message);
    }
  }

  var elapsed = ((new Date() - startTime) / 1000).toFixed(1);
  Logger.log('[cleanupOrphan] 完了: 削除 ' + deleted + '件 / 失敗 ' + failed + '件 / 経過 ' + elapsed + '秒');

  // 5件以上削除時に Slack 通知
  if (deleted >= 5) {
    try {
      var msg = '[NHA 置き去りタスク削除] ' + deleted + '件削除\n' +
                'スキャン: ' + tasks.length + '件 / 経過: ' + elapsed + '秒\n' +
                '原因: 予約日付変更時の古いタスク残存';
      sendSlackAlert_(msg);
    } catch (e) {}
  }

  return deleted;
}

// dryRun（ログのみ）
function cleanupOrphanTasksNhaDryRun() {
  var LEND_TYPES = ['PUB', 'DEL', 'PU', '来店'];
  var RET_TYPES  = ['BDB', 'COL', 'BD', '返却'];
  var fromDate = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'JST', 'yyyy-MM-dd');
  var tasks = supabaseGet_('bt_tasks',
    'select=_id,date,%E5%86%85%E5%AE%B9,%E4%BA%88%E7%B4%84%E7%95%AA%E5%8F%B7,%E4%BA%88%E7%B4%84%E8%80%85' +
    '&date=gte.' + fromDate);
  Logger.log('[orphanDryRun] 取得: ' + (tasks ? tasks.length : 0) + '件');
  // ★ 2026-05-10 fix: in.() URL長制限回避のため全件取得
  var resvMap = {};
  var rs = supabaseGet_('bt_reservations',
    'select=id,start_date,end_date,status&limit=10000');
  (rs || []).forEach(function(r) { resvMap[r.id] = r; });
  Logger.log('[orphanDryRun] 予約マスター: ' + Object.keys(resvMap).length + '件');
  var found = 0;
  (tasks || []).forEach(function(t) {
    var typ = t['内容'] || '';
    var rid = t['予約番号'] || '';
    if (!rid) return;
    var isLend = LEND_TYPES.indexOf(typ) >= 0;
    var isRet = RET_TYPES.indexOf(typ) >= 0;
    if (!isLend && !isRet) return;
    var resv = resvMap[rid];
    if (!resv || resv.status === 'cancelled') return;
    var expected = isLend ? resv.start_date : resv.end_date;
    if (t.date !== expected) {
      found++;
      Logger.log('  [orphan] _id=' + t._id + ' date=' + t.date + ' 期待=' + expected +
                 ' ' + typ + ' ' + rid + ' ' + (t['予約者'] || ''));
    }
  });
  Logger.log('[orphanDryRun] 置き去り検出: ' + found + '件');
}

// ★ cleanupDuplicateTasksNha の最後に cleanupOrphanTasksNha_ を追加実行
//   毎日 02:00 JST トリガー1個で両方クリーンアップ完了
function cleanupDailyNha() {
  Logger.log('[cleanupDaily] === 同カテゴリ重複削除 ===');
  cleanupDuplicateTasksNha();
  Logger.log('[cleanupDaily] === 置き去りタスク削除 ===');
  cleanupOrphanTasksNha_();
  Logger.log('[cleanupDaily] === 完了 ===');
}

// トリガー差し替え（cleanupDuplicateTasksNha → cleanupDailyNha）
function setupCleanupDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  var TARGETS = ['cleanupDuplicateTasksNha', 'cleanupDailyNha'];
  for (var i = 0; i < triggers.length; i++) {
    if (TARGETS.indexOf(triggers[i].getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('cleanupDailyNha').timeBased().atHour(2).everyDays(1).create();
  Logger.log('[setupCleanupDailyTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー: cleanupDailyNha 毎日 02:00 JST');
}

// ============================================================
// マスタースプシパトロール（2026-05-10 復元実装）
// ============================================================
// スプシ = 2次情報（編集後の最新値）→ DB に上書き同期。
// 旧仕様（CLAUDE.md 2026-05-02記載）から復元。
//
// データソース階層（オーナー確定）:
//   1次情報 = 予約メール (Gmail) → GAS processNewEmails (15分) → DB 初動登録
//   2次情報 = マスタースプシ → スタッフ編集後の最新値 → patrolReservationMaster (15分) → DB 上書き
//
// 列マッピング（0-indexed）:
//   2  = C列 = start_time      (貸出時刻)
//   3  = D列 = visit_type      (PUB/DEL/PU/来店)
//   7  = H列 = del_place       (お届け/送迎場所)
//   22 = W列 = end_time        (返却時刻)
//   23 = X列 = return_type     (BDB/COL/BD/返却)
//   24 = Y列 = col_place       (返却・送迎場所)
//   28 = AC列 = 予約番号       (照合キー)
//
// 動作:
//   - 公開URL CSV取得 → 予約番号(AC列)で集約
//   - 同一予約IDの複数行（貸出行・返却行）から非空セルを統合
//   - DB(bt_reservations)とフィールド毎に比較→差分のみPATCH
//   - スプシ非空セルのみ反映（空セルは DB を変更しない）
//   - キャンセル済みはスキップ
//   - del_place/col_place 変更時は bt_places も同期
//
// スプシ列構造変更禁止: 列インデックスがコードと直結している
// ============================================================
var MASTER_SHEET_PUB_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSBbORCPCGuadh3deGcfP1jFxO4aYJkxUnD5M0SH7Uu6-JCACjAE0Lg2fBdF39LGZvQNXOJ5JElP2ND/pub?gid=914474197&single=true&output=csv';

function patrolReservationMaster_(dryRun) {
  var startTime = new Date();
  Logger.log('[patrol] 開始: ' + startTime.toISOString() + ' (dryRun=' + (dryRun ? 'YES' : 'NO') + ')');

  // 1. CSV取得
  var csvText;
  try {
    var resp = UrlFetchApp.fetch(MASTER_SHEET_PUB_CSV_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('[patrol] CSV取得失敗 HTTP ' + resp.getResponseCode());
      updateHeartbeat_('bt_master_patrol', { success: 0, failure: 1 });
      return;
    }
    csvText = resp.getContentText('UTF-8');
  } catch (e) {
    Logger.log('[patrol] CSV取得例外: ' + e.message);
    updateHeartbeat_('bt_master_patrol', { success: 0, failure: 1 });
    return;
  }

  var rows = Utilities.parseCsv(csvText);
  Logger.log('[patrol] CSV行数: ' + rows.length);
  if (rows.length < 2) {
    Logger.log('[patrol] データなし');
    updateHeartbeat_('bt_master_patrol', { success: 1, processed: 0 });
    return;
  }

  // 2. 「合体行」のみを採用（CLAUDE.md仕様: 1予約=1合体行 / 追加行は付加メモなので無視）
  //    合体行 = 開始時刻(C) + 返却時刻(W) の両方が入っている行
  //    旧バグ: 追加行のD列(返却種別等)を visit_type として上書きしていた → 「visit_type:来店→返却」誤検知
  var COL = { ST:2, VT:3, DP:7, ET:22, RT:23, CP:24, ID:28 };
  var sheetMap = {}; // id -> {start_time, visit_type, del_place, end_time, return_type, col_place}
  var skippedAddon = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length <= COL.ID) continue;
    var id = String(r[COL.ID] || '').trim();
    if (!id) continue;

    var st = String(r[COL.ST] || '').trim();
    var et = String(r[COL.ET] || '').trim();

    // ★ 合体行判定: start_time と end_time の両方が必須
    //   どちらか欠けていれば追加行（返却単独行など）→ 同期対象外
    if (!st || !et) { skippedAddon++; continue; }

    // 合体行のみ採用。複数の合体行が同一IDにあれば最後優先（=スプシ最新）
    // ★ 2026-05-10: スプシ運用「BD」「PU」はAPPの「BDB」「PUB」と同義（スタッフ略記）
    //   APP内では BD/PU=ハイエース別カテゴリなので、書き込む前に正規化する
    var rawVt = String(r[COL.VT] || '').trim();
    var rawRt = String(r[COL.RT] || '').trim();
    if (rawVt === 'PU') rawVt = 'PUB';
    if (rawRt === 'BD') rawRt = 'BDB';

    sheetMap[id] = {
      start_time:  st,
      visit_type:  rawVt,
      del_place:   String(r[COL.DP] || '').trim(),
      end_time:    et,
      return_type: rawRt,
      col_place:   String(r[COL.CP] || '').trim()
    };
  }
  var sheetIds = Object.keys(sheetMap);
  Logger.log('[patrol] 合体行ユニーク予約: ' + sheetIds.length + ' / 追加行スキップ: ' + skippedAddon);

  // 3. DB全件取得（★ ページネーション必須 / 2026-05-10 fix）
  //    Supabase max-rows=1000 のため limit=10000 指定でも1000件で打切り
  //    offset で繰り返し呼んで全件取得
  var dbMap = {};
  var dbOffset = 0;
  var DB_PAGE = 1000;
  while (true) {
    var dbRows = supabaseGet_('bt_reservations',
      'select=id,start_time,visit_type,del_place,end_time,return_type,col_place,status' +
      '&order=id.asc&offset=' + dbOffset + '&limit=' + DB_PAGE);
    if (!dbRows || dbRows.length === 0) break;
    dbRows.forEach(function(d){ dbMap[d.id] = d; });
    if (dbRows.length < DB_PAGE) break;
    dbOffset += DB_PAGE;
    if (dbOffset > 50000) break; // 安全装置
  }
  Logger.log('[patrol] DB取得: ' + Object.keys(dbMap).length + '件 (page=' + DB_PAGE + ')');

  // 4. 差分検出 → PATCH
  var TIME_NORM = function(t) {
    if (!t) return '';
    var s = String(t).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return s;
    return ('0'+m[1]).slice(-2) + ':' + m[2];
  };
  var stats = { scanned:0, updated:0, unchanged:0, notInDb:0, cancelled:0, errors:0, fields:0 };
  var examples = [];

  for (var n = 0; n < sheetIds.length; n++) {
    var id = sheetIds[n];
    var s = sheetMap[id];
    var d = dbMap[id];
    stats.scanned++;
    if (!d) { stats.notInDb++; continue; }
    if (d.status === 'cancelled') { stats.cancelled++; continue; }

    var changes = {};
    if (s.start_time && TIME_NORM(s.start_time) !== TIME_NORM(d.start_time)) {
      changes.start_time = TIME_NORM(s.start_time);
    }
    if (s.visit_type && s.visit_type !== (d.visit_type || '')) {
      changes.visit_type = s.visit_type;
    }
    if (s.del_place && s.del_place !== (d.del_place || '')) {
      changes.del_place = s.del_place;
    }
    if (s.end_time && TIME_NORM(s.end_time) !== TIME_NORM(d.end_time)) {
      changes.end_time = TIME_NORM(s.end_time);
    }
    if (s.return_type && s.return_type !== (d.return_type || '')) {
      changes.return_type = s.return_type;
    }
    if (s.col_place && s.col_place !== (d.col_place || '')) {
      changes.col_place = s.col_place;
    }

    var keys = Object.keys(changes);
    if (keys.length === 0) { stats.unchanged++; continue; }
    stats.fields += keys.length;

    var summary = id + ' | ' + keys.map(function(k){
      return k + ':"' + (d[k] || '') + '"→"' + changes[k] + '"';
    }).join(' / ');

    if (dryRun) {
      Logger.log('[DRY] ' + summary);
      stats.updated++;
      if (examples.length < 10) examples.push(summary);
    } else {
      var ok = supabaseUpdate_('bt_reservations', 'id=eq.' + encodeURIComponent(id), changes);
      if (ok) {
        Logger.log('✅ ' + summary);
        stats.updated++;
        if (examples.length < 10) examples.push(summary);
        if (changes.hasOwnProperty('del_place') || changes.hasOwnProperty('col_place')) {
          try { syncNhaPlaces_(id, changes, d); }
          catch (e) { Logger.log('  [places-sync] err ' + id + ': ' + e.message); }
        }
      } else {
        stats.errors++;
        Logger.log('❌ ' + summary);
      }
    }
  }

  var elapsed = ((new Date() - startTime) / 1000).toFixed(1);
  Logger.log('[patrol] === DONE ' + elapsed + '秒 ===');
  Logger.log('  スキャン: ' + stats.scanned + ' / 更新: ' + stats.updated + '行 (' + stats.fields + 'フィールド)');
  Logger.log('  変更不要: ' + stats.unchanged + ' / DB未存在: ' + stats.notInDb + ' / キャンセル: ' + stats.cancelled + ' / エラー: ' + stats.errors);

  updateHeartbeat_('bt_master_patrol', {
    success: stats.errors === 0 ? 1 : 0,
    failure: stats.errors,
    processed: stats.scanned,
    updated: stats.updated
  });
}

// 本番実行（15分トリガー）
function patrolReservationMaster() { patrolReservationMaster_(false); }

// ドライラン（DBに書き込まずログのみ）
function patrolReservationMasterDryRun() { patrolReservationMaster_(true); }

// 15分間隔トリガー設定
function setupMasterPatrolTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'patrolReservationMaster') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('patrolReservationMaster').timeBased().everyMinutes(15).create();
  Logger.log('[setupMasterPatrolTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー: patrolReservationMaster 15分間隔');
}

// ============================================================
// キャンセル監視（2026-05-11 SP-20260507-0004/0005 誤キャンセル障害対策）
// ============================================================
// 直近30分以内に status=cancelled に変更された予約を検知して Slack通知。
// オーナーが誤キャンセル/不審キャンセルを即座に気付ける仕組み。
// 15分間隔トリガーで実行。
//
// 通知条件:
// - status='cancelled' AND updated_at >= 30分前
// - 前回通知済みの予約ID は ScriptProperties で除外（重複通知防止）
//
// Slack通知先: #kagawa_operations-team (SLACK_EMAIL_OPS)
// ============================================================
var CANCEL_NOTIFY_KEY = 'bt_cancel_notified_ids';

function monitorCancellations() {
  try {
    var THIRTY_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    var rows = supabaseGet_('bt_reservations',
      'select=id,name,ota,start_date,end_date,vehicle_class,created_at,updated_at' +
      '&status=eq.cancelled&updated_at=gte.' + encodeURIComponent(THIRTY_MIN_AGO) +
      '&order=updated_at.desc&limit=50');
    if (!rows || !rows.length) {
      Logger.log('[monitorCancellations] 直近30分キャンセルなし');
      return;
    }

    // 既通知IDを取得（24時間以内のみ保持）
    var notifiedRaw = PropertiesService.getScriptProperties().getProperty(CANCEL_NOTIFY_KEY) || '{}';
    var notified;
    try { notified = JSON.parse(notifiedRaw); } catch(e) { notified = {}; }
    var nowMs = Date.now();
    Object.keys(notified).forEach(function(k){
      if (nowMs - notified[k] > 24*60*60*1000) delete notified[k];
    });

    var newCxl = rows.filter(function(r){ return !notified[r.id]; });
    if (!newCxl.length) {
      Logger.log('[monitorCancellations] 新規キャンセルなし（全件既通知）');
      return;
    }

    // 不審判定: 登録→キャンセルが60分以内 = 誤キャンセル疑い
    var lines = ['🚨 *予約キャンセル検知* ' + newCxl.length + '件（直近30分）', ''];
    var suspicious = 0;
    newCxl.forEach(function(r){
      var sus = '';
      try {
        var c = new Date(r.created_at).getTime();
        var u = new Date(r.updated_at).getTime();
        var diffMin = (u - c) / 60000;
        if (diffMin < 60) {
          sus = ' 🔴**登録' + Math.round(diffMin) + '分後にCXL = 誤操作疑い**';
          suspicious++;
        }
      } catch(e){}
      lines.push('• ' + (r.ota||'?') + ' ' + r.id + ' | ' + (r.name||'-') +
        ' | ' + (r.start_date||'') + '〜' + (r.end_date||'') +
        ' | ' + (r.vehicle_class||'') + sus);
    });
    if (suspicious > 0) {
      lines.push('');
      lines.push('⚠️ 誤キャンセル疑い ' + suspicious + '件 → APP データタブ > CXL タブで「復元」可能');
    }

    var subject = '🚨 高松 予約キャンセル ' + newCxl.length + '件' + (suspicious>0?' (誤操作疑い'+suspicious+')':'');
    try {
      MailApp.sendEmail(SLACK_EMAIL_OPS, subject, lines.join('\n'));
      Logger.log('[monitorCancellations] Slack通知: ' + newCxl.length + '件');
    } catch(e) {
      Logger.log('[monitorCancellations] Slack送信エラー: ' + e.message);
    }

    // 既通知ID更新
    newCxl.forEach(function(r){ notified[r.id] = nowMs; });
    PropertiesService.getScriptProperties().setProperty(CANCEL_NOTIFY_KEY, JSON.stringify(notified));
  } catch(e) {
    Logger.log('[monitorCancellations] Fatal: ' + e.message);
  }
}

function setupCancelMonitorTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'monitorCancellations') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('monitorCancellations').timeBased().everyMinutes(15).create();
  Logger.log('[setupCancelMonitorTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー: monitorCancellations 15分間隔');
}

// ============================================================
// 会計重複検知 Slackアラート（2026-05-11 SP-20260507-0004/0005 重複障害対策）
// ============================================================
// 同一 (resv_no, type) で複数行ある異常を検知して Slack通知。
// 人的ミス（期間誤り再入力・二重入力・URL作り直しで古い行残存等）を即座に発見。
//
// 検知ルール:
//   type=extra_sales が同一予約に2行以上 = 異常
//   type=advance が同一予約に2行以上 = 異常
//   type が違えば正常（予約外売上 + 立替 の組合せは除外）
//
// 既通知 resv_no は ScriptProperties で除外（24時間保持・重複通知防止）
// 通知先: #kagawa_operations-team
// 頻度: 15分間隔
// ============================================================
var ACCT_DUP_NOTIFY_KEY = 'bt_acct_dup_notified';

function detectAccountingDuplicates() {
  try {
    // 直近90日のextra_sales/advance を取得（古いゴミ含めて検知）
    var fromDate = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
    var rows = supabaseGet_('bt_accounting',
      'select=id,date,type,resv_no,amount,user_name,description,paid,url,created_at' +
      '&type=in.(extra_sales,advance)&resv_no=neq.&date=gte.' + fromDate +
      '&order=resv_no.asc,created_at.asc&limit=5000');
    if (!rows || !rows.length) {
      Logger.log('[detectAcctDup] 対象なし');
      return;
    }

    // (resv_no, type) で集約
    var groups = {};
    rows.forEach(function(r){
      if (!r.resv_no) return;
      var key = r.resv_no + '|' + r.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });

    // 2行以上のもの抽出
    var dupGroups = [];
    Object.keys(groups).forEach(function(k){
      if (groups[k].length >= 2) dupGroups.push({ key: k, rows: groups[k] });
    });

    if (!dupGroups.length) {
      Logger.log('[detectAcctDup] 重複なし');
      return;
    }

    // 既通知除外（24時間以内）
    var notifiedRaw = PropertiesService.getScriptProperties().getProperty(ACCT_DUP_NOTIFY_KEY) || '{}';
    var notified;
    try { notified = JSON.parse(notifiedRaw); } catch(e) { notified = {}; }
    var nowMs = Date.now();
    Object.keys(notified).forEach(function(k){
      if (nowMs - notified[k] > 24*60*60*1000) delete notified[k];
    });

    var newDups = dupGroups.filter(function(g){ return !notified[g.key]; });
    if (!newDups.length) {
      Logger.log('[detectAcctDup] 全て既通知 (合計' + dupGroups.length + 'グループ)');
      return;
    }

    // Slack通知本文
    var lines = ['🚨 *会計重複検知* ' + newDups.length + 'パターン（人的ミス含む可能性）', ''];
    newDups.forEach(function(g){
      var parts = g.key.split('|');
      var resv = parts[0], typ = parts[1];
      var typeLabel = typ === 'extra_sales' ? '予約外売上' : typ === 'advance' ? '立替' : typ;
      lines.push('【' + resv + '】 (' + typeLabel + ' ' + g.rows.length + '行)');
      g.rows.forEach(function(r){
        var paidMark = r.paid ? '✅' : '❌';
        lines.push('  ' + paidMark + ' ¥' + (r.amount||0).toLocaleString() +
          ' | ' + (r.description||'').substring(0,40) +
          ' | id=' + r.id.substring(0,8));
      });
      lines.push('  → どちらか削除推奨（APPで確認）');
      lines.push('');
    });
    lines.push('────────────');
    lines.push('検知時刻: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm'));

    var subject = '🚨 高松会計 重複検知 ' + newDups.length + 'パターン';
    try {
      MailApp.sendEmail(SLACK_EMAIL_OPS, subject, lines.join('\n'));
      Logger.log('[detectAcctDup] Slack通知: ' + newDups.length + 'グループ');
    } catch(e) {
      Logger.log('[detectAcctDup] Slack送信エラー: ' + e.message);
    }

    // 既通知 key を記録
    newDups.forEach(function(g){ notified[g.key] = nowMs; });
    PropertiesService.getScriptProperties().setProperty(ACCT_DUP_NOTIFY_KEY, JSON.stringify(notified));
  } catch(e) {
    Logger.log('[detectAcctDup] Fatal: ' + e.message);
  }
}

function setupAcctDupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'detectAccountingDuplicates') {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }
  ScriptApp.newTrigger('detectAccountingDuplicates').timeBased().everyMinutes(15).create();
  Logger.log('[setupAcctDupTrigger] 旧トリガー削除=' + deleted + ' / 新トリガー: detectAccountingDuplicates 15分間隔');
}

// ============================================================
// ★ じゃらん未決済 リマインダーメール再送（高松・札幌 共通自動化）
//    トリガー: 毎日 9:30（setupJalanReminderTrigger で設定）
// ============================================================

/**
 * 高松: じゃらん未決済リマインダー再送
 * 対象: status=email_sent かつ 出発3日以内
 */
function resendNhaJalanUnpaidReminder() {
  var now = new Date();
  var today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  var in3days = Utilities.formatDate(new Date(now.getTime() + 3 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');

  var rows = supabaseGet_('bt_jalan_payments',
    'status=in.(email_sent,link_created)' +
    '&lend_date=gte.' + today +
    '&lend_date=lte.' + in3days +
    '&select=reservation_id,customer_name,customer_email,amount,square_payment_url,lend_date,return_date,vehicle_class');

  if (!rows || rows.length === 0) {
    Logger.log('[NhaJalanReminder] 対象なし');
    return;
  }

  var sent = [], failed = [];
  rows.forEach(function(pay) {
    if (!pay.customer_email || !pay.square_payment_url) {
      failed.push(pay.reservation_id + '(email/url欠落)');
      return;
    }
    // リマインダー用に件名に【再送】を追記
    var origPay = JSON.parse(JSON.stringify(pay));
    var ok = nhaSendJalanReminderEmail_(origPay);
    if (ok) {
      // ★ 送信成功 → status='reminded' に更新（翌日以降の重複送信を防止）
      supabaseUpdate_('bt_jalan_payments', 'reservation_id=eq.' + encodeURIComponent(pay.reservation_id), {status: 'reminded'});
      sent.push(pay.reservation_id + ' ' + pay.customer_name + '様（' + pay.lend_date + '出発）');
      Logger.log('[NhaJalanReminder] 送信+status=reminded: ' + pay.reservation_id);
    } else {
      failed.push(pay.reservation_id + '(送信失敗)');
    }
  });

  // Slack通知
  var msg = '📧 *じゃらん未決済リマインダー再送（高松）*\n'
    + '対象: ' + rows.length + '件 → 送信: ' + sent.length + '件\n'
    + (sent.length > 0 ? sent.map(function(s){return '✅ ' + s;}).join('\n') + '\n' : '')
    + (failed.length > 0 ? failed.map(function(f){return '❌ ' + f;}).join('\n') : '');
  nhaPostToSlackChannel_(NAHA_JALAN_PAY_CHANNEL, msg);
  Logger.log('[NhaJalanReminder] 完了 送信:' + sent.length + ' 失敗:' + failed.length);
}

/**
 * 高松: リマインダーメール本文（件名に【リマインド】追記）
 */
function nhaSendJalanReminderEmail_(pay) {
  if (!pay || !pay.customer_email || !pay.square_payment_url) return false;
  try {
    var subject = '【リマインド】【レンタカー BUDDICA TOURING BUDDICA TOURING 高松店】事前決済のお願い（予約番号: ' + pay.reservation_id + '）';
    var body = pay.customer_name + ' 様\n\n'
      + 'レンタカー BUDDICA TOURING 那覹空港店です。\n'
      + 'この度はご予約いただきありがとうございます。\n\n'
      + '当店では貸渡時の待ち時間をゼロにし、スムーズにご出発いただくため、\n'
      + '事前決済のご協力をお願いしております。\n'
      + 'お手数ですが、ご出発前にお手続きいただけますと幸いです。\n\n'
      + '予約番号: ' + pay.reservation_id + '\n'
      + '貸出日: ' + (pay.lend_date || '') + '\n'
      + '返却日: ' + (pay.return_date || '') + '\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ 事前決済\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + 'お支払い金額: ¥' + (pay.amount || 0).toLocaleString() + '\n'
      + '下記リンクよりお支払いをお願いいたします。\n'
      + pay.square_payment_url + '\n\n'
      + '※ ご出発3日前の19:00までにお支払いください。\n'
      + '※ 期限を過ぎた場合、ご予約をキャンセルさせていただく場合がございます。\n\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '■ LINE登録（未登録の方）\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '当日のご連絡はLINEで行います。\n'
      + 'LINE公式👉 https://lin.ee/jMU6xdJ\n'
      + 'LINE ID👉 @466dbckq\n\n'
      + 'BUDDICA TOURING BUDDICA TOURING 高松店\n'
      + 'TEL: 050-1724-6197（9:00〜19:00）\n';
    GmailApp.sendEmail(pay.customer_email, subject, body, {
      name: 'BUDDICA TOURING BUDDICA TOURING 高松店',
      from: 'reserve@rent-buddica-touring.jp',
      replyTo: 'reserve@rent-buddica-touring.jp'
    });
    return true;
  } catch (e) {
    Logger.log('[NhaJalanReminderEmail] Error: ' + e.message);
    return false;
  }
}

/**
 * リマインダートリガー設定（1回実行で完了）
 * 高松: 毎日 9:30
 */
function setupNhaJalanReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'resendNhaJalanUnpaidReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('resendNhaJalanUnpaidReminder')
    .timeBased().everyDays(1).atHour(9).nearMinute(30).create();
  Logger.log('[Trigger] resendNhaJalanUnpaidReminder 毎日9:30 設定完了');
}
