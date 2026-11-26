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
  let SP_FY=null;   // 店舗支出も PL と同じ 2026年10月起算・10月〜翌9月（オーナー指示 2026-11-20「店舗支出も10月起算に」）
  async function showSpend(){
    const body=$("finSpend"); if(!body)return;
    body.innerHTML='<div class="fn-empty">読み込み中…</div>';
    try{const rows=await loadAcct(); renderSpend(rows);}catch(e){body.innerHTML='<div class="fn-empty">読み込めませんでした：'+esc(e.message||e)+'</div>';}
  }
  function fySel(id,fy){const now=fyOf(ymNow());let o='';for(let y=2026;y<=now+1;y++)o+='<option value="'+y+'"'+(y===fy?' selected':'')+'>'+y+'年度（'+y+'年4月〜'+(y+1)+'年3月）</option>';return '<select class="fn-fy" id="'+id+'">'+o+'</select>';}
  function renderSpend(rows){
    const body=$("finSpend"); if(SP_FY==null)SP_FY=pfOf(ymNow()); const M=pfMonths(SP_FY), A=acctAgg(rows), cur=ymNow();
    const cats=ACCT_ORDER.filter(c=>A[c]).concat(Object.keys(A).filter(c=>!ACCT_ORDER.includes(c)));
    const cell=(c,m,k)=>(A[c]&&A[c][m]&&A[c][m][k])||0;
    const colTot=(m,k)=>cats.reduce((s,c)=>s+cell(c,m,k),0);
    let h='<div class="fn-bar">'+pfSel("spFy",SP_FY)+'<button class="btn" id="spReload">🔄 最新に更新</button></div>'
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
    ["リース料","veh","lease"],["保険料","veh","ins",["保険料"]],["車検","veh","shaken",["車検費"]],["点検","veh","tenken",["点検費"]],
    ["整備費用","mix",["車両整備費","修理費"]],["雑費","mix",["雑費","その他"]],
    ["販管費合計","calc"],["営業利益","calc"]];
  const PL_FIXED=new Set(["給与手当","賞与","賞与引当金繰入額","業務委託費（内部）","業務委託費（外部）",
    "法定福利費","福利厚生費","通信費","減価償却費","地代家賃","租税公課","諸会費","新聞図書費","リース料","保険料"]);
  const PL_COST_GROUPS={fixed:"固定費",variable:"変動費"};
  const PL_COST_KEY="bt_pl_cost_groups";
  const plCostOverrides=new Map();
  try{
    const stored=JSON.parse(localStorage.getItem(PL_COST_KEY)||"{}");
    for(const [account,group] of Object.entries(stored||{})){
      if(group==="fixed"||group==="variable")plCostOverrides.set(account,group);
    }
  }catch(error){}
  function plCostGroup(account,kind){
    if(kind==="calc"||account==="売上高")return "";
    return plCostOverrides.get(account)||(PL_FIXED.has(account)?"fixed":"variable");
  }
  function plCostSelect(account,group){
    const options=Object.entries(PL_COST_GROUPS).map(([key,label])=>
      '<option value="'+key+'"'+(key===group?' selected':'')+'>'+label+'</option>').join('');
    return '<select class="fn-cost-badge fn-cost-select '+group+'" data-cost-account="'+esc(account)
      +'" aria-label="'+esc(account)+'の費用区分">'+options+'</select>';
  }
  const plCostBadge=group=>'<span class="fn-cost-badge '+group+'">'+PL_COST_GROUPS[group]+'</span>';
  // 会計・カードは全科目を PL に入れる（オーナー指示 2026-11-20「カードコストがPL内に全て格納するのが前提。科目で例外があれば別枠で表示し解消確認できるように」）
  //   科目→PL行の割当は下の PL 定義から作る。割当のない科目は雑費に入れ、PL の下の「会計・カードの照合」に例外として出す
  const CAT2PL={}; PL.forEach(([a,k,x,y])=>{if(k==="mix"||(k==="auto"&&a==="支払手数料"))(x||[]).forEach(c=>CAT2PL[c]=a);if(k==="veh")(y||[]).forEach(c=>CAT2PL[c]=a);});
  const unmapped=D=>Object.keys(D.A).filter(c=>!CAT2PL[c]);
  const OVERLAP={"車検費":"車検","点検費":"点検","保険料":"保険料"};   // 車両リストの金額と同じ行に入る科目＝二重になっていないか確認する
  // 起算＝2026年10月（オーナー指示 2026-11-20「起算開始を 2026 10月から」）：PL は10月〜翌9月を1期として表示
  const PL_START=2026;
  const pfOf=ym=>Math.max(PL_START,+ym.slice(5)>=10?+ym.slice(0,4):+ym.slice(0,4)-1);
  const pfMonths=y=>{const a=[];for(let i=0;i<12;i++)a.push(addYm(y+'-10',i));return a;};
  function pfSel(id,y){const now=pfOf(ymNow());let o='';for(let k=PL_START;k<=now+1;k++)o+='<option value="'+k+'"'+(k===y?' selected':'')+'>'+k+'年10月〜'+(k+1)+'年9月</option>';return '<select class="fn-fy" id="'+id+'">'+o+'</select>';}
  // 給与枠（オーナー指示 2026-11-20「給与枠を追加できるように アルバイト 社員 本部 など」）：給与手当＝会計の給与手当＋各枠の合計。枠は bt_pl_manual の account「給与手当/<枠名>」
  const SAL="給与手当", SAL_DEF=["アルバイト","社員","本部"];
  function salNames(D){const n=SAL_DEF.slice();(D.manRows||[]).forEach(r=>{const a=String(r.account||"");if(a.indexOf(SAL+"/")===0){const x=a.slice(SAL.length+1);if(x&&n.indexOf(x)<0)n.push(x);}});return n;}
  const FEE_H=0.18, FEE_B=0.16;   // OTA手数料：HANDYMAN 18%／BUDDICA 16%（cost-cpa.html と同じ・2026-10-26 オーナー指示）
  let PLD=null, PL_FY=null;
  async function loadPL(){
    const [mtg,split,cpa,d]=await Promise.all([rpc("bt_mtg_h2"),rpc("bt_ota_brand_split"),rpc("bt_cost_cpa"),view()]);
    const acct=d.acct||[], V=vehOf(d), man=d.manual||[];
    const SP={};(Array.isArray(split)?split:[]).forEach(r=>{const m=String(r.ym||"");if(/^\d{4}-\d{2}$/.test(m))SP[m]=(+r.hdm_rev||0)*FEE_H+(+r.bud_rev||0)*FEE_B;});
    (Array.isArray(cpa)?cpa:[]).forEach(r=>{const m=String(r.ym||"");if(/^\d{4}-\d{2}$/.test(m)&&SP[m]==null)SP[m]=(+r.ota_rev||0)*FEE_H;});
    const MAN={}; man.forEach(r=>{if(r.amount!=null)MAN[r.id]=+r.amount;});
    return {sales:(mtg&&mtg.data)||{},gen:mtg&&mtg.generated,fee:SP,A:acctAgg(acct),V,MAN,manRows:man};
  }
  // 稼働フラグの記録が始まる前の月（開店前）は車両費を出さない。記録が終わった先の月は今の車で見込む
  function vehCost(V,ym){const s={lease:0,ins:0,shaken:0,tenken:0};const k0=Object.keys(V.K).sort()[0];if(!k0||ym<k0)return s;fleetOf(V,ym).forEach(v=>{if(!isAct(V,ym,v.code))return;const p=costParts(v);s.lease+=p.lease;s.ins+=p.ins;s.shaken+=p.shaken;s.tenken+=p.tenken;});return s;}
  // 1か月分の PL（行ごとの値）。サマリの「支出合計・損益」もここから出す（数字を別々に計算しない）
  function plMonth(D,ym){
    const o={}, auto={}, vc=vehCost(D.V,ym), mn=a=>D.MAN[ym+':'+a]; let used=0;
    const ac=cs=>{const v=(cs||[]).reduce((s,c)=>s+((D.A[c]&&D.A[c][ym]&&D.A[c][ym].all)||0),0);used+=v;return v;};
    PL.forEach(([a,k,x,y])=>{
      if(k==="auto"){o[a]=a==="売上高"?((D.sales[ym]&&D.sales[ym].tot_r)||0):Math.round(D.fee[ym]||0)+ac(x);auto[a]=o[a];}
      else if(k==="veh"){o[a]=Math.round(vc[x])+ac(y);auto[a]=o[a];}
      else if(k==="mix"){auto[a]=ac(x)+(a==="雑費"?ac(unmapped(D)):0);o[a]=auto[a]+(mn(a)||0);
        if(a===SAL)salNames(D).forEach(n=>{const v=mn(SAL+"/"+n)||0;o[SAL+"/"+n]=v;o[a]+=v;});}
      else if(k==="man"){o[a]=mn(a)||0;}
    });
    o["粗利"]=o["売上高"]-o["売上原価"];
    o["販管費合計"]=PL.filter(([a,k])=>k!=="calc"&&a!=="売上高"&&a!=="売上原価").reduce((s,[a])=>s+(o[a]||0),0);
    o["営業利益"]=o["粗利"]-o["販管費合計"];
    o._cost=o["売上原価"]+o["販管費合計"];   // 支出合計＝売上原価＋販管費合計
    o._acctIn=used; o._acctAll=Object.keys(D.A).reduce((s,c)=>s+((D.A[c][ym]&&D.A[c][ym].all)||0),0);   // 照合：PL に入った会計額／会計・カードの合計（店舗支出と同じ）
    return {o,auto};
  }
  // 会計・カードの照合（PL の下）：月ごとに 会計・カード合計＝PL に入った額 か、例外の科目は何か
  function reconHtml(M,R){
    const sumM=f=>M.map((m,i)=>f(m,i)), tot=a=>a.reduce((s,v)=>s+v,0), cell=v=>'<td'+(v?'':' class="z"')+'>'+num(v)+'</td>';
    const all=sumM((m,i)=>R[i].o._acctAll), inn=sumM((m,i)=>R[i].o._acctIn), dif=all.map((v,i)=>v-inn[i]), bad=dif.some(v=>v!==0);
    const amt=(c,m)=>(PLD.A[c]&&PLD.A[c][m]&&PLD.A[c][m].all)||0;
    let h='<h4 class="fn-h">🔎 会計・カードの照合 '+(bad?'<span class="fn-st ng">⚠️ 差があります</span>':'<span class="fn-st ok">✅ 全額 PL に入っています</span>')+'</h4>'
      +'<div class="fn-tw"><table class="fn-t fn-m"><thead><tr><th></th>'+M.map(m=>'<th>'+(+m.slice(5))+'月</th>').join('')+'<th>合計</th></tr></thead><tbody>'
      +'<tr><th>会計・カード合計（店舗支出と同じ）</th>'+all.map(cell).join('')+'<td class="b">'+num(tot(all))+'</td></tr>'
      +'<tr><th>PL に入った額</th>'+inn.map(cell).join('')+'<td class="b">'+num(tot(inn))+'</td></tr>'
      +'<tr class="tot"><th>差</th>'+dif.map(cell).join('')+'<td class="b">'+num(tot(dif))+'</td></tr>';
    // 例外①：科目の割当がない（雑費に入れた）／例外②：車両リストの金額と同じ行に入る（二重になっていないか確認）
    const ex=[];
    unmapped(PLD).forEach(c=>{const v=sumM(m=>amt(c,m));if(tot(v))ex.push(['「'+c+'」→ 雑費に入れました（科目の割当なし）',v]);});
    Object.keys(OVERLAP).forEach(c=>{const v=sumM(m=>amt(c,m));if(tot(v))ex.push(['「'+c+'」→ '+OVERLAP[c]+'（車両リストの'+OVERLAP[c]+'と二重になっていないか確認）',v]);});
    ex.forEach(([t,v])=>{h+='<tr class="ex"><th>⚠️ '+esc(t)+'</th>'+v.map(cell).join('')+'<td class="b">'+num(tot(v))+'</td></tr>';});
    h+='</tbody></table></div>';
    // 期の外（起算前）の会計・カード
    let before=0; Object.keys(PLD.A).forEach(c=>Object.keys(PLD.A[c]).forEach(m=>{if(m<PL_START+'-10')before+=PLD.A[c][m].all||0;}));
    h+='<div class="fn-note">'+(ex.length?'例外の科目は上の ⚠️ の行です。会計の科目を直すか、PL の割当を決めると消えます。':'例外の科目はありません。')
      +(before&&PL_FY===PL_START?'　起算（2026年10月）より前の会計・カード '+yen(before)+' は PL の期の外です（店舗支出の前の期にも出ません）。':'')+'</div>';
    return h;
  }
  async function showPL(){
    const body=$("finPL"); if(!body)return;
    body.innerHTML='<div class="fn-empty">読み込み中…</div>';
    try{PLD=await loadPL();renderPL();}catch(e){body.innerHTML='<div class="fn-empty">読み込めませんでした：'+esc(e.message||e)+'</div>';}
  }
  function renderPL(){
    const body=$("finPL"); if(PL_FY==null)PL_FY=pfOf(ymNow()); const M=pfMonths(PL_FY), cur=ymNow(), R=M.map(m=>plMonth(PLD,m));
    const groupRows=Object.keys(PL_COST_GROUPS).map(group=>{
      const accounts=PL.filter(([a,k])=>plCostGroup(a,k)===group);
      const monthly=R.map(r=>accounts.reduce((sum,[a])=>sum+(r.o[a]||0),0));
      return {group,monthly,total:monthly.reduce((sum,n)=>sum+n,0)};
    });
    let h='<div class="fn-bar">'+pfSel("plFy",PL_FY)+'<button class="btn" id="plReload">🔄 最新に更新</button></div>'
      +'<div class="fn-note"><b class="lg a">自動</b> 売上高＝サマリと同じ（返却月・予約＋予約外）／支払手数料＝OTA手数料（HANDYMAN 18%・BUDDICA 16%）＋会計の支払手数料／リース料・保険料・車検・点検＝車両リストの金額×その月の稼働車　'
      +'<b class="lg m">会計</b> 業務APPの会計（出納帳の出金・カード）を科目ごとに反映。手入力欄に入れた分は上乗せ　<b class="lg w">空欄</b> 手入力（自動にする定義が決まったら順次自動に）</div>';
    h+='<div class="fn-cost-totals" aria-label="期の費用区分別合計">'+groupRows.map(({group,total})=>
      '<div>'+plCostBadge(group)+' <strong>'+yen(total)+'</strong></div>').join('')+'</div>';
    h+='<div class="fn-tw"><table class="fn-t fn-m fn-pl"><thead><tr><th>勘定科目</th>'+M.map(m=>'<th class="'+(m===cur?'now':'')+'">'+m.slice(0,4)+'年'+(+m.slice(5))+'月<br><button class="fn-cp" data-cp="'+m+'" title="この月の手入力を、翌月の空欄にコピーします（翌月に入っている金額はそのまま）">翌月へ→</button></th>').join('')+'<th>合計</th></tr></thead><tbody>';
    PL.forEach(([a,k])=>{
      const group=plCostGroup(a,k);
      const tot=R.reduce((s,r)=>s+(r.o[a]||0),0), cls=k==="calc"?(a==="営業利益"?"tot pf":"tot"):(k==="auto"||k==="veh")?"a":k==="mix"?"m":"w";
      h+='<tr class="'+cls+'"><th>'+esc(a)+(group?' '+plCostSelect(a,group):'')+(k==="auto"||k==="veh"?' <small>自動</small>':'')+((k==="man"||k==="mix")&&a!==SAL?' '+'<button class="fn-cp fn-rcp" data-rcp="'+esc(a)+'" title="この科目の手入力を、右の空いている月にコピーします（入っている月はそのまま）">→</button>':'')+'</th>';
      R.forEach((r,i)=>{const m=M[i],v=r.o[a]||0;
        if((k==="man"||k==="mix")&&a!==SAL){const mv=PLD.MAN[m+':'+a], au=r.auto[a]||0;
          h+='<td>'+(k==="mix"&&au?'<div class="au" title="会計・カードの合計">'+num(au)+'</div>':'')+(CAN_EDIT?'<input class="fn-in pl" inputmode="numeric" data-ym="'+m+'" data-ac="'+esc(a)+'" value="'+(mv!=null?num(mv):'')+'">':(mv!=null?num(mv):''))+'</td>';}
        else h+='<td class="'+(v<0?'neg':'')+'">'+(k==="calc"&&v<0?'('+num(-v)+')':num(v))+'</td>';});
      h+='<td class="b'+(tot<0?' neg':'')+'">'+(tot<0?'('+num(-tot)+')':num(tot))+'</td></tr>';
      if(a===SAL){
        salNames(PLD).forEach(n=>{const ac=SAL+"/"+n, st=R.reduce((s,r)=>s+(r.o[ac]||0),0);
          h+='<tr class="w sub"><th>└ '+esc(n)+' '+'<button class="fn-cp fn-rcp" data-rcp="'+esc(ac)+'" title="この科目の手入力を、右の空いている月にコピーします（入っている月はそのまま）">→</button>'+'</th>'+M.map(m=>{const mv=PLD.MAN[m+':'+ac];return '<td><input class="fn-in pl" inputmode="numeric" data-ym="'+m+'" data-ac="'+esc(ac)+'" value="'+(mv!=null?num(mv):'')+'"></td>';}).join('')+'<td class="b">'+num(st)+'</td></tr>';});
        h+='<tr class="w sub"><th colspan="14"><input id="salNew" class="fn-sal" maxlength="20" placeholder="枠の名前（例：パート）"> <button class="btn" id="salAdd">＋給与枠</button></th></tr>';
      }});
    for(const {group,monthly,total} of groupRows){
      h+='<tr class="tot fn-cost-group"><th>'+plCostBadge(group)+' 合計</th>'
        +monthly.map(n=>'<td>'+num(n)+'</td>').join('')+'<td class="b">'+num(total)+'</td></tr>';
    }
    h+='</tbody></table></div><div class="fn-note">出所：売上＝bt_mtg_h2（'+esc(PLD.gen||'')+'）・OTA手数料＝bt_ota_brand_split・会計＝bt_accounting・車両＝bt_vehicles×bt_vehicle_monthly_kpi・手入力＝bt_pl_manual。車両の金額は今の登録値で各月を計算します。'
      +'</div>'+reconHtml(M,R);
    body.innerHTML=h;
    $("plFy").onchange=e=>{PL_FY=+e.target.value;renderPL();};
    $("salAdd").onclick=addSal;
    $("plReload").onclick=showPL;
  }
  document.addEventListener("change",ev=>{
    const select=ev.target;
    if(!select.matches?.("#finPL .fn-cost-select")||!PLD)return;
    const account=select.dataset.costAccount, group=select.value;
    if(group!=="fixed"&&group!=="variable")return;
    plCostOverrides.set(account,group);
    try{localStorage.setItem(PL_COST_KEY,JSON.stringify(Object.fromEntries(plCostOverrides)));}catch(error){}
    const table=document.querySelector("#finPL .fn-tw");
    const {scrollLeft,scrollTop}=table;
    const {scrollX,scrollY}=window;
    renderPL();
    const updatedTable=document.querySelector("#finPL .fn-tw");
    updatedTable.scrollLeft=scrollLeft;
    updatedTable.scrollTop=scrollTop;
    const updatedSelect=Array.from(updatedTable.querySelectorAll(".fn-cost-select"))
      .find(el=>el.dataset.costAccount===account);
    updatedSelect?.focus({preventScroll:true});
    window.scrollTo(scrollX,scrollY);
  });
  // 翌月コピー（オーナー指示 2026-11-20「支出を翌月コピ機能追加」）：その月の手入力（bt_pl_manual）を翌月の空欄にだけ写す。翌月に入っている金額は上書きしない
  document.addEventListener("click",async ev=>{
    const b=ev.target&&ev.target.closest&&ev.target.closest("#finPL .fn-cp"); if(!b||!PLD)return;
    const m=b.dataset.cp, nx=addYm(m,1), pre=m+':', todo=[]; let kept=0;
    Object.keys(PLD.MAN).forEach(id=>{if(id.indexOf(pre)!==0)return;const ac=id.slice(pre.length);if(PLD.MAN[nx+':'+ac]!=null){kept++;return;}todo.push([ac,PLD.MAN[id]]);});
    const ml=x=>(+x.slice(5))+'月';
    if(!todo.length){setStatus(ml(m)+"の手入力で、"+ml(nx)+"にコピーするものはありません"+(kept?"（"+kept+"件は"+ml(nx)+"に入力済み）":""));return;}
    document.querySelectorAll("#finPL .fn-cp").forEach(x=>x.disabled=true);
    let ok=0, ng=0;
    for(const [ac,v] of todo){
      const {data,error}=await sb.rpc("bt_fin_set_manual",{p_key:VIEW_KEY,p_ym:nx,p_account:ac,p_amount:v});
      if(error||!data||data.id!==nx+':'+ac){ng++;continue;}
      ok++; PLD.MAN[data.id]=+data.amount; if(!PLD.manRows.some(r=>r.id===data.id))PLD.manRows.push({id:data.id,ym:nx,account:ac,amount:data.amount});
    }
    const sx=window.scrollX,sy=window.scrollY,sl=(document.querySelector("#finPL .fn-tw")||{}).scrollLeft||0;
    if(nx>pfMonths(PL_FY)[11])PL_FY=pfOf(nx);
    renderPL(); const tw=document.querySelector("#finPL .fn-tw"); if(tw)tw.scrollLeft=sl; window.scrollTo(sx,sy);
    setStatus(ml(m)+"→"+ml(nx)+"："+ok+"件コピーしました"+(kept?"（"+kept+"件は入力済みのためそのまま）":"")+(ng?"・"+ng+"件は保存できませんでした":""));
  });
  // 科目ごとのコピー（オーナー指示 2026-11-20「各勘定科目にコピ機能」）：表示中の期の中で、入力のある月の金額を右の空いている月に入れる。入っている月は上書きしない
  document.addEventListener("click",async ev=>{
    const b=ev.target&&ev.target.closest&&ev.target.closest("#finPL .fn-rcp"); if(!b||!PLD)return;
    const ac=b.dataset.rcp, M=pfMonths(PL_FY), todo=[]; let last=null;
    M.forEach(m=>{const v=PLD.MAN[m+':'+ac]; if(v!=null)last=v; else if(last!=null)todo.push([m,last]);});
    const nm=ac.replace(SAL+"/","給与 ");
    if(!todo.length){setStatus(nm+"："+(last==null?"まだ金額が入っていません":"右の月はすべて入力済みです"));return;}
    document.querySelectorAll("#finPL .fn-cp").forEach(x=>x.disabled=true);
    let ok=0, ng=0;
    for(const [m,v] of todo){
      const {data,error}=await sb.rpc("bt_fin_set_manual",{p_key:VIEW_KEY,p_ym:m,p_account:ac,p_amount:v});
      if(error||!data||data.id!==m+':'+ac){ng++;continue;}
      ok++; PLD.MAN[data.id]=+data.amount; if(!PLD.manRows.some(r=>r.id===data.id))PLD.manRows.push({id:data.id,ym:m,account:ac,amount:data.amount});
    }
    const sx=window.scrollX,sy=window.scrollY,sl=(document.querySelector("#finPL .fn-tw")||{}).scrollLeft||0;
    renderPL(); const tw=document.querySelector("#finPL .fn-tw"); if(tw)tw.scrollLeft=sl; window.scrollTo(sx,sy);
    setStatus(nm+"："+ok+"か月にコピーしました"+(ng?"・"+ng+"件は保存できませんでした":""));
  });
  async function addSal(){
    const el=$("salNew"), n=(el&&el.value||"").trim();
    if(!n)return;
    if(!/^[0-9A-Za-zぁ-んァ-ヶー一-鿿々〆・（）()＿_０-９Ａ-Ｚａ-ｚ-]{1,20}$/.test(n)){setStatus("枠の名前は、かな・カナ・漢字・英数字で20文字まで（空白・記号は使えません）");return;}   // DB の bt_fin_set_manual と同じ文字
    if(salNames(PLD).indexOf(n)>=0){setStatus("「"+n+"」はもうあります");return;}
    const b=$("salAdd"); if(b)b.disabled=true;
    const {data,error}=await sb.rpc("bt_fin_set_manual",{p_key:VIEW_KEY,p_ym:PL_FY+"-10",p_account:SAL+"/"+n,p_amount:null});
    if(b)b.disabled=false;
    if(error||!data){setStatus("追加できませんでした："+((error&&error.message)||""));return;}
    PLD.manRows.push({id:data.id,ym:PL_FY+"-10",account:SAL+"/"+n,amount:null});
    renderPL(); setStatus("給与枠「"+n+"」を追加しました");
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
    if(!PLD.manRows.some(r=>r.id===id))PLD.manRows.push({id,ym,account:ac,amount:data.amount});
    const sx=window.scrollX,sy=window.scrollY,sl=(document.querySelector("#finPL .fn-tw")||{}).scrollLeft||0;
    renderPL(); const tw=document.querySelector("#finPL .fn-tw"); if(tw)tw.scrollLeft=sl; window.scrollTo(sx,sy);
    setStatus("保存しました："+(+ym.slice(5))+"月 "+ac);
  });

  // サマリ用：指定した月の 売上・支出合計・損益（PL と同じ計算）。読めなければ null
  async function summary(yms){
    try{const D=await loadPL();const out={};yms.forEach(m=>{const {o}=plMonth(D,m);out[m]={sales:o["売上高"],cost:o._cost,profit:o["売上高"]-o._cost};});return out;}catch(e){return null;}
  }
  document.addEventListener("click",ev=>{if(ev.target&&ev.target.id==="fleetReload")showFleet();});
  async function planDailyRates(V,fleet,ym){
    const day=86400000;
    const date=value=>Date.parse(String(value||"").slice(0,10));
    const key=v=>JSON.stringify([normBrand(v.brand),v.type]);
    const startMonth=addYm(ym,-3);
    const {data,error}=await sb.rpc("bt_vehicle_dashboard_view",{
      p_key:VIEW_KEY,p_from:addYm(ym,-4)+'-01',p_ym:ym
    });
    if(error)throw error;
    const classes=new Set(V.classes.map(c=>c.id));
    const vehicles=V.vs.filter(v=>classes.has(v.type));
    const history=new Map((data.vehicles||[]).map(v=>[v.code,v]));
    const assignments=new Map((data.fleet||[]).map(f=>[f.reservation_id,f.vehicle_code]));
    const bookings=new Map();
    for(const r of data.res||[]){
      const code=assignments.get(r.id);
      const start=date(r.start_date), end=date(r.end_date);
      if(!code||!(end>=start)||/cancel|キャンセル/i.test(r.status||""))continue;
      const sales=Number(r.final_price)||Number(r.price)||Number(r.amount)||0;
      if(!bookings.has(code))bookings.set(code,[]);
      bookings.get(code).push({start,end,sales});
    }
    const totals=new Map();
    const current=new Set(fleet.map(v=>v.code));
    const periodStart=date(startMonth+'-01'), periodEnd=date(ym+'-01');
    for(const v of vehicles){
      const meta=history.get(v.code)||{};
      const reservations=bookings.get(v.code)||[];
      const firstBooking=reservations.reduce((first,r)=>Math.min(first,r.start),Infinity);
      const purchase=date(meta.purchase_date);
      const registered=date(meta.created_at);
      const knownStart=Number.isFinite(purchase)?purchase:registered;
      const inferredStart=Math.min(Number.isFinite(knownStart)?knownStart:Infinity,firstBooking);
      const serviceStart=date(v.service_from), serviceEnd=date(v.service_to);
      const swapped=date(meta.swapped_at);
      const group=key(v);
      const sums=totals.get(group)||{sales:0,days:0,available:0,baseline:0};
      totals.set(group,sums);
      for(const r of reservations){
        if(current.has(v.code)&&r.end>=periodStart&&r.end<periodEnd&&
          !(r.start<swapped)&&r.sales>0)sums.baseline+=r.sales;
      }
      for(let month=startMonth;month<ym;month=addYm(month,1)){
        if(!isAct(V,month,v.code))continue;
        const monthStart=Math.max(date(month+'-01'),date("2026-08-03"));
        const monthEnd=date(addYm(month,1)+'-01')-day;
        const from=Math.max(monthStart,Number.isFinite(serviceStart)?serviceStart:inferredStart);
        const until=Math.min(monthEnd,Number.isFinite(serviceEnd)?serviceEnd:Infinity);
        if(!(until>=from))continue;
        sums.available+=(until-from)/day+1;
        const used=new Set();
        for(const r of reservations){
          if(r.start<swapped)continue;
          const begin=Math.max(r.start,from), end=Math.min(r.end,until);
          if(end<begin)continue;
          const perDay=Math.max(0,r.sales)/((r.end-r.start)/day+1);
          for(let t=begin;t<=end;t+=day)used.add(t);
          sums.sales+=perDay*((end-begin)/day+1);
        }
        sums.days+=used.size;
      }
    }
    return totals;
  }
  async function planFleetCosts(){
    const ym=ymNow(), V=await loadVehicles(), fleet=fleetOf(V,ym);
    const rates=await planDailyRates(V,fleet,ym).catch(()=>null);
    return Object.keys(BRL).map(brand=>{
      const vehicles=fleet.filter(v=>normBrand(v.brand)===brand);
      const classes=V.classes.flatMap(c=>{
        const members=vehicles.filter(v=>v.type===c.id);
        if(!members.length)return [];
        const totals={id:c.id,name:c.name,count:members.length,active:0,lease:0,ins:0};
        for(const v of members){
          if(isAct(V,ym,v.code))totals.active++;
          const {lease,ins}=costParts(v);
          totals.lease+=lease;
          totals.ins+=ins;
        }
        const rate=rates?.get(JSON.stringify([brand,c.id]));
        totals.dailyRate=rate?.days?Math.round(rate.sales/rate.days):null;
        totals.monthlySales=rates?Math.round((rate?.baseline||0)/3):null;
        totals.utilization=rate?.available?Math.round(rate.days/rate.available*1000)/10:0;
        return [totals];
      });
      return {brand,label:BRL[brand],classes};
    });
  }
  async function planPLExpenses(){
    const month=ymNow();
    const {o}=plMonth(await loadPL(),month);
    // The simulator already calculates these costs separately.
    const excluded=new Set(["リース料","保険料","支払手数料"]);
    const fixed=[],variable=[];
    for(const [account,kind] of PL){
      const group=plCostGroup(account,kind);
      if(excluded.has(account))continue;
      if(group==="fixed")fixed.push({account,amount:o[account]||0});
      if(group==="variable")variable.push(account);
    }
    return {month,fixed,variable};
  }
  return {showFleet,showSpend,showPL,summary,planFleetCosts,planPLExpenses};
})();
