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
      S.lifeCols=S.v.length>0&&("life_limit_km" in S.v[0]); S.leaseCols=S.v.length>0&&("acquire_type" in S.v[0]);
      S.relayCols=S.v.length>0&&("relay_to" in S.v[0]); S.slideCols=S.v.length>0&&("next_car" in S.v[0]);
      const swAt={}; S.v.forEach(v=>{if(v.swapped_at)swAt[v.code]=ts(v.swapped_at);});   // スライド入替：この日より前の実績は旧車のもの（新車に混ぜない）
      const r2v={}; fleet.forEach(f=>{r2v[f.reservation_id]=f.vehicle_code;});
      S.res={}; res.forEach(r=>{const c=r2v[r.id]; if(!c||isCancel(r))return; if(swAt[c]!=null&&ts(r.start_date)<swAt[c])return; (S.res[c]=S.res[c]||[]).push(r);});
      markOdo();
      S.maint={}; mt.forEach(m=>{if(swAt[m.vehicle_code]!=null&&ts(m.completed_date||m.date)<swAt[m.vehicle_code])return; (S.maint[m.vehicle_code]=S.maint[m.vehicle_code]||[]).push(m);});
      S.kpi={}; ((kpi&&kpi.data)||[]).forEach(k=>{S.kpi[k.vehicle_code]=k.active;});
      S.cfgSaved=!!(cfg&&cfg.data); if(cfg&&cfg.data)S.cfg=Object.assign({},DEF,cfg.data,{class_limits:cfg.data.class_limits||{}});
      // 入替車両の準備（仕入候補の進捗・ETC）。閲覧リンクでは読まない
      S.proc=[]; S.etc={};
      if(!VIEW_KEY){const [pr,et]=await Promise.all([sb.from("bt_procurement").select("id,no,model,vclass,plate,status,maint_status,pickup_status,prep_status,op_start_date"),sb.from("bt_etc_setup").select("code,done")]);
        S.proc=(pr&&pr.data)||[];
        S.swaps=[]; if(S.slideCols){const sw=await sb.from("bt_vehicle_swaps").select("code,swapped_at,old,new,stats").order("swapped_at",{ascending:false}).limit(200);S.swaps=(sw&&!sw.error&&sw.data)||[];} ((et&&et.data)||[]).forEach(x=>{S.etc[x.code]=x.done;});}
      S.mk={}; S.mkOn=!!(mk&&!mk.error); if(S.mkOn)(mk.data||[]).forEach(m=>{if(swAt[m.vehicle_code]!=null&&ts(String(m.surveyed_at).slice(0,10))<swAt[m.vehicle_code])return; (S.mk[m.vehicle_code]=S.mk[m.vehicle_code]||[]).push(m);});
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
      // 導入方法（オーナー指示 2026-11-01 改）：仕入額は常に総額（一括仕入＝仕入総額、リース＝リース総額）。最終利益＝市場売却額＋累計売上−仕入額（総額）
      const isLease=acqOf(v)==="lease", lf=n(v.lease_monthly)||null, leasePaid=isLease&&lf!=null?Math.round(lf*Math.max(0,(t0-(ts(v.purchase_date)||ts(DATA_FROM)))/MON)):null, basis=buy;
      S.calc[v.code]={isLease,lf,leasePaid,basis,talk,paceOwn,odoSrc,mkt,rate,dayGross,daysLeft,kmEnd,nowExit,endExit,vsNow,vsLater,sellNow,overBuy,stopT,ride,odo,limit,flag,runDays,heldDays,nDone:done.length,cost,buy,recov,monKm,future,limitT,shaken,byShaken,saleT,why,procT,st,
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
  const SECS0=[["全体",[["sum","📊","サマリ"]]],["売却・入替",[["relay","🔁","入替車両"],["forecast","📅","入替予測"]]],["車両",[["karte","🚗","車両カルテ"],["shaken","📋","車検証"]]],["準備",[["proc","🛒","仕入候補"],["tire","🛞","タイヤチェック"],["etc","📡","ETCセットアップ"]]],["お金",[["kpi","💰","クラス実績"],["market","📈","相場"]]],["設定",[["def","📘","アルゴリズム"],["rule","⚙","ルール"]]]];
  const secBadge=k=>{const a=S.v.filter(v=>S.calc[v.code].st!=="sold");
    if(k==="relay")return a.filter(v=>inPrep(v)&&!v.relay_to).length;
    if(k==="forecast")return planSoon().length;
    if(k==="shaken")return a.filter(v=>shakenOf(v).some(o=>o.miss)).length;
    if(k==="market")return a.filter(v=>holdSell(v)||S.calc[v.code].overBuy).length;
    return 0;};
  // 仕入候補・タイヤ・ETC（オーナー指示 2026-11-01：上のタブから車両ダッシュボードの中へ）＝procurement.html の既存画面をここに差し込む
  const HOSTED=["proc","tire","etc"];
  function renderDash(){
    const body=$("karteBody"); if(!body)return;
    const SECS=SECS0;   // 閲覧リンクでも仕入候補・タイヤ・ETCを出す（以前の上のタブと同じ。オーナー指示 2026-11-01）
    const all=SECS.flatMap(g=>g[1]); if(!all.some(x=>x[0]===S.sec))S.sec="sum";
    const lb=x=>x[1]+' '+x[2], bd=x=>{const n=secBadge(x[0]);return n?n:0;};
    let h='<div class="vl-dash"><nav class="vl-side">'+SECS.map(([g,items])=>'<div class="g">'+e(g)+'</div>'+items.map(x=>'<button class="'+(S.sec===x[0]?"on":"")+'" data-sec="'+x[0]+'"><span>'+lb(x)+'</span>'+(bd(x)?'<i>'+bd(x)+'</i>':'')+'</button>').join("")).join("")+'</nav>';
    h+='<div class="vl-main"><label class="vl-pick"><select class="vl-secsel" aria-label="画面を選ぶ">'+SECS.map(([g,items])=>'<optgroup label="'+e(g)+'">'+items.map(x=>'<option value="'+x[0]+'"'+(S.sec===x[0]?" selected":"")+'>'+x[2]+(bd(x)?' 🔴'+bd(x):'')+'</option>').join("")+'</optgroup>').join("")+'</select></label>';
    h+='<div class="vl-sec">'+(S.v.length?secHtml():'<div class="vl-empty err">車両が0台です。配車表にログインしていない端末では表示されません。<br><a href="index.html" target="_blank" rel="noopener">配車表でログイン ↗</a> してから、この画面を開き直してください。</div>')+'</div>';
    h+=(VIEW_KEY?'':'<div class="vl-foot live">🟢 リアルタイム共有（配車表・点検の更新が自動で反映されます）'+(S.updated?'　最終更新 '+String(S.updated.getHours()).padStart(2,"0")+':'+String(S.updated.getMinutes()).padStart(2,"0"):'')+'</div>')+'</div></div>';
    if(window.VL_PARK)window.VL_PARK();   // 差し込んだ画面を書き換えで消さないよう、先に退避
    body.innerHTML=h;
    if(HOSTED.includes(S.sec)&&window.VL_HOST)window.VL_HOST(S.sec,body.querySelector(".vl-host"));
    if(S.sec==="karte")S.open.forEach(code=>{if(S.detail[code]===undefined)loadDetail(code);});
  }
  function secHtml(){
    switch(S.sec){
      case "karte":return karteHtml();
      case "relay":return relayHtml();
      case "forecast":return forecastHtml();
      case "kpi":return kpiHtml();
      case "market":return marketHtml();
      case "shaken":return shakenHtml();
      case "rule":return cfgHtml(true);
      case "def":return defHtml();
      case "proc":case "tire":case "etc":return '<div class="vl-host"></div>';
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
  // 出口の目印（オーナー指示 2026-10-31）：売却／乗り潰し。リース返却は一覧から外れるので出さない
  const exTag=v=>v.exit_type==="ride"?'<em class="vl-ex ride">乗り潰し</em>':'<em class="vl-ex">売却</em>';
  const judgeOf=c=>c.talk&&c.stopT==null?"talk":c.stopT==null?"wait":c.why==="車検"||(c.shaken!=null&&c.stopT<c.shaken)?"swap":"pass";
  function sumHtml(){
    const C=v=>S.calc[v.code], a=S.v.filter(v=>C(v).st!=="sold"), t0=T0();
    const g=S.ovg||"class", so=S.ovs||"stop";
    const mk=x=>x==null?'—':(Math.round(x/1e3)/10)+'万';
    const cntJ=k=>a.filter(v=>judgeOf(C(v))===k).length;
    // 数字4つ
    let h='<div class="ov-tiles"><div><b>'+a.length+'</b><span>台</span></div><div class="r"><b>'+cntJ("swap")+'</b><span>リミット先行</span></div></div>';
    // 試算（オーナー指示 2026-10-31）：全車・全期間の実績から
    const G=S.global||{};
    h+='<div class="ov-est">'+[["1予約平均",G.avgKm,"走行 "+(G.n||0)+"件"],["1予約日数",G.avgDays,"同 "+(G.n||0)+"件","日",1],["1日あたり",G.dayKm,"距離÷日数"],["月間/台",G.monKm,"メーター増分"+(G.nOdo||0)+"台分÷"+(G.nOp||0)+"台÷"+(G.mons||0).toFixed(1)+"ヶ月"],["年間/台",G.monKm*12,"月間×12"]].map(([lb,x,why,u,dp])=>'<div><span>'+lb+'<em>試算</em></span><b>'+(x?(dp?x.toFixed(dp):km(x)):'—')+'<small>'+(u||'km')+'</small></b><i>'+why+'</i></div>').join('')+'</div><div class="ov-estn">集計 '+(()=>{const d=new Date(ts(DATA_FROM));return (d.getUTCMonth()+1)+'/'+d.getUTCDate();})()+'〜今日（約'+(G.mons||0).toFixed(1)+'ヶ月）・予約や返却が入るたびに自動で更新され、数字は変わります</div>';
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
    h+='<div class="ov-band"><button data-ovb="all" class="'+(ob==null?'on':'')+'"><span>全て</span><b>'+a.length+'<small>台</small></b></button>'+BANDS.map(([lo,hi,lb],i)=>{const n=a.filter(v=>inB(v,i)).length;return '<button data-ovb="'+i+'" class="'+(lo>=8e4?'sell '+(n?'has ':''):'')+(String(ob)===String(i)?'on':'')+'"><span>'+lb+'</span>'+(lo>=8e4?'<em class="vsk">'+(n?'<i></i>':'')+'売却検討</em>':'')+'<b>'+n+'<small>台</small></b></button>';}).join('')
      +[["due","入替該当","r "],["talk","協議","o "],["prep","入替準備","o "],["stop","売却確定","r "]].map(([k,lb,cl])=>{const m=a.filter(v=>inB(v,k)).length;const sl=k==="prep";return '<button data-ovb="'+k+'" class="'+(sl?'sell '+(m?'has ':''):m?cl:'')+(ob===k?'on':'')+'"><span>'+lb+'</span>'+(sl?'<em class="vsk">'+(m?'<i></i>':'')+'売却検討</em>':'')+'<b>'+m+'<small>台</small></b></button>';}).join('')+(a.some(v=>C(v).odo==null)?'<button data-ovb="na" class="mut'+(ob==="na"?' on':'')+'"><span>未入力</span><b>'+a.filter(v=>C(v).odo==null).length+'<small>台</small></b></button>':'')+'</div>';
    const shown=ob==null?a:a.filter(v=>inB(v,ob));
    // 下段＝保有判定（オーナー指示 2026-11-02：サマリの下段を保有判定に入れ替え。上の距離帯・入替などのボタンで絞り込める）
    h+=holdListHtml(shown);
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
    return '<h4 class="vl-h4">💰 クラス実績</h4>'
      +'<div class="vl-ksum k3"><div><span>総売上</span><b>'+man(all.rev*all.n)+'</b></div><div><span>台平均売上</span><b>'+man(all.rev)+'</b></div><div><span>稼働率</span><b>'+pc(all.util)+'</b></div></div>'
      +'<div class="vl-crs">'+rows.filter(r=>!r.v).sort(by).map(row).join('')+'</div>'
      +'<h4 class="vl-h4">AA</h4><div class="vl-crs">'+rows.filter(r=>r.v).sort(by).map(row).join('')+'</div>';
  }
  // 車検更新回数（オーナー指示 2026-11-01 改）：推定はしない。整備記録（配車表）の車検の実績だけを数える。記録が無ければ出さない
  function shakenCount(v){
    const n=(S.maint[v.code]||[]).filter(m=>/車検/.test(m.type||"")&&(m.completed_date||m.date)).length;
    return n?{n,why:'配車表の整備記録にある車検の回数'}:null;
  }
  // 最終利益の中身ポップ（オーナー指示 2026-11-01）：導入方法（一括仕入／リース、手動か自動判定か）と計算式
  function plPop(code){
    const v=S.v.find(x=>x.code===code), c=v&&S.calc[code]; if(!c)return;
    const sp=n(v.sale_price), mv=sp!=null?sp:c.nowExit, L=c.isLease, manual=!!v.acquire_type;
    const pl=c.basis!=null&&mv!=null?mv+c.revDone-c.basis:null;
    const row=(k,val,sub,cls)=>'<div class="pr'+(cls?' '+cls:'')+'"><span>'+k+(sub?'<small>'+sub+'</small>':'')+'</span><b>'+val+'</b></div>';
    const miss=[]; if(mv==null)miss.push('市場売却額（相場が未調査）'); if(c.basis==null)miss.push(L?'リース総額（カルテで入力）':'仕入額');
    openPop('<div class="mp-hd">'+nm(v)+'</div><div class="mp-up">導入方法 <b>'+(L?'リース':'一括仕入')+'</b>　'+(manual?'カルテで設定':'自動判定（'+(L?'仕入額なし＋マスタにリース月額あり':'仕入額あり')+'）')+'</div>'
      +'<div class="mp-big'+(pl!=null&&pl>=0?' ok':pl==null?' na':'')+'"><span>最終利益</span><b>'+(pl!=null?(pl>0?'+':'')+man(pl):'—')+'</b><small>＝ 市場売却額 ＋ 累計売上 − 仕入額（総額）</small></div>'
      +'<div class="mp-h">計算の中身</div><div class="mp-calc">'
      +row('市場売却額',man(mv),sp!=null?'売却額（確定）':'自動査定')
      +row('＋ 累計売上',man(c.revDone),'8/3〜今日の予約売上')
      +row('− 仕入額',man(c.buy),L?'リース総額':'仕入総額')
      +row('＝ 最終利益',pl!=null?(pl>0?'+':'')+man(pl):'—','',pl!=null&&pl<0?'tot r':'tot')+'</div>'
      +(miss.length?'<div class="mp-n">未入力のため計算できません：'+miss.join('・')+'</div>':'')
      +'<div class="mp-n">今日売った場合の目安です。導入方法はカルテで切り替えられます。</div>');
  }
  function openPop(inner){
    const old=document.getElementById('vl-mkpop'); if(old)old.remove();
    const d=document.createElement('div'); d.id='vl-mkpop';
    d.innerHTML='<div class="mp-bg"></div><div class="mp-box" role="dialog"><button class="mp-x" aria-label="閉じる">×</button>'+inner+'</div>';
    document.body.appendChild(d);
    const close=()=>{d.remove();document.removeEventListener('keydown',esc);}, esc=ev=>{if(ev.key==='Escape')close();};
    d.querySelector('.mp-bg').onclick=close; d.querySelector('.mp-x').onclick=close; document.addEventListener('keydown',esc);
  }
  // 市場売却額の根拠ポップ（オーナー指示 2026-11-01）：台数・中央値・中間50%・市場売却額と試算根拠
  function mkPop(code){
    const v=S.v.find(x=>x.code===code), c=v&&S.calc[code], m=c&&c.mkt&&c.mkt.now; if(!m)return;
    const rate=c.rate!=null?c.rate:(n(S.cfg.buy_rate)||DEF.buy_rate)/100, cd=m.cond||{}, km=x=>x==null?'':(Math.round(x/1000)/10)+'万km';
    const when=m.when?String(m.when).slice(0,10).replace(/-/g,'/'):'—';
    const u=(m.urls||[]).find(x=>x.u);
    // 保存された検索URLから条件をそのまま読む（推測で書かない）
    let Q={}; try{Q=Object.fromEntries(new URL(u?u.u:'https://x/').searchParams);}catch(_){}
    const FU={1:'ガソリン',2:'ディーゼル',3:'ハイブリッド',4:'電気'}, KU={'4WD0':'2WD','4WD1':'4WD'};
    const yQ=Q.YMIN||cd.year_from, yQ2=Q.YMAX||cd.year_to, sQ=Q.SMIN!=null?+Q.SMIN:cd.km_from, sQ2=Q.SMAX!=null?+Q.SMAX:cd.km_to;
    const qc=[['車種',(v.name||'')+((u&&String(u.u).match(/usedcar\/([^/]+\/[^/?]+)/))?'（カーセンサー '+String(u.u).match(/usedcar\/([^/]+\/[^/?]+)/)[1]+'）':'')],
      ['年式',yQ?(yQ===yQ2?yQ+'年':yQ+'〜'+yQ2+'年'):'—'],['走行',sQ!=null||sQ2!=null?km(sQ)+'〜'+km(sQ2):'—'],
      ['修復歴',Q.OPTCD==='REP0'?'なし':'指定なし'],['排気量',Q.HMIN?(Q.HMIN===Q.HMAX?Q.HMIN+'cc':Q.HMIN+'〜'+Q.HMAX+'cc'):'指定なし'],
      ['動力',Q.FUEL?(FU[Q.FUEL]||Q.FUEL):'指定なし'],['駆動',Q.KUDO?(KU[Q.KUDO]||Q.KUDO):'指定なし'],['定員',Q.TEIIN?Q.TEIIN+'人':'指定なし'],['並び',Q.SORT==='2'?'本体価格の安い順':'—']];
    const old=document.getElementById('vl-mkpop'); if(old)old.remove();
    const d=document.createElement('div'); d.id='vl-mkpop';
    d.innerHTML='<div class="mp-bg"></div><div class="mp-box" role="dialog"><button class="mp-x" aria-label="閉じる">×</button>'
      +'<div class="mp-hd">'+nm(v)+'</div><div class="mp-up">更新日 <b>'+when+'</b></div>'
      +'<div class="mp-big"><span>市場売却額</span><b>'+man(c.nowExit)+'</b><small>＝ 中央値 '+man(m.med)+' × '+Math.round(rate*100)+'%</small></div>'
      +'<div class="mp-g"><div><span>台数</span><b>'+(m.n||0)+'<small>台</small></b></div><div><span>中央値</span><b>'+man(m.med)+'</b></div><div><span>中間50%</span><b>'+man(m.p25)+'〜'+man(m.p75)+'</b></div></div>'
      +'<div class="mp-h">検索条件（この調査で実際に使った条件）</div><dl class="mp-dl">'+qc.map(([k,x])=>'<dt>'+k+'</dt><dd>'+e(x)+'</dd>').join('')+'</dl>'
      +'<div class="mp-h">試算根拠</div><dl class="mp-dl"><dt>価格</dt><dd>本体価格（掲載価格・目安）</dd><dt>売却額</dt><dd>中央値 '+man(m.med)+' × 買取率 '+Math.round(rate*100)+'%</dd><dt>更新日</dt><dd>'+when+'</dd>'+(cd.note?'<dt>確認</dt><dd>'+e(cd.note)+'</dd>':'')+'</dl>'
      +(u?'<a class="mp-a" href="'+e(u.u)+'" target="_blank" rel="noopener">カーセンサーで同じ条件を開く ↗</a>':'')
      +'<div class="mp-n">目安です。実際の買取額は査定で変わります。</div></div>';
    document.body.appendChild(d);
    const close=()=>{d.remove();document.removeEventListener('keydown',esc);}, esc=ev=>{if(ev.key==='Escape')close();};
    d.querySelector('.mp-bg').onclick=close; d.querySelector('.mp-x').onclick=close; document.addEventListener('keydown',esc);
  }
  function marketHtml(){
    const a=S.v.filter(v=>S.calc[v.code].st!=="sold").sort((x,y)=>(holdSell(y)?1:0)-(holdSell(x)?1:0)||(S.calc[x.code].stopT??9e15)-(S.calc[y.code].stopT??9e15));
    return '<h4 class="vl-h4">📈 相場 <small>今の走行で売った場合の小売相場</small></h4><details class="vl-rule"><summary>この基準で検索しています（あくまで目安）</summary><dl>'+MARKET_RULE.map(([k,t])=>'<dt>'+e(k)+'</dt><dd>'+e(t)+'</dd>').join("")+'</dl></details>'
      +tbl(["車両","相場（真ん中50%）","中央値","買取見込み","判定"],a.map(v=>{const c=S.calc[v.code],x=c.mkt&&c.mkt.now;
        return '<tr data-goto="'+e(v.code)+'"><td>'+nm(v)+'</td><td>'+(x?man(x.p25)+'〜'+man(x.p75):'<span class="mut">未調査</span>')+'</td><td>'+(x?man(x.med):'—')+'</td><td>'+(c.nowExit!=null?man(c.nowExit):'—')+'</td><td>'+(holdSell(v)?'<b class="org">💡今が売り時（保有判定）</b>':c.overBuy?'<b class="org">仕入額超え</b>':'')+'</td></tr>';}));
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
    const nFlag=base.filter(v=>S.calc[v.code].flag).length, nNow=base.filter(v=>holdSell(v)||S.calc[v.code].overBuy).length;
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
      +'<div class="vl-nm"><b>'+e(v.name||v.code)+'<em class="vl-yr'+(v.year?'':' na')+'">'+(v.year?e(wYear(v.year)||v.year)+'年式':'年式未入力')+'</em>'+(v.exit_type==="return"?'':exTag(v))+'</b><small>'+e(plate4(v)||"—")+' · <span class="'+(isHdm(v)?"vl-hdm":"vl-bt")+'">'+(isHdm(v)?"HDM":"BT")+'</span>'+(kpiOff?' · <span class="vl-off">今月停止</span>':'')+'</small></div>'
      +(c.st==='sold'?'<span class="vl-st sold">終了済</span>':holdBadge(holdOf(v)))+'</div>';
    // オーナー指示 2026-10-31：カードは決めた10項目だけ（走行・日付・お金）。入替＝売り止めの準備期間前、市場価格＝相場中央値×買取率
    const fx=S.v.find(x=>x.code===v.code), sold=n(fx&&fx.sale_price), sale=sold!=null?sold:c.nowExit, swapT=c.stopT!=null?addMon(c.stopT,-LEAD()):null, t0=T0();
    const cell=(lb,val,sub,cls)=>'<div'+(cls?' class="'+cls+'"':'')+'><span>'+lb+'</span><b>'+val+'</b>'+(sub?'<small>'+sub+'</small>':'')+'</div>';
    const dt=t=>{if(t==null)return'—';const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();}, soon=t=>t!=null&&t<=addMon(t0,2)?'r':''; const span=(a,b)=>{if(!a||b==null||b<a)return'—';const m=Math.round((b-a)/MON);return (m>=12?Math.floor(m/12)+'年':'')+(m%12?m%12+'ヶ月':'');};
    h+='<div class="kc-g" data-tog="1"><div class="kc-row m">'
      +cell('リミット',km(c.limit))+cell('現在',km(c.odo),'',pct>=90?'r':'')+cell('平均/月',km(c.monKm),c.paceOwn?'この車の実測':'平均で試算')+cell('予想/年',c.monKm!=null?km(c.monKm*12):'—')
      +'</div><div class="kc-bar"><i style="width:'+pct.toFixed(1)+'%"></i></div><div class="kc-row m">'
      +cell('次回車検',dt(c.shaken),'',soon(c.shaken))+cell('売止',dt(c.stopT),'',soon(c.stopT))+cell('入替',dt(swapT),'',soon(swapT))+cell('運用期間',span(ts(v.purchase_date),c.saleT),ts(v.purchase_date)?'':'仕入日なし')
      +'</div><div class="kc-row m">'
      +(()=>{const x=holdOf(v), ok=x&&!x.na, bb=ok?x.best:null, fN=ok?holdFin(v,x.all[0]):null, fB=ok?holdFin(v,bb):null;
        return cell(c.isLease?'リース総額':'仕入額',man(c.buy),c.isLease?'リース':'一括仕入')+cell(ok&&x.mode==='ride'?'乗り潰し':'手放す',!ok?'—':bb.k===0?'今':dt(addMon(t0,bb.k)).replace(/\/\d+$/,''),ok&&bb.k>0?bb.k+'か月後':'',ok&&bb.k===0?'r':'')
          +cell('今売ると',fN==null?'—':hpm(fN),'',fN!=null&&fN<0?'neg':'')+cell('手放す時なら',fB==null?'—':hpm(fB),ok?'今売るより'+hpm(bb.up):'',fB!=null&&fB<0?'neg':'');})()
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
    {const x=holdOf(v); if(x)h+='<section class="hd-sec"><h4>⚖ 保有判定 '+holdBadge(x)+'</h4>'+(x.na?'':'<div class="hd-story">'+e(holdStory(v,x))+'</div>')+'<div class="hd-why">'+e(holdWhy(x))+'</div>'+(x.na?'':holdFlow(v,x)+holdChart(v,x)+'<div class="vl-note">売上：'+(x.src==='own'?'この車の実績（'+ymd(x.opFrom)+'〜'+x.opDays+'日）を年換算 '+man(x.S1)+'/年':(x.src==='class'?'同じクラス':'全車')+'の平均（稼働30日以上の'+x.srcN+'台）'+man(x.S1)+'/年')+'・単価低下'+HOLD.drop+'%/年。経費：年'+man(HOLD.insMon*12+HOLD.shaken+HOLD.tenken*HOLD.tenkenN)+'（保険・車検・点検）。売却額：今'+man(x.V0)+'から、距離は1万kmごと'+x.sl.pct.toFixed(1)+'%下落（'+slopeLb(x.sl)+'）、年数は年'+HOLD.age+'%下落（仮置き）。</div>')+'</section>';}
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
    h+='<div class="vl-exit">'+[["sell","売却"],["ride","乗り潰し"],["return","🔙 リース返却"]].map(([k,l])=>'<button data-exit="'+k+'" class="'+((v.exit_type||"sell")===k?"on":"")+'"'+(S.lifeCols?'':' disabled')+'>'+l+'</button>').join("")+'</div>';
    h+='<div class="vl-form">'
      +acqHtml(v)+fld(v,"purchase_date",acqOf(v)==="lease"?"導入日":"仕入日","","date")
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
  // 導入方法：［一括仕入｜リース］。リース額は車両マスタ（配車表）の「リース月額」をそのまま使う（オーナー指示 2026-11-01：マスタ連携）
  // 未選択の車は、仕入額が空でマスタにリース月額がある＝リース、それ以外＝一括仕入 とみなす
  function acqOf(v){return v.acquire_type||((n(v.purchase_price)==null&&n(v.lease_monthly)>0)?"lease":"buy");}
  function acqHtml(v){
    const L=acqOf(v)==="lease", dis=S.leaseCols?'':' disabled';
    let h='<div class="vl-f vl-acq"><span>導入方法</span><span class="seg">'+[["buy","一括仕入"],["lease","リース"]].map(([k,l])=>'<button data-acq="'+k+'" class="'+((L?"lease":"buy")===k?"on":"")+'"'+dis+'>'+l+'</button>').join("")+'</span></div>';
    if(!S.leaseCols)h+='<div class="vl-warn">導入方法を切り替えるにはデータベースに列の追加が必要です（sql/bt_vehicle_lease.sql）。</div>';
    if(!L)return h+fld(v,"purchase_price","仕入額（総額）","円","number");
    const m=n(v.lease_monthly)||0;
    return h+fld(v,"purchase_price","リース総額","円","number","契約の総額")+'<div class="vl-f"><span>参考：リース月額</span><span class="in ro"><b>'+(m?'月 '+man(m):'—')+'</b><small>車両マスタ（配車表）</small></span></div>';
  }
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
  // オーナー指示 2026-10-31：自動では登録しない（売止未定の車まで止まって意味不明になるため）。
  //   既存のブロックを読むだけ。登録は入替車両タブの「⛔ 配車表を止める」ボタン（売止日が出ている車だけ）で人が押す
  async function syncStop(){
    S.stop={};
    let rows;
    if(VIEW_KEY){const {data,error}=await sb.rpc("bt_vehicle_stop_sync",{p_key:VIEW_KEY,p_rows:[]});if(error)throw error;rows=data||[];}
    else{const {data,error}=await sb.from("bt_maintenance").select("id,vehicle_code,start_date,end_date").eq("label","売止");if(error)throw error;rows=data||[];}
    rows.forEach(r=>{S.stop[r.vehicle_code]=r;});
  }
  async function addStop(code){
    const v=S.v.find(x=>x.code===code), c=S.calc[code], t0=T0(); if(!v||!c||c.stopT==null)return;
    const w={code,start:dstr(Math.max(c.stopT,t0)),end:FAR};
    if(!confirm((v.name||code)+" "+plate4(v)+" の配車表を "+w.start+" から止めます（在庫調整に「要」が出ます）。よろしいですか？"))return;
    let error=null;
    if(VIEW_KEY){({error}=await sb.rpc("bt_vehicle_stop_sync",{p_key:VIEW_KEY,p_rows:[w]}));}
    else{({error}=await sb.from("bt_maintenance").upsert({id:stopId(code),vehicle_code:code,start_date:w.start,end_date:w.end,label:"売止",cost:0,actual_cost:0,workshop:"",invoice_no:"",maint_notes:"車両ダッシュボードの入替車両タブから登録（売止）",status:"approved"},{onConflict:"id",ignoreDuplicates:true}));
      if(!error)intakeLog("intake_created",code,w.start,w.end);}
    setStatus(error?"止められませんでした："+error.message:"✅ 配車表を止めました");
    await syncStop(); render();
  }
  async function delStop(code){
    if(!confirm("配車表のブロックを外しますか？"))return;
    const er=await setStopEnd(code,"0000-00-00"); setStatus(er?"外せませんでした："+er.message:"✅ ブロックを外しました");
    await syncStop(); render();
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
  // オーナー指示 2026-10-31：協議（10万km超・売止日未定）の車も入替の対象としてここに出す
  const inPrep=v=>{const c=S.calc[v.code];return c.st!=="sold"&&!isSucc(v.code)&&n(v.sale_price)==null&&(c.stopT!=null?addMon(c.stopT,-LEAD())<=T0():!!c.talk);};
  // 入替予測（オーナー指示 2026-11-02）：今日から3ヶ月以内に走行リミットへ届く予定の車を、到達が早い順に出す。協議の車はリミット未定なので入らない
  const FORECAST_MON=3;
  const forecastCars=()=>S.v.filter(v=>{const c=S.calc[v.code];return c.st!=="sold"&&!isSucc(v.code)&&n(v.sale_price)==null&&c.limitT!=null;}).sort((a,b)=>S.calc[a.code].limitT-S.calc[b.code].limitT);
  const forecastList=()=>{const end=addMon(T0(),FORECAST_MON);return forecastCars().filter(v=>S.calc[v.code].limitT<=end);};
  // 保有判定（オーナー指示 2026-11-02）：1台ごとに「今売る／1年後に売る／2年後に売る」を比べ、生涯利益が最大の時期を出す
  //   上乗せ利益(n)＝n年間の粗利の合計 −（今の売却額 − n年後の売却額）。プラスなら保有、1年後・2年後とも0以下なら今売却
  //   仕入額（一括仕入・リース総額）は持っても売っても変わらない確定済みの支出なので判定に使わない。リース月額も使わない
  //   粗利＝売上 − 整備費 − 保険・税 − 車検費（売上・整備費は 2026-08-03 以降の実績を年換算。最終利益と同じく人件費・OTA手数料は含めない）
  //   n年後の売却額＝今の売却額（相場×買取率）×（1−年下落率）^n ×（1−距離下落率×増える距離÷1万km）。年間走行はその車のペース
  //   n年後にリミットを超える選択肢は除外。仮置きの率は HOLD に1行ずつ（売却実績が出たら置き換える）
  const HOLD={paceY:15000, maxY:3, rideAgeY:7, age:5, kmDep:6, drop:5, insMon:10000, shaken:100000, tenken:25000, tenkenN:2};   // 経費は一旦固定（オーナー指示 2026-11-02）：保険 月1万／車検 年1回10万／点検 年2回×2.5万   // 年下落率％（Aクラス／その他）・1万kmごとの下落％・単価低下％/年
  function opOf(v){const t0=T0(), st=(S.res[v.code]||[]).map(r=>ts(r.start_date)).filter(t=>t!=null&&t<=t0&&t>=ts(DATA_FROM));
    if(!st.length)return null;const from=Math.min(...st);return {from,days:Math.round((t0-from)/DAY)};}
  function holdRate(type){   // 稼働30日以上の車の 売上合計÷稼働日数合計
    const pool=S.v.filter(x=>S.calc[x.code].st!=="sold").map(x=>({x,o:opOf(x)})).filter(y=>y.o&&y.o.days>=30);
    const rate=l=>{const d=l.reduce((s,y)=>s+y.o.days,0);return d?l.reduce((s,y)=>s+S.calc[y.x.code].revDone,0)/d:null;};
    const cl=pool.filter(y=>y.x.type===type);
    if(cl.length)return {perDay:rate(cl),src:"class",n:cl.length};
    return pool.length?{perDay:rate(pool),src:"all",n:pool.length}:null;}
  // 目的を利益最大化に統一（オーナー指示 2026-11-02）：売る時期＝利益が最大の月。上限（保有3年 または 90km の早い方・手入力の売却予定日）より後には持たない
  const HMAX=120, HNOCAP=60;   // 上限が分からない車（協議など）は60か月先まで。どの車も最長120か月
  // 売却額の下がり方（オーナー指示 2026-11-02：査定と連動）
  //   距離の分＝その車の相場の実測：今の相場（今の走行帯）と終了時の相場（同じ年式・10万km前後）を結んだ、1万kmあたりの下落率
  //   終了時の相場がない車は同じクラスの平均、いなければ全車平均、それもなければ HOLD.kmDep。年数の分は相場に入らない（同じ年式で調査）ので HOLD.age を足す
  const kmMid=r=>r&&n(r.km_from)!=null&&n(r.km_to)!=null?(n(r.km_from)+n(r.km_to))/2:null;
  function mktSlope(v){const m=S.calc[v.code].mkt;if(!m||!m.now||!m.end)return null;
    const a=kmMid(m.now.cond), b=kmMid(m.end.cond);if(a==null||b==null||b<=a||!(m.now.med>0))return null;
    const pct=Math.max(0,(m.now.med-m.end.med)/((b-a)/1e4)/m.now.med*100);
    return {pct,ref:(n(m.end.n)||0)<5||/参考/.test(m.end.cond&&m.end.cond.note||""),nowMed:m.now.med,endMed:m.end.med,endKm:b};}
  function holdSlope(v){const own=mktSlope(v);if(own)return Object.assign({src:"own"},own);
    const avg=l=>{const xs=l.map(mktSlope).filter(Boolean);return xs.length?{pct:xs.reduce((s,x)=>s+x.pct,0)/xs.length,n:xs.length}:null;};
    const act=S.v.filter(x=>S.calc[x.code].st!=="sold"), cl=avg(act.filter(x=>x.type===v.type));
    if(cl)return Object.assign({src:"class"},cl);const al=avg(act);if(al)return Object.assign({src:"all"},al);return {src:"default",pct:HOLD.kmDep};}
  const slopeLb=sl=>sl.src==="own"?'この車の相場（今'+man(sl.nowMed)+'→'+km(sl.endKm)+'km時'+man(sl.endMed)+(sl.ref?'・終了時は参考値':'')+'）':sl.src==="class"?'同じクラスの相場の平均（'+sl.n+'台）':sl.src==="all"?'全車の相場の平均（'+sl.n+'台）':'仮置き';
  // 手放す時期（オーナー指示 2026-11-02）：保有は最長 HOLD.maxY 年（保有期間が長いほどリスクが増えるため）。上限＝保有3年 または 90km の早い方・手入力・保有上限の一番早い月
  //   年式が古い車（初度登録から HOLD.rideAgeY 年以上）と、出口が「乗り潰し」の車は、売る場合と「90km到達まで乗り潰す（売却額0）」を比べ、利益の大きい方を推奨する
  function holdOf(v){
    const c=S.calc[v.code];
    if(c.st==="sold")return null;
    const sp=n(v.sale_price), V0=sp!=null?sp:c.nowExit;
    if(V0==null&&!c.ride)return {na:"相場なし（市場売却額が出ると判定）"};
    const V0x=V0??0;
    // 月の売上＝実績売上÷稼働日数（その車の最初の予約日〜今日）で年換算（オーナー指示 2026-11-02：稼働前の期間で薄めない）。返却が入るたびに更新。単価は年HOLD.drop%ずつ下がる
    //   稼働30日未満の車は、同じクラスの稼働30日以上の車の平均（1日あたり売上）で代用。クラスにいなければ全車平均（オーナー指示 2026-11-02）
    const op=opOf(v), own=op&&op.days>=30, cr=own?null:holdRate(v.type);
    if(!own&&!cr)return {na:"売上の実績がまだない"};
    const opFrom=op?op.from:null, opDays=op?op.days:0;
    const S1=own?c.revDone/opDays*365:cr.perDay*365, src=own?"own":cr.src, sm=S1/12, cm=(HOLD.insMon*12+HOLD.shaken+HOLD.tenken*HOLD.tenkenN)/12;
    const kmM=HOLD.paceY/12, age=HOLD.age/100, sl=holdSlope(v);   // 今後の走行ペースは想定値（オーナー指示 2026-11-02：年1.5万km）。実績ペースは使わない
    const V=k=>V0x*Math.pow(1-age,k/12)*Math.max(.1,1-sl.pct/100*(kmM||0)*k/1e4);   // 下限は今の10%
    // 上限：保有 HOLD.maxY 年（仕入日→なければ稼働開始日から）・90km到達・手入力の売却予定日の一番早い月
    const t0=T0(), start=ts(v.purchase_date)||ts(v.service_from)||opFrom, capEnd=start!=null?addMon(start,12*HOLD.maxY):null;
    // 上限＝保有3年 または 90km到達 の早い方（オーナー指示 2026-11-02）。手入力の売却予定日があればそれも上限。車検手前は上限にしない（車検費は経費に入っている）
    const mo=t=>t==null?null:Math.max(0,Math.floor(monthsTo(t)));
    const limT=c.talk||c.odo==null?null:c.odo>=c.limit?t0:t0+(c.limit-c.odo)/kmM*MON;   // 9万km到達は想定ペースで出す
    const caps=[[mo(limT),km(c.limit)+'km到達'],[mo(capEnd),'保有'+HOLD.maxY+'年（'+(ts(v.purchase_date)?'仕入日':'稼働開始')+' '+ymd(start)+'から）'],[mo(ts(v.sale_plan_date)),'手入力の売却予定日']].filter(z=>z[0]!=null).sort((a,b)=>a[0]-b[0]);
    // 車検トリガー（オーナー指示 2026-11-02：3年・9万km・車検の3つ）：次の車検を通しても、その後1年以内（2回目以降の車検は毎年）に3年か9万kmに届くなら、車検の手前で手放す
    const shk=c.shaken!=null&&c.shaken>t0?mo(c.shaken):null;
    if(caps.length&&shk!=null&&S.cfg.shaken_rule!=="ignore"&&shk<caps[0][0]&&caps[0][0]<shk+12&&caps[0][1]!=='手入力の売却予定日')caps.unshift([shk,'車検手前（車検後1年以内に'+caps[0][1].replace(/（.*$/,'')+'に届くため、車検を通さない）']);
    const capK=caps.length?caps[0][0]:null, capWhy=caps.length?caps[0][1]:null;
    const H=Math.min(capK??HNOCAP,HMAX);
    // 乗り潰し：年式が古い車・出口が乗り潰しの車だけ。90km到達まで走らせ、売却額は0
    const yr=wYear(v.year), old=yr!=null&&new Date(t0).getUTCFullYear()-yr>=HOLD.rideAgeY;
    const rideOK=(c.ride||old)&&c.odo!=null&&kmM>0&&!c.talk, Hr=rideOK?Math.min(HMAX,Math.max(0,Math.floor((c.limit-c.odo)/kmM))):null;
    const Hall=Math.max(H,Hr??0), all=[]; let cs=0,cc=0;
    for(let k=0;k<=Hall;k++){
      if(k>0){cs+=sm*Math.pow(1-HOLD.drop/100,(k-1)/12); cc+=cm;}
      const val=V(k), cum=cs-cc;
      all.push({k,cs,cc,cum,val,drop:V0x-val,up:cum-(V0x-val),ok:k<=H,kmAt:c.odo!=null&&kmM!=null?c.odo+kmM*k:null});}
    const sellBest=V0==null?null:all.filter(r=>r.ok).reduce((b,r)=>r.up>b.up?r:b,all[0]);
    const rideRow=Hr!=null?Object.assign({},all[Hr],{val:0,drop:V0x,up:all[Hr].cum-V0x,ride:true,ok:true}):null;
    const mode=rideRow&&(c.ride||!sellBest||rideRow.up>sellBest.up)?"ride":"sell", best=mode==="ride"?rideRow:sellBest;
    const pick=[...new Set([0,6,12,24,36,H,sellBest?sellBest.k:0].filter(k=>k<=H))].sort((a,b)=>a-b);
    const rows=(V0==null?[]:pick.map(k=>all[k])).concat(rideRow?[rideRow]:[]);
    // 手放す時期（利益最大の月）と、そこから逆算した売止・入替準備。今の設定（saleT）と並べて見せる（予約停止はまだ今の設定で動く）
    const saleU=addMon(t0,best.k), stopU=addMon(saleU,-1), prepU=addMon(stopU,-LEAD());
    return {code:v.code,all,rows,best,mode,sellBest,rideRow,old,H,Hall,capK,capWhy,saleU,stopU,prepU,V0:V0x,S1,kmM,sl,opFrom,opDays,src,srcN:cr?cr.n:0,edge:capK==null&&mode==="sell"&&best.k===H,short:own&&opDays<90};
  }
  // 保有判定の共通部品（サマリ・保有判定・車両カルテで同じものを使う。オーナー指示 2026-11-02：目的は利益最大化。保有判定を主役にする）
  const manC=x=>x==null?'—':Math.abs(x)>=1e6?(x<0?'−':'')+Math.round(Math.abs(x)/1e4).toLocaleString()+'万':man(x);
  const hpm=x=>x==null?'—':(x>0?'+':x<0?'−':'')+man(Math.abs(x)).replace(/^−/,'');
  const hpmC=x=>x==null?'—':(x>0?'+':x<0?'−':'')+manC(Math.abs(x));
  const holdFin=(v,r)=>{const c=S.calc[v.code];return c.buy!=null&&r?r.val+c.revDone+r.cs-r.cc-c.buy:null;};   // 最終利益＝売却額＋売上（実績＋見込み）−経費−仕入額
  const holdSell=v=>{const x=holdOf(v);return !!(x&&!x.na&&x.mode==='sell'&&x.best.k===0);};
  function holdWhy(x){
    if(x.na)return x.na;
    const cap=x.capWhy?'上限は'+ym(addMon(T0(),x.H))+'（'+x.capWhy+'）':'';
    if(x.mode==='ride')return (S.calc[x.code||'']||{}).ride?'出口が乗り潰しの車':'年式が古く売却額が小さいため、売るより'+ym(x.saleU)+'（90km到達）まで乗り潰す方が利益が大きい'+(x.sellBest?'（売る場合より'+hpm(x.best.up-x.sellBest.up)+'）':'');
    if(x.best.k===0){if(x.H===0)return '上限（'+(x.capWhy||'')+'）に達している';const okR=x.all.filter(r=>r.k>0);const r=okR.reduce((b,q)=>q.up>b.up?q:b);return 'どの月で売っても 保有中の粗利より売却額の下落が大きい（'+r.k+'か月後で 粗利'+hpm(r.cum)+'／下落'+hpm(-r.drop)+'）・'+cap;}
    if(x.capK!=null&&x.best.k===x.H)return '上限まで持つのが最大：'+ym(addMon(T0(),x.best.k))+'（'+x.capWhy+'）に手放し、今売るより '+hpm(x.best.up);
    return ym(addMon(T0(),x.best.k))+'に手放すのが最大で、今売るより '+hpm(x.best.up)+(x.edge?'（'+x.H+'か月以上先の可能性）':'')+(cap?'・'+cap:'');
  }
  // 1台の結論を文章で（オーナー指示 2026-11-02）：年間〜km走って〜か月後に売ると〜%下落、レンタル期間の売上を合算すると生涯成績は〜
  function holdStory(v,x){
    if(!x||x.na)return '';
    if(x.mode==='ride'){const c=S.calc[v.code], b=x.best, f=holdFin(v,b), gp=c.revDone+b.cs-b.cc;
      return 'この'+(v.name||'車')+'は'+(x.kmM!=null?'年間'+km(x.kmM*12)+'km走行し、':'')+b.k+'か月後（'+ym(x.saleU)+(b.kmAt!=null?'・'+km(b.kmAt)+'km':'')+'）まで乗り潰すと、レンタル期間の粗利は'+man(gp)+'（売上'+man(c.revDone+b.cs)+'−経費'+man(b.cc)+'）。売却額は0として'+(f!=null?'仕入額'+man(c.buy)+'を引いた生涯成績は'+hpm(f):'見ると今売るより'+hpm(b.up))+'です。'+(x.sellBest?'売る場合（'+ym(addMon(T0(),x.sellBest.k))+'）より'+hpm(b.up-x.sellBest.up)+'多くなります。':'');}
    const c=S.calc[v.code], b=x.best, f=holdFin(v,b), base=c.buy!=null?c.buy:x.V0, baseLb=c.buy!=null?(c.isLease?'リース総額':'仕入額'):'今の売却額';
    const pct=base?Math.round((base-b.val)/base*100):null;
    const run=x.kmM!=null?'年間'+km(x.kmM*12)+'km走行し、':'';
    const when=b.k===0?'今売ると':b.k+'か月後（'+ym(addMon(T0(),b.k))+(b.kmAt!=null?'・'+km(b.kmAt)+'km':'')+'）に売ると';
    const drop='売却額は'+baseLb+man(base)+'から'+man(b.val)+'へ'+(pct!=null?(pct>=0?pct+'%下落':(-pct)+'%上昇'):'')+'します';
    const gp=c.revDone+b.cs-b.cc;
    const life=f!=null?'レンタル期間の粗利'+man(gp)+'（売上'+man(c.revDone+b.cs)+'−経費'+man(b.cc)+'）に売却額'+man(b.val)+'を足し、'+baseLb+man(c.buy)+'を引いた生涯成績は'+hpm(f)+'になります':'レンタル期間の粗利は'+man(gp)+'（売上'+man(c.revDone+b.cs)+'−経費'+man(b.cc)+'）。仕入額が未入力のため生涯成績は出せません（今売るより'+hpm(b.up)+'）';
    return 'この'+(v.name||'車')+'は'+run+when+'、'+drop+'。'+life+'。';
  }
  const ymS3=t=>{const d=new Date(t);return d.getUTCFullYear()+'/'+(d.getUTCMonth()+1);};
  const holdBadge=x=>!x?'<span class="vl-st sold">終了済</span>':x.na?'<em class="hj na">判定不可</em>':x.mode==='ride'?'<em class="hj ride">乗り潰し '+ymS3(x.saleU)+'まで</em>':x.best.k===0?'<em class="hj sell">今手放す</em>':'<em class="hj keep">'+ymS3(x.saleU)+'に手放す</em>';
  function holdFlow(v,x){
    const c=S.calc[v.code], buy=c.buy;
    return '<div class="hd-buy">仕入額 <b>'+(buy!=null?manC(buy):'未入力')+'</b>'+(buy!=null?'（'+(c.isLease?'リース総額':'一括仕入')+'）':'')+' からスタート</div><div class="hd-flow"><table><thead><tr><th>売る時期</th><th class="bc">仕入額</th><th>＋売上</th><th>−経費</th><th class="gp">＝粗利</th><th>＋売却額</th><th class="eq">＝最終利益</th></tr></thead><tbody>'
      +x.rows.map(r=>{const best=r===x.best, off=!r.ok, f=holdFin(v,r);
        return '<tr class="'+(best?'best':'')+(off?' off':'')+(r.ride?' rd':'')+'"><td>'+(r.ride?'乗り潰し '+r.k+'か月':r.k===0?'今売る':r.k+'か月後')+'<small>'+(r.kmAt!=null?km(r.kmAt)+'km':'')+(off?' リミット超過':'')+'</small></td>'
          +'<td class="bc">'+(buy!=null?manC(buy):'未入力')+'</td>'
          +'<td>'+manC(c.revDone+r.cs)+(r.k?'<small>うち見込み'+manC(r.cs)+(x.src!=='own'?'（'+(x.src==='class'?'クラス平均':'全車平均')+'）':'')+'</small>':'<small>実績'+(x.opFrom!=null?' '+ymd(x.opFrom).slice(5)+'〜'+x.opDays+'日':'')+(x.short?'（90日未満）':'')+'</small>')+'</td>'
          +'<td>'+(r.cc?'−'+manC(r.cc):'0')+(r.k?'<small>'+r.k+'か月分</small>':'')+'</td>'
          +'<td class="gp"><b class="'+(c.revDone+r.cs-r.cc>=0?'':'r')+'">'+manC(c.revDone+r.cs-r.cc)+'</b><small>売上−経費</small></td>'
          +'<td>'+manC(r.val)+'</td>'
          +'<td class="eq"><b class="'+(f==null?'':f>=0?'g':'r')+'">'+(f==null?'—':hpmC(f))+'</b>'+(r.k?'<small>今売るより'+hpmC(r.up)+'</small>':'')+'</td></tr>';}).join('')
      +'</tbody></table></div>';
  }
  // 最終利益（仕入額が未入力なら「今売るより」）の月ごとの推移。最大の月に印、リミット到達月に線
  function holdChart(v,x){
    const fin=holdFin(v,x.all[0])!=null, val=r=>fin?holdFin(v,r):r.up, pts=x.sellBest?x.all.filter(r=>r.ok):[], ys=pts.concat(x.rideRow?[x.rideRow]:[]).map(val), lo=Math.min(0,...ys), hi=Math.max(0,...ys);
    const HX=x.rideRow?x.Hall:x.H, W=400,H=170,L=50,R=10,T=16,B=24, X=k=>L+(W-L-R)*k/(HX||1), Y=y=>T+(H-T-B)*(1-(y-lo)/((hi-lo)||1));
    const okPts=pts;
    const path=a=>a.map((r,i)=>(i?'L':'M')+X(r.k).toFixed(1)+' '+Y(val(r)).toFixed(1)).join('');
    const b=x.best, st=HX<=24?6:HX<=48?12:HX<=84?24:36, ticks=Array.from({length:Math.floor(HX/st)+1},(_,i)=>i*st);
    return '<div class="hd-ch"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+(fin?'最終利益':'今売るより上乗せ')+'の月ごとの推移">'
      +'<line x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(0).toFixed(1)+'" y2="'+Y(0).toFixed(1)+'" class="z"/>'
      +ticks.map(k=>'<text x="'+X(k)+'" y="'+(H-8)+'" text-anchor="middle">'+(k?k+'か月':'今')+'</text>').join('')
      +[hi,lo].filter((y,i,a)=>a.indexOf(y)===i).map(y=>'<text x="'+(L-6)+'" y="'+(Y(y)+4).toFixed(1)+'" text-anchor="end">'+hpmC(y)+'</text>').join('')
      +(x.capK!=null?'<line x1="'+X(x.H)+'" x2="'+X(x.H)+'" y1="'+T+'" y2="'+(H-B)+'" class="lim"/><text x="'+(X(x.H)-4)+'" y="'+(H-B-4)+'" text-anchor="end" class="lim">上限</text>':'')
      +(okPts.length?'<path d="'+path(okPts)+'" class="ln"/>':'')+(x.rideRow&&x.rideRow!==b?'<circle cx="'+X(x.rideRow.k).toFixed(1)+'" cy="'+Y(val(x.rideRow)).toFixed(1)+'" r="4" class="rp"/>':'')+(x.rideRow&&b===x.rideRow&&x.sellBest?'<circle cx="'+X(x.sellBest.k).toFixed(1)+'" cy="'+Y(val(x.sellBest)).toFixed(1)+'" r="4" class="sp"/>':'')
      +'<circle cx="'+X(b.k).toFixed(1)+'" cy="'+Y(val(b)).toFixed(1)+'" r="5" class="bp"/><text x="'+Math.min(W-R-4,Math.max(L+4,X(b.k))).toFixed(1)+'" y="'+(Y(val(b))-10<T+8?Y(val(b))+20:Y(val(b))-10).toFixed(1)+'" text-anchor="'+(b.k>HX*.7?'end':b.k<HX*.2?'start':'middle')+'" class="bt">'+(b.ride?'乗り潰し ':'')+(b.k?b.k+'か月後 ':'今 ')+hpmC(val(b))+'</text>'
      +'</svg><div class="hd-chl">'+(fin?'最終利益':'今売るより上乗せ（仕入額が未入力のため）')+'の推移（売る場合）・●が推奨'+(x.rideRow?'・紫＝90kmまで乗り潰した場合':'')+'</div></div>';
  }
  const ymdS2=t=>{if(t==null)return'—';const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
  function holdPlan(v,x){const c=S.calc[v.code], diff=c.stopT!=null&&Math.abs(c.stopT-x.stopU)>31*DAY;
    return '<div class="hd-plan"><span><i>'+(x.mode==='ride'?'乗り潰し（90km到達）':'手放す（利益最大）')+'</i><b>'+(x.best.k===0?'今':ymdS2(x.saleU))+'</b></span><span><i>売止</i><b>'+(x.best.k===0?'今':ymdS2(x.stopU))+'</b></span><span><i>入替準備</i><b>'+(x.prepU<=T0()?'今':ymdS2(x.prepU))+'</b></span>'
      +'<span class="now'+(diff?' df':'')+'"><i>今の設定（予約停止はこちらで動作中）</i><b>売止 '+ymdS2(c.stopT)+'・入替準備 '+(c.stopT!=null?ymdS2(addMon(c.stopT,-LEAD())):'—')+'</b></span></div>';}
  function holdListHtml(a){
    const H=a.map(v=>({v,h:holdOf(v)})).filter(x=>x.h);
    const keep=H.filter(x=>!x.h.na&&x.h.mode==='sell'&&x.h.best.k>0), sell=H.filter(x=>!x.h.na&&x.h.mode==='sell'&&x.h.best.k===0), ride=H.filter(x=>!x.h.na&&x.h.mode==='ride'), na=H.filter(x=>x.h.na);
    let h='<div class="ov-tiles hd-t"><div class="g"><b>'+keep.length+'</b><span>期限内に手放す</span></div><div class="r"><b>'+sell.length+'</b><span>今手放す</span></div><div class="p"><b>'+ride.length+'</b><span>乗り潰し</span></div><div><b>'+na.length+'</b><span>判定不可</span></div></div>';
    h+='<details class="hd-n"><summary>計算のしかた</summary><div>1台ごとに、お金の流れ（仕入額 → ＋売上 → −経費 → ＋売却額 ＝ 最終利益）を、今から上限（保有'+HOLD.maxY+'年・90km・車検の3つのトリガー。車検後1年以内に3年か90kmに届くなら車検の手前。手入力の売却予定日があればそれも。分からない車は'+HNOCAP+'か月先）まで1か月ずつ計算し、最終利益が一番大きい月を売却予定にします（緑の行）。表は今・6・12・24・36・60か月後・上限と、その月を表示。返却が入るたびに再計算されます。売上は'+(()=>{const d=new Date(ts(DATA_FROM));return (d.getUTCMonth()+1)+'/'+d.getUTCDate();})()+'以降の実績＋今後の見込み（実績を年換算・月の売上＝実績÷稼働日数（その車の最初の予約日〜今日）で月換算。稼働30日未満の車は同じクラスの平均（いなければ全車平均）で代用し「クラス平均」と表示・単価低下'+HOLD.drop+'%/年）。経費は1年あたり 保険'+man(HOLD.insMon*12)+'（月'+man(HOLD.insMon)+'）＋車検'+man(HOLD.shaken)+'（年1回）＋点検'+man(HOLD.tenken*HOLD.tenkenN)+'（年'+HOLD.tenkenN+'回×'+man(HOLD.tenken)+'）＝'+man(HOLD.insMon*12+HOLD.shaken+HOLD.tenken*HOLD.tenkenN)+'の仮置き。売却額は今の市場売却額から、距離の分は査定の相場（今の相場と10万km前後の相場）を結んだ下がり方で、年数の分は年'+HOLD.age+'%（仮置き）で下げます。相場が更新されると自動で連動します。仕入額が未入力でも、どの行にも同じ額が引かれるだけなので判定は出ます。</div></details>';
    const ord=x=>x.h.na?3:x.h.mode==='ride'?2:x.h.best.k===0?0:1;
    const rowsH=H.slice().sort((x,y)=>ord(x)-ord(y)||(y.h.best?y.h.best.up:0)-(x.h.best?x.h.best.up:0));
    h+=rowsH.map(({v,h:x})=>{
      const c=S.calc[v.code];
      const why=holdWhy(x);
      const jd=holdBadge(x);
      const kmTxt=(c.odo!=null?km(c.odo)+'km':'走行—')+'・今後 年'+km(HOLD.paceY)+'km（想定）'+(c.monKm!=null?'・実績 年'+km(c.monKm*12)+'km'+(c.paceOwn?'':'（平均）'):'')+(c.limit&&!c.talk?'・リミット'+km(c.limit):'');
      let t='<div class="hd-card" data-goto="'+e(v.code)+'"><div class="hd-hd"><div class="nmc">'+nm(v)+'</div><div class="hd-j">'+jd+'<small>'+e(why)+'</small></div></div><div class="hd-km">'+kmTxt+'</div>'+(x.na?'':holdPlan(v,x))+(x.na?'':'<div class="hd-story">'+e(holdStory(v,x))+'</div>');
      if(!x.na)t+=holdFlow(v,x);
      return t+'</div>';}).join('');
    return h;
  }
  // アルゴリズム（オーナー指示 2026-11-02：目的・判断のしかた・前提値・変更履歴を1か所に。名前は「アルゴリズム」に統一）
  //   ロジックや前提値を変えたら、DEF_LOG の先頭に1行足す（日付・何を変えたか・なぜ）。前提値の表は HOLD・ルール設定から自動で出る
  const DEF_LOG=[
    ["2026-11-02","入替予測タブを、保有判定の「手放す月」にもとづく入替予定（月ごとの台数・入替準備・売止・手放す）に置き換え。メニューの数字は3か月以内に入替準備に入る台数","入替の計画を保有判定に揃えるため（表示のみ。予約停止はまだ以前の基準）"],
    ["2026-11-02","タブ名を「定義・変更履歴」から「アルゴリズム」に変更","シンプルに統一するため"],
    ["2026-11-02","目的を「品質を保ちながら、"+HOLD.maxY+"年・90km以内で最大の利益（利益が同じなら早く手放す）」に更新","長く持つほど品質・リスク・相場の面で不利になり、利益はほとんど増えないため（オーナー判断）"],
    ["2026-11-02","今後の走行ペースを想定値 年"+HOLD.paceY.toLocaleString()+"km に（全車共通）。9万km到達・距離による下落・乗り潰しの期間はこのペースで計算","今後の運用の想定で判断するため（実績は8月からで短い）"],
    ["2026-11-02","上限のトリガーを「保有"+HOLD.maxY+"年・90km・車検」の3つに。車検を通しても1年以内に3年か90kmに届くなら、車検の手前で手放す","オーナー判断"],
    ["2026-11-02","上限を「保有"+HOLD.maxY+"年 または 90km の早い方」（＋手入力の売却予定日）に整理。車検手前は上限から外す","オーナー判断。車検費は経費に入っているため"],
    ["2026-11-02","保有の上限を"+HOLD.maxY+"年に（期限に追加）。表示を「◯年◯月に手放す」に変更。年式が古い車（初度登録から"+HOLD.rideAgeY+"年以上）は90kmまでの乗り潰しとも比べ、利益が大きい方を推奨","保有期間が長いほどリスクが増えるため（オーナー判断）。古い車は売却額が小さく乗り潰しの方が得な場合があるため"],
    ["2026-11-02","目的を「90km以内で利益最大」に統一。90km到達・車検手前・手入力の売却予定を期限にし、その中で最終利益が最大の月を売却予定にする。売止・入替準備を逆算し、今の設定と並べて表示（予約停止はまだ今の設定）","目的が画面ごとにばらばらだったため"],
    ["2026-11-02","サマリの下段を保有判定のカードに入れ替え。保有判定メニューはサマリに統合","保有判定が主役のため"],
    ["2026-11-02","将来の売却額を査定の相場に連動（距離＝今の相場と10万km相場から実測、年数＝年"+HOLD.age+"%）","一律2%の仮置きが実際の下がり方（2〜9%）と合わなかったため"],
    ["2026-11-02","売上の年換算を稼働日数（その車の最初の予約日〜今日）で割る。稼働30日未満はクラス平均で代用","稼働前の期間で売上が薄まっていたため"],
    ["2026-11-02","年間経費を一旦固定：保険 月1万＋車検 年1回10万＋点検 年2回×2.5万＝年27万","オーナー指示"],
    ["2026-11-02","仕入額（一括仕入＝仕入総額、リース＝リース総額）をスタート額として表示。リース月額は計算に使わない","総額で見るため"],
    ["2026-11-02","保有判定を追加（月ごとに最終利益を計算し、最大の月を売却予定にする）","売り時を利益で決めるため"]];
  function defHtml(){
    const cfg=S.cfg, yr=HOLD.insMon*12+HOLD.shaken+HOLD.tenken*HOLD.tenkenN;
    const row=(k,v,why)=>'<tr><td>'+k+'</td><td><b>'+v+'</b></td><td>'+why+'</td></tr>';
    let h='<h4 class="vl-h4">📘 アルゴリズム <small>この画面の数字は、今のプログラムの設定値をそのまま表示しています</small></h4>';
    h+='<div class="df-goal"><span>目的</span><b>在庫（1台ごと）を、品質を保ちながら、'+HOLD.maxY+'年・'+km(n(cfg.default_limit_km)||DEF.default_limit_km)+'km以内で最大の利益を生むように運用する（利益が同じなら早く手放す）</b><small>持ちすぎない＝同じ利益を、より新しい車・より低いリスクで出す</small></div>';
    h+='<div class="df-sec"><h5>判断の流れ</h5><ol>'
      +'<li><b>上限（3つのトリガー）</b>：<b>保有'+HOLD.maxY+'年</b>・<b>'+km(n(cfg.default_limit_km)||DEF.default_limit_km)+'km</b>・<b>車検</b>。3年か'+km(n(cfg.default_limit_km)||DEF.default_limit_km)+'kmの早い方が上限。次の車検を通してもその後1年以内（2回目以降の車検は毎年）に上限に届くなら、車検の手前で手放す。保有は仕入日から（なければ稼働開始日から）。手入力の売却予定日があればそれも上限。保有が長いほどリスクが増えるため、これより後には持たない</li>'
      +'<li><b>手放す時期</b>：今から上限までを1か月ずつ計算し、最終利益が一番大きい月</li>'
      +'<li><b>乗り潰し</b>：年式が古い車（初度登録から'+HOLD.rideAgeY+'年以上）と、出口が「乗り潰し」の車は、90km到達まで乗り潰した場合（売却額0）とも比べ、利益が大きければ乗り潰しを推奨する（保有'+HOLD.maxY+'年の上限はかけない）</li>'
      +'<li><b>売止・入替準備</b>：売却予定の1か月前に売止、その'+LEAD()+'か月前から入替準備</li>'
      +'<li><b>表示</b>：「◯年◯月に手放す」「今手放す」「乗り潰し ◯年◯月まで」</li></ol>'
      +'<p class="df-warn">運用状態：予約停止（売止）は、まだ今までの基準（90km到達・車検・手入力）で動いています。統一した売却予定への切り替えは未実施です。</p></div>';
    h+='<div class="df-sec"><h5>計算式</h5><ul>'
      +'<li><b>最終利益（生涯成績）</b> ＝ 粗利 ＋ 売却額 − 仕入額</li>'
      +'<li><b>粗利</b> ＝ 売上（実績＋見込み）− 経費</li>'
      +'<li><b>仕入額</b> ＝ 一括仕入なら仕入総額、リースならリース総額（リース月額は使わない）</li>'
      +'<li>仕入額は、どの月に売っても同じ額が引かれるので、売却予定の選び方には影響しない（未入力でも判定は出る）</li></ul></div>';
    h+='<div class="df-sec"><h5>前提値（今の設定）</h5>'+tbl(["項目","値","決め方"],[
      row('売上（見込み）','実績を年換算','その車の実績売上 ÷ 稼働日数（最初の予約日〜今日）× 365。稼働30日未満は同じクラスの平均（いなければ全車平均）。'+(()=>{const d=new Date(ts(DATA_FROM));return d.getUTCFullYear()+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();})()+'以降の予約が対象'),
      row('単価の低下','年'+HOLD.drop+'%','仮置き'),
      row('年間経費',man(yr)+'/年','保険 月'+man(HOLD.insMon)+'＋車検 年1回'+man(HOLD.shaken)+'＋点検 年'+HOLD.tenkenN+'回×'+man(HOLD.tenken)+'（仮置き・全車共通）'),
      row('今の売却額','相場中央値×'+(n(cfg.buy_rate)||DEF.buy_rate)+'%','査定（カーセンサー）の今の走行帯の中央値 × 買取率。売却額が確定していればその額'),
      row('距離による下落','車ごとの実測','今の相場と10万km前後の相場を結んだ1万kmあたりの下落率。ない車は同じクラスの平均→全車平均→'+HOLD.kmDep+'%'),
      row('年数による下落','年'+HOLD.age+'%','仮置き（相場は同じ年式で調べるため年数の分が入らない）'),
      row('今後の走行ペース','年'+km(HOLD.paceY)+'km','想定（全車共通）。9万km到達・距離による下落・乗り潰しの期間はこのペースで計算。実績ペース（メーター増分÷期間）は参考表示のみ'),
      row('リミット',km(n(cfg.default_limit_km)||DEF.default_limit_km)+'km','ルール設定'),
      row('入替準備期間',LEAD()+'か月','ルール設定'),
      row('保有の上限',HOLD.maxY+'年','オーナー判断（保有期間が長いほどリスクが増えるため）'),
      row('乗り潰しを比べる年式','初度登録から'+HOLD.rideAgeY+'年以上','仮置き'),
      row('最長で見る期間',HMAX+'か月（期限が分からない車は'+HNOCAP+'か月）','')])+'</div>';
    h+='<div class="df-sec"><h5>変更履歴 <small>新しい順</small></h5>'+tbl(["日付","変更","理由"],DEF_LOG.map(([d,c,w])=>'<tr><td>'+e(d)+'</td><td>'+e(c)+'</td><td>'+e(w)+'</td></tr>'))+'</div>';
    return h;
  }
  // 入替予測＝入替予定（オーナー指示 2026-11-02：保有判定の「手放す月」を月ごとに並べる。既存のリミット基準の予測から置き換え）
  //   表示だけ。配車表の予約は、入替車両の「配車表を止める」を押した時だけ止まる（その日付はまだ今の設定）
  function planList(){
    return S.v.filter(v=>S.calc[v.code].st!=="sold"&&!isSucc(v.code)&&n(v.sale_price)==null).map(v=>({v,x:holdOf(v)})).filter(o=>o.x&&!o.x.na);
  }
  const planSoon=()=>{const end=addMon(T0(),FORECAST_MON);return planList().filter(o=>o.x.prepU<=end);};   // 3か月以内に入替準備に入る車（メニューの数字）
  function forecastHtml(){
    const t0=T0(), L=planList(), na=S.v.filter(v=>S.calc[v.code].st!=="sold"&&!isSucc(v.code)&&n(v.sale_price)==null).filter(v=>{const x=holdOf(v);return x&&x.na;});
    const mk=t=>{const d=new Date(t);return d.getUTCFullYear()*12+d.getUTCMonth();}, m0=mk(t0), lb=m=>Math.floor(m/12)+'/'+(m%12+1);
    const last=Math.max(m0+11,...L.map(o=>mk(o.x.saleU))), N=Math.min(last-m0+1,48);
    const cnt=Array.from({length:N},(_,i)=>L.filter(o=>mk(o.x.saleU)===m0+i).length), mx=Math.max(1,...cnt);
    let h='<h4 class="vl-h4">📅 入替予測 <small>保有判定の「手放す月」を月ごとに並べた入替予定。返却や相場の更新で自動で変わります</small></h4>';
    h+='<div class="pl-note">表示だけです。配車表の予約は、入替車両の「⛔ 配車表を止める」を押した時だけ止まります（その日付はまだ以前の基準）。</div>';
    // 月ごとの台数（手放す）
    h+='<div class="pl-bars" role="img" aria-label="月ごとの手放す台数">'+cnt.map((n2,i)=>'<div class="pl-b'+((m0+i)%12===0?' y':'')+'"><b>'+(n2||'')+'</b><i style="height:'+(n2/mx*100).toFixed(0)+'%"></i><span>'+(i===0?'今月':(m0+i)%12===0?String(Math.floor((m0+i)/12)).slice(2)+'/1':[3,6,9].includes((m0+i)%12)?String((m0+i)%12+1):'')+'</span></div>').join('')+'</div>';
    // 月別リスト：入替準備を始める／売止／手放す
    const ev=[]; L.forEach(o=>{const x=o.x;
      ev.push({m:mk(Math.max(x.prepU,t0)),t:'prep',o});ev.push({m:mk(Math.max(x.stopU,t0)),t:'stop',o});ev.push({m:mk(x.saleU),t:'sale',o});});
    const TL={prep:['入替準備を始める','pp'],stop:['売止（予約を止める）','ps'],sale:['手放す','px']};
    const months=[...new Set(ev.map(z=>z.m))].sort((a,b)=>a-b);
    h+='<div class="pl-list">'+months.map(m=>{const es=ev.filter(z=>z.m===m);
      return '<div class="pl-m"><div class="pl-mh">'+lb(m)+(m===m0?' <small>今月</small>':'')+'<em>手放す '+es.filter(z=>z.t==='sale').length+'台</em></div>'
        +['prep','stop','sale'].filter(t=>es.some(z=>z.t===t)).map(t=>'<div class="pl-g"><span class="pl-t '+TL[t][1]+'">'+TL[t][0]+'</span>'
          +es.filter(z=>z.t===t).map(z=>{const x=z.o.x,v=z.o.v,f=holdFin(v,x.best);
            return '<div class="pl-r" data-goto="'+e(v.code)+'"><div class="nmc">'+nm(v)+'</div><div class="pl-w">'+(t==='sale'?(x.mode==='ride'?'乗り潰し（90km）':x.capK!=null&&x.best.k===x.H?e(String(x.capWhy).replace(/（.*$/,'')):x.best.k===0?'今が利益最大':'利益最大')+(f!=null?'・生涯成績 '+hpmC(f):''):'手放す '+ymS3(x.saleU))+'</div></div>';}).join('')+'</div>').join('')+'</div>';}).join('')+'</div>';
    if(na.length)h+='<div class="pl-m"><div class="pl-mh">判定不可 <em>'+na.length+'台</em></div>'+na.map(v=>'<div class="pl-r" data-goto="'+e(v.code)+'"><div class="nmc">'+nm(v)+'</div><div class="pl-w">'+e(holdOf(v).na)+'</div></div>').join('')+'</div>';
    return h;
  }
  function relayHtml(){
    const t0=T0(), ymd2=t=>{const d=new Date(t);return String(d.getUTCFullYear()).slice(2)+'/'+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
    const due=S.v.filter(inPrep).sort((a,b)=>(S.calc[a.code].stopT??-1)-(S.calc[b.code].stopT??-1));
    let h='<div class="vl-rl2">';
    if(!S.relayCols)h+='<div class="vl-warn">リレー用の列がまだDBにありません（sql/bt_vehicle_lifecycle.sql を適用すると使えます）。</div>';
    if(!due.length)h+='<div class="vl-note">入替準備期間（売止の'+LEAD()+'ヶ月前〜）に入った車はありません。</div>';
    let ym="";
    const gk=t=>{if(t==null)return '協議（売止日未定）';const d=new Date(t);return d.getUTCFullYear()+'年'+(d.getUTCMonth()+1)+'月 売止';};
    due.forEach(v=>{const c=S.calc[v.code], nx=relayOf(v.code), k=gk(c.stopT);
      if(k!==ym){ym=k;h+='<div class="gh">'+k+'<b>'+due.filter(x=>gk(S.calc[x.code].stopT)===k).length+'</b></div>';}
      const late=c.stopT!=null&&c.stopT<=t0;
      h+='<div class="rw'+(nx?' dn':' nd')+'" data-code="'+e(v.code)+'"><div class="nmc">'+nm(v)+'<div class="sub"><em class="yr">'+(v.year?e(wYear(v.year)||v.year)+'年式':'年式—')+'</em>'+exTag(v)+'</div></div>'
        +'<div class="nums"><span><i>現在</i>'+(c.odo!=null?km(c.odo):'—')+'</span><span><i>売止</i><b class="'+(late?'r':'')+'">'+(c.stopT!=null?ymd2(c.stopT):'未定')+'</b></span><span><i>売却</i>'+(c.saleT!=null?ymd2(c.saleT):'—')+'</span></div><div class="succ">';
      if(nx){const sw=v.service_to?dstr(ts(v.service_to)+DAY):null, sp=sw?spanning(v.code,sw):[], st=prepOf(nx)||[];
        h+='<span class="ar">→</span><span class="nm">'+e(nx.name||nx.code)+' <small>'+e(plate4(nx))+'</small></span><span class="dt">切替 '+(sw?ymd(ts(sw)):'—')+'</span>'
          +st.map(([l,x])=>'<em class="'+(x?'y':'')+'">'+(x?'✓':'')+l+'</em>').join('')+(sp.length?'<span class="vl-warn">切替日をまたぐ予約 '+sp.length+'件</span>':'')
          +'<button class="vl-mini" data-unrelay="'+e(v.code)+'">解除</button>';}
      else h+=slideHtml(v,c);
      const b=S.stop&&S.stop[v.code], na=b?afterStop(v.code).length:0;
      if(b)h+='<span class="blk">⛔ 配車表ブロック '+mdS(ts(b.start_date))+'〜'+(b.end_date>=FAR?'無期限':mdS(ts(b.end_date)))+(na?' ・<b>売止後の予約 '+na+'件</b>':'')+'</span>'+(VIEW_KEY?'':'<button class="vl-mini" data-delstop="'+e(v.code)+'">外す</button>');
      else if(!nx&&c.stopT!=null)h+='<button class="vl-mini" data-addstop="'+e(v.code)+'">⛔ 配車表を止める</button>';
      // 協議（オーナー指示 2026-10-31）：ここで人が判断する。売止日を決める（→その後に配車表を止める）か、リミットを決めて継続。決めるまでブロックしない
      if(c.talk&&c.stopT==null)h+='<div class="tk"><b>判断</b><label>売止日 <input type="date" class="vl-tkd" value="'+dstr(addMon(t0,1))+'"></label><button class="vl-mini go" data-tkstop="'+e(v.code)+'">売止日を決める</button>'
        +'<span class="or">または</span><label>リミット <input class="vl-tkl" inputmode="numeric" placeholder="例 150000" size="8">km</label><button class="vl-mini" data-tkkeep="'+e(v.code)+'">継続</button></div>';
      h+='</div></div>';});
    return h+'</div>'+(S.slideCols?'':'<div class="vl-warn">スライド入替用の列がまだDBにありません（sql/bt_vehicle_swap.sql を適用すると使えます）。</div>')+'<div class="vl-note sm">後継車の情報をここに入れておき、入替日に［スライド実行］。配車表の枠・予約・OTAはそのままで、車種名・ナンバーだけ切り替わります。</div>'+swapsHtml();
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

  // ---------- スライド入替（オーナー指示 2026-11-01）----------
  // 売り止めせず、事前準備した後継車を旧車の枠（車両コード）にスライドする。後継車の登録情報は旧車の車両マスタ行 next_car に保存。
  // 入替日に［スライド実行］：旧車の車両マスタ情報と成績を bt_vehicle_swaps に保存 → 車両マスタの車種名・ナンバー・年式・走行・車検・仕入額を後継車に差し替え
  //   → 入替日以降の予約のナンバー表示も差し替え。予約・OTA・アドミン設定・枠はそのまま。旧車の実績は swapped_at より前として切り分ける（新車に混ぜない）
  const NX_F=[["name","車種名","text","例 ノア"],["plate_no","ナンバー","text","例 4120"],["year","年式","text","例 2021"],["mileage","走行km","number","例 32000"],["shaken","車検満了","date",""],["price","仕入額","number","総額（円）"]];
  const nxOf=v=>(v&&v.next_car&&typeof v.next_car==="object")?v.next_car:{};
  const nxDate=(v,c)=>nxOf(v).date||dstr(Math.max(c.stopT??0,T0()+DAY));
  const NX_OPEN=new Set();   // 開いている行の車両コード。保存後の描き直しで閉じないように覚える（既定は閉じる）
  function slideHtml(v,c){
    const x=nxOf(v), t0=T0(), d=nxDate(v,c), cd=e(v.code), p4=String(x.plate_no||"").match(/(\d{1,4})\s*$/), ok=s=>s==="OK";
    const pr=p4?S.proc.find(r=>{const m=String(r.plate||"").match(/(\d{1,4})\s*$/);return m&&m[1]===p4[1];}):null;
    const st=[["整備",pr?ok(pr.maint_status):null],["引取",pr?ok(pr.pickup_status):null],["準備",pr?ok(pr.prep_status):null]];
    const ready=!!(x.name&&x.plate_no), sp=spanning(v.code,d).length, early=ts(d)>t0, dis=!S.slideCols||VIEW_KEY;
    const sum=x.name||x.plate_no?[x.name,x.plate_no].filter(Boolean).join(' ')+'・入替日 '+mdS(ts(d)):'未登録';
    return '<details class="nx" data-code="'+cd+'"'+(NX_OPEN.has(v.code)?' open':'')+'><summary class="nxh">後継車の登録情報<small>'+e(sum)+'</small></summary><div class="nxd">車両マスタに保存。スライド実行で枠の表示が切り替わります</div><div class="nxf">'
      +NX_F.map(([k,l,t,ph])=>'<label><span>'+l+'</span><input data-nx="'+k+'" data-code="'+cd+'" type="'+(t==="date"?"date":"text")+'"'+(t==="number"?' inputmode="numeric"':'')+(dis?' disabled':'')+' placeholder="'+e(ph)+'" value="'+e(x[k]==null?"":(t==="number"?Number(x[k]).toLocaleString():x[k]))+'"></label>').join('')
      +'<label><span>導入方法</span><select data-nx="acq" data-code="'+cd+'"'+(dis?' disabled':'')+'><option value="buy"'+(x.acq!=="lease"?" selected":"")+'>一括仕入</option><option value="lease"'+(x.acq==="lease"?" selected":"")+'>リース（総額）</option></select></label></div>'
      +'<div class="nxs">'+st.map(([l,y])=>'<em class="'+(y?'y':'')+'">'+(y?'✓':'')+l+'</em>').join('')
      +'<label class="'+(x.etc?'y':'')+'"><input type="checkbox" data-nx="etc" data-code="'+cd+'"'+(x.etc?' checked':'')+(dis?' disabled':'')+'>ETC</label>'
      +(p4&&!pr?'<span class="nxn">仕入リストにナンバー '+e(p4[1])+' がありません</span>':'')+'</div>'
      +'<div class="nxg"><label class="dt">入替日 <input type="date" data-nx="date" data-code="'+cd+'" value="'+d+'"'+(dis?' disabled':'')+'></label>'
      +'<button class="vl-mini go" data-slide="'+cd+'"'+(ready&&!dis?'':' disabled')+'>スライド実行</button>'
      +(sp?'<span class="vl-warn">入替日に貸出中の予約 '+sp+'件</span>':ready&&early?'<span class="nxn">入替日（'+mdS(ts(d))+'）から押せます</span>':'')+'</div></details>';
  }
  async function saveNx(inp){
    if(VIEW_KEY||!S.slideCols)return;
    const code=inp.dataset.code, k=inp.dataset.nx, v=S.v.find(x=>x.code===code); if(!v)return;
    let val=inp.type==="checkbox"?inp.checked:String(inp.value).trim();
    if(k==="mileage"||k==="price"){val=String(val).replace(/[^\d]/g,"");val=val===""?null:Number(val);} else if(val==="")val=null;
    const nx=Object.assign({},nxOf(v),{[k]:val});
    inp.classList.add("saving");
    const {error}=await sb.from("bt_vehicles").update({next_car:nx,updated_at:new Date().toISOString()}).eq("code",code);
    inp.classList.remove("saving");
    if(error){inp.classList.add("err");setStatus("保存できませんでした："+error.message);return;}
    inp.classList.remove("err"); v.next_car=nx; setStatus("✅ 後継車の情報を保存しました");
    if(k==="plate_no"||k==="date"||k==="etc"||k==="name")render();   // 準備状況・ボタンの状態が変わる項目だけ描き直す（入力中のフォーカスを奪わない）
  }
  async function doSlide(code){
    if(VIEW_KEY||!S.slideCols)return;
    const v=S.v.find(x=>x.code===code), c=S.calc[code]; if(!v||!c)return;
    const x=nxOf(v), d=nxDate(v,c);
    if(!x.name||!x.plate_no){alert("後継車の車種名とナンバーを入れてください。");return;}
    if(d>todayStr()){alert("入替日（"+d.replace(/-/g,"/")+"）になったら押してください。それまで配車表は今の車のままです。");return;}
    const sp=spanning(code,d);
    if(sp.length){alert("入替日 "+d.replace(/-/g,"/")+" に今の車の貸出が残っています（"+sp.map(r=>r.start_date+"〜"+r.end_date).join("、")+"）。\n返却が終わってから押してください。");return;}
    const fut=(S.res[code]||[]).filter(r=>ts(r.start_date)>=ts(d));
    const notReady=[["整備","maint_status"],["引取","pickup_status"],["準備","prep_status"]].filter(([,f])=>{const p4=String(x.plate_no).match(/(\d{1,4})\s*$/),pr=p4&&S.proc.find(r=>{const m=String(r.plate||"").match(/(\d{1,4})\s*$/);return m&&m[1]===p4[1];});return !pr||pr[f]!=="OK";}).map(([l])=>l).concat(x.etc?[]:["ETC"]);
    if(!confirm(v.name+" "+plate4(v)+" → "+x.name+" "+x.plate_no+"\n入替日 "+d.replace(/-/g,"/")+"\n\n・配車表の枠・予約・OTA・アドミン設定はそのまま\n・車両マスタの車種名・ナンバー・年式・走行・車検・仕入額を後継車に変えます\n・入替日以降の予約 "+fut.length+" 件のナンバー表示も変えます\n・今の車の成績は入替履歴に保存します"+(notReady.length?"\n\n⚠ まだ ✓ になっていない項目："+notReady.join("・"):"")+"\n\nスライドしますか？"))return;
    const now=new Date().toISOString(), mv=n(v.sale_price)!=null?n(v.sale_price):c.nowExit;
    const keep=["name","plate_no","year","grade","color","current_mileage","inspection_due_date","purchase_price","purchase_date","acquire_type","lease_monthly","sale_price","sale_date","sale_plan_date","sale_expected","sale_dest","life_limit_km","life_flag","exit_type","chassis_no","specs","swapped_at"];
    const old={}; keep.forEach(k=>{if(k in v)old[k]=v[k];});
    const stats={from:v.swapped_at||v.purchase_date||DATA_FROM,to:d,rev:Math.round(c.revDone||0),buy:c.buy,exit:mv!=null?Math.round(mv):null,profit:c.buy!=null&&mv!=null?Math.round(mv+c.revDone-c.buy):null,odo:c.odo,rents:c.rents,maint:Math.round(c.mCost||0)};
    let r=await sb.from("bt_vehicle_swaps").insert({code,swapped_at:d,old,new:x,stats});
    if(r.error){setStatus("スライドできませんでした（入替履歴を保存できません）："+r.error.message);return;}
    r=await sb.from("bt_vehicles").update({name:x.name,plate_no:x.plate_no,year:x.year||"",grade:"",color:"",current_mileage:x.mileage??0,inspection_due_date:x.shaken||null,
      purchase_price:x.price??null,purchase_date:d,acquire_type:x.acq==="lease"?"lease":"buy",lease_monthly:0,sale_price:null,sale_date:null,sale_plan_date:null,sale_expected:null,sale_dest:null,
      life_limit_km:null,life_flag:null,exit_type:"sell",chassis_no:null,specs:x.mileage!=null?{odo_at:d}:{},swapped_at:d,next_car:null,updated_at:now}).eq("code",code);
    if(r.error){setStatus("⚠ 車両マスタを変えられませんでした："+r.error.message);return;}
    let err=null; const ids=fut.map(q=>q.id);
    if(ids.length){({error:err}=await sb.from("bt_reservations").update({plate_no:x.plate_no}).in("id",ids));
      if(!err)({error:err}=await sb.from("bt_tasks").update({"No":x.plate_no,updated_at:now}).in("予約番号",ids).eq("assigned_vehicle",code));}
    if(S.stop&&S.stop[code])await setStopEnd(code,dstr(ts(d)-DAY));
    setStatus(err?"⚠ 予約のナンバー表示を一部変えられませんでした："+err.message:"✅ "+x.name+" "+x.plate_no+" にスライドしました（予約 "+ids.length+" 件のナンバーも変更）");
    S.loaded=false; await load(true); render();
  }
  // 入替履歴（旧車の成績）
  function swapsHtml(){
    if(!S.swaps||!S.swaps.length)return '';
    return '<div class="vl-rl2 sw"><div class="gh">入替履歴<b>'+S.swaps.length+'</b></div>'+S.swaps.map(s=>{const o=s.old||{},w=s.new||{},t=s.stats||{};
      return '<div class="rw"><div class="nmc"><span class="nm">'+e(o.name||"")+' <small>'+e(plate4({plate_no:o.plate_no}))+'</small> → '+e(w.name||"")+' <small>'+e(plate4({plate_no:w.plate_no}))+'</small></span></div>'
        +'<div class="nums"><span><i>入替日</i>'+ymd(ts(s.swapped_at))+'</span><span><i>累計売上</i>'+man(t.rev)+'</span><span><i>最終利益</i><b class="'+(t.profit<0?'r':'')+'">'+(t.profit!=null?(t.profit>0?'+':'')+man(t.profit):'—')+'</b></span></div></div>';}).join('')+'</div>';
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
    kb.addEventListener("click",ev=>{if(ev.target.closest&&ev.target.closest(".vl-host"))return;   // 仕入候補・タイヤ・ETC の画面は procurement.html 側で処理

      const t=ev.target;
      if(t.closest(".vl-odobox:not(.bad)>summary")){S.odoOpen=!t.closest("details").open;return;}
      const os=t.closest("[data-odosave]"); if(os){saveOdo(os.closest(".vl-odo"));return;}
      const fs=t.closest("[data-fsave]"); if(fs){saveForm(fs.closest("[data-code]").dataset.code,fs.closest("section"));return;}
      const og=t.closest("[data-ovg]"); if(og){S.ovg=og.dataset.ovg;render();return;}
      const ob=t.closest("[data-ovb]"); if(ob){const k=ob.dataset.ovb, v=k==="all"?null:isNaN(+k)?k:+k; S.ovb=(v===S.ovb)?null:v; render();return;}
      const os2=t.closest("[data-ovs]"); if(os2){S.ovs=os2.dataset.ovs;render();return;}
      const sc=t.closest("[data-sec]"); if(sc){goSec(sc.dataset.sec);return;}
      const sd=t.closest("[data-slide]"); if(sd&&!sd.disabled){doSlide(sd.dataset.slide);return;}
      const rl=t.closest("[data-relay]"); if(rl&&!rl.disabled){doRelay(rl.dataset.relay,rl.closest("[data-code]"));return;}
      const ur=t.closest("[data-unrelay]"); if(ur){undoRelay(ur.dataset.unrelay);return;}
      const as=t.closest("[data-addstop]"); if(as){addStop(as.dataset.addstop);return;}
      const tk=t.closest("[data-tkstop]"); if(tk){const d=tk.closest(".tk").querySelector(".vl-tkd").value;if(!/^\d{4}-\d{2}-\d{2}$/.test(d)){setStatus("売止日を入れてください");return;}
        const cd=tk.dataset.tkstop;saveVal(cd,"sale_plan_date",dstr(addMon(ts(d),1))).then(()=>addStop(cd));return;}   // 決めたらそのまま配車表を売止日から止める（オーナー指示：判断＝配車表連携）   // 売却予定日＝売止日の1ヶ月後（売止＝売却の1ヶ月前のルール）
      const kp=t.closest("[data-tkkeep]"); if(kp){const x=Number(String(kp.closest(".tk").querySelector(".vl-tkl").value).replace(/[^\d]/g,""));if(!x){setStatus("リミット（km）を入れてください");return;}
        saveVal(kp.dataset.tkkeep,"life_limit_km",x);return;}
      const ds=t.closest("[data-delstop]"); if(ds){delStop(ds.dataset.delstop);return;}
      const pq=t.closest("[data-pl]"); if(pq){plPop(pq.dataset.pl);return;}
      const mk=t.closest("[data-mk]"); if(mk){ev.stopPropagation&&ev.stopPropagation();mkPop(mk.dataset.mk);return;}
      const g=t.closest("[data-goto]"); if(g&&!t.closest(".vl-card")&&!t.closest("input,select,label")){gotoCard(g.dataset.goto);return;}
      const sf=t.closest("[data-stf]"); if(sf){S.stf=S.stf===sf.dataset.stf?"all":sf.dataset.stf;S.sec="karte";saveUi();render();return;}
      const br=t.closest("[data-br]"); if(br){S.brand=br.dataset.br;saveUi();render();return;}
      if(t.closest(".vl-gear")){S.showCfg=!S.showCfg;render();return;}
      if(t.closest("[data-cfgclose]")){S.showCfg=false;render();return;}
      if(t.closest("[data-cfgsave]")){saveCfg(t.closest(".vl-cfg"));return;}
      const aq=t.closest("[data-acq]"); if(aq&&!aq.disabled){saveVal(aq.closest(".vl-card").dataset.code,"acquire_type",aq.dataset.acq);return;}
      const ex=t.closest("[data-exit]"); if(ex&&!ex.disabled){const code=ex.closest(".vl-card").dataset.code,v=S.v.find(x=>x.code===code);
        if(ex.dataset.exit==="return"&&v&&v.exit_type!=="return"&&!confirm((v.name||code)+" をリース返却済みにして、スケジュールの一覧から外します（履歴は残ります）。よろしいですか？"))return;
        saveVal(code,"exit_type",ex.dataset.exit);return;}
      const dm=t.closest("[data-dmg]"); if(dm){const img=dm.querySelector("img");if(img)openViewer(img.src);return;}
      const tg=t.closest("[data-tog]"); if(tg){const code=tg.closest(".vl-card").dataset.code;
        if(S.open.has(code))S.open.delete(code); else{S.open.add(code); if(S.detail[code]===undefined||S.detail[code].err)loadDetail(code);}
        rerenderCard(code); return;}
    });
    kb.addEventListener("toggle",ev=>{const t=ev.target;if(!t.classList||!t.classList.contains("nx"))return;if(t.open)NX_OPEN.add(t.dataset.code);else NX_OPEN.delete(t.dataset.code);},true);   // toggle は伝わらないので capture で受ける
    kb.addEventListener("change",ev=>{if(ev.target.closest&&ev.target.closest(".vl-host"))return;   // 仕入候補・タイヤ・ETC の画面は procurement.html 側で処理
const t=ev.target;
      if(t.classList.contains("vl-secsel")){goSec(t.value);return;}
      if(t.classList.contains("vl-sort")){S.sort=t.value;saveUi();render();return;}
      if(t.dataset.nx){saveNx(t);return;}
      if(t.dataset.f){saveField(t.closest("[data-code]").dataset.code,t);}
    });
    kb.addEventListener("keydown",ev=>{if(ev.target.closest&&ev.target.closest(".vl-host"))return;   // 仕入候補・タイヤ・ETC の画面は procurement.html 側で処理
if(ev.key==="Enter"&&ev.target.dataset.f)ev.target.blur();if(ev.key==="Enter"&&ev.target.dataset.odo)saveOdo(ev.target.closest(".vl-odo"));});
    kb.addEventListener("focusin",ev=>{if(ev.target.closest&&ev.target.closest(".vl-host"))return;   // 仕入候補・タイヤ・ETC の画面は procurement.html 側で処理
const t=ev.target;if(t.dataset.t==="number"||/_km$/.test(t.dataset.cfg||"")||t.dataset.cls)t.value=t.value.replace(/[^\d]/g,"");});
    // リアルタイム：車両・予約（配車表）・整備・設定が変わったら、開いている人全員の画面を自動で更新（入力中は待つ）
    let tm=null; const visible=()=>$("viewKarte").style.display!=="none";
    const refresh=()=>{clearTimeout(tm);tm=setTimeout(()=>{const ae=document.activeElement;
      if(ae&&ae.closest&&ae.closest("#viewKarte")&&/INPUT|SELECT/.test(ae.tagName)){refresh();return;}
      if(!S.loaded)return; load(true).then(()=>{S.updated=new Date();if(visible()&&!HOSTED.includes(S.sec))render();}).catch(()=>{});},4000);};
    const ch=sb.channel("vl-rt");
    ["bt_vehicles","bt_reservations","bt_fleet","bt_vehicle_maintenance","bt_vehicle_life_settings"].forEach(t=>ch.on("postgres_changes",{event:"*",schema:"public",table:t},refresh));
    ch.subscribe();
    const rl=$("reload"); if(rl)rl.addEventListener("click",()=>{if(S.view&&$("viewKarte").style.display!=="none"){S.loaded=false;S.detail={};show(S.view);}});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind); else bind();
  return {show,load,surveySpec,wYear,MARKET_RULE,_S:S};
})();
