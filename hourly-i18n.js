/* BUDDICA TOURISM 時間貸し 多言語（日/EN/繁/한） 共通 */
(function(){
  var DICT={
    /* 共通 */
    brand_sub:{ja:"CAR AND LIFE.",en:"CAR AND LIFE.",zh:"CAR AND LIFE.",ko:"CAR AND LIFE."},
    mock_note:{ja:"🖼 デザインモック（DB未接続）",en:"🖼 Design mock (no DB)",zh:"🖼 設計原型（未連接資料庫）",ko:"🖼 디자인 목업 (DB 미연결)"},
    footer_store:{ja:"高松空港店｜お問い合わせ：reserve.touring@buddica.co.jp",en:"Takamatsu Airport｜Contact: reserve.touring@buddica.co.jp",zh:"高松機場店｜洽詢：reserve.touring@buddica.co.jp",ko:"다카마쓰공항점｜문의: reserve.touring@buddica.co.jp"},
    step_datetime:{ja:"日時・お車",en:"Date & Car",zh:"日期・車輛",ko:"일시·차량"},
    step_confirm:{ja:"ご確認",en:"Confirm",zh:"確認",ko:"확인"},
    step_pay:{ja:"お支払い",en:"Payment",zh:"付款",ko:"결제"},
    step_done:{ja:"完了",en:"Done",zh:"完成",ko:"완료"},
    /* mock1 日時・お車 */
    s1_label:{ja:"まず、ご利用時間をお選びください",en:"First, choose your time",zh:"請先選擇使用時間",ko:"먼저 이용 시간을 선택하세요"},
    date_label:{ja:"📅 ご利用日",en:"📅 Date",zh:"📅 使用日期",ko:"📅 이용일"},
    date_ph:{ja:"タップして利用日を選択",en:"Tap to select date",zh:"點擊選擇日期",ko:"탭하여 날짜 선택"},
    lend:{ja:"貸出",en:"Pick-up",zh:"取車",ko:"대여"},
    ret:{ja:"返却",en:"Return",zh:"還車",ko:"반납"},
    flow_plan:{ja:"選んだ時間で、料金プランが決まります",en:"Your plan is set by the time you choose",zh:"依所選時間決定方案",ko:"선택한 시간에 따라 요금제가 정해집니다"},
    s2_label:{ja:"ご利用プランが確定します",en:"Your plan is determined",zh:"確定使用方案",ko:"이용 요금제 확정"},
    auto_judge:{ja:"自動判定",en:"Auto",zh:"自動判定",ko:"자동판정"},
    hint_3:{ja:"〜3時間",en:"up to 3h",zh:"3小時內",ko:"3시간까지"},
    hint_6:{ja:"〜6時間",en:"up to 6h",zh:"6小時內",ko:"6시간까지"},
    hint_12:{ja:"〜12時間",en:"up to 12h",zh:"12小時內",ko:"12시간까지"},
    hint_24:{ja:"〜1日",en:"up to 24h",zh:"1天內",ko:"1일까지"},
    plan_prompt:{ja:"貸出・返却のお時間をお選びください",en:"Please choose pick-up and return times",zh:"請選擇取車與還車時間",ko:"대여·반납 시간을 선택하세요"},
    plan_word:{ja:"ご利用プラン",en:"Plan",zh:"使用方案",ko:"이용 요금제"},
    view_plans:{ja:"📋 料金プランを見る",en:"📋 View price plans",zh:"📋 查看價目表",ko:"📋 요금표 보기"},
    tnote:{ja:"ご返却後3時間は点検・清掃のため、次のご予約はお受けできません",en:"For 3h after return, the car is unavailable for cleaning & inspection",zh:"還車後3小時為檢查清潔時間，無法接受下一筆預約",ko:"반납 후 3시간은 점검·청소로 다음 예약을 받지 않습니다"},
    car_pick_title:{ja:"この時間でご利用いただけるお車",en:"Cars available for your time",zh:"此時段可租的車輛",ko:"이 시간에 이용 가능한 차량"},
    car_pick_label:{ja:"お車を選ぶ",en:"Choose a car",zh:"選擇車輛",ko:"차량 선택"},
    avail_ok:{ja:"◯ 空きあり",en:"◯ Available",zh:"◯ 有空車",ko:"◯ 예약가능"},
    avail_few:{ja:"△ 残りわずか",en:"△ Few left",zh:"△ 僅剩少量",ko:"△ 잔여 소수"},
    over_unit:{ja:"24時間超は1時間ごと",en:"Over 24h: per hour",zh:"超過24小時每小時",ko:"24시간 초과 시 1시간마다"},
    car_hint:{ja:"※ ◯=空きあり／△=残りわずか。写真・料金は仮置き（税抜）です。",en:"※ ◯=available / △=few left. Photos & prices are placeholders (excl. tax).",zh:"※ ◯=有空車／△=僅剩少量。照片與價格為暫定（未稅）。",ko:"※ ◯=예약가능/△=잔여소수. 사진·요금은 임시(부가세 별도)."},
    bar_prompt:{ja:"まず、ご利用日時をお選びください",en:"First, choose date & time",zh:"請先選擇日期與時間",ko:"먼저 일시를 선택하세요"},
    bar_sub:{ja:"日付・時間の選択でお進みいただけます",en:"Select date & time to continue",zh:"選好日期時間即可繼續",ko:"일시를 선택하면 진행됩니다"},
    to_car:{ja:"お車を選ぶ →",en:"Choose a car →",zh:"選擇車輛 →",ko:"차량 선택 →"},
    proceed:{ja:"予約へ進む",en:"Proceed →",zh:"前往預約",ko:"예약 진행"},
    plan_can_go:{ja:"この日時でお車を選べます",en:"You can pick a car for this time",zh:"可為此時段選車",ko:"이 일시로 차량을 선택할 수 있습니다"},
    unit_plan:{ja:"時間プラン",en:"h plan",zh:"小時方案",ko:"시간 요금제"},
    /* 料金表モーダル */
    m_title:{ja:"料金プラン",en:"Price plans",zh:"價目表",ko:"요금제"},
    m_car:{ja:"車種",en:"Car",zh:"車種",ko:"차종"},
    m_over:{ja:"超過/1h",en:"Over/1h",zh:"超過/1h",ko:"초과/1h"},
    m_note:{ja:"※ ご利用の合計時間を上のプランに繰り上げて計算します（例：3.5時間→6時間プラン）。24時間超は1時間ごとに超過料金。",en:"※ Total time rounds up to the plan above (e.g. 3.5h → 6h plan). Over 24h is charged per hour.",zh:"※ 使用總時數進位至上方方案（例：3.5小時→6小時方案）。超過24小時按每小時加收。",ko:"※ 이용 합계 시간을 상위 요금제로 올림 계산(예: 3.5시간→6시간). 24시간 초과는 시간당 요금."},
    tax_ex:{ja:"税抜",en:"excl. tax",zh:"未稅",ko:"부가세 별도"},
    /* mock3 ご確認 */
    c1:{ja:"ご予約内容",en:"Booking details",zh:"預約內容",ko:"예약 내용"},
    c2:{ja:"お客様情報",en:"Your information",zh:"顧客資料",ko:"고객 정보"},
    c3:{ja:"お受け取り・ご返却",en:"Pick-up & Return",zh:"取車・還車",ko:"수령·반납"},
    f_date:{ja:"ご利用日",en:"Date",zh:"使用日期",ko:"이용일"},
    f_time:{ja:"ご利用時間",en:"Time",zh:"使用時間",ko:"이용 시간"},
    f_plan:{ja:"ご利用プラン",en:"Plan",zh:"使用方案",ko:"요금제"},
    f_pickup:{ja:"お受け取り",en:"Pick-up",zh:"取車",ko:"수령"},
    f_total:{ja:"お支払い合計",en:"Total",zh:"總計",ko:"결제 합계"},
    store_front:{ja:"高松空港店（店頭）",en:"Takamatsu Airport (in-store)",zh:"高松機場店（門市）",ko:"다카마쓰공항점(매장)"},
    req:{ja:"必須",en:"Required",zh:"必填",ko:"필수"},
    name:{ja:"お名前",en:"Name",zh:"姓名",ko:"이름"},
    kana:{ja:"フリガナ",en:"Name (kana)",zh:"假名",ko:"후리가나"},
    tel:{ja:"お電話番号",en:"Phone",zh:"電話號碼",ko:"전화번호"},
    email:{ja:"メールアドレス",en:"Email",zh:"電子郵件",ko:"이메일"},
    recv_title:{ja:"🏬 高松空港店（店頭でお受け取り）",en:"🏬 Takamatsu Airport (in-store pick-up)",zh:"🏬 高松機場店（門市取車）",ko:"🏬 다카마쓰공항점(매장 수령)"},
    planned_time:{ja:"ご利用予定時間",en:"Planned time",zh:"預定使用時間",ko:"이용 예정 시간"},
    shuttle:{ja:"空港送迎",en:"Airport shuttle",zh:"機場接送",ko:"공항 픽업"},
    sh_no:{ja:"なし（店舗引き取り）",en:"None (in-store)",zh:"無（門市取車）",ko:"없음(매장 수령)"},
    sh_yes:{ja:"あり（空港送迎）",en:"Yes (airport shuttle)",zh:"有（機場接送）",ko:"있음(공항 픽업)"},
    sh_no_box:{ja:"🏬 高松空港店の店頭でお引き取りください（お受け取り時刻：",en:"🏬 Please pick up at Takamatsu Airport store (pick-up time: ",zh:"🏬 請至高松機場店門市取車（取車時間：",ko:"🏬 다카마쓰공항점 매장에서 수령해 주세요(수령 시각: "},
    sh_yes_box:{ja:"🚐 高松空港ターミナルまでお迎えにあがります。",en:"🚐 We'll pick you up at Takamatsu Airport terminal.",zh:"🚐 我們將前往高松機場航廈迎接您。",ko:"🚐 다카마쓰공항 터미널로 마중 나갑니다."},
    pickup_time_want:{ja:"ご希望お迎え時間",en:"Preferred pick-up time",zh:"希望迎接時間",ko:"희망 픽업 시간"},
    flight_no:{ja:"ご到着便名（任意）",en:"Arrival flight (optional)",zh:"抵達航班（選填）",ko:"도착 편명(선택)"},
    pill_guide:{ja:"📄 ご予約後、ご利用ガイドで免許証のご登録・貸渡約款へのご署名をお願いします",en:"📄 After booking, register your license & sign the rental terms in the Guide",zh:"📄 預約後請於使用指南登錄駕照並簽署租賃約款",ko:"📄 예약 후 이용 가이드에서 면허증 등록·약관 서명을 부탁드립니다"},
    total_tax:{ja:"お支払い合計（税抜）",en:"Total (excl. tax)",zh:"總計（未稅）",ko:"결제 합계(부가세 별도)"},
    to_pay:{ja:"お支払いへ進む →",en:"To payment →",zh:"前往付款 →",ko:"결제로 →"},
    /* mock3b お支払い */
    p_label:{ja:"お時間とお支払いについて",en:"About time & payment",zh:"關於時間與付款",ko:"이용 시간과 결제 안내"},
    ex_intro:{ja:"時間貸しは利用メーター制。ご利用時間は実測で確定します。",en:"Hourly rental uses a usage meter. Your time is confirmed by actual use.",zh:"時租採計時制，以實際使用時間確定。",ko:"시간제 렌탈은 이용 미터제. 실제 이용 시간으로 확정됩니다."},
    ef_start:{ja:"利用開始",en:"Start",zh:"開始使用",ko:"이용 시작"},
    ef_meter:{ja:"計測",en:"Metering",zh:"計時",ko:"계측"},
    ef_req:{ja:"返却リクエスト",en:"Return request",zh:"申請還車",ko:"반납 요청"},
    ef_approve:{ja:"店舗承認＝確定",en:"Store approval = final",zh:"門市核准＝確定",ko:"매장 승인=확정"},
    pt1:{ja:"実際のご利用時間でプラン確定（1分でも超えると次のプラン）",en:"Plan is set by actual time (even 1 min over moves to the next plan)",zh:"依實際使用時間確定方案（超過1分鐘即進入下一方案）",ko:"실제 이용 시간으로 확정(1분만 초과해도 다음 요금제)"},
    pt2:{ja:"料金は料金表どおり（3→6→12→24時間／24時間超は1時間ごと）",en:"Prices per the table (3→6→12→24h / over 24h per hour)",zh:"費用依價目表（3→6→12→24小時／超過24小時每小時）",ko:"요금은 요금표대로(3→6→12→24시간/24시간 초과는 시간당)"},
    pay_today:{ja:"💳 本日のお支払い",en:"💳 Pay today",zh:"💳 今日付款",ko:"💳 오늘 결제"},
    pay_today_v:{ja:"予約プラン分を前払い",en:"Prepay the booked plan",zh:"預付預約方案",ko:"예약 요금제 선불"},
    pay_over:{ja:"超過分の差額",en:"Overage difference",zh:"超時差額",ko:"초과 차액"},
    pay_over_v:{ja:"ご返却時に店舗で精算（後払い）",en:"Settle at store on return (pay later)",zh:"還車時於門市結算（後付）",ko:"반납 시 매장에서 정산(후불)"},
    agree_label:{ja:"ご確認・ご同意",en:"Confirm & Agree",zh:"確認與同意",ko:"확인·동의"},
    agree_text:{ja:"貸渡約款・キャンセル規定に同意します",en:"I agree to the rental terms & cancellation policy",zh:"我同意租賃約款與取消規定",ko:"대여 약관·취소 규정에 동의합니다"},
    note_full:{ja:"※ ご返却後3時間は点検・清掃のため、次のご予約はお受けできません。<br>※ ご予約後、ご利用ガイドから免許証のご登録・約款へのご署名をお願いします。<br>※ 表示価格は税抜です。<br>※ 超過分の追加清算は、ご返却時に店舗でお支払いいただきます。",en:"※ For 3h after return the car is unavailable (cleaning/inspection).<br>※ After booking, register your license & sign the terms in the Guide.<br>※ Prices exclude tax.<br>※ Overage is settled at the store on return.",zh:"※ 還車後3小時無法接受下一預約（檢查清潔）。<br>※ 預約後請於指南登錄駕照並簽署約款。<br>※ 標示價格未稅。<br>※ 超時差額於還車時在門市支付。",ko:"※ 반납 후 3시간은 점검·청소로 예약 불가.<br>※ 예약 후 가이드에서 면허 등록·약관 서명 부탁드립니다.<br>※ 표시가격은 부가세 별도.<br>※ 초과분은 반납 시 매장에서 정산합니다."},
    pay_method:{ja:"お支払い方法",en:"Payment method",zh:"付款方式",ko:"결제 수단"},
    card_no:{ja:"カード番号",en:"Card number",zh:"卡號",ko:"카드 번호"},
    card_exp:{ja:"有効期限",en:"Expiry",zh:"有效期限",ko:"유효기간"},
    card_cvc:{ja:"セキュリティコード",en:"CVC",zh:"安全碼",ko:"보안코드"},
    ssl_note:{ja:"🔒 お支払い情報はSSLで安全に保護されます（モック・決済は行われません）",en:"🔒 Payment info is protected by SSL (mock — no real charge)",zh:"🔒 付款資訊以SSL保護（原型・不會實際扣款）",ko:"🔒 결제 정보는 SSL로 보호됩니다(목업·실결제 없음)"},
    confirm_book:{ja:"予約を確定する",en:"Confirm booking",zh:"確定預約",ko:"예약 확정"},
    agree_alert:{ja:"貸渡約款・キャンセル規定へのご同意が必要です",en:"You must agree to the rental terms & cancellation policy",zh:"需同意租賃約款與取消規定",ko:"대여 약관·취소 규정 동의가 필요합니다"},
    /* mock4 完了 */
    done_title:{ja:"ご予約が完了しました",en:"Your booking is complete",zh:"預約已完成",ko:"예약이 완료되었습니다"},
    done_sub:{ja:"ご予約内容の確認メールをお送りしました。<br>当日は高松空港店の店頭でお受け取りください。",en:"A confirmation email has been sent.<br>Please pick up at Takamatsu Airport store on the day.",zh:"已寄送預約確認郵件。<br>當日請至高松機場店門市取車。",ko:"예약 확인 메일을 보냈습니다.<br>당일 다카마쓰공항점 매장에서 수령해 주세요."},
    res_no:{ja:"ご予約番号",en:"Booking No.",zh:"預約編號",ko:"예약 번호"},
    before_go:{ja:"ご出発までのお手続き",en:"Before you go",zh:"出發前手續",ko:"출발 전 절차"},
    st_lic:{ja:"運転免許証のご登録",en:"Register driver's license",zh:"登錄駕照",ko:"운전면허증 등록"},
    st_lic_d:{ja:"運転される方全員分をご利用ガイドからご登録ください。",en:"Register all drivers in the Guide.",zh:"請於指南登錄所有駕駛人。",ko:"운전하는 모든 분을 가이드에서 등록하세요."},
    st_terms:{ja:"貸渡約款のご署名",en:"Sign rental terms",zh:"簽署租賃約款",ko:"대여 약관 서명"},
    st_terms_d:{ja:"ご利用ガイドで内容をご確認のうえ、ご署名ください。",en:"Review and sign in the Guide.",zh:"請於指南確認後簽署。",ko:"가이드에서 확인 후 서명하세요."},
    st_dmg:{ja:"お車の状態確認",en:"Check car condition",zh:"確認車輛狀態",ko:"차량 상태 확인"},
    st_dmg_d:{ja:"お受け取り時にお車の外装をご確認いただけます。",en:"Check the exterior at pick-up.",zh:"取車時可確認外觀。",ko:"수령 시 외관을 확인하실 수 있습니다."},
    st_recv:{ja:"店頭でお受け取り",en:"Pick up in-store",zh:"門市取車",ko:"매장 수령"},
    st_recv_d:{ja:"ご利用ガイドの「時間管理」でお時間をご確認いただけます。",en:"Track time in the Guide's meter.",zh:"可於指南「時間管理」查看時間。",ko:"가이드 '시간 관리'에서 시간을 확인하세요."},
    mail_note:{ja:"📧 ご登録のメールアドレスに、ご利用ガイドのご案内をお送りしました。",en:"📧 The Guide link was sent to your email.",zh:"📧 已將使用指南寄至您的信箱。",ko:"📧 등록 이메일로 이용 가이드를 보냈습니다."},
    open_guide:{ja:"📄 ご利用ガイドを開く",en:"📄 Open the Guide",zh:"📄 開啟使用指南",ko:"📄 이용 가이드 열기"},
    /* guide ご利用ガイド */
    guide_title:{ja:"ご利用ガイド",en:"User Guide",zh:"使用指南",ko:"이용 가이드"},
    meter_label:{ja:"⏱ 利用時間メーター",en:"⏱ Usage Meter",zh:"⏱ 使用時間計",ko:"⏱ 이용 시간 미터"},
    demo_reset:{ja:"（デモ操作をリセット）",en:"(Reset demo)",zh:"（重設示範）",ko:"(데모 초기화)"},
    todo_label:{ja:"📋 ご出発前のお手続き",en:"📋 Before departure",zh:"📋 出發前手續",ko:"📋 출발 전 절차"},
    lic_tt:{ja:"運転免許証のご登録",en:"Register driver's license",zh:"登錄駕照",ko:"운전면허증 등록"},
    lic_ts:{ja:"運転される方全員分（表・裏）",en:"All drivers (front & back)",zh:"所有駕駛人（正反面）",ko:"운전자 전원(앞·뒤)"},
    terms_tt:{ja:"貸渡約款のご署名",en:"Sign rental terms",zh:"簽署租賃約款",ko:"대여 약관 서명"},
    terms_ts:{ja:"内容をご確認のうえご署名ください",en:"Review and sign",zh:"確認後簽署",ko:"확인 후 서명"},
    dmg_tt:{ja:"お車の状態確認",en:"Check car condition",zh:"確認車輛狀態",ko:"차량 상태 확인"},
    dmg_ts:{ja:"外装のキズ等（お受け取り時）",en:"Exterior scratches (at pick-up)",zh:"外觀刮痕等（取車時）",ko:"외관 흠집 등(수령 시)"},
    badge_lic:{ja:"未登録",en:"Not done",zh:"未登錄",ko:"미등록"},
    badge_terms:{ja:"未署名",en:"Not signed",zh:"未簽署",ko:"미서명"},
    badge_dmg:{ja:"受取時",en:"At pick-up",zh:"取車時",ko:"수령 시"},
    recv_label:{ja:"🏬 店頭お受け取り・ご返却",en:"🏬 In-store pick-up & return",zh:"🏬 門市取還車",ko:"🏬 매장 수령·반납"},
    g_store:{ja:"BUDDICA TOURISM 高松空港店",en:"BUDDICA TOURISM Takamatsu Airport",zh:"BUDDICA TOURISM 高松機場店",ko:"BUDDICA TOURISM 다카마쓰공항점"},
    g_addr_k:{ja:"ご住所",en:"Address",zh:"地址",ko:"주소"},
    g_addr_v:{ja:"香川県高松市…（店頭）",en:"Takamatsu, Kagawa (in-store)",zh:"香川縣高松市…（門市）",ko:"가가와현 다카마쓰시…(매장)"},
    g_sched_k:{ja:"ご予約のお時間",en:"Booked time",zh:"預約時間",ko:"예약 시간"},
    g_shuttle_k:{ja:"送迎",en:"Shuttle",zh:"接送",ko:"픽업"},
    g_shuttle_v:{ja:"なし（店頭でのお受け取り・ご返却）",en:"None (in-store pick-up & return)",zh:"無（門市取還車）",ko:"없음(매장 수령·반납)"},
    g_map:{ja:"🗺 店舗地図（モック）",en:"🗺 Store map (mock)",zh:"🗺 門市地圖（原型）",ko:"🗺 매장 지도(목업)"},
    /* license modal */
    lm_title:{ja:"運転免許証のご登録",en:"Register driver's license",zh:"登錄駕照",ko:"운전면허증 등록"},
    lm_desc:{ja:"運転される方<b style=\"color:#ffcfae\">全員分</b>の運転免許証を、<b style=\"color:#ffcfae\">表面・裏面</b>それぞれ撮影またはアップロードしてください。",en:"Please upload the <b style=\"color:#ffcfae\">front & back</b> of the license for <b style=\"color:#ffcfae\">every driver</b>.",zh:"請上傳<b style=\"color:#ffcfae\">每位駕駛人</b>駕照的<b style=\"color:#ffcfae\">正反面</b>。",ko:"운전하는 <b style=\"color:#ffcfae\">모든 분</b>의 면허증 <b style=\"color:#ffcfae\">앞·뒤</b>를 업로드하세요."},
    lm_add:{ja:"＋ 運転者を追加",en:"+ Add driver",zh:"＋ 新增駕駛人",ko:"＋ 운전자 추가"},
    lm_save:{ja:"登録する",en:"Register",zh:"登錄",ko:"등록"},
    driver:{ja:"運転者",en:"Driver",zh:"駕駛人",ko:"운전자"},
    side_front:{ja:"表面",en:"Front",zh:"正面",ko:"앞면"},
    side_back:{ja:"裏面",en:"Back",zh:"背面",ko:"뒷면"},
    /* terms modal */
    tm_title:{ja:"貸渡約款のご署名",en:"Sign rental terms",zh:"簽署租賃約款",ko:"대여 약관 서명"},
    tm_sign_here:{ja:"下の白い枠に、ご署名ください",en:"Please sign in the white box below",zh:"請於下方白框簽名",ko:"아래 흰 칸에 서명해 주세요"},
    tm_clear:{ja:"消去してやり直す",en:"Clear",zh:"清除重簽",ko:"지우고 다시"},
    tm_agree:{ja:"約款に同意して署名する",en:"Agree & sign",zh:"同意並簽署",ko:"약관 동의 후 서명"},
    /* meter dynamic (T使用) */
    lang_names:{ja:"日本語",en:"English",zh:"繁體中文",ko:"한국어"}
  };
  function lang(){try{return localStorage.getItem("btlang")||"ja";}catch(e){return "ja";}}
  window.BTL=lang;
  window.T=function(k){var d=DICT[k];if(!d)return k;return d[lang()]||d.ja||k;};
  window.applyLang=function(){
    var L=lang();
    document.documentElement.setAttribute("lang",L==="zh"?"zh-Hant":(L==="ko"?"ko":(L==="en"?"en":"ja")));
    document.querySelectorAll("[data-t]").forEach(function(el){var k=el.getAttribute("data-t");if(DICT[k])el.innerHTML=DICT[k][L]||DICT[k].ja;});
    document.querySelectorAll("[data-tph]").forEach(function(el){var k=el.getAttribute("data-tph");if(DICT[k])el.setAttribute("placeholder",DICT[k][L]||DICT[k].ja);});
    // 言語ボタンのactive
    document.querySelectorAll(".langbtn").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-l")===L);});
    if(window.onLang)try{window.onLang(L);}catch(e){}
  };
  window.setLang=function(l){try{localStorage.setItem("btlang",l);}catch(e){}window.applyLang();};
  // 言語切替UIを注入（右上固定）
  function injectSwitcher(){
    if(document.getElementById("langbar"))return;
    var css=document.createElement("style");
    css.textContent="#langbar{position:fixed;top:8px;right:8px;z-index:200;display:flex;gap:3px;background:rgba(10,10,12,.85);border:1px solid #33333c;border-radius:20px;padding:3px;backdrop-filter:blur(6px)}.langbtn{background:transparent;border:none;color:#9a9aa5;font-size:11px;font-weight:800;padding:5px 8px;border-radius:14px;cursor:pointer;line-height:1}.langbtn.on{background:#f26522;color:#fff}";
    document.head.appendChild(css);
    var bar=document.createElement("div");bar.id="langbar";
    var langs=[["ja","日"],["en","EN"],["zh","繁"],["ko","한"]];
    bar.innerHTML='<span style="color:#8a8a95;font-size:12px;padding:0 2px">🌐</span>'+langs.map(function(a){return '<button class="langbtn" data-l="'+a[0]+'" onclick="setLang(\''+a[0]+'\')">'+a[1]+'</button>';}).join("");
    document.body.appendChild(bar);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){injectSwitcher();window.applyLang();});
  else{injectSwitcher();window.applyLang();}
})();
