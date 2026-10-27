/* 出発前点検 11項目の「やり方」（見るところ・OKの基準・NGのとき）— 3店共通（SPK/NHA/BT 同一ファイル）
   2026-10-27 追加。表示だけ（DBに書かない）。各点検画面の項目の右「やり方」でトグル表示。
   写真：IMG_BASE に <key>_N.jpg を置くと自動で表示（無いファイルは出ない）。一覧＝ PHOTO_REQUEST（下）。
   ※このファイルは3リポ（spk-task / naha-project / buddica-touring app）で同じ内容。直す時は3つとも同じに。 */
(function(){
  if(window.InspHowto)return;
  var IMG_BASE="insp-howto/";
  var OPEN={};

  /* ---------- 図（線画・実車写真ではない） ---------- */
  var S='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 120" width="100%" style="max-width:300px;display:block;margin:6px 0" font-family="sans-serif">';
  var FIG={
    exterior:S+'<rect x="95" y="20" width="90" height="80" rx="22" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>'+
      '<rect x="110" y="38" width="60" height="44" rx="8" fill="#cbd5e1"/>'+
      '<path d="M70 60 A70 40 0 1 1 70 61" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="6 4"/>'+
      '<text x="140" y="12" font-size="12" text-anchor="middle" fill="#0f172a" font-weight="700">①前（バンパー・ライト・ガラス）</text>'+
      '<text x="140" y="117" font-size="12" text-anchor="middle" fill="#0f172a" font-weight="700">③後ろ（バンパー・トランク）</text>'+
      '<text x="6" y="64" font-size="12" fill="#0f172a" font-weight="700">④助手席側</text>'+
      '<text x="212" y="64" font-size="12" fill="#0f172a" font-weight="700">②運転席側</text></svg>',
    fuel:S+'<path d="M60 100 A80 80 0 0 1 220 100" fill="none" stroke="#475569" stroke-width="6"/>'+
      '<text x="52" y="116" font-size="16" font-weight="900" fill="#b91c1c">E</text><text x="218" y="116" font-size="16" font-weight="900" fill="#166534">F</text>'+
      '<line x1="140" y1="100" x2="210" y2="62" stroke="#dc2626" stroke-width="5" stroke-linecap="round"/><circle cx="140" cy="100" r="7" fill="#0f172a"/>'+
      '<text x="140" y="14" font-size="13" text-anchor="middle" font-weight="800" fill="#166534">針が F の線まで来ていればOK</text></svg>',
    washer:S+'<circle cx="70" cy="60" r="42" fill="#dbeafe" stroke="#2563eb" stroke-width="3"/>'+
      '<path d="M44 74 Q70 46 96 74 Z" fill="none" stroke="#1e3a8a" stroke-width="3"/>'+
      '<path d="M70 66 L58 44 M70 66 L70 40 M70 66 L82 44" stroke="#1e3a8a" stroke-width="2.5" stroke-dasharray="3 3"/>'+
      '<text x="128" y="44" font-size="13" font-weight="800" fill="#0f172a">このマークのキャップ</text>'+
      '<text x="128" y="64" font-size="12" fill="#334155">＝ウォッシャー液のタンク</text>'+
      '<text x="128" y="84" font-size="12" fill="#334155">（青か白のことが多い）</text></svg>',
    oil:S+'<rect x="10" y="52" width="220" height="10" rx="5" fill="#cbd5e1" stroke="#475569"/>'+
      '<circle cx="250" cy="57" r="16" fill="none" stroke="#f59e0b" stroke-width="7"/>'+
      '<rect x="10" y="52" width="88" height="10" rx="5" fill="#a16207"/>'+
      '<line x1="40" y1="40" x2="40" y2="74" stroke="#0f172a" stroke-width="2"/><line x1="120" y1="40" x2="120" y2="74" stroke="#0f172a" stroke-width="2"/>'+
      '<rect x="40" y="46" width="80" height="22" fill="#22c55e" opacity=".18"/>'+
      '<text x="40" y="34" font-size="13" text-anchor="middle" font-weight="900" fill="#b91c1c">L</text><text x="120" y="34" font-size="13" text-anchor="middle" font-weight="900" fill="#166534">F</text>'+
      '<text x="80" y="92" font-size="12" text-anchor="middle" font-weight="800" fill="#166534">油の先がこの間ならOK</text>'+
      '<text x="246" y="92" font-size="10" text-anchor="middle" fill="#334155">黄色の取っ手</text></svg>',
    coolant:S+'<rect x="40" y="14" width="80" height="96" rx="10" fill="#f8fafc" stroke="#475569" stroke-width="2"/>'+
      '<rect x="42" y="52" width="76" height="56" rx="8" fill="#f9a8d4"/>'+
      '<line x1="34" y1="36" x2="126" y2="36" stroke="#166534" stroke-width="2"/><line x1="34" y1="84" x2="126" y2="84" stroke="#b91c1c" stroke-width="2"/>'+
      '<text x="132" y="40" font-size="13" font-weight="900" fill="#166534">FULL（MAX）</text><text x="132" y="88" font-size="13" font-weight="900" fill="#b91c1c">LOW（MIN）</text>'+
      '<text x="132" y="64" font-size="12" font-weight="800" fill="#0f172a">液面がこの間ならOK</text></svg>',
    tire_air:S+'<rect x="20" y="14" width="150" height="92" rx="6" fill="#fff" stroke="#475569" stroke-width="2"/>'+
      '<text x="95" y="34" font-size="12" text-anchor="middle" font-weight="900" fill="#0f172a">タイヤ空気圧（指定値）</text>'+
      '<text x="34" y="62" font-size="13" font-weight="800" fill="#0f172a">前 ○○○ kPa</text><text x="34" y="88" font-size="13" font-weight="800" fill="#0f172a">後 ○○○ kPa</text>'+
      '<text x="180" y="50" font-size="12" fill="#334155">運転席ドアを</text><text x="180" y="68" font-size="12" fill="#334155">開けた柱に</text><text x="180" y="86" font-size="12" fill="#334155">貼ってある</text></svg>'
  };

  /* ---------- 中身（見る＝見るところ／ok＝OKの基準／ng＝NGのとき） ---------- */
  var D={
    exterior:{
      see:["車の周りを1周（前→運転席側→後ろ→助手席側）","バンパーの角・ドア・ミラー・ホイール・屋根","フロントガラスのヒビ・飛び石の跡"],
      ok:"前回の記録（傷チェック）に無い新しい傷・へこみ・ヒビが無い",
      ng:"写真を撮って傷チェックに登録し、責任者に報告"},
    interior:{
      see:["座席の上・下、足元マット","ドアポケット・ドリンクホルダー・グローブボックス","トランク（荷室）","におい（たばこ・ペット・強い芳香剤）","窓の内側の汚れ・指紋"],
      ok:"ゴミ・忘れ物・砂・髪の毛が無く、においも無い",
      ng:"清掃・消臭する。忘れ物は責任者へ渡す"},
    fuel:{
      see:["エンジンをかけてメーターの燃料計を見る"],
      ok:"針（または目盛り）が F いっぱい",
      ng:"給油する（給油機が自動で止まるまで。継ぎ足しはしない）"},
    washer:{
      see:["ボンネットを開け、ウォッシャーのマークのキャップのタンク","運転席でワイパーレバーを手前に引き、液が出るか"],
      ok:"タンクに液が十分あり、前のガラスにしっかり出る",
      ng:"専用のウォッシャー液を補充（冬は凍らない寒冷地用）。出ない時は責任者へ"},
    oil:{
      see:["平らな場所・エンジンを止めて5分以上たってから","黄色（オレンジ）の輪の取っ手＝オイルゲージを抜く","布で拭く→奥まで差し込む→もう一度抜いて、油が付いた位置を見る"],
      ok:"油の先が L と F の間。色が真っ黒でドロドロ・白っぽく濁っていない",
      ng:"L より下・色がおかしい時は貸し出さず責任者へ。ゲージが見つからない車も責任者へ"},
    coolant:{
      see:["エンジンが冷えている時に見る","ボンネット内の半透明のタンク（リザーバータンク）の横の線"],
      ok:"液面が FULL（MAX）と LOW（MIN）の間",
      ng:"LOW より下は責任者へ。⚠️熱い時はキャップを絶対に開けない（やけど）"},
    tire_air:{
      see:["運転席ドアを開けた柱のラベルで指定の空気圧（kPa）を確認","エアゲージで4本とも測る","タイヤの横のヒビ・ふくらみ、接地面の釘・ネジ・石","溝（スリップサインが出ていないか）"],
      ok:"4本とも指定の空気圧どおり。釘・ふくらみ・深いヒビが無い",
      ng:"空気が少なければ指定値まで入れる。釘・ふくらみ・すり減りは貸し出さず責任者へ"},
    lights:{
      see:["エンジンをかけて、ヘッドライト（下向き・上向き）・車幅灯","ウインカー左右（前・後ろ・ミラー）とハザード","ブレーキランプ（2人で見る／壁やガラスに映して見る）","バックランプ（ブレーキを踏んだままRに入れる）"],
      ok:"全部点く。ウインカーの点滅がいつもより速くない（速い＝球切れのサイン）",
      ng:"点かない所があれば貸し出さず責任者へ"},
    warning:{
      see:["エンジンをかける前（キーON）にメーターの警告灯が一斉に点く","エンジンをかけた後、数秒で全部消えるか"],
      ok:"エンジン始動後に点いたままの警告灯が無い（サイドブレーキ・シートベルトは外せば消える＝正常）",
      ng:"🔴赤（ブレーキ・油圧・充電・水温）＝走らせない。🟡黄（エンジン・ABS・エアバッグ等）＝貸し出さない。メーターの写真を撮って責任者へ",
      html:'<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0"><span class="ih-chip" style="background:#fee2e2;color:#991b1b">🔴 赤＝すぐ止める</span><span class="ih-chip" style="background:#fef3c7;color:#92400e">🟡 黄・オレンジ＝点検が必要</span><span class="ih-chip" style="background:#dcfce7;color:#166534">🟢 緑・青＝作動中の表示（問題なし）</span></div>'},
    aircon:{
      see:["エンジンをかけ、A/C ボタンON・温度いちばん低く・風量は中","1〜2分後に吹き出し口の風を手で確認","温度をいちばん高くして温風も確認"],
      ok:"冷たい風・温かい風が全部の吹き出し口から出る。カビ臭・異音が無い",
      ng:"冷えない・におう・音がする時は責任者へ"},
    docs:{
      see:["グローブボックス（助手席前）の車検証入れ","車検証・自賠責保険の証明書・取扱説明書の3点"],
      ok:"3点そろっている。車検証のナンバーがこの車と同じ。自賠責の期間が切れていない",
      ng:"足りない・違う車の物・期限切れは貸し出さず責任者へ"}
  };

  /* ---------- 写真（齊藤さん用意分）：ファイル名＝IMG_BASE+f。置けば自動で出る ---------- */
  var PHOTO_REQUEST={
    exterior:[{f:"exterior_1.jpg",cap:"新しい傷を見つけた時の撮り方（離れて1枚＋近くで1枚）"}],
    interior:[{f:"interior_1.jpg",cap:"清掃が終わった状態の見本"},{f:"interior_2.jpg",cap:"見落としやすい所（座席の下・ドアポケット・荷室）"}],
    fuel:[{f:"fuel_1.jpg",cap:"燃料計が F の実車メーター"}],
    washer:[{f:"hood_1.jpg",cap:"ボンネットの開け方（レバーの場所）"},{f:"washer_1.jpg",cap:"ウォッシャー液タンクの場所"}],
    oil:[{f:"hood_1.jpg",cap:"ボンネットの開け方（レバーの場所）"},{f:"oil_1.jpg",cap:"オイルゲージの場所"},{f:"oil_2.jpg",cap:"抜いたゲージの先（油の位置）"}],
    coolant:[{f:"hood_1.jpg",cap:"ボンネットの開け方（レバーの場所）"},{f:"coolant_1.jpg",cap:"冷却水タンクの場所と FULL/LOW の線"}],
    tire_air:[{f:"tire_air_1.jpg",cap:"運転席ドアの柱の空気圧ラベル"},{f:"tire_air_2.jpg",cap:"エアゲージで測るところ"},{f:"tire_air_3.jpg",cap:"NGの例（釘・ふくらみ・ヒビ）"}],
    lights:[{f:"lights_1.jpg",cap:"ライトスイッチとウインカーレバー"}],
    warning:[{f:"warning_1.jpg",cap:"エンジン始動後、警告灯が消えたメーター（OK）"}],
    aircon:[{f:"aircon_1.jpg",cap:"エアコンの操作パネル（A/C ボタン）"}],
    docs:[{f:"docs_1.jpg",cap:"車検証入れの中の3点がそろった状態"}]
  };

  function css(){
    if(document.getElementById("ih-css"))return;
    var st=document.createElement("style");st.id="ih-css";
    st.textContent=".ih-row{display:flex;align-items:center;gap:6px}.ih-row>label{flex:1 1 auto;min-width:0}"+
      ".ih-wrap{border-bottom:1px solid #f1f5f9}.ih-wrap .ins-it{border-bottom:none}"+
      ".ih-btn{flex:0 0 auto;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;font-family:inherit}"+
      ".ih-btn.on{background:#0f172a;color:#fff;border-color:#0f172a}"+
      ".ih-p{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin:2px 0 8px;font-size:13px;line-height:1.6;color:#1e293b;font-weight:500;text-align:left}"+
      ".ih-p[hidden]{display:none}.ih-p b{display:block;font-size:12px;font-weight:900;margin-top:6px}.ih-p b:first-child{margin-top:0}"+
      ".ih-p ul{margin:2px 0 0;padding-left:18px}.ih-ok{color:#166534}.ih-ng{color:#b91c1c}"+
      ".ih-chip{display:inline-block;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:800}"+
      ".ih-ph{margin-top:8px}.ih-ph figure{margin:0 0 8px}.ih-ph img{width:100%;max-width:340px;border-radius:8px;display:block;border:1px solid #e2e8f0}.ih-ph figcaption{font-size:11px;color:#64748b}";
    (document.head||document.documentElement).appendChild(st);
  }
  function has(k){return !!D[k];}
  function body(k){
    var d=D[k];if(!d)return "";
    var h='<b>👀 見るところ</b><ul>'+d.see.map(function(s){return "<li>"+s+"</li>";}).join("")+'</ul>'+
      '<b class="ih-ok">✅ OKの基準</b><div>'+d.ok+'</div>'+
      '<b class="ih-ng">⚠️ NGのとき</b><div>'+d.ng+'</div>'+(d.html||"")+(FIG[k]||"");
    var ph=PHOTO_REQUEST[k]||[];
    if(ph.length)h+='<div class="ih-ph">'+ph.map(function(p){return '<figure><img src="'+IMG_BASE+p.f+'" alt="" loading="lazy" onerror="this.parentNode.remove()"><figcaption>'+p.cap+'</figcaption></figure>';}).join("")+'</div>';
    return h;
  }
  function btn(k){css();if(!D[k])return "";return '<button type="button" class="ih-btn'+(OPEN[k]?" on":"")+'" data-ihk="'+k+'" onclick="event.preventDefault();event.stopPropagation();InspHowto.toggle(this)">やり方</button>';}
  function panel(k){css();if(!D[k])return "";return '<div class="ih-p" data-ihp="'+k+'"'+(OPEN[k]?"":" hidden")+'>'+(OPEN[k]?body(k):"")+'</div>';}
  // 文字列で組む画面用：ラベル＋ボタンの行と、その下のパネル
  function row(labelHtml,k){if(!D[k])return labelHtml;return '<div class="ih-row">'+labelHtml+btn(k)+'</div>'+panel(k);}
  function toggle(b){
    var k=b.getAttribute("data-ihk");OPEN[k]=!OPEN[k];b.classList.toggle("on",!!OPEN[k]);
    var r=b.closest(".ih-row"),n=r&&r.nextElementSibling,p=n&&(n.classList.contains("ih-p")?n:n.querySelector(".ih-p"));
    if(p){if(OPEN[k]&&!p.innerHTML)p.innerHTML=body(k);p.hidden=!OPEN[k];}
  }
  window.InspHowto={has:has,btn:btn,panel:panel,row:row,toggle:toggle,PHOTO_REQUEST:PHOTO_REQUEST,IMG_BASE:IMG_BASE};
})();
