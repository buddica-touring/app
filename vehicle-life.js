// ===== 🚗 車両カルテ／🔄 入替（procurement.html ?tab=karte / ?tab=swap）=====
// 1台1カード：クラス・装備・走行・傷（写真）・車検・生涯収支。走行リミットと次回車検から売却予定日を出し、その N ヶ月前を仕入れ開始にする。
// 読む：bt_vehicles / bt_fleet×bt_reservations（売上・メーター実測）/ bt_vehicle_maintenance / bt_vehicle_monthly_kpi
//       vehicle_twins（傷・写真＝開いた時だけ1台分）/ bt_inspection_photos・bt_tire_photos（写真）/ bt_vehicle_life_settings
// 書く：bt_vehicles のライフサイクル列・bt_vehicle_life_settings（sql/bt_vehicle_lifecycle.sql 適用後）
// 入替リレー（2026-10-30 オーナー指示：販売を止めない）：前の車の service_to＝切替日の前日、後継車の service_from＝切替日、relay_to＝後継車。
//       切替日以降の配車（bt_fleet）とOPシートのタスクを後継車へ移す。配車表は同じ行で前の車→後継車を表示し、自動配車は稼働期間外の車を使わない。
// 予測：全車共通の1本＝1予約あたり平均km × 1台あたり月の予約件数（どちらも全車・全期間の実績）。
//       クラスや車種で分けない。開くたびに最新の実績で計算し直すので、営業日数が増えるほど精度が上がる。メーター実測は 2026-09-05〜。
const VL=(()=>{
  const DAY=864e5, MON=30.44*DAY;
  const VIEW_KEY=(()=>{try{return new URLSearchParams(location.search).get("view")||"";}catch(e){return "";}})();   // 閲覧専用リンク
  if(VIEW_KEY)document.documentElement.classList.add("vl-view");   // 閲覧リンク：ルール設定・リレーはログイン時だけ（ボタンを出さない）
  const DATA_FROM="2026-08-03";          // 予約・売上データの開始日
  const KM_MAX=3000, KM_PER_DAY_MAX=1000; // これを超える1予約の走行は入力ミス扱い（予測から外す）
  const LEAD=()=>n(S.cfg&&S.cfg.lead_months)||3;   // 入替車両準備期間（オーナー指示 2026-10-31：3ヶ月、ルールで変更可）
  const DEF={default_limit_km:90000,over_limit_km:150000,class_limits:{},lead_months:3,shaken_rule:"next",buy_rate:75};   // オーナー指示 2026-10-30：全車10万km。その時点で超えていた車は15万km＋フラグ
  // 市場価格の判断基準（オーナー指示 2026-10-31：定義をあいまいにしない・画面にも出す）。基準を足すときはここに1行足す（docs/market-price-rule.md も同じ内容に）
  const MARKET_RULE=[
    ["車種","カーセンサーの同じ車種（車種コード）。クラスは車種で決まる"],
    ["年式","その車の年式 ±1年（例：2017年式なら2016〜2018年式）"],
    ["走行距離","売る時点の走行を1万km単位に丸めて ±1万km（例：6.4万kmなら5〜7万km。カーセンサーの指定が1万km刻みのため）"],
    ["必須条件","排気量・動力（ハイブリッド／ガソリン／ディーゼル）・駆動方式（2WD／4WD）・乗車定員（何人乗り）の4つは必ず合わせる（同じ車種でも価格帯が別になるため）"],
    ["修復歴","修復歴ありは除く"],
    ["台数が少ない時","5台未満なら、年式を±2年 → 走行も±2万kmの順に広げ、5台以上になった条件で出す（広げた時は画面に明記）。それでも5台未満なら参考値、0台なら該当なし"],
    ["グレード・装備","絞らない（実測で絞っても価格帯が狭くならず、台数だけ減るため）。装備は記録だけ"],
    ["派生モデル","クロスオーバーなど価格帯が別の派生モデルは、派生モデルだけで取る"],
    ["出し方","本体価格（支払総額ではない）の中央値と、真ん中50%（25〜75%）の価格帯。店の売り出し価格で、売れた価格ではない。毎週ブラウザで調査"],
    ["数え方","本体価格の安い順に並べ、25%・50%・75%の順位の台が載るページだけ開く（1ページ30台。例：318台なら80・159・239番目＝3・6・8ページ目＋台数を見る1ページ目）。全部のページは見なくても順位で決まる"],
    ["買取見込み","小売相場の中央値 × 設定の％（初期75%）"]];
  const S={loaded:false,loading:null,cfg:Object.assign({},DEF),cfgSaved:false,lifeCols:false,
    v:[],res:{},maint:{},dmg:{},kpi:{},calc:{},open:new Set(),detail:{},
    brand:"all",stf:"all",sort:"sale",view:"karte",sec:"sum",showCfg:false};
  try{const o=JSON.parse(localStorage.getItem("vl_ui")||"{}");["brand","stf","sort","sec"].forEach(k=>{if(o[k])S[k]=o[k];});}catch(e){}
  const saveUi=()=>{try{localStorage.setItem("vl_ui",JSON.stringify({brand:S.brand,stf:S.stf,sort:S.sort,sec:S.sec}));}catch(e){}};
  const e=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const n=x=>{if(x==null||x==="")return null;const v=Number(x);return isFinite(v)?v:null;};
  const yen=x=>x==null?"—":(x<0?"−":"")+"¥"+Math.abs(Math.round(x)).toLocaleString();
  const man=x=>x==null?'—':(x<0?'−':'')+(Math.abs(x)>=1e4?(Math.round(Math.abs(x)/1e3)/10).toLocaleString()+'万':Math.round(Math.abs(x)).toLocaleString()+'円');
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
    talk:{lb:"協議",ic:"🟣",cls:"talk",rank:1},
    nodata:{lb:"予測待ち",ic:"⚪",cls:"nodata",rank:4}};
  const DMG_T={scratch:"擦り傷",dent:"へこみ",chip:"欠け",stone_chip:"飛び石",break:"破損"};
  const DMG_S={minor:"軽",moderate:"中",severe:"重"};

  async function all(make){let out=[],from=0;for(;;){const {data,error}=await make().range(from,from+999);if(error)throw error;out=out.concat(data||[]);if(!data||data.length<1000)break;from+=1000;}return out;}

  async function load(force){
    if(S.loading&&!force)return S.loading;
    S.loading=(async()=>{
      const ymNow=todayStr().slice(0,7);
      // 閲覧専用リンク（?view=キー）：ログインなしで関数1本から読む（sql/bt_vehicle_view_key.sql）
      const [veh,fleet,res,mt,kpi,cfg,dmg,mk]=VIEW_KEY?await (async()=>{
        const {data:d,error}=await sb.rpc("bt_vehicle_dashboard_view",{p_key:VIEW_KEY,p_from:DATA_FROM,p_ym:ymNow});
        if(error)throw new Error(/invalid view key/.test(error.message)?"閲覧リンクが無効です（キーが変更された可能性があります）":error.message);
        return [d.vehicles,d.fleet,d.res,d.maint,{data:d.kpi},{data:d.cfg},{data:d.dmg},{data:d.market}];
      })():await Promise.all([
        all(()=>sb.from("bt_vehicles").select("*").order("code")),
        all(()=>sb.from("bt_fleet").select("reservation_id,vehicle_code")),
        all(()=>sb.from("bt_reservations").select("id,start_date,end_date,status,final_price,price,amount,driven_km,start_odo,end_odo,end_odo_at").gte("start_date",DATA_FROM).order("id")),
        all(()=>sb.from("bt_vehicle_maintenance").select("vehicle_code,type,date,completed_date,cost,actual_cost,workshop,odometer_km,km_at").order("id")),
        sb.from("bt_vehicle_monthly_kpi").select("vehicle_code,active").eq("year_month",ymNow),
        sb.from("bt_vehicle_life_settings").select("*").eq("id",1).maybeSingle(),
        sb.rpc("bt_vehicle_damage_summary"),
        sb.from("bt_market_prices").select("vehicle_code,source,purpose,surveyed_at,year_from,year_to,km_from,km_to,n,median,p25,p75,min,max,points,query_url,note").gte("surveyed_at",new Date(Date.now()-180*DAY).toISOString()).order("surveyed_at",{ascending:false}).limit(2000)]);
      S.v=veh.filter(v=>v.type!=="送迎");
      S.lifeCols=S.v.length>0&&("life_limit_km" in S.v[0]);
      S.relayCols=S.v.length>0&&("relay_to" in S.v[0]);
      const r2v={}; fleet.forEach(f=>{r2v[f.reservation_id]=f.vehicle_code;});
      S.res={}; res.forEach(r=>{const c=r2v[r.id]; if(!c||isCancel(r))return; (S.res[c]=S.res[c]||[]).push(r);});
      markOdo();
      S.maint={}; mt.forEach(m=>{(S.maint[m.vehicle_code]=S.maint[m.vehicle_code]||[]).push(m);});
      S.kpi={}; ((kpi&&kpi.data)||[]).forEach(k=>{S.kpi[k.vehicle_code]=k.active;});
      S.cfgSaved=!!(cfg&&cfg.data); if(cfg&&cfg.data)S.cfg=Object.assign({},DEF,cfg.data,{class_limits:cfg.data.class_limits||{}});
      // 入替車両の準備（仕入候補の進捗・ETC）。閲覧リンクでは読まない
      S.proc=[]; S.etc={};
      if(!VIEW_KEY){const [pr,et]=await Promise.all([sb.from("bt_procurement").select("id,no,model,vclass,plate,status,maint_status,pickup_status,prep_status,op_start_date"),sb.from("bt_etc_setup").select("code,done")]);
        S.proc=(pr&&pr.data)||[]; ((et&&et.data)||[]).forEach(x=>{S.etc[x.code]=x.done;});}
      S.mk={}; S.mkOn=!!(mk&&!mk.error); if(S.mkOn)(mk.data||[]).forEach(m=>{(S.mk[m.vehicle_code]=S.mk[m.vehicle_code]||[]).push(m);});
      S.dmg={}; if(dmg&&!dmg.error)(dmg.data||[]).forEach(d=>{S.dmg[d.code]=d;});
      compute();
      try{await syncStop();}catch(err){console.warn("[VL] 売止ブロック",err&&err.message);}
      S.loaded=true; S.updated=new Date();
    })().catch(err=>{S.err=err;throw err;}).finally(()=>{S.loading=null;});
    return S.loading;
  }

  // 1予約の走行km。入力ミス（オーナー指示 2026-10-31：異常値は必ず外す）は null にして、平均にも今の走行にも使わない
  //   外す条件：0km以下／1回3,000km超／1日1,000km超／走行kmとメーター差が50km以上違う／出発メーターが前回の返却より小さい（markOdo）
  const rawKm=r=>n(r.driven_km)!=null?n(r.driven_km):(n(r.end_odo)!=null&&n(r.start_odo)!=null?n(r.end_odo)-n(r.start_odo):null);
  function tripBad(r){
    const k=rawKm(r); if(k==null)return "";
    if(r._bad)return r._bad;
    if(k<=0)return "0km以下";
    if(k>KM_MAX)return "1回 "+km(KM_MAX)+"km超";
    const d=Math.max(1,Math.round((ts(r.end_date)-ts(r.start_date))/DAY)+1);
    if(k/d>KM_PER_DAY_MAX)return "1日 "+km(KM_PER_DAY_MAX)+"km超";
    if(n(r.driven_km)!=null&&n(r.end_odo)!=null&&n(r.start_odo)!=null&&Math.abs(n(r.driven_km)-(n(r.end_odo)-n(r.start_odo)))>=50)return "走行kmとメーター差が合わない";
    return "";
  }
  function tripKm(r){const k=rawKm(r);return k==null||tripBad(r)?null:k;}
  function suspect(r){return rawKm(r)!=null&&!!tripBad(r);}
  // 車ごとにメーターを日付順に並べて、前後が合わない記録に印をつける（返却メーターが前回より小さい・2万km以上飛ぶ／出発メーターが前回の返却より小さい）
  function markOdo(){
    Object.values(S.res).forEach(rs=>{let last=null;
      rs.slice().sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date))).forEach(r=>{r._bad="";r._odoBad=false;
        const so=n(r.start_odo), eo=n(r.end_odo);
        if(so!=null&&last!=null&&so<last-50)r._bad="出発メーターが前回の返却より小さい";
        if(eo!=null){if(last!=null&&(eo<last-50||eo-last>20000)){r._odoBad=true;r._bad=r._bad||"返却メーターが前回と合わない";}else last=Math.max(last||0,eo);}
      });});
  }
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

  // 相場（オーナー指示 2026-10-30）：ピンポイントで当てず「相場感」を出す。
  //   条件＝同じ車種・年式±1年（3年分）・走行±1万km。今の走行と終了時の走行の2つで調べ、中央値と価格帯（25〜75%）を出す。装備・グレードはカーセンサーの検索条件に依存
  function wYear(y){const s=String(y||"").replace(/\s/g,"");let m;
    if((m=s.match(/^(19|20)(\d{2})/)))return +(m[1]+m[2]);
    if((m=s.match(/^(?:H|平成)(\d{1,2})/)))return 1988+ +m[1];
    if((m=s.match(/^(?:R|令和)(\d{1,2})/)))return 2018+ +m[1];
    return null;}
  function band(k){if(k==null)return null;const c=Math.round(k/10000)*10000;return [Math.max(0,c-10000),c+10000];}
  // カーセンサーの車種ページ＋条件（YMIN/YMAX＝年式、SMIN/SMAX＝走行km）。車種コードは bt_vehicles.market_code（例 TO_S228＝アクア）
  function csUrl(code,ys,b){const m=String(code||"").match(/^([A-Z]{2})_S(\d+)$/i);if(!m||!ys||!b)return null;
    return "https://www.carsensor.net/usedcar/b"+m[1].toUpperCase()+"/s"+m[2]+"/index.html?YMIN="+ys[0]+"&YMAX="+ys[1]+"&SMIN="+b[0]+"&SMAX="+b[1];}
  // 車検証の項目（配車表の車両マスターで必須入力）。必須条件＝排気量・動力・駆動・乗車定員
  const SHAKEN_ITEMS=[["maker","車名"],["model_code","型式"],["first_reg","初度登録年月"],["displacement","総排気量"],["fuel","燃料の種類"],["seats","乗車定員"],["type_no","型式指定番号"],["class_no","類別区分番号"],["chassis_no","車台番号"],["drive","駆動方式"]];
  const spOf=v=>(v.specs&&typeof v.specs==="object")?v.specs:{};
  function shakenOf(v){const sp=(v.specs&&typeof v.specs==="object")?v.specs:{};const val=k=>k==="seats"?v.seats:k==="chassis_no"?v.chassis_no:sp[k];
    return SHAKEN_ITEMS.map(([k,l])=>({k,l,x:val(k)})).map(o=>Object.assign(o,{miss:o.x==null||String(o.x).trim()===""}));}
  function surveySpec(v,c){const sp=(v.specs&&typeof v.specs==="object")?v.specs:{};
    const fr=String(sp.first_reg||"").match(/^(\d{4})/), y=fr?+fr[1]:wYear(v.year), ys=y?[y-1,y+1]:null, now=band(c.odo), end=c.ride?null:band(c.kmEnd);
    const must=[sp.displacement?sp.displacement+"L":null,sp.fuel||null,sp.drive||null,v.seats?v.seats+"人乗り":null];
    return {name:v.name,year:y,years:ys,now,end,must,mustMiss:must.filter(x=>!x).length,code:v.market_code||null,urlNow:csUrl(v.market_code,ys,now),urlEnd:csUrl(v.market_code,ys,end)};}
  // 安い順で25%・50%・75%の順位と、それが載るページ（カーセンサーは1ページ30台）。調査で開くのはこのページと1ページ目だけ
  function rankTxt(N){if(!(N>0))return "";const r=[.25,.5,.75].map(p=>Math.max(1,Math.ceil(N*p))),pg=[...new Set([1].concat(r.map(x=>Math.ceil(x/30))))];
    return '安い順 '+r.join('・')+'番目（全'+Math.ceil(N/30)+'ページ中 '+pg.join('・')+'ページ目を確認）';}
  function market(code){
    const rows=S.mk[code]; if(!rows||!rows.length)return null;
    const med=a=>{const b=a.slice().sort((x,y)=>x-y);if(!b.length)return null;const q=p=>{const i=(b.length-1)*p,l=Math.floor(i);return b[l]+(b[Math.ceil(i)]-b[l])*(i-l);};return {med:q(.5),p25:q(.25),p75:q(.75),min:b[0],max:b[b.length-1],n:b.length};};
    const pick=purpose=>{
      const latest={}; rows.filter(r=>(r.purpose||"now")===purpose).forEach(r=>{if(!latest[r.source])latest[r.source]=r;});
      const cur=Object.values(latest); if(!cur.length)return null;
      const prices=[].concat(...cur.map(r=>Array.isArray(r.points)?r.points.map(p=>Array.isArray(p)?p[1]:p):[])).filter(x=>x>0);
      let st=prices.length?med(prices):null;
      if(!st){const ms=cur.filter(r=>n(r.median)!=null);if(!ms.length)return null;
        st={med:ms.reduce((s,r)=>s+n(r.median),0)/ms.length,p25:Math.min(...ms.map(r=>n(r.p25)??n(r.median))),p75:Math.max(...ms.map(r=>n(r.p75)??n(r.median))),min:Math.min(...ms.map(r=>n(r.min)??n(r.median))),max:Math.max(...ms.map(r=>n(r.max)??n(r.median))),n:ms.reduce((s,r)=>s+(n(r.n)||0),0)};}
      const prev=rows.find(r=>(r.purpose||"now")===purpose&&!cur.includes(r)&&n(r.median)!=null);
      return Object.assign(st,{when:cur.map(r=>r.surveyed_at).sort().pop(),sources:cur.map(r=>r.source),urls:cur.map(r=>({s:r.source,u:r.query_url})),prev:prev?n(prev.median):null,
        cond:cur[0]});
    };
    const now=pick("now"), end=pick("end");
    return now||end?{now,end,median:(now||end).med}:null;
  }
  // 売却済＝売却額（確定）が入り、売却日（旧データ）か売却予定日を過ぎた車。売却日・売却先の入力欄は削除（オーナー指示 2026-10-31）
  const soldDone=(v,t0)=>n(v.sale_price)!=null&&!!(v.sale_date||(v.sale_plan_date&&ts(v.sale_plan_date)<=t0));
  function compute(){
    const t0=T0(), allKm=[], allD=[];
    let nRes=0, vDays=0;
    S.v.forEach(v=>{
      const rs=(S.res[v.code]||[]).filter(r=>ts(r.start_date)<=t0);
      rs.forEach(r=>{const k=tripKm(r);if(k!=null){allKm.push(k);allD.push(Math.max(1,Math.round((ts(r.end_date)-ts(r.start_date))/DAY)+1));}});
      if(!rs.length)return;
      const first=Math.min(...rs.map(r=>ts(r.start_date)));
      nRes+=rs.length; vDays+=Math.max(1,(t0-Math.max(first,ts(DATA_FROM)))/DAY);
    });
    const avgKm=allKm.length?allKm.reduce((s,x)=>s+x,0)/allKm.length:null;
    // オーナー指示 2026-10-31：全車対象。総走行（1予約平均×期間の予約件数）÷運用台数÷期間の月数＝1台あたりの月間走行
    const nOp=S.v.filter(v=>v.exit_type!=="return"&&!soldDone(v,t0)).length;
    const nIn=S.v.reduce((m,v)=>m+(S.res[v.code]||[]).filter(r=>ts(r.start_date)<=t0&&ts(r.start_date)>=ts(DATA_FROM)).length,0), mons=Math.max(1,(t0-ts(DATA_FROM))/DAY/30.44);
    const perMon=nOp?nIn/nOp/mons:0;
    // オーナー指示 2026-10-31：実測（距離のある予約）は 1予約平均・日数・1日あたり の根拠。台あたり月間は別計算＝期間中のメーター増分の合計÷月数÷運用台数
    // 各車のリミット予測はその車のペース（期間のメーター増分÷その車の期間）。期間が3ヶ月未満の車はフリート平均で代用（止まっている車は自然に遅くなる）
    let odoSum=0, nOdo=0; const pace={};
    S.v.forEach(v=>{const rs=(S.res[v.code]||[]).filter(r=>!r._odoBad&&ts(r.start_date)>=ts(DATA_FROM)&&ts(r.start_date)<=t0);
      const lo=Math.min(...rs.map(r=>n(r.start_odo)).filter(x=>x>0)), hi=Math.max(...rs.map(r=>n(r.end_odo)).filter(x=>x>0));
      if(isFinite(lo)&&isFinite(hi)&&hi>lo&&hi-lo<=20000*mons){odoSum+=hi-lo;nOdo++;
        const from=Math.max(ts(DATA_FROM),ts(v.service_from)||0), m=(t0-from)/DAY/30.44; if(m>=3)pace[v.code]=(hi-lo)/m;}});
    const monKm=nOp&&odoSum?odoSum/mons/nOp:null;
    const sD=allD.reduce((s,x)=>s+x,0), avgDays=allD.length?sD/allD.length:null, dayKm=sD?allKm.reduce((s,x)=>s+x,0)/sD:null;
    S.global={avgKm,avgDays,dayKm,n:allKm.length,perMon,nOp,mons,odoSum,nOdo,monKm,nRes,days:Math.round((t0-ts(DATA_FROM))/DAY)};
    S.calc={};
    const monKmF=monKm;
    S.v.forEach(v=>{
      const monKm=pace[v.code]??monKmF, paceOwn=pace[v.code]!=null;
      const rs=(S.res[v.code]||[]).slice().sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date)));
      const done=rs.filter(r=>ts(r.end_date)<t0);
      const future=rs.filter(r=>ts(r.start_date)>t0&&ts(r.start_date)<=t0+60*DAY).length;
      // 現在の走行距離＝マスターと返却メーターの大きい方（桁違いは除く）
      const base=n(v.current_mileage)||0;
      let odoMax=0,odoRetT=null; done.forEach(r=>{const o=n(r.end_odo);if(o&&!r._odoBad&&o>odoMax&&o-base<=20000){odoMax=o;odoRetT=ts(r.end_date);}});
      const odo=Math.max(base,odoMax)||null;
      // 走行の出どころ：返却メーター／手入力（specs.odo_at＝入力した日）／マスター。返却記録がない車は手入力で補う（2026-10-31）
      const odoAt=ts(spOf(v).odo_at), odoSrc=odo==null?null:odoMax>0&&odoMax>=base?{k:"ret",t:odoRetT}:odoAt!=null?{k:"man",t:odoAt}:{k:"master",t:null};
      const limit=limitOf(v,odo), flag=overFlag(v,odo);
      let limitT=null; if(odo!=null&&odo>=limit)limitT=t0; else if(odo!=null&&monKm>0)limitT=t0+(limit-odo)/monKm*MON;
      const shaken=ts(v.inspection_due_date||v.inspection_next_date);
      // 車検ルール：next＝次の車検期間（2年）中にリミット到達なら、車検で終わらせる（車検を通さない）
      let byShaken=null;
      if(shaken&&S.cfg.shaken_rule!=="ignore"&&v.exit_type!=="ride"){   // 乗り潰しは車検を通して走行リミットまで使う
        const kmAtNext=odo!=null&&monKm!=null?odo+monKm*((addMon(shaken,24)-t0)/MON):null;
        if(S.cfg.shaken_rule==="always"||(kmAtNext!=null&&kmAtNext>=limit))byShaken=shaken;
      }
      // オーナー指示 2026-10-31：リミット9万km。すでに10万km超の車は「協議」＝自動の予測・売止を出さず、売却か継続かを決める（決めたら売却予定日を手入力）
      const talk=v.life_flag==="協議"&&!n(v.life_limit_km); if(talk){limitT=null;byShaken=null;}
      let saleT=null, why="";
      if(v.exit_type==="return"){saleT=ts(v.sale_date)||t0;why="返却済";}   // リース返却・手放した車（2026-10-31 911）。一覧から外し、履歴は残す
      else if(soldDone(v,t0)){saleT=ts(v.sale_date||v.sale_plan_date);why="売却済";}
      else if(v.sale_plan_date){saleT=ts(v.sale_plan_date);why="手動";}
      else if(limitT!=null&&(byShaken==null||limitT<=byShaken)){saleT=limitT;why="走行";}
      else if(byShaken!=null){saleT=byShaken;why="車検";}
      // saleT＝稼働の終わり（リミット到達・車検・手動）。その1ヶ月前に売り止め（予約を止める）、売り止めから逆算して仕入れ開始
      const lead=n(S.cfg.lead_months)||3, stopT=saleT!=null&&why!=="売却済"&&why!=="返却済"?addMon(saleT,-1):null, procT=stopT!=null?addMon(stopT,-lead):null;
      const ride=v.exit_type==="ride";   // 乗り潰し（売らずに使い切る）
      let st="run";
      if(why==="売却済"||why==="返却済")st="sold";
      else if(saleT==null)st=talk?"talk":odo==null||monKm==null?"nodata":"run";
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
      const mkt=market(v.code);
      // 今売る vs 走らせる（売り止めまで今のペースで稼ぎ、終了時の走行での相場で売る）
      const rate=(n(S.cfg.buy_rate)||DEF.buy_rate)/100;
      const dayGross=(revDone-mCost-fixed)/heldDays;   // 1日あたりの粗利（仕入額を除く）
      const daysLeft=stopT!=null?Math.max(0,(stopT-t0)/DAY):null;
      const kmEnd=limitT!=null&&saleT!=null&&why==="走行"?limit:(odo!=null&&monKm!=null&&saleT!=null?odo+monKm*Math.max(0,(saleT-t0)/MON):null);
      const nowExit=mkt&&mkt.now?mkt.now.med*rate:null, endExit=mkt&&mkt.end?mkt.end.med*rate:null;
      const vsNow=nowExit!=null?gross+nowExit:null, vsLater=daysLeft!=null&&(ride||endExit!=null)?gross+dayGross*daysLeft+(ride?0:endExit):null;
      const sellNow=vsNow!=null&&vsLater!=null&&vsNow>vsLater&&!ride;
      const vsLaterRide=ride&&vsNow!=null&&daysLeft!=null?gross+dayGross*daysLeft:null;
      const overBuy=mkt&&buy!=null&&nowExit>buy;
      S.calc[v.code]={talk,paceOwn,odoSrc,mkt,rate,dayGross,daysLeft,kmEnd,nowExit,endExit,vsNow,vsLater,sellNow,overBuy,stopT,ride,odo,limit,flag,runDays,heldDays,nDone:done.length,cost,buy,recov,monKm,future,limitT,shaken,byShaken,saleT,why,procT,st,
        revDone,revBooked,mCost,fixed,fixedMon,months,gross,exitPrice,total,susp:rs.filter(suspect).length,rents:rs.length};
    });
  }

  // ---------- 表示 ----------
  function show(view){
    S.view="karte"; if(view==="swap"||view==="relay")S.sec="relay";
    const body=$("karteBody");
    if(!S.loaded){
      body.innerHTML='<div class="vl-empty">読み込み中…</div>';
      load().then(render).catch(err=>{body.innerHTML='<div class="vl-empty err">取得できませんでした：'+e(err.message||err)+'<br><small>配車表にログインした端末で開いてください。</small></div>';});
      return;
    }
    render();
  }
  function render(){ renderDash(); }

  // ---------- ダッシュボード（オーナー指示 2026-10-31：管理APPと同じ形。上にサマリ、メニューはスマホ＝上のプルダウン／PC＝左） ----------
  const SECS=[["全体",[["sum","📊","サマリ"]]],["売却・入替",[["relay","🛒","入替車両"]]],["車両",[["karte","🚗","車両カルテ"],["shaken","📋","車検証"]]],["お金",[["kpi","💴","クラス実績"],["market","📈","相場"]]],["設定",[["rule","⚙","ルール"]]]];
  const secBadge=k=>{const a=S.v.filter(v=>S.calc[v.code].st!=="sold");
    if(k==="relay")return a.filter(v=>inPrep(v)&&!v.relay_to).length;
    if(k==="shaken")return a.filter(v=>shakenOf(v).some(o=>o.miss)).length;
    if(k==="market")return a.filter(v=>S.calc[v.code].sellNow||S.calc[v.code].overBuy).length;
    return 0;};
  function renderDash(){
    const body=$("karteBody"); if(!body)return;
    const all=SECS.flatMap(g=>g[1]); if(!all.some(x=>x[0]===S.sec))S.sec="sum";
    const lb=x=>x[1]+' '+x[2], bd=x=>{const n=secBadge(x[0]);return n?n:0;};
    let h='<div class="vl-dash"><nav class="vl-side">'+SECS.map(([g,items])=>'<div class="g">'+e(g)+'</div>'+items.map(x=>'<button class="'+(S.sec===x[0]?"on":"")+'" data-sec="'+x[0]+'"><span>'+lb(x)+'</span>'+(bd(x)?'<i>'+bd(x)+'</i>':'')+'</button>').join("")).join("")+'</nav>';
    h+='<div class="vl-main"><label class="vl-pick"><select class="vl-secsel" aria-label="画面を選ぶ">'+SECS.map(([g,items])=>'<optgroup label="'+e(g)+'">'+items.map(x=>'<option value="'+x[0]+'"'+(S.sec===x[0]?" selected":"")+'>'+x[2]+(bd(x)?' 🔴'+bd(x):'')+'</option>').join("")+'</optgroup>').join("")+'</select></label>';
    h+='<div class="vl-sec">'+(S.v.length?secHtml():'<div class="vl-empty err">車両が0台です。配車表にログインしていない端末では表示されません。<br><a href="index.html" target="_blank" rel="noopener">配車表でログイン ↗</a> してから、この画面を開き直してください。</div>')+'</div>';
    h+=(VIEW_KEY?'':'<div class="vl-foot live">🟢 リアルタイム共有（配車表・点検の更新が自動で反映されます）'+(S.updated?'　最終更新 '+String(S.updated.getHours()).padStart(2,"0")+':'+String(S.updated.getMinutes()).padStart(2,"0"):'')+'</div>')+'</div></div>';
    body.innerHTML=h;
    if(S.sec==="karte")S.open.forEach(code=>{if(S.detail[code]===undefined)loadDetail(code);});
  }
  function secHtml(){
    switch(S.sec){
      case "karte":return karteHtml();
      case "relay":return relayHtml();
      case "kpi":return kpiHtml();
      case "market":return marketHtml();
      case "shaken":return shakenHtml();
      case "rule":return cfgHtml(true);
      default:return sumHtml();
    }
  }
  const nm=v=>'<span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type)+'</span><span class="nm">'+e(v.name)+' <small>'+e(plate4(v))+'</small></span>';
  // 全体（オーナー指示 2026-10-31：文字を減らし、図で俯瞰。クラス・ブランド・判定でまとめ、並び替えできる）
  //   判定：リミット先行（車検前に入替）＝次の車検期間中にリミットに届くので車検を通さず入れ替える／車検更新＝それ以外／予測待ち＝走行データ不足
  const JUDGE={talk:{lb:"協議",c:"#7c3aed"},swap:{lb:"リミット先行",c:"#dc2626"},pass:{lb:"車検更新",c:"#475569"},wait:{lb:"予測待ち",c:"#cbd5e1"}};
  // 次にやること（オーナー指示 2026-10-31：いつ何をするかを文章で）。車検・後継車登録・売止・売却のうち、まだの一番早いもの
  const ymdS=t=>{const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
  function nextAct(v,c){
    const t0=T0(); if(c.st==="sold")return null;
    if(c.talk&&c.stopT==null)return {txt:'協議：売却か継続かを決める',t:null,lv:"o"};
    if(c.stopT==null)return {txt:'走行を入力すると予定が出ます',t:null,lv:"mut"};
    const sw=addMon(c.stopT,-LEAD()), over=c.odo!=null&&c.limit&&c.odo>=c.limit, ev=[];
    if(c.shaken!=null&&c.shaken>=t0&&c.shaken<c.stopT)ev.push({t:c.shaken,a:'車検を通す'});
    if(!v.relay_to)ev.push(t0<sw?{t:sw,a:'入替車両の準備を始める'}:{t:c.stopT,a:'後継車を登録（売止日から販売）'});
    if(t0<=c.stopT)ev.push({t:c.stopT,a:'予約を止める（売止）'});
    ev.push({t:c.saleT,a:(c.ride?'廃車':c.shaken!=null&&c.saleT<=c.shaken?'車検を通さず売却':'売却')});
    const x=ev.filter(o=>o.t!=null).sort((a,b)=>a.t-b.t)[0]; if(!x)return null;
    const d=Math.round((x.t-t0)/DAY);
    if(d<0||over&&x.a!=='後継車を登録'&&x.a!=='車検を通す')return {txt:'今すぐ '+x.a+(over?'（リミット超過）':'（'+(-d)+'日超過）'),t:x.t,lv:"r"};
    return {txt:ymdS(x.t)+(x.a==='車検を通す'?' ':'までに ')+x.a,t:x.t,lv:d<=60?"o":""};
  }
  const judgeOf=c=>c.talk&&c.stopT==null?"talk":c.stopT==null?"wait":c.why==="車検"||(c.shaken!=null&&c.stopT<c.shaken)?"swap":"pass";
  function sumHtml(){
    const C=v=>S.calc[v.code], a=S.v.filter(v=>C(v).st!=="sold"), t0=T0();
    const g=S.ovg||"class", so=S.ovs||"stop";
    const mk=x=>x==null?'—':(Math.round(x/1e3)/10)+'万';
    const cntJ=k=>a.filter(v=>judgeOf(C(v))===k).length;
    const in1y=a.filter(v=>C(v).stopT!=null&&C(v).stopT<=addMon(t0,12)).length;
    // 数字4つ
    let h='<div class="ov-tiles"><div><b>'+a.length+'</b><span>台</span></div><div class="r"><b>'+cntJ("swap")+'</b><span>リミット先行</span></div><div><b>'+in1y+'</b><span>1年以内に売り止め</span></div><div><b>'+man(a.reduce((x,v)=>x+C(v).revDone,0))+'</b><span>総売上</span></div></div>';
    // 試算（オーナー指示 2026-10-31）：全車・全期間の実績から
    const G=S.global||{};
    h+='<div class="ov-est">'+[["1予約平均",G.avgKm,"走行 "+(G.n||0)+"件"],["1予約日数",G.avgDays,"同 "+(G.n||0)+"件","日",1],["1日あたり",G.dayKm,"距離÷日数"],["月間/台",G.monKm,"メーター増分"+(G.nOdo||0)+"台分÷"+(G.nOp||0)+"台÷"+(G.mons||0).toFixed(1)+"ヶ月"],["年間/台",G.monKm*12,"月間×12"]].map(([lb,x,why,u,dp])=>'<div><span>'+lb+'<em>試算</em></span><b>'+(x?(dp?x.toFixed(dp):km(x)):'—')+'<small>'+(u||'km')+'</small></b><i>'+why+'</i></div>').join('')+'</div>';
    // 全体＝車両カルテのサマリ（オーナー指示 2026-10-31）：1台1枚の小さなカードに カルテの要点（判定・走行/リミット・車検・売止・入替・総売上・市場価格）
    const keyOf=v=>g==="brand"?(isHdm(v)?"HDM":"BT"):g==="judge"?judgeOf(C(v)):(v.type||"—");
    const keys=[...new Set(a.map(keyOf))].sort((x,y)=>g==="judge"?["swap","pass","wait"].indexOf(x)-["swap","pass","wait"].indexOf(y):g==="class"?(M_ORDER.indexOf(x)+99)%199-(M_ORDER.indexOf(y)+99)%199:String(x).localeCompare(String(y)));
    const glb=k=>g==="judge"?JUDGE[k].lb:g==="brand"?(k==="HDM"?"HANDYMAN":"BUDDICA"):k;
    const sorter=(x,y)=>{const X=C(x),Y=C(y);return so==="km"?(Y.odo||0)/(Y.limit||1)-(X.odo||0)/(X.limit||1):so==="gross"?Y.revDone-X.revDone:(X.stopT??9e15)-(Y.stopT??9e15);};
    const ymS=t=>{if(t==null)return'—';const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1);};
    // 走行距離帯ごとの保有台数（オーナー指示 2026-10-31）
    const BANDS=[[0,3e4,"〜3万km"],[3e4,5e4,"3〜5万km"],[5e4,8e4,"5〜8万km"],[8e4,1e5,"8〜10万km"],[1e5,9e9,"10万km〜"]];
    // カードを押すとその距離帯だけ表示（オーナー指示 2026-10-31）。もう一度押すか「全て」で全車
    const sold=v=>n(v.sale_price)!=null;   // 売却確定＝売却額（確定）が入っている
    const inB=(v,i)=>i==="due"?C(v).limitT!=null&&C(v).limitT<=addMon(t0,LEAD())&&!sold(v):i==="talk"?C(v).talk:i==="prep"?inPrep(v):i==="stop"?sold(v):i==="na"?C(v).odo==null:C(v).odo!=null&&C(v).odo>=BANDS[i][0]&&C(v).odo<BANDS[i][1], ob=S.ovb==null?null:S.ovb;
    h+='<div class="ov-band"><button data-ovb="all" class="'+(ob==null?'on':'')+'"><span>全て</span><b>'+a.length+'<small>台</small></b></button>'+BANDS.map(([lo,hi,lb],i)=>{const n=a.filter(v=>inB(v,i)).length;return '<button data-ovb="'+i+'" class="'+(lo>=1e5&&n?'r ':lo>=8e4&&n?'o ':'')+(String(ob)===String(i)?'on':'')+'"><span>'+lb+'</span><b>'+n+'<small>台</small></b></button>';}).join('')
      +[["due","入替該当","r "],["talk","協議","o "],["prep","入替準備","o "],["stop","売却確定","r "]].map(([k,lb,cl])=>{const m=a.filter(v=>inB(v,k)).length;return '<button data-ovb="'+k+'" class="'+(m?cl:'')+(ob===k?'on':'')+'"><span>'+lb+'</span><b>'+m+'<small>台</small></b></button>';}).join('')+(a.some(v=>C(v).odo==null)?'<button data-ovb="na" class="mut'+(ob==="na"?' on':'')+'"><span>未入力</span><b>'+a.filter(v=>C(v).odo==null).length+'<small>台</small></b></button>':'')+'</div>';
    const shown=ob==null?a:a.filter(v=>inB(v,ob));
    // サマリ＝数字だけ（オーナー指示 2026-10-31）：①現在距離 ②リミット距離 ③予想到達日 ④入替準備開始日（売止の準備期間前）
    const ymd=t=>{if(t==null)return'—';const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
    h+='<div class="ov-num"><div class="hr"><span>車両</span><span>現在</span><span>リミット</span><span>到達予想</span><span>入替準備</span></div>';
    keys.filter(k=>shown.some(v=>keyOf(v)===k)).forEach(k=>{const l=shown.filter(v=>keyOf(v)===k).sort(sorter);
      h+='<div class="gh">'+e(glb(k))+'<b>'+l.length+'</b></div>';
      h+=l.map(v=>{const c=C(v),p=c.odo!=null&&c.limit?c.odo/c.limit:0,pr=c.stopT!=null?addMon(c.stopT,-LEAD()):null;
        return '<div class="rw" data-goto="'+e(v.code)+'"><div class="nmc">'+nm(v)+'</div>'
          +'<div data-l="現在"'+(p>=.9?' class="r"':'')+'>'+(c.odo!=null?km(c.odo):'—')+'</div><div data-l="リミット">'+(c.limit&&!c.talk?km(c.limit):'—')+'</div>'
          +'<div data-l="到達予想"'+(c.talk?' class="o"':c.limitT!=null&&c.limitT<=t0?' class="r"':'')+'>'+(c.talk?'協議':ymd(c.limitT))+'</div><div data-l="入替準備"'+(pr!=null&&pr<=t0?' class="o"':'')+'>'+ymd(pr)+'</div></div>';}).join('');});
    h+='</div>';
    return h;
  }
  const tbl=(head,rows)=>'<div class="vl-ctbl vl-dt"><table><thead><tr>'+head.map(x=>'<th>'+x+'</th>').join("")+'</tr></thead><tbody>'+rows.join("")+'</tbody></table></div>';
  // 個体別スケジュール（オーナー指示 2026-10-31：まず1台ずつの状況と予定をはっきり出す・UIUX重視）
  // 1台1枚。期限の近い順に「今すぐ対応／半年以内／稼働中／予測待ち」の帯に分け、今→2年先の帯グラフで 稼働・仕入・売り止め を色で見せる。
  // 今の走行（手入力）：返却メーターの記録がない車・記録より新しい値がある時に使う。current_mileage と specs.odo_at（日付）に保存
  const odoLb=c=>!c.odoSrc?'':c.odoSrc.k==="ret"?'返却 '+mdS(c.odoSrc.t):c.odoSrc.k==="man"?'手入力 '+mdS(c.odoSrc.t):'マスター';
  const mdS=t=>{if(t==null)return'';const d=new Date(t);return (d.getUTCMonth()+1)+'/'+d.getUTCDate();};
  const odoForm=(v,c)=>'<div class="vl-odo" data-code="'+e(v.code)+'"><input class="vl-ti" data-odo="km" inputmode="numeric" placeholder="'+(c.odo!=null?km(c.odo):'例 45,200')+'" aria-label="今のメーター（km）"><i>km</i><input class="vl-ti" type="date" data-odo="at" value="'+todayStr()+'" aria-label="見た日"><button type="button" data-odosave>保存</button></div>';
  // クラス実績（オーナー指示 2026-10-31）：AA以外はクラスでまとめて1台あたり、AAは1台ずつ。稼働率＝稼働日数÷保有日数（データ開始日か仕入日から）
  function kpiHtml(){
    const C=v=>S.calc[v.code], a=S.v.filter(v=>C(v).st!=="sold"), sum=(l,f)=>l.reduce((s,v)=>s+(f(C(v))||0),0);
    const st=l=>{const hd=sum(l,c=>c.heldDays);return {n:l.length,rev:sum(l,c=>c.revDone)/l.length,util:hd?sum(l,c=>c.runDays)/hd:null};};
    const cls=[...new Set(a.filter(v=>v.type!=="AA").map(v=>v.type||"?"))];
    const rows=cls.map(t=>{const l=a.filter(v=>(v.type||"?")===t);return {t,l,x:st(l)};}).concat(a.filter(v=>v.type==="AA").map(v=>({v,l:[v],x:st([v])})));
    const all=st(a), pc=u=>u==null?'—':Math.round(u*100)+'%';
    const row=r=>'<div class="vl-cr"'+(r.v?' data-goto="'+e(r.v.code)+'"':'')+'><div class="hd">'+(r.v?nm(r.v):'<span class="m-badge" style="background:'+clsCol(r.t)+'">'+e(r.t)+'</span><span class="nm">'+e([...new Set(r.l.map(v=>v.name))].join('・'))+'</span><em>'+r.x.n+'台</em>')+'</div>'
      +'<div class="nums"><div><span>'+(r.v?'売上':'総売上')+'</span><b>'+man(r.x.rev*r.x.n)+'</b></div>'+(r.v?'':'<div><span>台平均売上</span><b>'+man(r.x.rev)+'</b></div>')+'<div><span>稼働率</span><b>'+pc(r.x.util)+'</b></div></div>'
      +'<div class="bar"><u style="width:'+(r.x.util==null?0:Math.min(100,r.x.util*100)).toFixed(1)+'%"></u></div></div>';
    const by=(x,y)=>y.x.rev-x.x.rev;
    return '<h4 class="vl-h4">💴 クラス実績</h4>'
      +'<div class="vl-ksum k3"><div><span>総売上</span><b>'+man(all.rev*all.n)+'</b></div><div><span>台平均売上</span><b>'+man(all.rev)+'</b></div><div><span>稼働率</span><b>'+pc(all.util)+'</b></div></div>'
      +'<div class="vl-crs">'+rows.filter(r=>!r.v).sort(by).map(row).join('')+'</div>'
      +'<h4 class="vl-h4">AA</h4><div class="vl-crs">'+rows.filter(r=>r.v).sort(by).map(row).join('')+'</div>';
  }
  function marketHtml(){
    const a=S.v.filter(v=>S.calc[v.code].st!=="sold").sort((x,y)=>(S.calc[y.code].sellNow?1:0)-(S.calc[x.code].sellNow?1:0)||(S.calc[x.code].stopT??9e15)-(S.calc[y.code].stopT??9e15));
    return '<h4 class="vl-h4">📈 相場 <small>今の走行で売った場合の小売相場</small></h4><details class="vl-rule"><summary>この基準で検索しています（あくまで目安）</summary><dl>'+MARKET_RULE.map(([k,t])=>'<dt>'+e(k)+'</dt><dd>'+e(t)+'</dd>').join("")+'</dl></details>'
      +tbl(["車両","相場（真ん中50%）","中央値","買取見込み","判定"],a.map(v=>{const c=S.calc[v.code],x=c.mkt&&c.mkt.now;
        return '<tr data-goto="'+e(v.code)+'"><td>'+nm(v)+'</td><td>'+(x?man(x.p25)+'〜'+man(x.p75):'<span class="mut">未調査</span>')+'</td><td>'+(x?man(x.med):'—')+'</td><td>'+(c.nowExit!=null?man(c.nowExit):'—')+'</td><td>'+(c.sellNow?'<b class="org">💡今が売り時</b>':c.overBuy?'<b class="org">仕入額超え</b>':'')+'</td></tr>';}));
  }
  function shakenHtml(){
    const a=S.v.filter(v=>S.calc[v.code].st!=="sold").map(v=>({v,ms:shakenOf(v).filter(o=>o.miss)})).sort((x,y)=>y.ms.length-x.ms.length);
    return '<h4 class="vl-h4">📋 車検証 <small>相場の検索条件に使います。入力は配車表の車両マスター（基本情報）</small></h4>'
      +tbl(["車両","未入力","足りない項目"],a.map(({v,ms})=>'<tr data-goto="'+e(v.code)+'"><td>'+nm(v)+'</td><td class="'+(ms.length?'red':'grn')+'">'+(ms.length?ms.length:'✓')+'</td><td>'+ms.map(o=>e(o.l)).join('・')+'</td></tr>'));
  }

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

  function karteHtml(){
    const base=S.v.filter(v=>S.brand==="all"||(S.brand==="HDM")===isHdm(v));
    const cnt=k=>base.filter(v=>S.calc[v.code].st===k).length;
    let h='';
    h+='<div class="vl-sum">'
      +'<button class="vl-kpi'+(S.stf==="sell"?" on":"")+'" data-stf="sell"><span>⛔ 売り止め</span><b>'+cnt("sell")+'</b></button>'
      +'<button class="vl-kpi'+(S.stf==="prep"?" on":"")+'" data-stf="prep"><span>🟠 入替準備</span><b>'+cnt("prep")+'</b></button>'
      +'<button class="vl-kpi'+(S.stf==="soon"?" on":"")+'" data-stf="soon"><span>🟡 半年以内</span><b>'+cnt("soon")+'</b></button>'
      +'<div class="vl-kpi st"><span>月間走行/台</span><b>'+km(S.global.monKm)+'<small>km</small></b></div></div>';
    const G=S.global;
    const nFlag=base.filter(v=>S.calc[v.code].flag).length, nNow=base.filter(v=>S.calc[v.code].sellNow||S.calc[v.code].overBuy).length;
    h+='<div class="vl-bar1">'
      +['all','BT','HDM'].map(b=>'<button class="chip'+(S.brand===b?" on":"")+'" data-br="'+b+'">'+(b==="all"?"全体 "+S.v.length:b==="BT"?"🟢 BT":"🔵 HDM")+'</button>').join("")
      +'<select class="vl-sort" aria-label="並び順">'+[["sale","売り止め順"],["class","クラス順"],["km","走行距離順"],["profit","粗利順"]].map(([k,l])=>'<option value="'+k+'"'+(S.sort===k?" selected":"")+'>'+l+'</option>').join("")+'</select>'
      +'<button class="vl-gear" title="設定">⚙</button></div>';
    if(S.stf!=="all")h+='<div class="vl-filt">'+STATUS[S.stf].ic+' '+STATUS[S.stf].lb+'のみ表示中 <button class="vl-clr" data-stf="all">すべて表示 ✕</button></div>';
    if(S.showCfg)h+=cfgHtml();
    const list=filtered();
    if(!list.length)h+='<div class="vl-empty">該当する車両はありません。</div>';
    list.forEach(v=>{h+=cardHtml(v);});
    return h;
  }

  function cardHtml(v){
    const c=S.calc[v.code], st=STATUS[c.st], open=S.open.has(v.code);
    const pct=c.odo!=null?Math.min(100,c.odo/c.limit*100):0;
    const shPct=c.shaken&&c.monKm&&c.odo!=null?Math.min(100,(c.odo+c.monKm*monthsTo(c.shaken))/c.limit*100):null;
    const d=S.dmg[v.code], dn=d?d.n:null;
    const kpiOff=S.kpi[v.code]===false||v.active===false;
    let h='<div class="vl-card '+st.cls+(open?" open":"")+'" data-code="'+e(v.code)+'">';
    h+='<div class="vl-hd" data-tog="1"><span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type||"?")+'</span>'
      +'<div class="vl-nm"><b>'+e(v.name||v.code)+'<em class="vl-yr'+(v.year?'':' na')+'">'+(v.year?e(wYear(v.year)||v.year)+'年式':'年式未入力')+'</em></b><small>'+e(plate4(v)||"—")+' · <span class="'+(isHdm(v)?"vl-hdm":"vl-bt")+'">'+(isHdm(v)?"HDM":"BT")+'</span>'+(kpiOff?' · <span class="vl-off">今月停止</span>':'')+'</small></div>'
      +(c.st==='sold'?'<span class="vl-st sold">終了済</span>':'<span class="kc-j '+judgeOf(c)+'">'+JUDGE[judgeOf(c)].lb+'</span>')+'</div>';
    // オーナー指示 2026-10-31：カードは決めた10項目だけ（走行・日付・お金）。入替＝売り止めの準備期間前、市場価格＝相場中央値×買取率
    const fx=S.v.find(x=>x.code===v.code), sold=n(fx&&fx.sale_price), sale=sold!=null?sold:c.nowExit, swapT=c.stopT!=null?addMon(c.stopT,-LEAD()):null, t0=T0();
    const cell=(lb,val,sub,cls)=>'<div'+(cls?' class="'+cls+'"':'')+'><span>'+lb+'</span><b>'+val+'</b>'+(sub?'<small>'+sub+'</small>':'')+'</div>';
    const dt=t=>{if(t==null)return'—';const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();}, soon=t=>t!=null&&t<=addMon(t0,2)?'r':''; const span=(a,b)=>{if(!a||b==null||b<a)return'—';const m=Math.round((b-a)/MON);return (m>=12?Math.floor(m/12)+'年':'')+(m%12?m%12+'ヶ月':'');};
    h+='<div class="kc-g" data-tog="1"><div class="kc-row m">'
      +cell('リミット',km(c.limit))+cell('現在',km(c.odo),'',pct>=90?'r':'')+cell('平均/月',km(c.monKm),c.paceOwn?'この車の実測':'平均で試算')+cell('予想/年',c.monKm!=null?km(c.monKm*12):'—')
      +'</div><div class="kc-bar"><i style="width:'+pct.toFixed(1)+'%"></i></div><div class="kc-row m">'
      +cell('次回車検',dt(c.shaken),'',soon(c.shaken))+cell('売止',dt(c.stopT),'',soon(c.stopT))+cell('入替',dt(swapT),'',soon(swapT))+cell('運用期間',span(ts(v.purchase_date),c.saleT),ts(v.purchase_date)?'':'仕入日なし')
      +'</div><div class="kc-row m">'
      +cell('仕入',man(c.buy))+cell('総売上',man(c.revDone))+cell(sold!=null?'売却額':'査定額',man(sale),sold==null&&c.mkt&&c.mkt.now&&c.mkt.now.when?dt(Date.parse(String(c.mkt.now.when).slice(0,10)+'T00:00:00Z'))+' 調査':'')
      +cell('売却後総売上',sale!=null?man(c.revDone+sale):'—','',sale!=null&&c.buy!=null&&c.revDone+sale<c.buy?'neg':'')
      +'</div></div>';
    h+='<div class="kc-more" data-tog="1">'+(dn?'<span>傷 '+dn+'</span>':'')+(c.susp?'<span class="r">走行ミス '+c.susp+'</span>':'')+'<em>'+(open?'閉じる ▴':'詳しく ▾')+'</em></div>';
    if(open)h+='<div class="vl-bd">'+detailHtml(v)+'</div>';
    return h+'</div>';
  }


  // 車検とリミットの関係（オーナー指示 2026-10-31：相関が見えない）。0→リミットの帯に「今」「次の車検時」「その次の車検時（車検を通した場合に使い切る距離）」を置く
  function shakenGauge(c){
    if(!c.shaken||c.odo==null||!c.monKm||c.st==="sold")return '';
    const t0=T0(); let sh=c.shaken; while(sh<t0)sh=addMon(sh,24);
    const kAt=t=>c.odo+c.monKm*Math.max(0,(t-t0)/MON), k1=kAt(sh), k2=kAt(addMon(sh,24));
    const over=k1>=c.limit?"before":k2>=c.limit?"swap":"pass";
    const mx=Math.max(c.limit,k2)*1.04, P=k=>(Math.min(k,mx)/mx*100).toFixed(1)+'%', yy=t=>ym(t).replace("年","/").replace("月","");
    const dec=over==="pass"?'<b class="ok">車検更新</b>':'<b class="ng">リミット先行</b>';
    const gap=over==="before"?'車検前にリミット到達':over==="swap"?'次の車検期間中にリミット（'+(c.limitT?yy(c.limitT):'')+'）':'次の車検まで余裕 '+(Math.round((c.limit-k2)/1e3)/10)+'万km';
    return '<div class="kc-sg" data-tog="1"><div class="hd">'+dec+'<span>'+gap+'</span></div>'
      +'<div class="g"><i class="a" style="width:'+P(c.odo)+'"></i><i class="b" style="left:'+P(c.odo)+';width:calc('+P(k1)+' - '+P(c.odo)+')"></i><i class="c'+(k2>=c.limit?' x':'')+'" style="left:'+P(k1)+';width:calc('+P(k2)+' - '+P(k1)+')"></i><em style="left:'+P(c.limit)+'"></em></div>'
      +'<div class="lb"><span><i class="a"></i>今 <b>'+(Math.round(c.odo/1e3)/10)+'万</b></span><span><i class="b"></i>車検 '+yy(sh)+' <b>'+(Math.round(k1/1e3)/10)+'万</b></span><span><i class="c"></i>次の車検 '+yy(addMon(sh,24))+' <b class="'+(k2>=c.limit?'ng':'')+'">'+(Math.round(k2/1e3)/10)+'万</b></span><span><em></em>リミット '+Math.round(c.limit/1e4)+'万</span></div><div class="avg">平均走行 <b>月 '+km(c.monKm)+'km</b> '+(c.paceOwn?'＝ この車のメーター増分 ÷ 月数<small>この車の実測・日々更新</small>':'＝ 平均で試算（全車のメーター増分 ÷ <b>'+S.global.nOp+'台</b> ÷ <b>'+S.global.mons.toFixed(1)+'ヶ月</b>）<small>データ3ヶ月未満のため・日々更新</small>')+'</div></div>';
  }

  // この車の働き（オーナー指示 2026-10-31：目的は「いくら稼いだか」と「売却で最後どうなるか」）
  //   働き＝売上−経費（リース・保険・税・整備）。最後＝働き＋売却額（確定前は今の相場の買取見込み）−仕入額。
  //   1本の帯：働き（黒）＋売却（灰）を積み、仕入額の位置に赤線。赤線を越えれば元が取れている
  function moneyFlow(c){
    if(c.buy==null)return '<div class="kc-mf na" data-tog="1">仕入額を入れると「稼いだ額」と「最後に残る額」が出ます</div>';
    const work=c.revDone-c.fixed-c.mCost, v=S.v.find(x=>S.calc[x.code]===c), fixed=v&&n(v.sale_price)!=null;
    const sale=fixed?n(v.sale_price):c.nowExit, fin=sale!=null?work+sale-c.buy:null;
    const mx=Math.max(c.buy,Math.max(0,work)+(sale||0))*1.05||1, P=x=>(Math.max(0,x)/mx*100).toFixed(1)+'%';
    return '<div class="kc-mf" data-tog="1"><div class="two"><div><span>稼いだ額</span><b class="'+(work<0?'neg':'')+'">'+man(work)+'</b></div>'
      +'<div><span>'+(fixed?'売却して最後':'今売ったら最後')+'</span><b class="'+(fin!=null&&fin<0?'neg':'pos')+'">'+(fin==null?'—':(fin>0?'+':'')+man(fin))+'</b></div></div>'
      +'<div class="bar"><i class="w" style="width:'+P(work)+'"></i>'+(sale!=null?'<i class="s" style="left:'+P(work)+';width:'+P(sale)+'"></i>':'')+'<em style="left:'+P(c.buy)+'"></em></div>'
      +'<div class="lg"><span><i class="w"></i>稼いだ額＝売上 '+man(c.revDone)+' − 経費 '+man(c.fixed+c.mCost)+'</span><span><i class="s"></i>'+(fixed?'売却額':'今の相場で売却')+(sale!=null?' '+man(sale)+(fixed||!c.mkt||!c.mkt.now?'':'＝中央値 '+man(c.mkt.now.med)+'×'+(c.rate!=null?Math.round(c.rate*100):n(S.cfg.buy_rate)||75)+'%'):' 未調査')+'</span><span><em></em>仕入 '+man(c.buy)+'</span></div></div>';
  }
  function lifeChart(c){
    const t0=T0(), W=300, Hh=96, L=26, R=6, T=12, B=16;
    if(c.odo==null||c.limit==null)return '<div class="kc-na">走行の記録がありません</div>';
    let tEnd=Math.max(c.saleT||0,c.shaken||0,addMon(t0,12)); tEnd=Math.min(addMon(tEnd,3),addMon(t0,60));
    const x=t=>L+(Math.min(Math.max(t,t0),tEnd)-t0)/(tEnd-t0)*(W-L-R), yMax=c.limit*1.05, y=k=>T+(1-Math.min(k,yMax)/yMax)*(Hh-T-B);
    let g='<svg viewBox="0 0 '+W+' '+Hh+'" class="kc-svg">';
    g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(c.limit)+'" y2="'+y(c.limit)+'" class="lim"/><text x="'+(L-3)+'" y="'+(y(c.limit)+3)+'" class="ax" text-anchor="end">'+Math.round(c.limit/1e4)+'万</text>';
    g+='<text x="'+(L-3)+'" y="'+(Hh-B+3)+'" class="ax" text-anchor="end">0</text><line x1="'+L+'" x2="'+(W-R)+'" y1="'+(Hh-B)+'" y2="'+(Hh-B)+'" class="base"/>';
    // 見込み線（今→リミット到達または右端）
    const tL=Math.min(c.saleT||tEnd,c.limitT||tEnd,tEnd), kL=c.limitT!=null&&tL>=c.limitT?c.limit:(c.monKm?c.odo+c.monKm*(tL-t0)/MON:c.odo);
    g+='<polygon points="'+x(t0)+','+(Hh-B)+' '+x(t0)+','+y(c.odo)+' '+x(tL)+','+y(kL)+' '+x(tL)+','+(Hh-B)+'" class="area"/><line x1="'+x(t0)+'" y1="'+y(c.odo)+'" x2="'+x(tL)+'" y2="'+y(kL)+'" class="proj"/>';
    g+='<circle cx="'+x(t0)+'" cy="'+y(c.odo)+'" r="3.5" class="now"/>';
    const vl=(t,cls,lb)=>t!=null&&t>=t0&&t<=tEnd?'<line x1="'+x(t)+'" x2="'+x(t)+'" y1="'+T+'" y2="'+(Hh-B)+'" class="'+cls+'"/><text x="'+x(t)+'" y="'+(T-3)+'" class="vt '+cls+'" text-anchor="middle">'+lb+'</text>':'';
    g+=vl(c.procT,"proc","仕入")+vl(c.stopT,"stop","売り止め");
    if(c.shaken)for(let t=c.shaken;t<=tEnd;t=addMon(t,24))if(t>=t0){const X=x(t),Y=Hh-B;g+='<rect x="'+(X-4)+'" y="'+(Y-4)+'" width="8" height="8" transform="rotate(45 '+X+' '+Y+')" class="shk'+(c.byShaken&&Math.abs(t-c.byShaken)<40*DAY?' x':'')+'"/>';}
    // 年の目盛り
    for(let yr=new Date(t0).getUTCFullYear()+1;;yr++){const t=Date.UTC(yr,0,1);if(t>tEnd)break;g+='<text x="'+x(t)+'" y="'+(Hh-3)+'" class="ax" text-anchor="middle">'+yr+'</text>';}
    g+='<text x="'+x(t0)+'" y="'+(Hh-3)+'" class="ax">今</text>';
    return g+'</svg>';
  }
  function cell(lb,val,sub,hot){return '<div class="vl-c'+(hot?" hot":"")+'"><label>'+lb+'</label><b>'+val+'</b><small>'+(sub||"&nbsp;")+'</small></div>';}

  function detailHtml(v){
    const c=S.calc[v.code], D=S.detail[v.code];
    let h='';
    // 今の走行（入力ミスで外した記録だけ出す）
    h+='<section><h4>📏 今の走行 <small>'+(c.odo!=null?km(c.odo)+'km・'+odoLb(c):'記録なし')+'</small></h4>'+odoForm(v,c);
    if(D&&D.trips){const bad=D.trips.filter(suspect);if(bad.length)h+='<div class="vl-trips">'+bad.slice(0,5).map(r=>'<div class="bad"><span>'+e(String(r.start_date).slice(5).replace("-","/"))+'〜'+e(String(r.end_date).slice(5).replace("-","/"))+'</span><b>⚠ '+km(rawKm(r))+'km <small>'+e(tripBad(r))+'・計算から除外</small></b></div>').join("")+'</div>';}
    h+='</section>';
    // 相場（範囲バー：真ん中50%・中央値・買取見込み）
    {const m=c.mkt, sp=surveySpec(v,c), ms=shakenOf(v).filter(o=>o.miss);
      const xs=[m&&m.now,m&&m.end].filter(Boolean), lo=xs.length?Math.min(...xs.map(x=>n(x.min)??x.p25)):0, hi=xs.length?Math.max(...xs.map(x=>n(x.max)??x.p75)):1;
      const P=x=>((x-lo)/((hi-lo)||1)*100).toFixed(1)+'%';
      const bar=(lb,x,exit)=>'<div class="kc-mr"><span>'+lb+'</span>'+(x?'<div class="b"><i style="left:'+P(x.p25)+';width:calc('+P(x.p75)+' - '+P(x.p25)+')"></i><em style="left:'+P(x.med)+'"></em>'+(exit!=null?'<u style="left:'+P(exit)+'"></u>':'')+'</div><b>'+man(x.med)+'</b>':'<div class="b na">未調査</div><b>—</b>')+'</div>';
      h+='<section><h4>📈 相場'+(ms.length?' <small class="r">車検証 未入力'+ms.length+'</small>':'')+'</h4>'
        +bar('今',m&&m.now,c.nowExit)+(c.ride?'':bar(c.saleT!=null?ym(c.saleT).replace("年","/").replace("月",""):'終了時',m&&m.end,c.endExit))
        +(xs.length?'<div class="kc-ml"><span><i></i>真ん中50%</span><span><em></em>中央値</span><span><u></u>買取見込み</span></div>':'')
        +(c.vsNow!=null&&c.vsLater!=null?'<div class="kc-vs'+(c.sellNow?' now':'')+'"><div><span>今売る</span><b>'+man(c.vsNow)+'</b></div><div><span>走らせる</span><b>'+man(c.vsLater)+'</b></div></div>':'')
        +(sp.urlNow?'<a class="kc-link" target="_blank" rel="noopener" href="'+e(sp.urlNow)+'">カーセンサー ↗</a>':'')+'</section>';}
    // 傷・写真
    h+='<section><h4>🩹 傷・写真</h4>';
    if(D===undefined||D==="loading")h+='<div class="vl-empty sm">読み込み中…</div>';
    else if(D.err)h+='<div class="vl-empty sm err">'+e(D.err)+'</div>';
    else if(D.ro)h+='<div class="vl-empty sm">傷 '+((S.dmg[v.code]&&S.dmg[v.code].n)||0)+'件</div>';
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
    h+='<div class="vl-exit">'+[["sell","💴 売却"],["ride","♻ 乗り潰し"],["return","🔙 リース返却"]].map(([k,l])=>'<button data-exit="'+k+'" class="'+((v.exit_type||"sell")===k?"on":"")+'"'+(S.lifeCols?'':' disabled')+'>'+l+'</button>').join("")+'</div>';
    h+='<div class="vl-form">'
      +fld(v,"purchase_price","仕入額","円","number")+fld(v,"purchase_date","仕入日","","date")
      +fld(v,"life_limit_km","この車のリミット","km","number",km(S.calc[v.code].limit)+"（既定）")
      +fld(v,"sale_plan_date","売却予定日（手動）","","date")
      +(()=>{const c=S.calc[v.code], m=c.mkt&&c.mkt.now;return '<div class="vl-f"><span>査定額（自動査定）</span><span class="in ro"><b>'+(c.nowExit!=null?man(c.nowExit):'—')+'</b><small>'+(m&&m.when?'相場 '+String(m.when).slice(0,10)+' 調査 × 買取率':'相場未調査')+'</small></span></div>';})()
      +fld(v,"sale_price",v.exit_type==="ride"?"廃車・下取り額（確定）":"売却額（確定）","円","number")
      +'</div><div class="vl-savebar"><button type="button" class="vl-mini go" data-fsave'+(S.lifeCols?'':' disabled')+'>保存</button>'
      +(S.saved&&S.saved[v.code]?'<span class="ok">✅ 保存しました '+new Date(S.saved[v.code]).toTimeString().slice(0,5)+'</span>':'<span>入力すると自動で保存されます</span>')+'</div></section>';
    return h;
  }
  // 保存ボタン（オーナー指示 2026-10-31）：フォームの変更をまとめて保存し「保存しました」を出す
  async function saveForm(code,box){
    const v=S.v.find(x=>x.code===code); if(!v)return; const patch={};
    box.querySelectorAll("[data-f]").forEach(inp=>{const key=inp.dataset.f,t=inp.dataset.t;let val=inp.value.trim();
      if(t==="number"){val=val.replace(/[^\d]/g,"");val=val===""?null:Number(val);}else if(val==="")val=null;
      if(!(v[key]===val||(v[key]==null&&val==null)))patch[key]=val;});
    if(Object.keys(patch).length){const {error}=await updV(code,patch);
      if(error){setStatus("保存できませんでした："+error.message);return;}
      Object.assign(v,patch); compute();}
    (S.saved=S.saved||{})[code]=Date.now(); setStatus("✅ 保存しました"); render();
  }
  const kp=(k,v,s)=>'<div class="vl-kp"><span>'+k+'</span><b>'+v+'</b>'+(s?'<small>'+s+'</small>':'')+'</div>';
  const kv=(k,v,s)=>'<div><span>'+k+'</span><b>'+v+'</b>'+(s?'<small>'+s+'</small>':'')+'</div>';
  const pl=(k,v,cls,s)=>'<div class="vl-pl-r"><span>'+k+(s?'<small>'+s+'</small>':'')+'</span><b class="'+cls+'">'+v+'</b></div>';
  function fld(v,key,lb,unit,type,ph){
    const val=v[key]==null?"":String(v[key]);
    return '<label class="vl-f"><span>'+lb+'</span><span class="in"><input type="'+(type==="number"?"text":type)+'"'+(type==="number"?' inputmode="numeric"':'')+' data-f="'+key+'" data-t="'+type+'" value="'+e(type==="number"&&val?Number(val).toLocaleString():val)+'" placeholder="'+e(ph||"")+'"'+(S.lifeCols?'':' disabled')+'>'+(unit?'<i>'+unit+'</i>':'')+'</span></label>';
  }

  async function loadDetail(code){
    if(VIEW_KEY){S.detail[code]={damages:[],photos:[],ro:true,trips:(S.res[code]||[]).filter(r=>r.driven_km!=null||r.end_odo!=null).sort((a,b)=>String(b.start_date).localeCompare(String(a.start_date)))};rerenderCard(code);return;}
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

  function cfgHtml(asSec){
    const c=S.cfg, cls=M_ORDER.filter(k=>k!=="送迎"&&S.v.some(v=>v.type===k));
    return '<div class="vl-cfg"><h4>⚙ 売却・入替のルール（全員共通）</h4>'
      +(S.cfgSaved?'':'<div class="vl-warn">設定を保存するにはデータベースの追加（sql/bt_vehicle_lifecycle.sql）が必要です。今は既定値で計算しています。</div>')
      +'<label class="vl-f"><span>走行リミット（既定）</span><span class="in"><input inputmode="numeric" data-cfg="default_limit_km" value="'+km(c.default_limit_km)+'"><i>km</i></span></label>'
      +'<label class="vl-f"><span>すでに既定を超えていた車のリミット</span><span class="in"><input inputmode="numeric" data-cfg="over_limit_km" value="'+km(c.over_limit_km)+'"><i>km</i></span></label>'
      +'<div class="vl-sub">クラス別のリミット（空欄＝既定）</div><div class="vl-cls">'+cls.map(k=>'<label><span class="m-badge" style="background:'+clsCol(k)+'">'+k+'</span><input inputmode="numeric" data-cls="'+k+'" value="'+(c.class_limits&&c.class_limits[k]?km(c.class_limits[k]):'')+'" placeholder="'+km(c.default_limit_km)+'"></label>').join("")+'</div>'
      +'<label class="vl-f"><span>買取見込み＝小売相場の何％か</span><span class="in"><input inputmode="numeric" data-cfg="buy_rate" value="'+(c.buy_rate||DEF.buy_rate)+'"><i>%</i></span></label>'
      +'<label class="vl-f"><span>入替車両準備期間</span><span class="in"><select data-cfg="lead_months">'+[1,2,3,4,5,6].map(m=>'<option value="'+m+'"'+(+c.lead_months===m?" selected":"")+'>売止の'+m+'ヶ月前</option>').join("")+'</select></span></label>'
      +'<label class="vl-f"><span>車検の扱い</span><span class="in"><select data-cfg="shaken_rule">'+[["next","次の車検期間中にリミットに達するなら、車検前に売る"],["always","車検の前に必ず売る"],["ignore","車検は見ない（走行だけ）"]].map(([k,l])=>'<option value="'+k+'"'+(c.shaken_rule===k?" selected":"")+'>'+l+'</option>').join("")+'</select></span></label>'
      +'<div class="vl-cfg-ft">'+(asSec?'':'<button class="btn" data-cfgclose="1">閉じる</button>')+'<button class="btn p" data-cfgsave="1"'+(S.cfgSaved?'':' disabled')+'>保存</button></div></div>';
  }

  // ---------- 入替タブ ----------
  // 入替車両の準備：後継車（入替車両（仕入）で登録した車）を仕入候補とナンバー下4桁で照合し 整備→引取→準備→ETC→稼働開始
  function prepOf(nv){if(!nv)return null;const p4=plate4(nv), pr=p4?S.proc.find(r=>{const m=String(r.plate||"").match(/(\d{1,4})\s*$/);return m&&m[1]===p4;}):null, ok=x=>x==="OK";
    return [["整備",pr?ok(pr.maint_status):null],["引取",pr?ok(pr.pickup_status):null],["準備",pr?ok(pr.prep_status):null],["ETC",nv.code in S.etc?!!S.etc[nv.code]:null],["稼働",nv.service_from?ts(nv.service_from)<=T0():null]];}
  // ---------- 売止ブロック（オーナー指示 2026-10-31：入替で販売しない期間を作らない）----------
  // 入替車両の準備期間（既定3ヶ月）で後継車を用意し、販売開始日＝売止日で同じ行にバトンタッチ＝在庫は減らさない。
  // 売止日になっても後継車が未登録の車だけ、配車表に「売止」ブロック（bt_maintenance label=売止, id=stop_<code>）を
  //   今日〜無期限で自動登録 → 在庫調整に全媒体「要」。後で後継車を登録すると、ブロックは切替日の前日で終わる。
  const FAR="2099-12-31", stopId=code=>"stop_"+code;
  async function syncStop(){
    S.stop={};
    const t0=T0(), want=S.v.filter(v=>{const c=S.calc[v.code];return c&&c.st!=="sold"&&c.stopT!=null&&c.stopT<=t0&&!v.relay_to&&!isSucc(v.code);})
      .map(v=>{const st=dstr(Math.max(S.calc[v.code].stopT,t0)), en=v.relay_to&&v.service_to?v.service_to:FAR;return {code:v.code,start:st,end:en};})
      .filter(w=>w.start<=w.end);
    let rows;
    if(VIEW_KEY){const {data,error}=await sb.rpc("bt_vehicle_stop_sync",{p_key:VIEW_KEY,p_rows:want});if(error)throw error;rows=data||[];}
    else{
      const {data,error}=await sb.from("bt_maintenance").select("id,vehicle_code,start_date,end_date").eq("label","売止");if(error)throw error;
      rows=data||[]; const have=new Set(rows.map(r=>r.vehicle_code));
      for(const w of want.filter(w=>!have.has(w.code))){
        const row={id:stopId(w.code),vehicle_code:w.code,start_date:w.start,end_date:w.end,label:"売止",cost:0,actual_cost:0,workshop:"",invoice_no:"",maint_notes:"売止日までに後継車が未登録のため自動登録（車両ダッシュボード）",status:"approved"};
        const {error:e1}=await sb.from("bt_maintenance").upsert(row,{onConflict:"id",ignoreDuplicates:true});
        if(e1){console.warn("[VL] 売止ブロック登録",e1.message);continue;}
        rows.push(row); intakeLog("intake_created",w.code,w.start,w.end);
      }
    }
    rows.forEach(r=>{S.stop[r.vehicle_code]=r;});
  }
  function intakeLog(type,code,from,to){try{sb.from("bt_intake_actions").insert({action_type:type,vehicle_code:code,user_email:(window.__BT_USER_EMAIL||""),target_date_from:from,target_date_to:to,notified_slack:false,payload:{action:type,id:stopId(code),label:"売止"}}).then(()=>{},()=>{});}catch(e){}}
  // ブロックの終わりを変える（入替の登録・解除）。在庫調整のチェックは付け直し（媒体の在庫を合わせ直すため）
  async function setStopEnd(code,end){
    const b=S.stop&&S.stop[code]; if(!b)return null;
    let r;
    if(end<b.start_date){r=await sb.from("bt_maintenance").delete().eq("id",b.id);if(!r.error)intakeLog("intake_cancelled",code,b.start_date,b.end_date);}
    else{r=await sb.from("bt_maintenance").update({end_date:end}).eq("id",b.id);if(!r.error)intakeLog("intake_edited",code,b.start_date,end);}
    if(!r.error){try{await sb.from("bt_inventory_status").delete().eq("id",b.id);}catch(e){}}
    return r.error;
  }
  // 売止日より後に入っている予約（ブロックと重なる）
  function afterStop(code){const b=S.stop&&S.stop[code];if(!b)return[];const a=ts(b.start_date),z=ts(b.end_date);return (S.res[code]||[]).filter(r=>ts(r.end_date)>=a&&ts(r.start_date)<=z);}

  // ---------- 入替リレー ----------
  const dstr=t=>new Date(t).toISOString().slice(0,10);
  function relayOf(code){const v=S.v.find(x=>x.code===code);return v&&v.relay_to?S.v.find(x=>x.code===v.relay_to)||{code:v.relay_to,name:v.relay_to}:null;}
  function isSucc(code){return S.v.some(x=>x.relay_to===code);}
  // 切替日 d をまたぐ予約（d より前に出て d 以降に返る）＝そのままでは切り替えられない
  function spanning(code,d){const t=ts(d);return (S.res[code]||[]).filter(r=>ts(r.start_date)<t&&ts(r.end_date)>=t);}
  // 入替車両（オーナー指示 2026-10-31）：売り止め・入替と入替車両（仕入）を1つに。入替準備期間に入った車を売止の月別・早い順に。後継車の登録と準備状況もここで
  const inPrep=v=>{const c=S.calc[v.code];return c.st!=="sold"&&!isSucc(v.code)&&c.stopT!=null&&addMon(c.stopT,-LEAD())<=T0()&&n(v.sale_price)==null;};
  function relayHtml(){
    const t0=T0(), ymd2=t=>{const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
    const due=S.v.filter(inPrep).sort((a,b)=>S.calc[a.code].stopT-S.calc[b.code].stopT);
    let h='<div class="vl-rl2">';
    if(!S.relayCols)h+='<div class="vl-warn">リレー用の列がまだDBにありません（sql/bt_vehicle_lifecycle.sql を適用すると使えます）。</div>';
    if(!due.length)h+='<div class="vl-note">入替準備期間（売止の'+LEAD()+'ヶ月前〜）に入った車はありません。</div>';
    let ym="";
    due.forEach(v=>{const c=S.calc[v.code], nx=relayOf(v.code), d=new Date(c.stopT), k=d.getUTCFullYear()+'年'+(d.getUTCMonth()+1)+'月';
      if(k!==ym){ym=k;h+='<div class="gh">'+k+' 売止<b>'+due.filter(x=>{const y=new Date(S.calc[x.code].stopT);return y.getUTCFullYear()+'年'+(y.getUTCMonth()+1)+'月'===k;}).length+'</b></div>';}
      const late=c.stopT<=t0;
      h+='<div class="rw'+(nx?' dn':' nd')+'" data-code="'+e(v.code)+'"><div class="nmc">'+nm(v)+'</div>'
        +'<div class="nums"><span><i>現在</i>'+(c.odo!=null?km(c.odo):'—')+'</span><span><i>売止</i><b class="'+(late?'r':'')+'">'+ymd2(c.stopT)+'</b></span><span><i>売却</i>'+(c.saleT!=null?ymd2(c.saleT):'—')+'</span></div><div class="succ">';
      if(nx){const sw=v.service_to?dstr(ts(v.service_to)+DAY):null, sp=sw?spanning(v.code,sw):[], st=prepOf(nx)||[];
        h+='<span class="ar">→</span><span class="nm">'+e(nx.name||nx.code)+' <small>'+e(plate4(nx))+'</small></span><span class="dt">切替 '+(sw?ymd(ts(sw)):'—')+'</span>'
          +st.map(([l,x])=>'<em class="'+(x?'y':'')+'">'+(x?'✓':'')+l+'</em>').join('')+(sp.length?'<span class="vl-warn">切替日をまたぐ予約 '+sp.length+'件</span>':'')
          +'<button class="vl-mini" data-unrelay="'+e(v.code)+'">解除</button>';}
      else{const cands=S.v.filter(x=>x.code!==v.code&&x.type===v.type&&String(x.brand||"")===String(v.brand||"")&&!x.relay_to&&!isSucc(x.code)&&S.calc[x.code].st!=="sold")
          .sort((a,b)=>(S.calc[a.code].rents-S.calc[b.code].rents)||String(b.created_at||"").localeCompare(String(a.created_at||"")));
        const def=dstr(Math.max(c.stopT,t0+DAY));
        h+='<span class="ar">→</span><select class="vl-rsel"'+(S.relayCols?'':' disabled')+'><option value="">後継車を選ぶ…</option>'+cands.map(x=>'<option value="'+e(x.code)+'">'+e(x.name)+' '+e(plate4(x))+(S.calc[x.code].rents?'（予約'+S.calc[x.code].rents+'件）':'（新規）')+'</option>').join("")+'</select>'
          +'<label class="dt">切替日 <input type="date" class="vl-rdate" value="'+def+'"'+(S.relayCols?'':' disabled')+'></label>'
          +'<button class="vl-mini go" data-relay="'+e(v.code)+'"'+(S.relayCols?'':' disabled')+'>登録</button>';}
      const b=S.stop&&S.stop[v.code], na=b?afterStop(v.code).length:0;
      if(b)h+='<span class="blk">⛔ 配車表ブロック '+mdS(ts(b.start_date))+'〜'+(b.end_date>=FAR?'無期限':mdS(ts(b.end_date)))+(na?' ・<b>売止後の予約 '+na+'件</b>':'')+'</span>';
      h+='</div></div>';});
    return h+'</div><div class="vl-note sm">後継車は先に車両マスターに登録。切替日から配車表の同じ行に入り、以降の予約も移ります。</div>';
  }
  async function doRelay(code,row){
    if(VIEW_KEY)return;
    const old=S.v.find(x=>x.code===code), to=row.querySelector(".vl-rsel").value, d=row.querySelector(".vl-rdate").value;
    const nv=S.v.find(x=>x.code===to);
    if(!old||!nv){alert("後継車を選んでください。新しい車は先に車両マスターに登録してください。");return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||ts(d)<=T0()){alert("切替日は明日以降の日付にしてください。");return;}
    const cc=S.calc[code], lastD=cc&&cc.stopT!=null?dstr(Math.max(cc.stopT,T0()+DAY)):null;
    if(lastD&&d>lastD){alert("後継車の販売開始日は売止日（"+lastD+"）までにしてください（販売しない期間を作らないため）。");return;}
    const sp=spanning(code,d);
    if(sp.length){const last=sp.reduce((m,r)=>ts(r.end_date)>m?ts(r.end_date):m,0);
      alert("切替日 "+d+" をまたぐ予約が "+sp.length+" 件あります（"+sp.map(r=>r.start_date+"〜"+r.end_date).join("、")+"）。\n切替日を "+dstr(last+DAY)+" 以降にしてください。");return;}
    const t=ts(d), moving=(S.res[code]||[]).filter(r=>ts(r.start_date)>=t);
    const busy=(S.res[to]||[]).filter(r=>ts(r.end_date)>=t);
    const clash=moving.filter(r=>busy.some(b=>ts(b.start_date)<=ts(r.end_date)&&ts(b.end_date)>=ts(r.start_date)));
    if(clash.length){alert("後継車には切替日以降に重なる予約があり、移せない予約が "+clash.length+" 件あります。配車表で調整してから登録してください。");return;}
    if(!confirm(old.name+" "+plate4(old)+" → "+nv.name+" "+plate4(nv)+"\n切替日 "+d+"\n\n・"+plate4(old)+" は "+dstr(t-DAY)+" まで\n・"+plate4(nv)+" は "+d+" から配車表の同じ行に入ります\n・切替日以降の予約 "+moving.length+" 件を "+plate4(nv)+" へ移します\n\n登録しますか？"))return;
    const now=new Date().toISOString();
    let r1=await sb.from("bt_vehicles").update({service_from:d,updated_at:now}).eq("code",to);
    if(!r1.error)r1=await sb.from("bt_vehicles").update({service_to:dstr(t-DAY),relay_to:to,updated_at:now}).eq("code",code);
    if(r1.error){setStatus("登録できませんでした："+r1.error.message);return;}
    let moved=0, err=null;
    for(const r of moving){const {error}=await sb.from("bt_fleet").upsert({reservation_id:r.id,vehicle_code:to},{onConflict:"reservation_id"});if(error){err=error;break;}moved++;}
    // OPシート（日付ごとのタスク）に入っている車両も差し替える
    if(!err&&moving.length){const {error}=await sb.from("bt_tasks").update({assigned_vehicle:to,"No":nv.plate_no||"",updated_at:now}).in("予約番号",moving.map(r=>r.id)).eq("assigned_vehicle",code);if(error)err=error;}
    const se=await setStopEnd(code,dstr(t-DAY));
    setStatus(err?"⚠ 一部の予約を移せませんでした（"+moved+"/"+moving.length+"件）："+err.message:se?"⚠ 売止ブロックを直せませんでした："+se.message:"✅ 入替車両を登録しました（予約 "+moved+" 件を移動"+(S.stop[code]?"・売止ブロックは "+dstr(t-DAY)+" まで":"")+"）");
    S.loaded=false; await load(true); render();
  }
  async function undoRelay(code){
    if(VIEW_KEY)return;
    const old=S.v.find(x=>x.code===code), nx=relayOf(code); if(!old||!nx)return;
    const t=old.service_to?ts(old.service_to)+DAY:null, back=t?(S.res[nx.code]||[]).filter(r=>ts(r.start_date)>=t):[];
    if(!confirm(old.name+" "+plate4(old)+" → "+(nx.name||nx.code)+" の入替車両の登録を解除しますか？\n\n予約は "+(nx.name||nx.code)+" に入ったまま残ります（"+back.length+"件）。必要なら配車表で戻してください。"))return;
    const now=new Date().toISOString();
    let r1=await sb.from("bt_vehicles").update({service_to:null,relay_to:null,updated_at:now}).eq("code",code);
    if(!r1.error)r1=await sb.from("bt_vehicles").update({service_from:null,updated_at:now}).eq("code",nx.code);
    if(!r1.error)await setStopEnd(code,FAR);
    setStatus(r1.error?"解除できませんでした："+r1.error.message:"✅ 入替車両の登録を解除しました");
    S.loaded=false; await load(true); render();
  }

  // ---------- 操作 ----------
  // 閲覧リンクでも車両の項目は編集できる（オーナー指示 2026-10-31）。キー付きの関数経由（sql/bt_vehicle_view_edit.sql）
  const updV=(code,patch)=>VIEW_KEY?sb.rpc("bt_vehicle_view_update",{p_key:VIEW_KEY,p_code:code,p_patch:patch}):sb.from("bt_vehicles").update(Object.assign({},patch,{updated_at:new Date().toISOString()})).eq("code",code);
  async function saveVal(code,key,val){
    const v=S.v.find(x=>x.code===code); if(!v||v[key]===val)return;
    const {error}=await updV(code,{[key]:val});
    if(error){setStatus("保存できませんでした："+error.message);return;}
    v[key]=val; compute(); setStatus("✅ 保存しました"); render();
  }
  async function saveField(code,inp){
    const key=inp.dataset.f, t=inp.dataset.t; let val=inp.value.trim();
    if(t==="number"){val=val.replace(/[^\d]/g,"");val=val===""?null:Number(val);}else if(val==="")val=null;
    const v=S.v.find(x=>x.code===code); if(!v||v[key]===val||(v[key]==null&&val==null))return;
    inp.classList.add("saving");
    const {error}=await updV(code,{[key]:val});
    inp.classList.remove("saving");
    if(error){inp.classList.add("err");setStatus("保存できませんでした："+error.message);return;}
    inp.classList.remove("err"); v[key]=val; compute(); (S.saved=S.saved||{})[code]=Date.now(); setStatus("✅ 保存しました");
    inp.blur(); render();
  }
  async function saveOdo(box){
    const code=box.dataset.code, v=S.v.find(x=>x.code===code), ki=box.querySelector('[data-odo="km"]'), di=box.querySelector('[data-odo="at"]');
    const val=Number(String(ki.value).replace(/[^\d]/g,"")), at=di.value||todayStr();
    if(!v||!val){ki.classList.add("err");ki.focus();setStatus("メーターの数字を入れてください");return;}
    if(at>todayStr()){di.classList.add("err");setStatus("未来の日付は入れられません");return;}
    const old=n(v.current_mileage);
    if(old!=null&&Math.abs(val-old)>50000&&!confirm(km(old)+"km → "+km(val)+"km に変えます。合っていますか？"))return;
    const specs=Object.assign({},spOf(v),{odo_at:at});
    box.classList.add("saving");
    const {error}=await (VIEW_KEY?updV(code,{current_mileage:val,odo_at:at}):updV(code,{current_mileage:val,specs}));
    box.classList.remove("saving");
    if(error){ki.classList.add("err");setStatus("保存できませんでした："+error.message);return;}
    if(box.closest(".vl-odobox"))S.odoOpen=true;
    v.current_mileage=val; v.specs=specs; compute(); setStatus("✅ "+(v.name||code)+"の走行を "+km(val)+"km にしました"); render();
  }
  async function saveCfg(root){
    if(VIEW_KEY)return;
    const c=Object.assign({},S.cfg,{class_limits:Object.assign({},S.cfg.class_limits)});
    const num=s=>{const x=String(s||"").replace(/[^\d]/g,"");return x?Number(x):null;};
    root.querySelectorAll("[data-cfg]").forEach(i=>{const k=i.dataset.cfg;c[k]=k==="shaken_rule"?i.value:num(i.value)||DEF[k];});
    root.querySelectorAll("[data-cls]").forEach(i=>{const x=num(i.value);if(x)c.class_limits[i.dataset.cls]=x;else delete c.class_limits[i.dataset.cls];});
    const {error}=await sb.from("bt_vehicle_life_settings").upsert({id:1,default_limit_km:c.default_limit_km,over_limit_km:c.over_limit_km,class_limits:c.class_limits,lead_months:c.lead_months,buy_rate:c.buy_rate,shaken_rule:c.shaken_rule,updated_at:new Date().toISOString()});
    if(error){setStatus("設定を保存できませんでした："+error.message);return;}
    S.cfg=c; S.showCfg=false; compute(); render(); setStatus("✅ ルールを保存しました");
  }
  function openViewer(src){
    const d=document.createElement("div"); d.className="vl-viewer"; d.innerHTML='<img src="'+e(src)+'" alt=""><button aria-label="閉じる">✕</button>';
    d.addEventListener("click",()=>d.remove()); document.body.appendChild(d);
  }
  function gotoCard(code){
    const b=document.querySelector('.tabbtn[data-v="karte"]'); S.stf="all"; S.sec="karte"; S.open.add(code); if(S.detail[code]===undefined||(S.detail[code]&&S.detail[code].err))loadDetail(code); if(b&&!b.classList.contains("on"))b.click(); else render();
    setTimeout(()=>{const el=document.querySelector('.vl-card[data-code="'+CSS.escape(code)+'"]');if(el)el.scrollIntoView({behavior:"smooth",block:"start"});},80);
  }

  function bind(){
    const kb=$("karteBody");
    const goSec=k=>{S.sec=k;saveUi();render();const m=document.querySelector(".vl-main");if(m&&m.getBoundingClientRect().top<0)m.scrollIntoView({block:"start"});};
    kb.addEventListener("click",ev=>{
      const t=ev.target;
      if(t.closest(".vl-odobox:not(.bad)>summary")){S.odoOpen=!t.closest("details").open;return;}
      const os=t.closest("[data-odosave]"); if(os){saveOdo(os.closest(".vl-odo"));return;}
      const fs=t.closest("[data-fsave]"); if(fs){saveForm(fs.closest("[data-code]").dataset.code,fs.closest("section"));return;}
      const og=t.closest("[data-ovg]"); if(og){S.ovg=og.dataset.ovg;render();return;}
      const ob=t.closest("[data-ovb]"); if(ob){const k=ob.dataset.ovb, v=k==="all"?null:isNaN(+k)?k:+k; S.ovb=(v===S.ovb)?null:v; render();return;}
      const os2=t.closest("[data-ovs]"); if(os2){S.ovs=os2.dataset.ovs;render();return;}
      const sc=t.closest("[data-sec]"); if(sc){goSec(sc.dataset.sec);return;}
      const rl=t.closest("[data-relay]"); if(rl&&!rl.disabled){doRelay(rl.dataset.relay,rl.closest(".vl-rl"));return;}
      const ur=t.closest("[data-unrelay]"); if(ur){undoRelay(ur.dataset.unrelay);return;}
      const g=t.closest("[data-goto]"); if(g&&!t.closest(".vl-card")&&!t.closest("input,select,label")){gotoCard(g.dataset.goto);return;}
      const sf=t.closest("[data-stf]"); if(sf){S.stf=S.stf===sf.dataset.stf?"all":sf.dataset.stf;S.sec="karte";saveUi();render();return;}
      const br=t.closest("[data-br]"); if(br){S.brand=br.dataset.br;saveUi();render();return;}
      if(t.closest(".vl-gear")){S.showCfg=!S.showCfg;render();return;}
      if(t.closest("[data-cfgclose]")){S.showCfg=false;render();return;}
      if(t.closest("[data-cfgsave]")){saveCfg(t.closest(".vl-cfg"));return;}
      const ex=t.closest("[data-exit]"); if(ex&&!ex.disabled){const code=ex.closest(".vl-card").dataset.code,v=S.v.find(x=>x.code===code);
        if(ex.dataset.exit==="return"&&v&&v.exit_type!=="return"&&!confirm((v.name||code)+" をリース返却済みにして、スケジュールの一覧から外します（履歴は残ります）。よろしいですか？"))return;
        saveVal(code,"exit_type",ex.dataset.exit);return;}
      const dm=t.closest("[data-dmg]"); if(dm){const img=dm.querySelector("img");if(img)openViewer(img.src);return;}
      const tg=t.closest("[data-tog]"); if(tg){const code=tg.closest(".vl-card").dataset.code;
        if(S.open.has(code))S.open.delete(code); else{S.open.add(code); if(S.detail[code]===undefined||S.detail[code].err)loadDetail(code);}
        rerenderCard(code); return;}
    });
    kb.addEventListener("change",ev=>{const t=ev.target;
      if(t.classList.contains("vl-secsel")){goSec(t.value);return;}
      if(t.classList.contains("vl-sort")){S.sort=t.value;saveUi();render();return;}
      if(t.dataset.f){saveField(t.closest("[data-code]").dataset.code,t);}
    });
    kb.addEventListener("keydown",ev=>{if(ev.key==="Enter"&&ev.target.dataset.f)ev.target.blur();if(ev.key==="Enter"&&ev.target.dataset.odo)saveOdo(ev.target.closest(".vl-odo"));});
    kb.addEventListener("focusin",ev=>{const t=ev.target;if(t.dataset.t==="number"||/_km$/.test(t.dataset.cfg||"")||t.dataset.cls)t.value=t.value.replace(/[^\d]/g,"");});
    // リアルタイム：車両・予約（配車表）・整備・設定が変わったら、開いている人全員の画面を自動で更新（入力中は待つ）
    let tm=null; const visible=()=>$("viewKarte").style.display!=="none";
    const refresh=()=>{clearTimeout(tm);tm=setTimeout(()=>{const ae=document.activeElement;
      if(ae&&ae.closest&&ae.closest("#viewKarte")&&/INPUT|SELECT/.test(ae.tagName)){refresh();return;}
      if(!S.loaded)return; load(true).then(()=>{S.updated=new Date();if(visible())render();}).catch(()=>{});},4000);};
    const ch=sb.channel("vl-rt");
    ["bt_vehicles","bt_reservations","bt_fleet","bt_vehicle_maintenance","bt_vehicle_life_settings"].forEach(t=>ch.on("postgres_changes",{event:"*",schema:"public",table:t},refresh));
    ch.subscribe();
    const rl=$("reload"); if(rl)rl.addEventListener("click",()=>{if(S.view&&$("viewKarte").style.display!=="none"){S.loaded=false;S.detail={};show(S.view);}});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind); else bind();
  return {show,load,surveySpec,wYear,MARKET_RULE,_S:S};
})();
