// ===== 🚗 車両カルテ／🔄 入替（procurement.html ?tab=karte / ?tab=swap）=====
// 1台1カード：クラス・装備・走行・傷（写真）・車検・生涯収支。走行リミットと次回車検から売却予定日を出し、その N ヶ月前を仕入れ開始にする。
// 読む：bt_vehicles / bt_fleet×bt_reservations（売上・メーター実測）/ bt_vehicle_maintenance / bt_vehicle_monthly_kpi
//       vehicle_twins（傷・写真＝開いた時だけ1台分）/ bt_inspection_photos・bt_tire_photos（写真）/ bt_vehicle_life_settings
// 書く：bt_vehicles のライフサイクル列・bt_vehicle_life_settings（sql/bt_vehicle_lifecycle.sql 適用後）
// 予測：全車共通の1本＝1予約あたり平均km × 1台あたり月の予約件数（どちらも全車・全期間の実績）。
//       クラスや車種で分けない。開くたびに最新の実績で計算し直すので、営業日数が増えるほど精度が上がる。メーター実測は 2026-09-05〜。
const VL=(()=>{
  const DAY=864e5, MON=30.44*DAY;
  const DATA_FROM="2026-08-03";          // 予約・売上データの開始日
  const KM_MAX=3000, KM_PER_DAY_MAX=1000; // これを超える1予約の走行は入力ミス扱い（予測から外す）
  const DEF={default_limit_km:100000,over_limit_km:150000,class_limits:{},lead_months:3,shaken_rule:"next"};   // オーナー指示 2026-10-30：全車10万km。その時点で超えていた車は15万km＋フラグ
  const S={loaded:false,loading:null,cfg:Object.assign({},DEF),cfgSaved:false,lifeCols:false,
    v:[],res:{},maint:{},dmg:{},kpi:{},calc:{},open:new Set(),detail:{},
    brand:"all",stf:"all",sort:"sale",view:"karte",showCfg:false};
  try{const o=JSON.parse(localStorage.getItem("vl_ui")||"{}");["brand","stf","sort"].forEach(k=>{if(o[k])S[k]=o[k];});}catch(e){}
  const saveUi=()=>{try{localStorage.setItem("vl_ui",JSON.stringify({brand:S.brand,stf:S.stf,sort:S.sort}));}catch(e){}};
  const e=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const n=x=>{if(x==null||x==="")return null;const v=Number(x);return isFinite(v)?v:null;};
  const yen=x=>x==null?"—":(x<0?"−":"")+"¥"+Math.abs(Math.round(x)).toLocaleString();
  const km=x=>x==null?"—":Math.round(x).toLocaleString();
  const todayStr=()=>new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
  const T0=()=>Date.parse(todayStr()+"T00:00:00Z");
  const ts=d=>{if(!d)return null;const m=String(d).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);return m?Date.UTC(+m[1],+m[2]-1,+m[3]):null;};
  const ymFar=t=>t>addMon(T0(),60)?'5年以上先':ym(t);
  const ym=t=>{const d=new Date(t);return d.getUTCFullYear()+"年"+(d.getUTCMonth()+1)+"月";};
  const ymd=t=>{const d=new Date(t);return d.getUTCFullYear()+"/"+String(d.getUTCMonth()+1).padStart(2,"0")+"/"+String(d.getUTCDate()).padStart(2,"0");};
  const addMon=(t,m)=>{const d=new Date(t);d.setUTCMonth(d.getUTCMonth()+m);return d.getTime();};
  const monthsTo=t=>(t-T0())/MON;
  const plate4=v=>{const m=String(v.plate_no||"").match(/(\d{1,4})\s*$/);return m?m[1]:"";};
  const clsCol=c=>(typeof M_CLSCOLOR!=="undefined"&&M_CLSCOLOR[c])||"#94a3b8";
  const isCancel=r=>/cancel|キャンセル/i.test(r.status||"");
  const STATUS={
    sold:{lb:"終了済",ic:"⚫",cls:"sold",rank:5},
    sell:{lb:"売り止め",ic:"⛔",cls:"sell",rank:0},
    prep:{lb:"入替準備",ic:"🟠",cls:"prep",rank:1},
    soon:{lb:"半年以内",ic:"🟡",cls:"soon",rank:2},
    run:{lb:"稼働中",ic:"🟢",cls:"run",rank:3},
    nodata:{lb:"予測待ち",ic:"⚪",cls:"nodata",rank:4}};
  const DMG_T={scratch:"擦り傷",dent:"へこみ",chip:"欠け",stone_chip:"飛び石",break:"破損"};
  const DMG_S={minor:"軽",moderate:"中",severe:"重"};

  async function all(make){let out=[],from=0;for(;;){const {data,error}=await make().range(from,from+999);if(error)throw error;out=out.concat(data||[]);if(!data||data.length<1000)break;from+=1000;}return out;}

  async function load(force){
    if(S.loading&&!force)return S.loading;
    S.loading=(async()=>{
      const ymNow=todayStr().slice(0,7);
      const [veh,fleet,res,mt,kpi,cfg,dmg]=await Promise.all([
        all(()=>sb.from("bt_vehicles").select("*").order("code")),
        all(()=>sb.from("bt_fleet").select("reservation_id,vehicle_code")),
        all(()=>sb.from("bt_reservations").select("id,start_date,end_date,status,final_price,price,amount,driven_km,start_odo,end_odo,end_odo_at").gte("start_date",DATA_FROM).order("id")),
        all(()=>sb.from("bt_vehicle_maintenance").select("vehicle_code,type,date,completed_date,cost,actual_cost,workshop,odometer_km,km_at").order("id")),
        sb.from("bt_vehicle_monthly_kpi").select("vehicle_code,active").eq("year_month",ymNow),
        sb.from("bt_vehicle_life_settings").select("*").eq("id",1).maybeSingle(),
        sb.rpc("bt_vehicle_damage_summary")]);
      S.v=veh.filter(v=>v.type!=="送迎");
      S.lifeCols=S.v.length>0&&("life_limit_km" in S.v[0]);
      const r2v={}; fleet.forEach(f=>{r2v[f.reservation_id]=f.vehicle_code;});
      S.res={}; res.forEach(r=>{const c=r2v[r.id]; if(!c||isCancel(r))return; (S.res[c]=S.res[c]||[]).push(r);});
      S.maint={}; mt.forEach(m=>{(S.maint[m.vehicle_code]=S.maint[m.vehicle_code]||[]).push(m);});
      S.kpi={}; ((kpi&&kpi.data)||[]).forEach(k=>{S.kpi[k.vehicle_code]=k.active;});
      S.cfgSaved=!!(cfg&&cfg.data); if(cfg&&cfg.data)S.cfg=Object.assign({},DEF,cfg.data,{class_limits:cfg.data.class_limits||{}});
      S.dmg={}; if(dmg&&!dmg.error)(dmg.data||[]).forEach(d=>{S.dmg[d.code]=d;});
      compute(); S.loaded=true; S.updated=new Date();
    })().catch(err=>{S.err=err;throw err;}).finally(()=>{S.loading=null;});
    return S.loading;
  }

  // 1予約の走行km（入力ミスらしい値は null）
  function tripKm(r){
    let k=n(r.driven_km); if(k==null&&n(r.end_odo)!=null&&n(r.start_odo)!=null)k=n(r.end_odo)-n(r.start_odo);
    if(k==null||k<=0||k>KM_MAX)return null;
    const d=Math.max(1,Math.round((ts(r.end_date)-ts(r.start_date))/DAY)+1);
    return k/d>KM_PER_DAY_MAX?null:k;
  }
  function suspect(r){const k=n(r.driven_km)!=null?n(r.driven_km):(n(r.end_odo)!=null&&n(r.start_odo)!=null?n(r.end_odo)-n(r.start_odo):null);return k!=null&&tripKm(r)==null;}
  // 既定リミットを既に超えていた車＝延長リミット＋フラグ。DB追加後は SQL で 2026-10-30 時点の該当車に life_limit_km と life_flag を固定する
  //（ここで毎回判定すると、あとから10万kmを超えた車まで延長されてしまうため、DB未適用の間だけの仮判定）
  function baseLimit(v){return n(S.cfg.class_limits&&S.cfg.class_limits[v.type])||n(S.cfg.default_limit_km)||DEF.default_limit_km;}
  function limitOf(v,odo){
    if(n(v.life_limit_km))return n(v.life_limit_km);
    const b=baseLimit(v);
    if(!S.lifeCols&&odo!=null&&odo>=b)return n(S.cfg.over_limit_km)||DEF.over_limit_km;
    return b;
  }
  function overFlag(v,odo){return v.life_flag||(!S.lifeCols&&!n(v.life_limit_km)&&odo!=null&&odo>=baseLimit(v)?(km(baseLimit(v)/10000)+"万km超"):"");}

  function compute(){
    const t0=T0(), allKm=[];
    let nRes=0, vDays=0;
    S.v.forEach(v=>{
      const rs=(S.res[v.code]||[]).filter(r=>ts(r.start_date)<=t0);
      rs.forEach(r=>{const k=tripKm(r);if(k!=null)allKm.push(k);});
      if(!rs.length)return;
      const first=Math.min(...rs.map(r=>ts(r.start_date)));
      nRes+=rs.length; vDays+=Math.max(1,(t0-Math.max(first,ts(DATA_FROM)))/DAY);
    });
    const avgKm=allKm.length?allKm.reduce((s,x)=>s+x,0)/allKm.length:null;
    const perMon=vDays?nRes/vDays*30.44:0;
    const monKm=avgKm!=null&&perMon>0?avgKm*perMon:null;
    S.global={avgKm,n:allKm.length,perMon,monKm,nRes,days:Math.round((t0-ts(DATA_FROM))/DAY)};
    S.calc={};
    S.v.forEach(v=>{
      const rs=(S.res[v.code]||[]).slice().sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date)));
      const done=rs.filter(r=>ts(r.end_date)<t0);
      const future=rs.filter(r=>ts(r.start_date)>t0&&ts(r.start_date)<=t0+60*DAY).length;
      // 現在の走行距離＝マスターと返却メーターの大きい方（桁違いは除く）
      const base=n(v.current_mileage)||0;
      const odoMax=done.reduce((m,r)=>{const o=n(r.end_odo);return o&&o>m&&o-base<=20000?o:m;},0);
      const odo=Math.max(base,odoMax)||null;
      const limit=limitOf(v,odo), flag=overFlag(v,odo);
      let limitT=null; if(odo!=null&&odo>=limit)limitT=t0; else if(odo!=null&&monKm>0)limitT=t0+(limit-odo)/monKm*MON;
      const shaken=ts(v.inspection_due_date||v.inspection_next_date);
      // 車検ルール：next＝次の車検期間（2年）中にリミット到達なら、車検で終わらせる（車検を通さない）
      let byShaken=null;
      if(shaken&&S.cfg.shaken_rule!=="ignore"&&v.exit_type!=="ride"){   // 乗り潰しは車検を通して走行リミットまで使う
        const kmAtNext=odo!=null&&monKm!=null?odo+monKm*((addMon(shaken,24)-t0)/MON):null;
        if(S.cfg.shaken_rule==="always"||(kmAtNext!=null&&kmAtNext>=limit))byShaken=shaken;
      }
      let saleT=null, why="";
      if(v.sale_date&&(n(v.sale_price)!=null||v.exit_type==="ride")){saleT=ts(v.sale_date);why="売却済";}
      else if(v.sale_plan_date){saleT=ts(v.sale_plan_date);why="手動";}
      else if(limitT!=null&&(byShaken==null||limitT<=byShaken)){saleT=limitT;why="走行";}
      else if(byShaken!=null){saleT=byShaken;why="車検";}
      // saleT＝稼働の終わり（リミット到達・車検・手動）。その1ヶ月前に売り止め（予約を止める）、売り止めから逆算して仕入れ開始
      const lead=n(S.cfg.lead_months)||3, stopT=saleT!=null&&why!=="売却済"?addMon(saleT,-1):null, procT=stopT!=null?addMon(stopT,-lead):null;
      const ride=v.exit_type==="ride";   // 乗り潰し（売らずに使い切る）
      let st="run";
      if(why==="売却済")st="sold";
      else if(saleT==null)st=odo==null||monKm==null?"nodata":"run";
      else if(stopT<=t0||(odo!=null&&odo>=limit))st="sell";
      else if(procT<=t0)st="prep";
      else if(stopT<=addMon(t0,6))st="soon";
      // 収支（売上は 2026-08-03 以降の実績）
      const price=r=>n(r.final_price)||n(r.price)||n(r.amount)||0;
      const revDone=done.reduce((s,r)=>s+price(r),0);
      const revBooked=rs.filter(r=>ts(r.end_date)>=t0).reduce((s,r)=>s+price(r),0);
      // 稼働日数＝貸出日数（今日までに経過した分）。在籍日数＝データ開始（または仕入日）から今日まで
      const runDays=rs.reduce((s,r)=>{const a=ts(r.start_date),b=Math.min(ts(r.end_date),t0-DAY);return b>=a?s+Math.round((b-a)/DAY)+1:s;},0);
      const from=Math.max(ts(DATA_FROM),ts(v.purchase_date)||0), months=Math.max(0,(t0-from)/MON), heldDays=Math.max(1,Math.round((t0-from)/DAY));
      const mts=S.maint[v.code]||[], mCost=mts.reduce((s,m)=>s+(n(m.actual_cost)||n(m.cost)||0),0);
      const fixedMon=(n(v.lease_monthly)||0)+(n(v.insurance_annual)||0)+(n(v.car_tax)||0)/12;
      const fixed=fixedMon*months, buy=n(v.purchase_price);
      const cost=(buy||0)+mCost+fixed, gross=revDone-cost;   // 原価＝仕入額＋整備費＋リース・保険・税
      const exitPrice=n(v.sale_price)!=null?n(v.sale_price):n(v.sale_expected)!=null?n(v.sale_expected):(v.exit_type==="ride"?0:null);
      const total=buy!=null&&exitPrice!=null?gross+exitPrice:null;
      const recov=buy?revDone/buy:null;
      S.calc[v.code]={stopT,ride,odo,limit,flag,runDays,heldDays,nDone:done.length,cost,buy,recov,monKm,future,limitT,shaken,byShaken,saleT,why,procT,st,
        revDone,revBooked,mCost,fixed,fixedMon,months,gross,exitPrice,total,susp:rs.filter(suspect).length,rents:rs.length};
    });
  }

  // ---------- 表示 ----------
  function show(view){
    S.view=view;
    const body=$(view==="swap"?"swapBody":"karteBody");
    if(!S.loaded){
      body.innerHTML='<div class="vl-empty">読み込み中…</div>';
      load().then(render).catch(err=>{body.innerHTML='<div class="vl-empty err">取得できませんでした：'+e(err.message||err)+'<br><small>配車表にログインした端末で開いてください。</small></div>';});
      return;
    }
    render();
  }
  function render(){ if(S.view==="swap")renderSwap(); else renderKarte(); }

  function filtered(){
    let list=S.v.slice();
    if(S.brand==="BT")list=list.filter(v=>!isHdm(v)); else if(S.brand==="HDM")list=list.filter(isHdm);
    if(S.stf!=="all")list=list.filter(v=>S.calc[v.code].st===S.stf);
    const c=v=>S.calc[v.code], ci=v=>{const i=M_ORDER.indexOf(v.type||"");return i<0?99:i;};
    if(S.sort==="sale")list.sort((a,b)=>STATUS[c(a).st].rank-STATUS[c(b).st].rank||(c(a).stopT??9e15)-(c(b).stopT??9e15));
    else if(S.sort==="km")list.sort((a,b)=>(c(b).odo||0)-(c(a).odo||0));
    else if(S.sort==="profit")list.sort((a,b)=>(c(b).gross||0)-(c(a).gross||0));
    else list.sort((a,b)=>ci(a)-ci(b)||String(a.name||"").localeCompare(String(b.name||"")));
    return list;
  }

  function renderKarte(){
    const body=$("karteBody"); if(!body)return;
    const base=S.v.filter(v=>S.brand==="all"||(S.brand==="HDM")===isHdm(v));
    const cnt=k=>base.filter(v=>S.calc[v.code].st===k).length;
    let h='';
    h+='<div class="vl-sum">'
      +'<button class="vl-kpi'+(S.stf==="sell"?" on":"")+'" data-stf="sell"><span>⛔ 売り止め</span><b>'+cnt("sell")+'</b></button>'
      +'<button class="vl-kpi'+(S.stf==="prep"?" on":"")+'" data-stf="prep"><span>🟠 入替準備</span><b>'+cnt("prep")+'</b></button>'
      +'<button class="vl-kpi'+(S.stf==="soon"?" on":"")+'" data-stf="soon"><span>🟡 半年以内</span><b>'+cnt("soon")+'</b></button>'
      +'<div class="vl-kpi st"><span>月間走行/台</span><b>'+km(S.global.monKm)+'<small>km</small></b></div></div>';
    const G=S.global;
    const nFlag=base.filter(v=>S.calc[v.code].flag).length;
    h+='<div class="vl-stat"><b>全車共通の予測</b>　1予約 平均 <b>'+km(G.avgKm)+'km</b> × 1台あたり <b>'+G.perMon.toFixed(1)+'件/月</b> ＝ <b>月 '+km(G.monKm)+'km</b><small>実績 '+G.days+'日・予約 '+G.nRes+'件・走行実測 '+G.n+'件から計算（営業日数が増えるほど精度が上がります）</small>'+(nFlag?'<span class="vl-flagline">⚑ '+km(S.cfg.default_limit_km)+'kmを既に超えている車 '+nFlag+'台は、リミット'+km(S.cfg.over_limit_km)+'kmで計算中</span>':'')+'</div>';
    h+='<div class="vl-bar1">'
      +['all','BT','HDM'].map(b=>'<button class="chip'+(S.brand===b?" on":"")+'" data-br="'+b+'">'+(b==="all"?"全体 "+S.v.length:b==="BT"?"🟢 BT":"🔵 HDM")+'</button>').join("")
      +'<select class="vl-sort" aria-label="並び順">'+[["sale","売り止め順"],["class","クラス順"],["km","走行距離順"],["profit","粗利順"]].map(([k,l])=>'<option value="'+k+'"'+(S.sort===k?" selected":"")+'>'+l+'</option>').join("")+'</select>'
      +'<button class="vl-gear" title="設定">⚙</button></div>';
    if(S.stf!=="all")h+='<div class="vl-filt">'+STATUS[S.stf].ic+' '+STATUS[S.stf].lb+'のみ表示中 <button class="vl-clr" data-stf="all">すべて表示 ✕</button></div>';
    if(S.showCfg)h+=cfgHtml();
    const list=filtered();
    if(!list.length)h+='<div class="vl-empty">該当する車両はありません。</div>';
    list.forEach(v=>{h+=cardHtml(v);});
    h+='<div class="vl-foot">🟢 リアルタイム共有（配車表・点検の更新が自動で反映されます）'+(S.updated?'　最終更新 '+String(S.updated.getHours()).padStart(2,"0")+':'+String(S.updated.getMinutes()).padStart(2,"0"):'')+'<br>売上は '+DATA_FROM.replace(/-/g,"/")+' 以降の実績。予測は開くたびに最新の実績で計算し直します。</div>';
    body.innerHTML=h;
    S.open.forEach(code=>{if(S.detail[code]===undefined)loadDetail(code);});
  }

  function cardHtml(v){
    const c=S.calc[v.code], st=STATUS[c.st], open=S.open.has(v.code);
    const pct=c.odo!=null?Math.min(100,c.odo/c.limit*100):0;
    const shPct=c.shaken&&c.monKm&&c.odo!=null?Math.min(100,(c.odo+c.monKm*monthsTo(c.shaken))/c.limit*100):null;
    const d=S.dmg[v.code], dn=d?d.n:null;
    const kpiOff=S.kpi[v.code]===false||v.active===false;
    let h='<div class="vl-card '+st.cls+(open?" open":"")+'" data-code="'+e(v.code)+'">';
    h+='<div class="vl-hd" data-tog="1"><span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type||"?")+'</span>'
      +'<div class="vl-nm"><b>'+e(v.name||v.code)+'</b><small>'+e(plate4(v)||"—")+' · <span class="'+(isHdm(v)?"vl-hdm":"vl-bt")+'">'+(isHdm(v)?"HDM":"BT")+'</span>'+(v.year?' · '+e(v.year):'')+(kpiOff?' · <span class="vl-off">今月停止</span>':'')+'</small></div>'
      +'<span class="vl-st '+st.cls+'">'+st.lb+'</span></div>';
    h+='<div class="vl-meter" data-tog="1"><div class="vl-track"><i style="width:'+pct.toFixed(1)+'%"></i>'+(shPct!=null?'<em style="left:'+shPct.toFixed(1)+'%" title="車検時点の予測"></em>':'')+'</div>'
      +'<div class="vl-kmrow"><span><b>'+km(c.odo)+'</b> / '+km(c.limit)+'km</span><span class="vl-rest">'+(c.odo!=null?(c.odo>=c.limit?'リミット超過':'残り '+km(c.limit-c.odo)+'km'):'走行未入力')+'</span></div></div>';
    h+='<div class="vl-grid" data-tog="1">'
      +cell("リミット到達",c.limitT!=null?ymFar(c.limitT):'—',c.monKm!=null?'月 '+km(c.monKm)+'km 計算':'')
      +cell("売り止め",c.stopT!=null?ymFar(c.stopT):(c.st==="sold"?'終了済':'—'),c.stopT!=null?(c.ride?'♻ 乗り潰し ':'💴 売却 ')+ymFar(c.saleT)+(c.why==="車検"?'（車検）':c.why==="手動"?'（手動）':''):'',c.st==="sell")
      +cell("仕入れ開始",c.procT!=null?ymFar(c.procT):'—',c.procT!=null?(c.procT<=T0()?'<b class="vl-now">今すぐ</b>':(monthsTo(c.procT)>60?'':'あと'+Math.ceil(monthsTo(c.procT))+'ヶ月')):'',c.st==="prep")
      +cell("車検",c.shaken?ymd(c.shaken).slice(2):'—',c.shaken?(monthsTo(c.shaken)<0?'期限切れ':'あと'+monthsTo(c.shaken).toFixed(1)+'ヶ月'):'')
      +'</div>';
    h+='<div class="vl-tags" data-tog="1">'
      +(dn!=null?'<span class="vl-tag'+(dn?" dmg":"")+'">🩹 傷 '+dn+'</span>':'')
      +(c.flag?'<span class="vl-tag flag">⚑ '+e(c.flag)+(c.ride?'':'・乗り潰し候補')+'</span>':'')+(c.ride?'<span class="vl-tag ride">♻ 乗り潰し</span>':'')
      +'<span class="vl-tag">💴 売上 '+yen(c.revDone)+'</span>'
      +'<span class="vl-tag">📅 稼働 '+c.runDays+'日</span>'
      +(c.susp?'<span class="vl-tag warn">⚠ 走行入力の確認 '+c.susp+'件</span>':'')
      +'<span class="vl-more">'+(open?'閉じる ▴':'詳しく ▾')+'</span></div>';
    if(open)h+='<div class="vl-bd">'+detailHtml(v)+'</div>';
    return h+'</div>';
  }
  function cell(lb,val,sub,hot){return '<div class="vl-c'+(hot?" hot":"")+'"><label>'+lb+'</label><b>'+val+'</b><small>'+(sub||"&nbsp;")+'</small></div>';}

  function detailHtml(v){
    const c=S.calc[v.code], D=S.detail[v.code];
    let h='';
    // 予測の根拠
    h+='<section><h4>📈 走行予測の根拠</h4><div class="vl-kv">'
      +kv("月間走行（全車共通）",km(c.monKm)+'km','1予約 '+km(S.global.avgKm)+'km × 月 '+S.global.perMon.toFixed(1)+'件')
      +kv("この車の予約",(S.res[v.code]||[]).length+'件','この先60日の予約 '+c.future+'件')
      +kv("リミット",km(c.limit)+'km',c.flag?'⚑ '+e(c.flag)+' → 延長リミット':n(v.life_limit_km)?'この車だけの設定':(S.cfg.class_limits&&S.cfg.class_limits[v.type]?'クラス'+e(v.type)+'の設定':'全体の既定'))
      +kv("リミット到達",c.limitT!=null?ymFar(c.limitT):'—',c.limitT!=null&&c.limitT>addMon(T0(),60)?'今のペースだと'+ym(c.limitT):'')
      +kv("売り止め → 仕入れ",c.stopT!=null?ymFar(c.stopT)+'売り止め':'—',c.procT!=null?'終了の1ヶ月前に予約を止める／その'+(S.cfg.lead_months||3)+'ヶ月前（'+ymFar(c.procT)+'）に同クラスの仕入れ開始':'')
      +kv("車検ルール",c.byShaken!=null?ym(c.byShaken)+'の車検で終了':'車検は通す',S.cfg.shaken_rule==="always"?'車検前に必ず売る設定':S.cfg.shaken_rule==="ignore"?'車検は見ない設定':'次の車検期間中にリミットに達するなら車検前に売る')
      +'</div>';
    if(D&&D.trips&&D.trips.length){
      h+='<div class="vl-trips">'+D.trips.slice(0,8).map(r=>{const k=tripKm(r),bad=suspect(r);
        return '<div class="'+(bad?"bad":"")+'"><span>'+e(String(r.start_date).slice(5).replace("-","/"))+'〜'+e(String(r.end_date).slice(5).replace("-","/"))+'</span><b>'+(k!=null?km(k)+'km':bad?'⚠ '+km(n(r.driven_km)??(n(r.end_odo)-n(r.start_odo)))+'km':'未入力')+'</b></div>';}).join("")+'</div>';
    }
    h+='</section>';
    // 生涯収支
    h+='<section><h4>💴 個体別の生涯成績</h4><div class="vl-kpis">'
      +kp("売上（生涯）",yen(c.revDone),'予約済み '+yen(c.revBooked)+' は別')
      +kp("稼働日数",c.runDays+'<small>日</small>','稼働率 '+Math.round(c.runDays/c.heldDays*100)+'%（在籍'+c.heldDays+'日）')
      +kp("予約件数",c.nDone+'<small>件</small>','日単価 '+(c.runDays?yen(c.revDone/c.runDays):'—'))
      +kp("粗利",'<span class="'+(c.gross>=0?"pos":"neg")+'">'+yen(c.gross)+'</span>',c.revDone?'粗利率 '+Math.round(c.gross/c.revDone*100)+'%':'')
      +'</div>';
    if(c.recov!=null)h+='<div class="vl-recov"><div><span>仕入額の回収</span><b>'+Math.round(c.recov*100)+'%</b></div><div class="tr"><i style="width:'+Math.min(100,c.recov*100)+'%"></i></div><small>売上 '+yen(c.revDone)+' ／ 仕入額 '+yen(c.buy)+'</small></div>';
    else h+='<div class="vl-warn">仕入額が未入力です。入れると、スタートからいくら回収したかが出ます。</div>';
    h+='<div class="vl-pl">'
      +pl("売上（実績）",yen(c.revDone),"pos")
      +pl("仕入額",c.buy!=null?yen(-c.buy):'未入力',"neg")
      +pl("整備費",yen(-c.mCost),"neg",(S.maint[v.code]||[]).length+'件')
      +pl("リース・保険・税",yen(-c.fixed),"neg",yen(c.fixedMon)+'/月 × '+c.months.toFixed(1)+'ヶ月')
      +'<div class="vl-pl-r sub"><span>原価 計</span><b class="neg">'+yen(-c.cost)+'</b></div>'
      +'<div class="vl-pl-r sub"><span>粗利（売上−原価）</span><b class="'+(c.gross>=0?"pos":"neg")+'">'+yen(c.gross)+'</b></div>'
      +pl(c.ride?(n(v.sale_price)!=null?"廃車・下取り額":"廃車・下取り額（見込み）"):(n(v.sale_price)!=null?"売却額":"予想売却額"),c.exitPrice!=null?yen(c.exitPrice):'未入力',"pos")
      +'<div class="vl-pl-r tot"><span>生涯で生んだ利益<small>粗利＋最後の売却額（仕入額は原価に含む）</small></span><b class="'+(c.total==null?"":c.total>=0?"pos":"neg")+'">'+(c.total!=null?yen(c.total):'仕入額・売却額の入力待ち')+'</b></div>'
+'</div><div class="vl-note">売上・固定費は '+DATA_FROM.replace(/-/g,"/")+'（または仕入日）以降で集計</div>';
    h+='</section>';
    // 売却時の条件（相場を見る材料）
    {
      const sp=(v.specs&&typeof v.specs==="object")?v.specs:{};
      const kmAtSale=c.why==="走行"?c.limit:(c.odo!=null&&c.monKm!=null&&c.saleT!=null?c.odo+c.monKm*Math.max(0,monthsTo(c.saleT)):c.odo);
      let shAt=c.shaken; if(shAt&&c.saleT!=null)while(shAt<c.saleT)shAt=addMon(shAt,24);   // 車検を通した場合は2年ごとに更新
      const shLeft=shAt&&c.saleT!=null?(shAt-c.saleT)/MON:null;
      const eq=[]; const navs=[]; if(sp.nav_en)navs.push("英");if(sp.nav_zh)navs.push("中");if(sp.nav_ko)navs.push("韓");
      if(navs.length)eq.push("ナビ("+navs.join("/")+")"); else if(sp.nav)eq.push("ナビ");
      [["backcam","バックカメラ"],["dashcam","ドラレコ"],["rearmonitor","リアモニター"],["bluetooth","Bluetooth"],["usb","USB"]].forEach(([k,l])=>{if(sp[k])eq.push(l);});
      if(v.equip&&v.equip!=="-")eq.push(v.equip);
      const dn=S.detail[v.code]&&S.detail[v.code].damages?S.detail[v.code].damages.length:(S.dmg[v.code]?S.dmg[v.code].n:null);
      h+='<section><h4>🏷 売却時の条件（相場を見る材料）</h4><div class="vl-kv">'
        +kv("年式",e(v.year||"—"),'')
        +kv(c.ride?"終了時の走行":"売却時の走行",km(kmAtSale)+'km',c.saleT!=null?ymFar(c.saleT)+'時点の見込み':'')
        +kv("グレード・型式",e([v.grade,sp.model_code].filter(Boolean).join(" ")||"—"),[sp.transmission,sp.fuel,v.seats?v.seats+"人":""].filter(Boolean).map(e).join("・"))
        +kv("車検残",shLeft==null?'—':shLeft<=0?'なし':shLeft.toFixed(0)+'ヶ月','売却時点')
        +'</div><div class="vl-eq">'+(eq.length?eq.map(x=>'<span>'+e(x)+'</span>').join(""):'<span class="none">装備未登録（マスターで入力）</span>')+(dn!=null?'<span class="dm">傷 '+dn+'件</span>':'')+'</div>';
      const q=encodeURIComponent([v.name,v.year,v.grade,kmAtSale?Math.round(kmAtSale/10000)+"万km":""].filter(Boolean).join(" "));
      h+='<div class="vl-mk"><span>相場を見る</span><a target="_blank" rel="noopener" href="https://www.google.com/search?q=site%3Acarsensor.net+'+q+'">カーセンサー ↗</a><a target="_blank" rel="noopener" href="https://www.google.com/search?q=site%3Agoo-net.com+'+q+'">グーネット ↗</a></div></section>';
    }
    // 傷・写真
    h+='<section><h4>🩹 傷・写真</h4>';
    if(D===undefined||D==="loading")h+='<div class="vl-empty sm">読み込み中…</div>';
    else if(D.err)h+='<div class="vl-empty sm err">'+e(D.err)+'</div>';
    else{
      const ds=D.damages||[];
      if(!ds.length)h+='<div class="vl-empty sm">記録された傷はありません</div>';
      else h+='<div class="vl-dmg">'+ds.map((x,i)=>'<button class="vl-dm" data-dmg="'+i+'">'+(x.photo?'<img src="'+e(x.photo)+'" alt="" loading="lazy">':'<span class="noimg">📷なし</span>')
        +'<span class="cap"><b>'+e(x.location||"位置不明")+'</b>'+e((DMG_T[x.type]||x.type||"")+(x.size?" "+x.size:"")+(x.severity?"・"+(DMG_S[x.severity]||x.severity):""))+'<small>'+e(String(x.addedAt||"").slice(0,10))+'</small></span></button>').join("")+'</div>';
      if(D.last)h+='<div class="vl-note">最終チェック '+e(String(D.last).slice(0,16).replace("T"," "))+(D.staff?'（'+e(D.staff)+'）':'')+'</div>';
      const ph=D.photos||[];
      if(ph.length)h+='<div class="vl-sub">点検・タイヤの写真（新しい順）</div><div class="vl-ph">'+ph.map(p=>{const u=phUrl(p.b,p.path,"thumb");return u?'<a href="'+e(phUrl(p.b,p.path,"full"))+'" target="_blank" rel="noopener"><img src="'+e(u)+'" alt="" loading="lazy"><small>'+e(p.lb)+'</small></a>':'';}).join("")+'</div>';
    }
    h+='</section>';
    // 装備
    h+='<section><h4>🧰 装備・登録情報</h4><div class="m-specs">'+(window.mSpecLine?mSpecLine(v):'')+'</div></section>';
    // 編集
    h+='<section><h4>✍ 仕入れ・出口（売却／乗り潰し）</h4>';
    if(!S.lifeCols)h+='<div class="vl-warn">入力欄を使うにはデータベースの追加（sql/bt_vehicle_lifecycle.sql）が必要です。</div>';
    h+='<div class="vl-exit">'+[["sell","💴 売却"],["ride","♻ 乗り潰し"]].map(([k,l])=>'<button data-exit="'+k+'" class="'+((v.exit_type||"sell")===k?"on":"")+'"'+(S.lifeCols?'':' disabled')+'>'+l+'</button>').join("")+'</div>';
    h+='<div class="vl-form">'
      +fld(v,"purchase_price","仕入額","円","number")+fld(v,"purchase_date","仕入日","","date")
      +fld(v,"life_limit_km","この車のリミット","km","number",km(S.calc[v.code].limit)+"（既定）")
      +fld(v,"sale_plan_date","売却予定日（手動）","","date")
      +fld(v,"sale_expected","予想売却額","円","number")
      +fld(v,"sale_price",v.exit_type==="ride"?"廃車・下取り額（確定）":"売却額（確定）","円","number")+fld(v,"sale_date",v.exit_type==="ride"?"廃車日":"売却日","","date")+fld(v,"sale_dest","売却先","","text","業者名など")
      +'</div></section>';
    return h;
  }
  const kp=(k,v,s)=>'<div class="vl-kp"><span>'+k+'</span><b>'+v+'</b>'+(s?'<small>'+s+'</small>':'')+'</div>';
  const kv=(k,v,s)=>'<div><span>'+k+'</span><b>'+v+'</b>'+(s?'<small>'+s+'</small>':'')+'</div>';
  const pl=(k,v,cls,s)=>'<div class="vl-pl-r"><span>'+k+(s?'<small>'+s+'</small>':'')+'</span><b class="'+cls+'">'+v+'</b></div>';
  function fld(v,key,lb,unit,type,ph){
    const val=v[key]==null?"":String(v[key]);
    return '<label class="vl-f"><span>'+lb+'</span><span class="in"><input type="'+(type==="number"?"text":type)+'"'+(type==="number"?' inputmode="numeric"':'')+' data-f="'+key+'" data-t="'+type+'" value="'+e(type==="number"&&val?Number(val).toLocaleString():val)+'" placeholder="'+e(ph||"")+'"'+(S.lifeCols?'':' disabled')+'>'+(unit?'<i>'+unit+'</i>':'')+'</span></label>';
  }

  async function loadDetail(code){
    S.detail[code]="loading";
    try{
      const [tw,ip,tp]=await Promise.all([
        sb.from("vehicle_twins").select("current_damages,last_check_at,last_check_staff").eq("id",code).maybeSingle(),
        sb.from("bt_inspection_photos").select("path,kind,created_at").eq("vehicle_code",code).eq("deleted",false).order("created_at",{ascending:false}).limit(12),
        sb.from("bt_tire_photos").select("path,created_at").eq("code",code).eq("deleted",false).order("created_at",{ascending:false}).limit(6)]);
      const photos=[].concat(((ip&&ip.data)||[]).map(p=>({b:"bt-inspections",path:p.path,t:p.created_at,lb:(p.kind==="post"?"返却後":"出発前")+" "+String(p.created_at).slice(5,10).replace("-","/")})),
        ((tp&&tp.data)||[]).map(p=>({b:"bt-tires",path:p.path,t:p.created_at,lb:"タイヤ "+String(p.created_at).slice(5,10).replace("-","/")}))).sort((a,b)=>String(b.t).localeCompare(String(a.t)));
      await Promise.all(["bt-inspections","bt-tires"].map(b=>{const ps=photos.filter(p=>p.b===b).map(p=>p.path);return ps.length?phSign(b,ps).catch(()=>0):0;}));
      const t=(tw&&tw.data)||{}, dm=Array.isArray(t.current_damages)?t.current_damages.slice().reverse():[];
      const trips=(S.res[code]||[]).filter(r=>r.driven_km!=null||r.end_odo!=null).sort((a,b)=>String(b.start_date).localeCompare(String(a.start_date)));
      S.detail[code]={damages:dm,last:t.last_check_at,staff:t.last_check_staff,photos,trips};
      if(!S.dmg[code])S.dmg[code]={n:dm.length};
    }catch(err){S.detail[code]={err:"取得できませんでした："+(err.message||err)};}
    rerenderCard(code);
  }
  function rerenderCard(code){
    const el=document.querySelector('.vl-card[data-code="'+CSS.escape(code)+'"]'); const v=S.v.find(x=>x.code===code);
    if(el&&v){const ae=document.activeElement; if(ae&&el.contains(ae)&&ae.tagName==="INPUT")return; el.outerHTML=cardHtml(v);}
  }

  function cfgHtml(){
    const c=S.cfg, cls=M_ORDER.filter(k=>k!=="送迎"&&S.v.some(v=>v.type===k));
    return '<div class="vl-cfg"><h4>⚙ 売却・入替のルール（全員共通）</h4>'
      +(S.cfgSaved?'':'<div class="vl-warn">設定を保存するにはデータベースの追加（sql/bt_vehicle_lifecycle.sql）が必要です。今は既定値で計算しています。</div>')
      +'<label class="vl-f"><span>走行リミット（既定）</span><span class="in"><input inputmode="numeric" data-cfg="default_limit_km" value="'+km(c.default_limit_km)+'"><i>km</i></span></label>'
      +'<label class="vl-f"><span>すでに既定を超えていた車のリミット</span><span class="in"><input inputmode="numeric" data-cfg="over_limit_km" value="'+km(c.over_limit_km)+'"><i>km</i></span></label>'
      +'<div class="vl-sub">クラス別のリミット（空欄＝既定）</div><div class="vl-cls">'+cls.map(k=>'<label><span class="m-badge" style="background:'+clsCol(k)+'">'+k+'</span><input inputmode="numeric" data-cls="'+k+'" value="'+(c.class_limits&&c.class_limits[k]?km(c.class_limits[k]):'')+'" placeholder="'+km(c.default_limit_km)+'"></label>').join("")+'</div>'
      +'<label class="vl-f"><span>仕入れを動かす時期</span><span class="in"><select data-cfg="lead_months">'+[1,2,3,4,5,6].map(m=>'<option value="'+m+'"'+(+c.lead_months===m?" selected":"")+'>売却の'+m+'ヶ月前</option>').join("")+'</select></span></label>'
      +'<label class="vl-f"><span>車検の扱い</span><span class="in"><select data-cfg="shaken_rule">'+[["next","次の車検期間中にリミットに達するなら、車検前に売る"],["always","車検の前に必ず売る"],["ignore","車検は見ない（走行だけ）"]].map(([k,l])=>'<option value="'+k+'"'+(c.shaken_rule===k?" selected":"")+'>'+l+'</option>').join("")+'</select></span></label>'
      +'<div class="vl-cfg-ft"><button class="btn" data-cfgclose="1">閉じる</button><button class="btn p" data-cfgsave="1"'+(S.cfgSaved?'':' disabled')+'>保存</button></div></div>';
  }

  // ---------- 入替タブ ----------
  function renderSwap(){
    const body=$("swapBody"); if(!body)return;
    const t0=T0(), months=[];
    for(let i=0;i<18;i++)months.push(addMon(Date.UTC(new Date(t0).getUTCFullYear(),new Date(t0).getUTCMonth(),1),i));
    const key=t=>{const d=new Date(t);return d.getUTCFullYear()*100+d.getUTCMonth();};
    const ev={}; const add=(t,o)=>{const k=key(Math.max(t,months[0]));(ev[k]=ev[k]||[]).push(o);};
    const late=[];
    S.v.forEach(v=>{const c=S.calc[v.code]; if(c.st==="sold"||c.saleT==null)return;
      if(c.procT<t0)late.push(v);
      add(c.procT,{k:"proc",v,c,t:c.procT}); add(c.stopT,{k:"stop",v,c,t:c.stopT}); add(c.saleT,{k:"sale",v,c,t:c.saleT});});
    let h='<div class="vl-swap-hd"><div><b>'+late.length+'</b>台は仕入れを動かす時期を過ぎています</div><small>リミット到達（または車検）の1ヶ月前に⛔売り止め、その'+(S.cfg.lead_months||3)+'ヶ月前に🛒仕入れ開始。売り止めまでに同じクラスの車を補充して入れ替えます。</small></div>';
    if(late.length)h+='<div class="vl-late">'+late.map(v=>{const c=S.calc[v.code];return '<button class="vl-ev proc late" data-goto="'+e(v.code)+'"><span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type)+'</span><span class="nm">'+e(v.name)+' <small>'+e(plate4(v))+'</small></span><span class="dt">売り止め '+ym(c.stopT)+'</span></button>';}).join("")+'</div>';
    // 全車両の売却目安（今→5年。走行は全車共通ペース、個体差は今の走行距離から）
    const H=60, rows=S.v.filter(v=>S.calc[v.code].st!=="sold").sort((a,b)=>(S.calc[a.code].saleT??9e15)-(S.calc[b.code].saleT??9e15));
    h+='<h4 class="vl-h4">全車両の売り止め・入替目安</h4><div class="vl-gantt"><div class="vl-gx"><span></span><div>'+[0,12,24,36,48,60].map(m=>'<i style="left:'+(m/H*100)+'%">'+(m===0?'今':m===60?'5年+':(m/12)+'年')+'</i>').join("")+'</div></div>';
    const pos=t=>t==null?null:Math.min(100,Math.max(0,monthsTo(t))/H*100);
    rows.forEach(v=>{const c=S.calc[v.code], pP=pos(c.procT), pS=pos(c.stopT), pE=pos(c.saleT), mo=c.saleT!=null?monthsTo(c.saleT):null;
      h+='<button class="vl-gr '+STATUS[c.st].cls+'" data-goto="'+e(v.code)+'"><span class="nm"><span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type)+'</span><span class="t">'+e(v.name)+'<small>'+e(plate4(v))+' · '+(c.odo!=null?km(c.odo)+'km':'—')+'</small></span></span><div class="bar">'
        +(pE!=null?'<i class="g" style="width:'+pP+'%"></i><i class="p" style="left:'+pP+'%;width:'+(pS-pP)+'%"></i><i class="s" style="left:'+pS+'%;width:'+Math.max(1.2,pE-pS)+'%"></i>'
          +'<b class="'+(pE>70?'r':'')+'" style="left:'+pE+'%">'+(mo>H?'5年+':(c.ride?'♻':'💴')+ym(c.saleT).replace("年","/").replace("月",""))+(c.why==="車検"?' 📋':'')+'</b>':'<b style="left:0">予測待ち</b>')
        +'</div></button>';});
    h+='</div><div class="vl-legend"><span><i class="g"></i>稼働</span><span><i class="p"></i>仕入れ期間</span><span><i class="s"></i>売り止め〜終了</span><span>💴売却 ♻乗り潰し 📋車検で終了</span></div><div class="vl-note">月の走行は全車共通（月 '+km(S.global.monKm)+'km）なので、差は今の走行距離から生まれます。</div>';
    h+='<h4 class="vl-h4">月別の入替予定</h4><div class="vl-tl">';
    let gap=[];
    const flush=()=>{if(!gap.length)return;h+='<div class="vl-mo empty gap">'+(gap.length>1?ym(gap[0])+'〜'+ym(gap[gap.length-1]):ym(gap[0]))+'　予定なし</div>';gap=[];};
    months.forEach((m,i)=>{
      const list=(ev[key(m)]||[]).sort((a,b)=>a.t-b.t);
      if(i>0&&!list.some(x=>!(x.k==="proc"&&x.t<t0))){gap.push(m);return;}
      flush();
      const nSale=list.filter(x=>x.k==="sale").length, nStop=list.filter(x=>x.k==="stop").length, nProc=list.filter(x=>x.k==="proc"&&x.t>=t0).length;
      h+='<div class="vl-mo'+(list.length?"":" empty")+(i===0?" now":"")+'"><div class="vl-mo-hd"><b>'+ym(m)+'</b>'+(i===0?'<span class="vl-nowtag">今月</span>':'')
        +(nProc?'<span class="vl-pill proc">🛒 '+nProc+'</span>':'')+(nStop?'<span class="vl-pill stop">⛔ '+nStop+'</span>':'')+(nSale?'<span class="vl-pill sale">終了 '+nSale+'</span>':'')+'</div>';
      list.forEach(x=>{ if(x.k==="proc"&&x.t<t0)return;
        const ic=x.k==="proc"?"🛒":x.k==="stop"?"⛔":(x.c.ride?"♻":"💴");
        h+='<button class="vl-ev '+x.k+'" data-goto="'+e(x.v.code)+'"><span class="ic">'+ic+'</span><span class="m-badge" style="background:'+clsCol(x.v.type)+'">'+e(x.v.type)+'</span><span class="nm">'+e(x.v.name)+' <small>'+e(plate4(x.v))+'</small></span><span class="dt">'+(x.k==="proc"?e(x.v.type)+'クラス補充の仕入れ開始':x.k==="stop"?'売り止め':(x.c.ride?'乗り潰し終了':'売却')+'（'+x.c.why+'）')+'</span></button>';});
      h+='</div>';
    });
    flush();
    h+='</div>';
    // クラス別の台数（売却予定を引いた見込み）
    const cls=M_ORDER.filter(k=>k!=="送迎"&&S.v.some(v=>v.type===k));
    const mIdx=[0,3,6,12];
    h+='<h4 class="vl-h4">クラス別の台数見込み（入れ替えなしの場合）</h4><div class="vl-ctbl"><table><thead><tr><th>クラス</th><th>今</th>'+mIdx.slice(1).map(i=>'<th>'+i+'ヶ月後</th>').join("")+'</tr></thead><tbody>'
      +cls.map(k=>{const vs=S.v.filter(v=>v.type===k&&S.calc[v.code].st!=="sold");const at=i=>{const t=addMon(t0,i);return vs.filter(v=>S.calc[v.code].saleT==null||S.calc[v.code].saleT>t).length;};
        return '<tr><td><span class="m-badge" style="background:'+clsCol(k)+'">'+k+'</span></td>'+mIdx.map(i=>{const x=at(i),d=x<vs.length;return '<td class="'+(d?"dn":"")+'">'+x+'</td>';}).join("")+'</tr>';}).join("")+'</tbody></table></div>';
    body.innerHTML=h;
  }

  // ---------- 操作 ----------
  async function saveVal(code,key,val){
    const v=S.v.find(x=>x.code===code); if(!v||v[key]===val)return;
    const {error}=await sb.from("bt_vehicles").update({[key]:val,updated_at:new Date().toISOString()}).eq("code",code);
    if(error){setStatus("保存できませんでした："+error.message);return;}
    v[key]=val; compute(); setStatus("✅ 保存しました"); render();
  }
  async function saveField(code,inp){
    const key=inp.dataset.f, t=inp.dataset.t; let val=inp.value.trim();
    if(t==="number"){val=val.replace(/[^\d]/g,"");val=val===""?null:Number(val);}else if(val==="")val=null;
    const v=S.v.find(x=>x.code===code); if(!v||v[key]===val||(v[key]==null&&val==null))return;
    inp.classList.add("saving");
    const {error}=await sb.from("bt_vehicles").update({[key]:val,updated_at:new Date().toISOString()}).eq("code",code);
    inp.classList.remove("saving");
    if(error){inp.classList.add("err");setStatus("保存できませんでした："+error.message);return;}
    inp.classList.remove("err"); v[key]=val; compute(); setStatus("✅ 保存しました");
    inp.blur(); render();
  }
  async function saveCfg(root){
    const c=Object.assign({},S.cfg,{class_limits:Object.assign({},S.cfg.class_limits)});
    const num=s=>{const x=String(s||"").replace(/[^\d]/g,"");return x?Number(x):null;};
    root.querySelectorAll("[data-cfg]").forEach(i=>{const k=i.dataset.cfg;c[k]=k==="shaken_rule"?i.value:num(i.value)||DEF[k];});
    root.querySelectorAll("[data-cls]").forEach(i=>{const x=num(i.value);if(x)c.class_limits[i.dataset.cls]=x;else delete c.class_limits[i.dataset.cls];});
    const {error}=await sb.from("bt_vehicle_life_settings").upsert({id:1,default_limit_km:c.default_limit_km,over_limit_km:c.over_limit_km,class_limits:c.class_limits,lead_months:c.lead_months,shaken_rule:c.shaken_rule,updated_at:new Date().toISOString()});
    if(error){setStatus("設定を保存できませんでした："+error.message);return;}
    S.cfg=c; S.showCfg=false; compute(); render(); setStatus("✅ ルールを保存しました");
  }
  function openViewer(src){
    const d=document.createElement("div"); d.className="vl-viewer"; d.innerHTML='<img src="'+e(src)+'" alt=""><button aria-label="閉じる">✕</button>';
    d.addEventListener("click",()=>d.remove()); document.body.appendChild(d);
  }
  function gotoCard(code){
    const b=document.querySelector('.tabbtn[data-v="karte"]'); S.stf="all"; S.open.add(code); if(b)b.click();
    setTimeout(()=>{const el=document.querySelector('.vl-card[data-code="'+CSS.escape(code)+'"]');if(el)el.scrollIntoView({behavior:"smooth",block:"start"});},80);
  }

  function bind(){
    const kb=$("karteBody"), sw=$("swapBody");
    kb.addEventListener("click",ev=>{
      const t=ev.target;
      const sf=t.closest("[data-stf]"); if(sf){S.stf=S.stf===sf.dataset.stf?"all":sf.dataset.stf;saveUi();renderKarte();return;}
      const br=t.closest("[data-br]"); if(br){S.brand=br.dataset.br;saveUi();renderKarte();return;}
      if(t.closest(".vl-gear")){S.showCfg=!S.showCfg;renderKarte();return;}
      if(t.closest("[data-cfgclose]")){S.showCfg=false;renderKarte();return;}
      if(t.closest("[data-cfgsave]")){saveCfg(t.closest(".vl-cfg"));return;}
      const ex=t.closest("[data-exit]"); if(ex&&!ex.disabled){const code=ex.closest(".vl-card").dataset.code;saveVal(code,"exit_type",ex.dataset.exit);return;}
      const dm=t.closest("[data-dmg]"); if(dm){const img=dm.querySelector("img");if(img)openViewer(img.src);return;}
      const tg=t.closest("[data-tog]"); if(tg){const code=tg.closest(".vl-card").dataset.code;
        if(S.open.has(code))S.open.delete(code); else{S.open.add(code); if(S.detail[code]===undefined||S.detail[code].err)loadDetail(code);}
        rerenderCard(code); return;}
    });
    kb.addEventListener("change",ev=>{const t=ev.target;
      if(t.classList.contains("vl-sort")){S.sort=t.value;saveUi();renderKarte();return;}
      if(t.dataset.f){saveField(t.closest(".vl-card").dataset.code,t);}
    });
    kb.addEventListener("keydown",ev=>{if(ev.key==="Enter"&&ev.target.dataset.f)ev.target.blur();});
    kb.addEventListener("focusin",ev=>{const t=ev.target;if(t.dataset.t==="number"||/_km$/.test(t.dataset.cfg||"")||t.dataset.cls)t.value=t.value.replace(/[^\d]/g,"");});
    sw.addEventListener("click",ev=>{const g=ev.target.closest("[data-goto]");if(g)gotoCard(g.dataset.goto);});
    // リアルタイム：車両・予約（配車表）・整備・設定が変わったら、開いている人全員の画面を自動で更新（入力中は待つ）
    let tm=null; const visible=()=>$("viewKarte").style.display!=="none"||$("viewSwap").style.display!=="none";
    const refresh=()=>{clearTimeout(tm);tm=setTimeout(()=>{const ae=document.activeElement;
      if(ae&&ae.closest&&ae.closest("#viewKarte,#viewSwap")&&/INPUT|SELECT/.test(ae.tagName)){refresh();return;}
      if(!S.loaded)return; load(true).then(()=>{S.updated=new Date();if(visible())render();}).catch(()=>{});},4000);};
    const ch=sb.channel("vl-rt");
    ["bt_vehicles","bt_reservations","bt_fleet","bt_vehicle_maintenance","bt_vehicle_life_settings"].forEach(t=>ch.on("postgres_changes",{event:"*",schema:"public",table:t},refresh));
    ch.subscribe();
    const rl=$("reload"); if(rl)rl.addEventListener("click",()=>{if(S.view&&($("viewKarte").style.display!=="none"||$("viewSwap").style.display!=="none")){S.loaded=false;S.detail={};show(S.view);}});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind); else bind();
  return {show,load,_S:S};
})();
