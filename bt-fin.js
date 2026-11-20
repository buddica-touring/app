// 車両リスト・店舗支出・PL（オーナー指示 2026-11-20）。procurement.html のタブから呼ぶ。
// 読む：bt_vehicles / bt_classes / bt_vehicle_monthly_kpi / bt_accounting（cash_out・card_pay）/ bt_mtg_h2 / bt_ota_brand_split（無ければ bt_cost_cpa）/ bt_pl_manual
// 書く（人が入力した1項目だけ）：bt_vehicles の lease_monthly・insurance_annual・shaken_cost・tenken_cost（配車表の車両マスタと同じ列）／bt_pl_manual の1セル
// 金額の数字は書き写さない。開くたび・🔄で正本から読み直す。
// ログインなしで見る（オーナー指示 2026-11-20「ログインなしで見るのが必須」）：車両ダッシュボードと同じ公開キーで閲覧用関数 bt_fin_view から読む（メモ・支払先・入力者は返さない）。
// 入力（車両の金額・PLの手入力）もログインなしで可（オーナー指示 2026-11-20「入力できない　支出」）：同じ公開キーで書込用関数 bt_fin_set_vehicle_cost／bt_fin_set_manual を呼び、1回に1セルだけ書く（audit_log に残る）。
window.FIN=(function(){
  const yen=n=>(n<0?'−':'')+'¥'+Math.abs(Math.round(+n||0)).toLocaleString();
  const num=n=>Math.round(+n||0).toLocaleString();
  const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const $=id=>document.getElementById(id);
  const jstNow=()=>new Date(Date.now()+9*3600e3);
  const ymNow=()=>{const d=jstNow();return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');};
  const todayStr=()=>jstNow().toISOString().slice(0,10);
  const addYm=(ym,n)=>{let y=+ym.slice(0,4),m=+ym.slice(5)-1+n;y+=Math.floor(m/12);m=((m%12)+12)%12;return y+'-'+String(m+1).padStart(2,'0');};
  const fyOf=ym=>+ym.slice(5)>=4?+ym.slice(0,4):+ym.slice(0,4)-1;          // 年度＝4月〜翌3月
  const fyMonths=fy=>{const a=[];for(let i=0;i<12;i++)a.push(addYm(fy+'-04',i));return a;};
  const normBrand=b=>{const s=String(b||"").trim().toUpperCase();return (s==="HDM"||s==="HANDYMAN")?"HDM":"BUDDICA";};   // 未設定は BUDDICA（配車表と同じ）
  const BRL={BUDDICA:"BUDDICA",HDM:"HANDYMAN"}, BRC={BUDDICA:"#047857",HDM:"#1e3a8a"};

  // 月額の換算＝配車表の車両マスタと同じ式（保険・リースは月額／車検は1回の費用÷12＝1年車検／点検は半年点検1回の費用÷6）
  const COST=[["lease_monthly","リース","月額",1],["insurance_annual","保険","月額",1],["shaken_cost","車検予算","1回",1/12],["tenken_cost","点検予算","半年1回",1/6]];
  const monthlyOf=v=>COST.reduce((s,[k,,,f])=>s+(+v[k]||0)*f,0);
  const costParts=v=>({lease:+v.lease_monthly||0,ins:+v.insurance_annual||0,shaken:(+v.shaken_cost||0)/12,tenken:(+v.tenken_cost||0)/6});

  async function session(){try{const {data}=await sb.auth.getSession();return data&&data.session||null;}catch(e){return null;}}
  const VIEW_KEY="tourism-public";   // vehicle-life.js の PUBLIC_KEY と同じ（bt_view_keys name='vehicle_dashboard'）
  const CAN_EDIT=true;   // ログインなしでも入力できる（書込は関数側で科目・列・金額の範囲を確認）
  async function view(){const {data,error}=await sb.rpc("bt_fin_view",{p_key:VIEW_KEY});if(error)throw error;return data||{};}
  async function all(make){let out=[],from=0;for(;;){const {data,error}=await make().range(from,from+999);if(error)throw error;out=out.concat(data||[]);if(!data||data.length<1000)break;from+=1000;}return out;}
  const rpc=async(fn)=>{try{const {data,error}=await sb.rpc(fn,{});return error?null:data;}catch(e){return null;}};

  // ===== 正本の読込 =====
  function vehOf(d){
    const vs=d.vehicles||[], classes=d.classes||[], K={};
    (d.kpi||[]).forEach(k=>{(K[k.year_month]=K[k.year_month]||{})[k.vehicle_code]=k.active;});
    return {vs,classes,K};
  }
  async function loadVehicles(){return vehOf(await view());}
  // 配車表に出る車＝クラス表にあるクラスの車（送迎など別枠は除く）・運用終了日が過ぎた車は除く
  function fleetOf(V,ym){
    const cs=new Set(V.classes.map(c=>c.id)), ms=ym+'-01', me=addYm(ym,1)+'-01';
    return V.vs.filter(v=>cs.has(v.type)&&!(v.service_to&&v.service_to<ms)&&!(v.service_from&&v.service_from>=me));
  }
  // 稼働＝その月の配車表の稼働フラグ（bt_vehicle_monthly_kpi）。未設定の車は稼働扱い＝配車表の見出し「計N（稼働a/未稼働i）」と同じ
  const isAct=(V,ym,code)=>{const m=V.K[ym];return !(m&&m[code]===false);};

  // ===== ② 車両リスト =====
  let FV=null;
  async function showFleet(){
    const body=$("finFleet"); if(!body)return;
    body.innerHTML='<div class="fn-empty">読み込み中…</div>';
    try{FV=await loadVehicles();renderFleet();}catch(e){body.innerHTML='<div class="fn-empty">読み込めませんでした：'+esc(e.message||e)+'</div>';}
  }
  function renderFleet(){
    const body=$("finFleet"), ym=ymNow(), list=fleetOf(FV,ym), CL={}; FV.classes.forEach(c=>CL[c.id]=c);
    const act=v=>isAct(FV,ym,v.code);
    const tot={n:list.length,a:list.filter(act).length};
    const sumC=(arr)=>arr.reduce((s,v)=>{const p=costParts(v);s.lease+=p.lease;s.ins+=p.ins;s.shaken+=p.shaken;s.tenken+=p.tenken;return s;},{lease:0,ins:0,shaken:0,tenken:0});
    const cAll=sumC(list), cAct=sumC(list.filter(act)), mAll=cAll.lease+cAll.ins+cAll.shaken+cAll.tenken, mAct=cAct.lease+cAct.ins+cAct.shaken+cAct.tenken;
    let h='<div class="fn-note">配車表に出ている車（'+(+ym.slice(5))+'月）。稼働／未稼働＝配車表の今月の稼働フラグ。リース・保険は月額、車検予算は1回分（1年ごと＝÷12で月額）、点検予算は半年点検1回分（÷6で月額）＝配車表の車両マスタと同じ欄です（どちらで直しても同じ値になります）。</div>';
    // 台数
    h+='<div class="fn-cards"><div class="fn-card"><span>合計運用台数</span><b>'+tot.n+'台</b><small>稼働 '+tot.a+' ／ 未稼働 '+(tot.n-tot.a)+'</small></div>';
    ["BUDDICA","HDM"].forEach(b=>{const l=list.filter(v=>normBrand(v.brand)===b),a=l.filter(act).length;h+='<div class="fn-card" style="border-top:4px solid '+BRC[b]+'"><span>'+BRL[b]+'</span><b>'+l.length+'台</b><small>稼働 '+a+' ／ 未稼働 '+(l.length-a)+'</small></div>';});
    h+='</div>';
    // 維持コスト
    h+='<div class="fn-h">維持コスト</div><div class="fn-tw"><table class="fn-t fn-cost"><thead><tr><th></th><th>リース</th><th>保険</th><th>車検</th><th>点検</th><th>月間</th><th>年間</th></tr></thead><tbody>'
      +[["稼働車（"+tot.a+"台）",cAct,mAct],["全車（"+tot.n+"台）",cAll,mAll]].map(([l,c,m])=>'<tr><th>'+l+'</th><td>'+yen(c.lease)+'</td><td>'+yen(c.ins)+'</td><td>'+yen(c.shaken)+'</td><td>'+yen(c.tenken)+'</td><td class="b">'+yen(m)+'</td><td class="b">'+yen(m*12)+'</td></tr>').join('')
      +'</tbody></table></div><div class="fn-note">月間＝リース＋保険＋車検予算÷12＋点検予算÷6。PL のリース料・保険料・車検・点検は、この計算を月ごとの稼働車で出しています。</div>';
    // クラス別台数
    const used=FV.classes.filter(c=>list.some(v=>v.type===c.id));
    h+='<div class="fn-h">クラス別</div><div class="fn-tw"><table class="fn-t"><thead><tr><th>クラス</th><th>BUDDICA</th><th>HANDYMAN</th><th>計</th><th>稼働</th><th>未稼働</th><th>維持コスト/月</th></tr></thead><tbody>'
      +used.map(c=>{const l=list.filter(v=>v.type===c.id),a=l.filter(act).length,nb=l.filter(v=>normBrand(v.brand)==="BUDDICA").length;return '<tr><th>'+esc(c.id)+' <small>'+esc(c.name)+'</small></th><td>'+nb+'</td><td>'+(l.length-nb)+'</td><td class="b">'+l.length+'</td><td>'+a+'</td><td>'+(l.length-a)+'</td><td>'+yen(l.reduce((s,v)=>s+monthlyOf(v),0))+'</td></tr>';}).join('')
      +'<tr class="tot"><th>計</th><td>'+list.filter(v=>normBrand(v.brand)==="BUDDICA").length+'</td><td>'+list.filter(v=>normBrand(v.brand)==="HDM").length+'</td><td class="b">'+tot.n+'</td><td>'+tot.a+'</td><td>'+(tot.n-tot.a)+'</td><td>'+yen(mAll)+'</td></tr></tbody></table></div>';
    // 1台ずつ（ブランド別 → クラス別）
    ["BUDDICA","HDM"].forEach(b=>{const l=list.filter(v=>normBrand(v.brand)===b); if(!l.length)return; const a=l.filter(act).length;
      h+='<div class="fn-bh" style="background:'+BRC[b]+'">'+BRL[b]+' <small>計 '+l.length+'台（稼働 '+a+' ／ 未稼働 '+(l.length-a)+'）・維持コスト/月 '+yen(l.reduce((s,v)=>s+monthlyOf(v),0))+'</small></div>';
      h+='<div class="fn-tw"><table class="fn-t fn-veh"><thead><tr><th>クラス</th><th>車種名</th><th>状態</th>'+COST.map(([,l,u])=>'<th>'+l+'<small>（'+u+'）</small></th>').join('')+'<th>月額計</th><th>年額計</th></tr></thead><tbody>';
      FV.classes.forEach(c=>{const g=l.filter(v=>v.type===c.id); if(!g.length)return; const ga=g.filter(act).length;
        h+='<tr class="cg"><th colspan="9">'+esc(c.id)+' '+esc(c.name)+' <small>'+g.length+'台（稼働 '+ga+' ／ 未稼働 '+(g.length-ga)+'）</small></th></tr>';
        g.forEach(v=>{const on=act(v),m=monthlyOf(v);
          h+='<tr><td>'+esc(v.type)+'</td><td class="nm">'+esc(v.name||v.code)+(v.plate_no?' <small>'+esc(v.plate_no)+'</small>':'')+'</td><td><span class="fn-st '+(on?'on':'off')+'">'+(on?'稼働':'未稼働')+'</span></td>'
            +COST.map(([k])=>'<td>'+(CAN_EDIT?'<input class="fn-in" inputmode="numeric" data-vc="'+esc(v.code)+'" data-col="'+k+'" value="'+(+v[k]?num(v[k]):'')+'" placeholder="0">':(+v[k]?num(v[k]):'<span class="z">0</span>'))+'</td>').join('')
            +'<td class="b" data-mo="'+esc(v.code)+'">'+yen(m)+'</td><td data-yr="'+esc(v.code)+'">'+yen(m*12)+'</td></tr>';});
      });
      h+='</tbody></table></div>';});
    body.innerHTML=h;
  }
  // 1台の1項目だけ書く（他の列・他の車は送らない）
  document.addEventListener("change",async ev=>{
    const el=ev.target; if(!el.matches||!el.matches("#finFleet .fn-in"))return;
    const code=el.dataset.vc, col=el.dataset.col, raw=el.value.replace(/[^\d]/g,""), n=raw===""?0:parseInt(raw,10);
    const v=FV&&FV.vs.find(x=>x.code===code); if(!v)return;
    if((+v[col]||0)===n){el.value=n?num(n):"";return;}
    el.disabled=true;
    const {data,error}=await sb.rpc("bt_fin_set_vehicle_cost",{p_key:VIEW_KEY,p_code:code,p_col:col,p_amount:n});
    el.disabled=false;
    if(error||!data||data.amount==null){el.classList.add("ng");setStatus("保存できませんでした："+((error&&error.message)||"権限がありません"));el.value=+v[col]?num(v[col]):"";return;}
    v[col]=+data.amount; el.classList.remove("ng"); el.classList.add("ok"); setTimeout(()=>el.classList.remove("ok"),1200);
    el.value=+v[col]?num(v[col]):"";
    const m=monthlyOf(v); const mo=document.querySelector('[data-mo="'+CSS.escape(code)+'"]'),yr=document.querySelector('[data-yr="'+CSS.escape(code)+'"]');
    if(mo)mo.textContent=yen(m); if(yr)yr.textContent=yen(m*12);
    setStatus("保存しました："+(v.name||code)+" "+(COST.find(c=>c[0]===col)||[])[1]);
  });
  const setStatus=t=>{const s=$("st");if(s)s.textContent=t;};

  // ===== ③ 店舗支出（会計の出納帳の出金＋カード）=====
  // 会計画面の科目（出納帳 cash_out・カード card_pay）をそのまま並べる。予約外売上・立替金・個人立替・雑所得は含めない。
  const ACCT_ORDER=["燃料費","車両整備費","車検費","点検費","修理費","保険料","駐車場代","消耗品費","広告宣伝費","通信費","水道光熱費","旅費交通費","給与手当","外注費","支払手数料","租税公課","雑費","その他"];
  const catOf=c=>{c=String(c||"").trim();return c==="その他出金"||!c?"その他":c;};
  async function loadAcct(){return (await view()).acct||[];}
  // rows＝bt_fin_view の acct（月×種類×科目の合計：ym・type・category・amount・n）
  function acctAgg(rows){const A={};rows.forEach(r=>{const ym=String(r.ym||"").slice(0,7),c=catOf(r.category);if(!ym)return;const a=(A[c]=A[c]||{});const x=(a[ym]=a[ym]||{all:0,card:0,cash:0});x.all+=+r.amount||0;x[r.type==="card_pay"?"card":"cash"]+=+r.amount||0;});return A;}
  let SP_FY=null;
  async function showSpend(){
    const body=$("finSpend"); if(!body)return;
    body.innerHTML='<div class="fn-empty">読み込み中…</div>';
    try{const rows=await loadAcct(); renderSpend(rows);}catch(e){body.innerHTML='<div class="fn-empty">読み込めませんでした：'+esc(e.message||e)+'</div>';}
  }
  function fySel(id,fy){const now=fyOf(ymNow());let o='';for(let y=2026;y<=now+1;y++)o+='<option value="'+y+'"'+(y===fy?' selected':'')+'>'+y+'年度（'+y+'年4月〜'+(y+1)+'年3月）</option>';return '<select class="fn-fy" id="'+id+'">'+o+'</select>';}
  function renderSpend(rows){
    const body=$("finSpend"); if(SP_FY==null)SP_FY=fyOf(ymNow()); const M=fyMonths(SP_FY), A=acctAgg(rows), cur=ymNow();
    const cats=ACCT_ORDER.filter(c=>A[c]).concat(Object.keys(A).filter(c=>!ACCT_ORDER.includes(c)));
    const cell=(c,m,k)=>(A[c]&&A[c][m]&&A[c][m][k])||0;
    const colTot=(m,k)=>cats.reduce((s,c)=>s+cell(c,m,k),0);
    let h='<div class="fn-bar">'+fySel("spFy",SP_FY)+'<button class="btn" id="spReload">🔄 最新に更新</button></div>'
      +'<div class="fn-note">業務APPの「会計」の出納帳（出金）と「カード」を、勘定科目ごと・月ごとに合計しています（日付の月で集計）。入力・修正は業務APPの会計で行ってください。</div>';
    h+='<div class="fn-tw"><table class="fn-t fn-m"><thead><tr><th>勘定科目</th>'+M.map(m=>'<th class="'+(m===cur?'now':'')+'">'+(+m.slice(5))+'月</th>').join('')+'<th>合計</th></tr></thead><tbody>';
    if(!cats.length)h+='<tr><td colspan="14" class="fn-empty">この年度の支出はまだありません</td></tr>';
    cats.forEach(c=>{const t=M.reduce((s,m)=>s+cell(c,m,"all"),0);h+='<tr><th>'+esc(c)+'</th>'+M.map(m=>'<td>'+(cell(c,m,"all")?num(cell(c,m,"all")):'')+'</td>').join('')+'<td class="b">'+(t?num(t):'')+'</td></tr>';});
    const gt=k=>M.reduce((s,m)=>s+colTot(m,k),0);
    h+='<tr class="tot"><th>支出合計</th>'+M.map(m=>'<td>'+num(colTot(m,"all"))+'</td>').join('')+'<td class="b">'+num(gt("all"))+'</td></tr>'
      +'<tr class="sub"><th>うちカード</th>'+M.map(m=>'<td>'+(colTot(m,"card")?num(colTot(m,"card")):'')+'</td>').join('')+'<td>'+num(gt("card"))+'</td></tr>'
      +'<tr class="sub"><th>うち出納帳</th>'+M.map(m=>'<td>'+(colTot(m,"cash")?num(colTot(m,"cash")):'')+'</td>').join('')+'<td>'+num(gt("cash"))+'</td></tr>';
    h+='</tbody></table></div><div class="fn-note">出所：bt_accounting（出納帳の出金・カード）。'+rows.reduce((s,r)=>s+(+r.n||0),0)+'件を集計。</div>';
    body.innerHTML=h;
    $("spFy").onchange=e=>{SP_FY=+e.target.value;renderSpend(rows);};
    $("spReload").onclick=showSpend;
  }

  // ===== ④ PL =====
  // 行：[科目, 種類, 会計の科目]。種類 auto＝自動のみ（手入力なし）／mix＝会計・カードの集計＋手入力／man＝手入力のみ（空欄＝未入力）／calc＝計算行
  //   車検・点検・保険・リースは②の車両リストの数字（その月の稼働車）。会計の「車検費・点検費・保険料」は②と重なるので足さない（店舗支出タブには出る）
  const PL=[
    ["売上高","auto"],["売上原価","man"],["粗利","calc"],
    ["給与手当","mix",["給与手当"]],["賞与","man"],["賞与引当金繰入額","man"],["業務委託費（内部）","man"],["業務委託費（外部）","man"],
    ["法定福利費","man"],["福利厚生費","man"],["外注費","mix",["外注費"]],["旅費交通費","mix",["旅費交通費"]],["調査費","man"],["通信費","mix",["通信費"]],
    ["交際費","man"],["会議費","man"],["減価償却費","man"],["地代家賃","mix",["駐車場代"]],["水道光熱費","mix",["水道光熱費"]],["広告宣伝費","mix",["広告宣伝費"]],
    ["消耗品費","mix",["消耗品費"]],["燃料費","mix",["燃料費"]],["支払手数料","auto",["支払手数料"]],["租税公課","mix",["租税公課"]],["諸会費","man"],["新聞図書費","man"],["教育研修費","man"],
    ["リース料","veh","lease"],["保険料","veh","ins"],["車検","veh","shaken"],["点検","veh","tenken"],
    ["整備費用","mix",["車両整備費","修理費"]],["雑費","mix",["雑費","その他"]],
    ["販管費合計","calc"],["営業利益","calc"]];
  const NOT_IN_PL=["車検費","点検費","保険料"];
  const FEE_H=0.18, FEE_B=0.16;   // OTA手数料：HANDYMAN 18%／BUDDICA 16%（cost-cpa.html と同じ・2026-10-26 オーナー指示）
  let PLD=null, PL_FY=null;
  async function loadPL(){
    const [mtg,split,cpa,d]=await Promise.all([rpc("bt_mtg_h2"),rpc("bt_ota_brand_split"),rpc("bt_cost_cpa"),view()]);
    const acct=d.acct||[], V=vehOf(d), man=d.manual||[];
    const SP={};(Array.isArray(split)?split:[]).forEach(r=>{const m=String(r.ym||"");if(/^\d{4}-\d{2}$/.test(m))SP[m]=(+r.hdm_rev||0)*FEE_H+(+r.bud_rev||0)*FEE_B;});
    (Array.isArray(cpa)?cpa:[]).forEach(r=>{const m=String(r.ym||"");if(/^\d{4}-\d{2}$/.test(m)&&SP[m]==null)SP[m]=(+r.ota_rev||0)*FEE_H;});
    const MAN={}; man.forEach(r=>{if(r.amount!=null)MAN[r.id]=+r.amount;});
    return {sales:(mtg&&mtg.data)||{},gen:mtg&&mtg.generated,fee:SP,A:acctAgg(acct),V,MAN};
  }
  // 稼働フラグの記録が始まる前の月（開店前）は車両費を出さない。記録が終わった先の月は今の車で見込む
  function vehCost(V,ym){const s={lease:0,ins:0,shaken:0,tenken:0};const k0=Object.keys(V.K).sort()[0];if(!k0||ym<k0)return s;fleetOf(V,ym).forEach(v=>{if(!isAct(V,ym,v.code))return;const p=costParts(v);s.lease+=p.lease;s.ins+=p.ins;s.shaken+=p.shaken;s.tenken+=p.tenken;});return s;}
  // 1か月分の PL（行ごとの値）。サマリの「支出合計・損益」もここから出す（数字を別々に計算しない）
  function plMonth(D,ym){
    const o={}, auto={}, vc=vehCost(D.V,ym), ac=cs=>(cs||[]).reduce((s,c)=>s+((D.A[c]&&D.A[c][ym]&&D.A[c][ym].all)||0),0), mn=a=>D.MAN[ym+':'+a];
    PL.forEach(([a,k,x])=>{
      if(k==="auto"){o[a]=a==="売上高"?((D.sales[ym]&&D.sales[ym].tot_r)||0):Math.round(D.fee[ym]||0)+ac(x);auto[a]=o[a];}
      else if(k==="veh"){o[a]=Math.round(vc[x]);auto[a]=o[a];}
      else if(k==="mix"){auto[a]=ac(x);o[a]=auto[a]+(mn(a)||0);}
      else if(k==="man"){o[a]=mn(a)||0;}
    });
    o["粗利"]=o["売上高"]-o["売上原価"];
    o["販管費合計"]=PL.filter(([a,k])=>k!=="calc"&&a!=="売上高"&&a!=="売上原価").reduce((s,[a])=>s+(o[a]||0),0);
    o["営業利益"]=o["粗利"]-o["販管費合計"];
    o._cost=o["売上原価"]+o["販管費合計"];   // 支出合計＝売上原価＋販管費合計
    return {o,auto};
  }
  async function showPL(){
    const body=$("finPL"); if(!body)return;
    body.innerHTML='<div class="fn-empty">読み込み中…</div>';
    try{PLD=await loadPL();renderPL();}catch(e){body.innerHTML='<div class="fn-empty">読み込めませんでした：'+esc(e.message||e)+'</div>';}
  }
  function renderPL(){
    const body=$("finPL"); if(PL_FY==null)PL_FY=fyOf(ymNow()); const M=fyMonths(PL_FY), cur=ymNow(), R=M.map(m=>plMonth(PLD,m));
    const ex=NOT_IN_PL.reduce((s,c)=>s+M.reduce((t,m)=>t+((PLD.A[c]&&PLD.A[c][m]&&PLD.A[c][m].all)||0),0),0);
    let h='<div class="fn-bar">'+fySel("plFy",PL_FY)+'<button class="btn" id="plReload">🔄 最新に更新</button></div>'
      +'<div class="fn-note"><b class="lg a">自動</b> 売上高＝サマリと同じ（返却月・予約＋予約外）／支払手数料＝OTA手数料（HANDYMAN 18%・BUDDICA 16%）＋会計の支払手数料／リース料・保険料・車検・点検＝車両リストの金額×その月の稼働車　'
      +'<b class="lg m">会計</b> 業務APPの会計（出納帳の出金・カード）を科目ごとに反映。手入力欄に入れた分は上乗せ　<b class="lg w">空欄</b> 手入力（自動にする定義が決まったら順次自動に）</div>';
    h+='<div class="fn-tw"><table class="fn-t fn-m fn-pl"><thead><tr><th>勘定科目</th>'+M.map(m=>'<th class="'+(m===cur?'now':'')+'">'+m.slice(0,4)+'年'+(+m.slice(5))+'月</th>').join('')+'<th>合計</th></tr></thead><tbody>';
    PL.forEach(([a,k])=>{
      const tot=R.reduce((s,r)=>s+(r.o[a]||0),0), cls=k==="calc"?(a==="営業利益"?"tot pf":"tot"):(k==="auto"||k==="veh")?"a":k==="mix"?"m":"w";
      h+='<tr class="'+cls+'"><th>'+esc(a)+(k==="auto"||k==="veh"?' <small>自動</small>':'')+'</th>';
      R.forEach((r,i)=>{const m=M[i],v=r.o[a]||0;
        if(k==="man"||k==="mix"){const mv=PLD.MAN[m+':'+a], au=r.auto[a]||0;
          h+='<td>'+(k==="mix"&&au?'<div class="au" title="会計・カードの合計">'+num(au)+'</div>':'')+(CAN_EDIT?'<input class="fn-in pl" inputmode="numeric" data-ym="'+m+'" data-ac="'+esc(a)+'" value="'+(mv!=null?num(mv):'')+'">':(mv!=null?num(mv):''))+'</td>';}
        else h+='<td class="'+(v<0?'neg':'')+'">'+(k==="calc"&&v<0?'('+num(-v)+')':num(v))+'</td>';});
      h+='<td class="b'+(tot<0?' neg':'')+'">'+(tot<0?'('+num(-tot)+')':num(tot))+'</td></tr>';});
    h+='</tbody></table></div><div class="fn-note">出所：売上＝bt_mtg_h2（'+esc(PLD.gen||'')+'）・OTA手数料＝bt_ota_brand_split・会計＝bt_accounting・車両＝bt_vehicles×bt_vehicle_monthly_kpi・手入力＝bt_pl_manual。車両の金額は今の登録値で各月を計算します。'
      +(ex?'<br>⚠️ 会計・カードの「車検費・点検費・保険料」計 '+yen(ex)+' は、車両リストの車検・点検・保険と重なるため PL には足していません（店舗支出タブには出ています）。':'')+'</div>';
    body.innerHTML=h;
    $("plFy").onchange=e=>{PL_FY=+e.target.value;renderPL();};
    $("plReload").onclick=showPL;
  }
  // 手入力1セルだけ書く（id＝'YYYY-MM:科目'）。空欄に戻す＝null（行は消さない）
  document.addEventListener("change",async ev=>{
    const el=ev.target; if(!el.matches||!el.matches("#finPL .fn-in.pl"))return;
    const ym=el.dataset.ym, ac=el.dataset.ac, id=ym+':'+ac, raw=el.value.replace(/[^\d-]/g,""), n=raw===""||raw==="-"?null:parseInt(raw,10);
    const old=PLD.MAN[id]; if((old==null&&n==null)||old===n){el.value=n==null?"":num(n);return;}
    el.disabled=true;
    const {data,error}=await sb.rpc("bt_fin_set_manual",{p_key:VIEW_KEY,p_ym:ym,p_account:ac,p_amount:n});
    el.disabled=false;
    if(error||!data||data.id!==id){el.classList.add("ng");setStatus("保存できませんでした："+((error&&error.message)||"権限がありません"));el.value=old==null?"":num(old);return;}
    if(data.amount==null)delete PLD.MAN[id]; else PLD.MAN[id]=+data.amount;
    const sx=window.scrollX,sy=window.scrollY,sl=(document.querySelector("#finPL .fn-tw")||{}).scrollLeft||0;
    renderPL(); const tw=document.querySelector("#finPL .fn-tw"); if(tw)tw.scrollLeft=sl; window.scrollTo(sx,sy);
    setStatus("保存しました："+(+ym.slice(5))+"月 "+ac);
  });

  // サマリ用：指定した月の 売上・支出合計・損益（PL と同じ計算）。読めなければ null
  async function summary(yms){
    try{const D=await loadPL();const out={};yms.forEach(m=>{const {o}=plMonth(D,m);out[m]={sales:o["売上高"],cost:o._cost,profit:o["売上高"]-o._cost};});return out;}catch(e){return null;}
  }
  document.addEventListener("click",ev=>{if(ev.target&&ev.target.id==="fleetReload")showFleet();});
  return {showFleet,showSpend,showPL,summary};
})();
