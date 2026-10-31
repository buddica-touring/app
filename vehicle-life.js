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
  const DATA_FROM="2026-08-03";          // 予約・売上データの開始日
  const KM_MAX=3000, KM_PER_DAY_MAX=1000; // これを超える1予約の走行は入力ミス扱い（予測から外す）
  const DEF={default_limit_km:100000,over_limit_km:150000,class_limits:{},lead_months:3,shaken_rule:"next",buy_rate:75};   // オーナー指示 2026-10-30：全車10万km。その時点で超えていた車は15万km＋フラグ
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
    nodata:{lb:"予測待ち",ic:"⚪",cls:"nodata",rank:4}};
  const DMG_T={scratch:"擦り傷",dent:"へこみ",chip:"欠け",stone_chip:"飛び石",break:"破損"};
  const DMG_S={minor:"軽",moderate:"中",severe:"重"};

  async function all(make){let out=[],from=0;for(;;){const {data,error}=await make().range(from,from+999);if(error)throw error;out=out.concat(data||[]);if(!data||data.length<1000)break;from+=1000;}return out;}

  async function load(force){
    if(S.loading&&!force)return S.loading;
    S.loading=(async()=>{
      const ymNow=todayStr().slice(0,7);
      const [veh,fleet,res,mt,kpi,cfg,dmg,mk]=await Promise.all([
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
      S.maint={}; mt.forEach(m=>{(S.maint[m.vehicle_code]=S.maint[m.vehicle_code]||[]).push(m);});
      S.kpi={}; ((kpi&&kpi.data)||[]).forEach(k=>{S.kpi[k.vehicle_code]=k.active;});
      S.cfgSaved=!!(cfg&&cfg.data); if(cfg&&cfg.data)S.cfg=Object.assign({},DEF,cfg.data,{class_limits:cfg.data.class_limits||{}});
      S.mk={}; S.mkOn=!!(mk&&!mk.error); if(S.mkOn)(mk.data||[]).forEach(m=>{(S.mk[m.vehicle_code]=S.mk[m.vehicle_code]||[]).push(m);});
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
      let odoMax=0,odoRetT=null; done.forEach(r=>{const o=n(r.end_odo);if(o&&o>odoMax&&o-base<=20000){odoMax=o;odoRetT=ts(r.end_date);}});
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
      S.calc[v.code]={odoSrc,mkt,rate,dayGross,daysLeft,kmEnd,nowExit,endExit,vsNow,vsLater,sellNow,overBuy,stopT,ride,odo,limit,flag,runDays,heldDays,nDone:done.length,cost,buy,recov,monKm,future,limitT,shaken,byShaken,saleT,why,procT,st,
        revDone,revBooked,mCost,fixed,fixedMon,months,gross,exitPrice,total,susp:rs.filter(suspect).length,rents:rs.length};
    });
  }

  // ---------- 表示 ----------
  function show(view){
    S.view="karte"; if(view==="swap")S.sec="swap";
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
  const SECS=[["全体",[["sum","📊","サマリ"]]],["売却・入替",[["plan","📅","個体別スケジュール"],["swap","🗓","売り止め・入替予定"],["relay","🔁","リレー入替"]]],["車両",[["karte","🚗","車両カルテ"],["shaken","📋","車検証"]]],["お金",[["kpi","💴","生涯成績"],["market","📈","相場"]]],["設定",[["rule","⚙","ルール"]]]];
  const secBadge=k=>{const a=S.v.filter(v=>S.calc[v.code].st!=="sold");
    if(k==="swap")return a.filter(v=>["sell","prep"].includes(S.calc[v.code].st)).length;
    if(k==="relay")return a.filter(v=>!v.relay_to&&!isSucc(v.code)&&["sell","prep"].includes(S.calc[v.code].st)).length;
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
    h+='<div class="vl-foot live">🟢 リアルタイム共有（配車表・点検の更新が自動で反映されます）'+(S.updated?'　最終更新 '+String(S.updated.getHours()).padStart(2,"0")+':'+String(S.updated.getMinutes()).padStart(2,"0"):'')+'</div></div></div>';
    body.innerHTML=h;
    if(S.sec==="karte")S.open.forEach(code=>{if(S.detail[code]===undefined)loadDetail(code);});
  }
  function secHtml(){
    switch(S.sec){
      case "karte":return karteHtml();
      case "plan":return planHtml();
      case "swap":return swapHtml();
      case "relay":return relayHtml();
      case "kpi":return kpiHtml();
      case "market":return marketHtml();
      case "shaken":return shakenHtml();
      case "rule":return cfgHtml(true);
      default:return sumHtml();
    }
  }
  const nm=v=>'<span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type)+'</span><span class="nm">'+e(v.name)+' <small>'+e(plate4(v))+'</small></span>';
  function sumHtml(){
    const a=S.v.filter(v=>S.calc[v.code].st!=="sold"), C=v=>S.calc[v.code], cnt=k=>a.filter(v=>C(v).st===k).length, G=S.global;
    const sum=f=>a.reduce((s,v)=>s+(f(C(v),v)||0),0);
    const relayMiss=secBadge("relay"), relayOk=a.filter(v=>v.relay_to).length;
    const shOk=a.filter(v=>!shakenOf(v).some(o=>o.miss)).length, buyIn=a.filter(v=>n(v.purchase_price)!=null).length;
    const mkN=a.filter(v=>C(v).mkt&&C(v).mkt.now).length;
    const next=a.filter(v=>C(v).stopT!=null).sort((x,y)=>C(x).stopT-C(y).stopT).slice(0,5);
    let h='<div class="vl-lead">売り止め＝走行リミット（または車検）の1ヶ月前。入替は同じクラスの車をリレーで引き継ぎ、販売を止めません。売上は '+DATA_FROM.replace(/-/g,"/")+' 以降の実績、走行は全車共通の月 '+km(G.monKm)+'km で予測しています。</div>';
    h+='<h4 class="vl-h4">全体の状況 <small>（'+a.length+'台・自動更新）</small></h4><div class="vl-cards">';
    const card=(sec,title,body,alert)=>'<button class="vl-dc'+(alert?" al":"")+'" data-sec="'+sec+'"><div class="t">'+title+'</div>'+body+'</button>';
    h+=card("plan","📅 個体別スケジュール",'<div class="row"><b class="red">'+cnt("sell")+'</b><span>売り止め</span><b class="org">'+cnt("prep")+'</b><span>入替準備</span><b class="yel">'+cnt("soon")+'</b><span>半年以内</span></div>'
      +(next.length?'<ul>'+next.map(v=>'<li>'+nm(v)+'<em>'+ymd(C(v).stopT)+'</em></li>').join("")+'</ul>':''),cnt("sell")>0);
    h+=card("relay","🔁 リレー入替",'<div class="row"><b>'+relayOk+'</b><span>登録済み</span><b class="red">'+relayMiss+'</b><span>後継車 未定</span></div>',relayMiss>0);
    h+=card("kpi","💴 生涯成績（全車合計）",'<div class="row"><b>'+man(sum(c=>c.revDone))+'</b><span>売上</span><b>'+km(sum(c=>c.runDays))+'</b><span>稼働日数</span></div><div class="row"><b class="'+(sum(c=>c.gross)>=0?"grn":"red")+'">'+man(sum(c=>c.buy!=null?c.gross:null))+'</b><span>粗利（仕入額入力済み '+buyIn+'台）</span></div>',false);
    h+=card("market","📈 相場",'<div class="row"><b>'+mkN+'</b><span>調査済み</span><b class="org">'+secBadge("market")+'</b><span>今が売り時・仕入額超え</span></div>',secBadge("market")>0);
    h+=card("shaken","📋 車検証",'<div class="row"><b>'+shOk+'<small>/'+a.length+'</small></b><span>入力完了</span><b class="red">'+(a.length-shOk)+'</b><span>未入力あり</span></div>',a.length-shOk>0);
    h+=card("karte","🚗 走行予測（全車共通）",'<div class="row"><b>'+km(G.avgKm)+'<small>km</small></b><span>1予約</span><b>'+G.perMon.toFixed(1)+'<small>件</small></b><span>1台/月</span></div><div class="row"><b>'+km(G.monKm)+'<small>km</small></b><span>月間走行/台</span></div>',false);
    return h+'</div>';
  }
  const tbl=(head,rows)=>'<div class="vl-ctbl vl-dt"><table><thead><tr>'+head.map(x=>'<th>'+x+'</th>').join("")+'</tr></thead><tbody>'+rows.join("")+'</tbody></table></div>';
  // 個体別スケジュール（オーナー指示 2026-10-31：まず1台ずつの状況と予定をはっきり出す・UIUX重視）
  // 1台1枚。期限の近い順に「今すぐ対応／半年以内／稼働中／予測待ち」の帯に分け、今→2年先の帯グラフで 稼働・仕入・売り止め を色で見せる。
  // 今の走行（手入力）：返却メーターの記録がない車・記録より新しい値がある時に使う。current_mileage と specs.odo_at（日付）に保存
  const odoLb=c=>!c.odoSrc?'':c.odoSrc.k==="ret"?'返却 '+mdS(c.odoSrc.t):c.odoSrc.k==="man"?'手入力 '+mdS(c.odoSrc.t):'マスター';
  const mdS=t=>{if(t==null)return'';const d=new Date(t);return (d.getUTCMonth()+1)+'/'+d.getUTCDate();};
  const odoForm=(v,c)=>'<div class="vl-odo" data-code="'+e(v.code)+'"><input class="vl-ti" data-odo="km" inputmode="numeric" placeholder="'+(c.odo!=null?km(c.odo):'例 45,200')+'" aria-label="今のメーター（km）"><i>km</i><input class="vl-ti" type="date" data-odo="at" value="'+todayStr()+'" aria-label="見た日"><button type="button" data-odosave>保存</button></div>';
  function planHtml(){
    const t0=T0(), H=24, C=v=>S.calc[v.code];
    const a=S.v.filter(v=>C(v).st!=="sold").sort((x,y)=>(C(x).stopT??9e15)-(C(y).stopT??9e15)||STATUS[C(x).st].rank-STATUS[C(y).st].rank);
    if(!a.length)return '<h4 class="vl-h4">📅 個体別スケジュール</h4><div class="vl-empty">表示できる車両がありません。</div>';
    const md=t=>{const d=new Date(t);return (d.getUTCFullYear()!==new Date(t0).getUTCFullYear()?String(d.getUTCFullYear()).slice(2)+'/':'')+(d.getUTCMonth()+1)+'/'+d.getUTCDate();};
    const left=t=>{const d=Math.round((t-t0)/DAY),m=d/30.44;return d<0?'<em class="over">'+(-d)+'日過ぎ</em>':d===0?'<em class="over">今日</em>':'<em>あと'+(m<1?d+'日':m<24?m.toFixed(1)+'ヶ月':(m/12).toFixed(1)+'年')+'</em>';};
    const mkm=x=>x==null?'—':(x/1e4).toFixed(x>=1e5?0:1)+'万';
    const pos=t=>Math.max(0,Math.min(100,(t-t0)/MON/H*100));
    const seg=(f,t,cls)=>{if(f==null||t==null)return'';const l=pos(f),r=pos(t);return r>l?'<i class="'+cls+'" style="left:'+l+'%;width:'+(r-l)+'%"></i>':'';};
    const why={走行:"走行リミット",車検:"車検",手動:"手動"};
    const bar=c=>{if(c.stopT==null)return '<div class="tl none"><span>走行の実績がたまると予定が出ます</span></div>';
      return '<div class="tl">'+seg(t0,c.procT,"run")+seg(Math.max(t0,c.procT),c.stopT,"prep")+seg(Math.max(t0,c.stopT),c.saleT,"stop")
        +(c.procT>t0&&pos(c.procT)<100?'<b class="mk p" style="left:'+pos(c.procT)+'%"></b>':'')
        +(pos(c.stopT)<100?'<b class="mk s" style="left:'+pos(c.stopT)+'%"></b>':'')
        +(c.shaken!=null&&c.shaken>t0&&pos(c.shaken)<100?'<b class="mk k" style="left:'+pos(c.shaken)+'%" title="車検 '+ymd(c.shaken)+'"></b>':'')+'</div>';};
    const card=v=>{const c=C(v),st=STATUS[c.st],nx=relayOf(v.code),hot=["sell","prep"].includes(c.st);
      const succ=nx?'<span class="ok">🔁 '+e(nx.name||nx.code)+' '+e(plate4(nx))+(v.service_to?' '+md(ts(v.service_to)+DAY)+'〜':'')+'</span>':hot?'<span class="ng">後継車 未定</span>':'';
      return '<button class="vl-pc '+st.cls+'" data-goto="'+e(v.code)+'">'
        +'<div class="who">'+nm(v)+'<span class="vl-pill2 '+st.cls+'">'+st.ic+' '+st.lb+'</span></div>'
        +'<div class="when">'+(c.stopT!=null?'<small>売り止め</small><b>'+ymd(c.stopT)+'</b>'+left(c.stopT):'<small>売り止め</small><b class="mut">—</b>')+'</div>'
        +bar(c)
        +'<div class="meta"><span>走行 <b>'+mkm(c.odo)+'</b>/'+mkm(c.limit)+'km'+(c.flag?' ⚑':'')+(c.odoSrc&&c.odoSrc.k!=="ret"?'<small class="'+(c.odoSrc.k==="master"?'ng2':'')+'">（'+odoLb(c)+'）</small>':'')+'</span>'
          +(c.procT!=null?'<span class="'+(c.procT<=t0?'org':'')+'">仕入開始 <b>'+md(c.procT)+'</b></span>':'')
          +(c.saleT!=null?'<span>終了 <b>'+md(c.saleT)+'</b>'+(c.why?'（'+(why[c.why]||e(c.why))+'）':'')+'</span>':'')
          +(c.shaken!=null?'<span>車検 <b>'+md(c.shaken)+'</b></span>':'')
          +'<span>'+(c.ride?'♻ 乗り潰し':'💴 売却')+'</span>'+succ+'</div></button>';};
    const G=[["now","今すぐ対応",v=>["sell","prep"].includes(C(v).st)],["soon","半年以内に売り止め",v=>C(v).st==="soon"],["run","稼働中",v=>C(v).st==="run"],["nodata","予測待ち",v=>C(v).st==="nodata"]];
    const ax=[[0,"今日"],[6,"半年後"],[12,"1年後"],[18,"1年半後"],[24,"2年後"]].map(([m,l])=>'<span style="left:'+(m/H*100)+'%">'+l+'</span>').join("");
    const noOdo=a.filter(v=>{const s=C(v).odoSrc;return !s||s.k==="master";}).sort((x,y)=>(C(x).odo==null?0:1)-(C(y).odo==null?0:1));
    let h='<h4 class="vl-h4">📅 個体別スケジュール <small>売り止めが近い順・押すと車両カルテ</small></h4>'
      +(noOdo.length?'<details class="vl-odobox"'+((S.odoOpen??(noOdo.length<=8||noOdo.some(v=>C(v).odo==null)))?' open':'')+'><summary>📏 返却メーターの記録がない車 <b>'+noOdo.length+'台</b><span>今のメーターを入れると予定が正確になります</span></summary>'
        +noOdo.map(v=>{const c=C(v);return '<div class="r"><div class="who">'+nm(v)+'<small>'+(c.odo!=null?'今 '+km(c.odo)+'km（マスター）':'走行なし')+'</small></div>'+odoForm(v,c)+'</div>';}).join("")+'</details>':'')
      +'<div class="vl-legend"><span><i class="run"></i>稼働</span><span><i class="prep"></i>仕入・入替準備</span><span><i class="stop"></i>売り止め〜終了</span><span><b class="mk k"></b>車検</span></div>'
      +'<div class="vl-plan"><div class="vl-axis"><div></div><div></div><div class="ax">'+ax+'</div></div>';
    G.forEach(([k,lb,f])=>{const l=a.filter(f);if(!l.length)return;h+='<div class="vl-pg '+k+'">'+lb+'<b>'+l.length+'台</b></div>'+l.map(card).join("");});
    return h+'</div><div class="vl-lead">売り止め＝終了（走行リミット・車検・手動のうち早い方）の1ヶ月前。仕入開始＝売り止めの'+(S.cfg.lead_months||3)+'ヶ月前。走行は全車共通の月 '+km(S.global.monKm)+'km で予測。</div>';
  }
  function kpiHtml(){
    const a=S.v.filter(v=>S.calc[v.code].st!=="sold").sort((x,y)=>(S.calc[y.code].revDone)-(S.calc[x.code].revDone));
    const inp=(v,k,type,ph)=>'<input class="vl-ti" type="'+(type==="number"?"text":type)+'"'+(type==="number"?' inputmode="numeric"':'')+' data-f="'+k+'" data-t="'+type+'" value="'+e(v[k]==null?"":type==="number"?Number(v[k]).toLocaleString():v[k])+'" placeholder="'+(ph||"")+'"'+(S.lifeCols?'':' disabled')+'>';
    return '<h4 class="vl-h4">💴 生涯成績 <small>売上順・仕入額と仕入日はこの表で直接入力できます（欄から外れると保存）</small></h4>'+tbl(["車両","売上","稼働日数","原価","粗利","回収","仕入額（円）","仕入日"],a.map(v=>{const c=S.calc[v.code];
      return '<tr data-goto="'+e(v.code)+'" data-code="'+e(v.code)+'"><td>'+nm(v)+'</td><td>'+man(c.revDone)+'</td><td>'+c.runDays+'日</td><td>'+(c.buy!=null?man(c.cost):'—')+'</td><td class="'+(c.buy==null?'':c.gross>=0?'grn':'red')+'">'+(c.buy!=null?man(c.gross):'—')+'</td><td>'+(c.recov!=null?Math.round(c.recov*100)+'%':'—')+'</td><td>'+inp(v,"purchase_price","number","未入力")+'</td><td>'+inp(v,"purchase_date","date")+'</td></tr>';}));
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
    h+='<div class="vl-stat"><b>全車共通の予測</b>　1予約 平均 <b>'+km(G.avgKm)+'km</b> × 1台あたり <b>'+G.perMon.toFixed(1)+'件/月</b> ＝ <b>月 '+km(G.monKm)+'km</b><small>実績 '+G.days+'日・予約 '+G.nRes+'件・走行実測 '+G.n+'件から計算（営業日数が増えるほど精度が上がります）</small>'+(nNow?'<span class="vl-flagline hot">💡 相場から見て今が売り時の車 '+nNow+'台</span>':'')+(nFlag?'<span class="vl-flagline">⚑ '+km(S.cfg.default_limit_km)+'kmを既に超えている車 '+nFlag+'台は、リミット'+km(S.cfg.over_limit_km)+'kmで計算中</span>':'')+'</div>';
    h+='<div class="vl-bar1">'
      +['all','BT','HDM'].map(b=>'<button class="chip'+(S.brand===b?" on":"")+'" data-br="'+b+'">'+(b==="all"?"全体 "+S.v.length:b==="BT"?"🟢 BT":"🔵 HDM")+'</button>').join("")
      +'<select class="vl-sort" aria-label="並び順">'+[["sale","売り止め順"],["class","クラス順"],["km","走行距離順"],["profit","粗利順"]].map(([k,l])=>'<option value="'+k+'"'+(S.sort===k?" selected":"")+'>'+l+'</option>').join("")+'</select>'
      +'<button class="vl-gear" title="設定">⚙</button></div>';
    if(S.stf!=="all")h+='<div class="vl-filt">'+STATUS[S.stf].ic+' '+STATUS[S.stf].lb+'のみ表示中 <button class="vl-clr" data-stf="all">すべて表示 ✕</button></div>';
    if(S.showCfg)h+=cfgHtml();
    const list=filtered();
    if(!list.length)h+='<div class="vl-empty">該当する車両はありません。</div>';
    list.forEach(v=>{h+=cardHtml(v);});
    h+='<div class="vl-foot">売上は '+DATA_FROM.replace(/-/g,"/")+' 以降の実績。予測は開くたびに最新の実績で計算し直します。</div>';
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
      +(c.flag?'<span class="vl-tag flag">⚑ '+e(c.flag)+(c.ride?'':'・乗り潰し候補')+'</span>':'')+(c.ride?'<span class="vl-tag ride">♻ 乗り潰し</span>':'')+(c.mkt?'<span class="vl-tag mk'+(c.sellNow?' hot':'')+'">📊 相場 '+(c.mkt.now?man(c.mkt.now.p25)+'〜'+man(c.mkt.now.p75):man(c.mkt.median))+(c.sellNow?'・今が売り時':'')+'</span>':'')+(c.overBuy?'<span class="vl-tag hot">💡 買取見込みが仕入額超え</span>':'')
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
      +kv("今の走行",c.odo!=null?km(c.odo)+'km':'—',odoLb(c)||'記録なし')
      +kv("月間走行（全車共通）",km(c.monKm)+'km','1予約 '+km(S.global.avgKm)+'km × 月 '+S.global.perMon.toFixed(1)+'件')
      +kv("この車の予約",(S.res[v.code]||[]).length+'件','この先60日の予約 '+c.future+'件')
      +kv("リミット",km(c.limit)+'km',c.flag?'⚑ '+e(c.flag)+' → 延長リミット':n(v.life_limit_km)?'この車だけの設定':(S.cfg.class_limits&&S.cfg.class_limits[v.type]?'クラス'+e(v.type)+'の設定':'全体の既定'))
      +kv("リミット到達",c.limitT!=null?ymFar(c.limitT):'—',c.limitT!=null&&c.limitT>addMon(T0(),60)?'今のペースだと'+ym(c.limitT):'')
      +kv("売り止め → 仕入れ",c.stopT!=null?ymFar(c.stopT)+'売り止め':'—',c.procT!=null?'終了の1ヶ月前に予約を止める／その'+(S.cfg.lead_months||3)+'ヶ月前（'+ymFar(c.procT)+'）に同クラスの仕入れ開始':'')
      +kv("車検ルール",c.byShaken!=null?ym(c.byShaken)+'の車検で終了':'車検は通す',S.cfg.shaken_rule==="always"?'車検前に必ず売る設定':S.cfg.shaken_rule==="ignore"?'車検は見ない設定':'次の車検期間中にリミットに達するなら車検前に売る')
      +'</div><div class="vl-odo-l"><span>今のメーターを手で入れる</span>'+odoForm(v,c)+'</div>';
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
    // 市場価格（ブラウザで週1回調査した結果）
    {
      const m=c.mkt, sp=surveySpec(v,c);
      const condTxt=b=>e(sp.name)+'・'+(sp.years?sp.years[0]+'〜'+sp.years[1]+'年式':'年式不明')+'・'+(b?km(b[0])+'〜'+km(b[1])+'km':'走行不明')+'・'+sp.must.filter(Boolean).map(e).join('・')+(sp.mustMiss?'・<span class="miss">必須条件 '+sp.mustMiss+'つ未入力</span>':'');
      const box=(lb,x,b,exit)=>'<div class="big"><span>'+lb+'</span>'+(x?'<b>'+man(x.p25)+'〜'+man(x.p75)+'</b><em class="md">中央値 '+man(x.med)+'</em>'+(x.prev!=null&&Math.round(x.med-x.prev)?'<em class="'+(x.med>x.prev?"up":"dn")+'">'+(x.med>x.prev?'▲':'▼')+man(Math.abs(x.med-x.prev))+'</em>':'')
          +'<small>'+x.n+'台（全体 '+man(x.min)+'〜'+man(x.max)+'）・'+rankTxt(x.n)+'・'+e(x.sources.join("/"))+' '+e(String(x.when).slice(5,10).replace("-","/"))+'調査</small>'+(x.cond&&x.cond.note&&/広げ/.test(x.cond.note)?'<small class="miss">'+e(x.cond.note.split('／').filter(t=>/広げ|参考/.test(t)).join('／'))+'</small>':'')+(exit!=null?'<small class="ex">買取見込み '+yen(exit)+'（中央値×'+Math.round(c.rate*100)+'%）</small>':''):'<b class="no">未調査</b>')
          +'<small class="cond">条件：'+condTxt(b)+'・修復歴なし</small></div>';
      h+='<section><h4>📊 市場価格（一般小売の相場感）</h4>';
      if(!S.mkOn)h+='<div class="vl-warn">相場の保存先（データベースの追加）がまだありません。</div>';
      {const ms=shakenOf(v).filter(o=>o.miss);if(ms.length)h+='<div class="vl-warn">車検証の未入力 '+ms.length+'項目：'+ms.map(o=>e(o.l)).join('・')+'<br><small>配車表の車両マスター（基本情報）で入れると、相場の検索条件に使われます。</small></div>';}
      h+='<details class="vl-rule"><summary>この基準で検索しています（あくまで目安）</summary><dl>'+MARKET_RULE.map(([k,t])=>'<dt>'+e(k)+'</dt><dd>'+e(t)+'</dd>').join("")+'</dl></details>';
      h+='<div class="vl-mkt">'+box('今の走行で売ると',m&&m.now,sp.now,c.nowExit)+(c.ride?'':box('終了時（'+(c.saleT!=null?ymFar(c.saleT):'—')+'）に売ると',m&&m.end,sp.end,c.endExit))+'</div>';
      if(c.vsNow!=null&&c.vsLater!=null)h+='<div class="vl-vs'+(c.sellNow?' now':'')+'"><div><span>今売る</span><b>'+yen(c.vsNow)+'</b><small>粗利＋買取見込み</small></div><div><span>'+(c.ride?'乗り潰す':'売り止めまで走らせる')+'</span><b>'+yen(c.vsLater)+'</b><small>あと'+Math.round(c.daysLeft)+'日 × 粗利'+yen(c.dayGross)+'/日</small></div><p>'+(c.sellNow?'💡 今売った方が生涯利益が <b>'+yen(c.vsNow-c.vsLater)+'</b> 多い見込み':'走らせた方が <b>'+yen(c.vsLater-c.vsNow)+'</b> 多い見込み')+'</p></div>';
      else if(m&&c.buy==null)h+='<div class="vl-note">仕入額を入れると「今売る／走らせる」の比較が出ます。</div>';
      if(c.overBuy)h+='<div class="vl-warn hot">💡 買取見込み '+yen(c.nowExit)+' が仕入額 '+yen(c.buy)+' を上回っています</div>';
      if(sp.urlNow||sp.urlEnd)h+='<div class="vl-mk"><span>カーセンサーで見る</span>'+(sp.urlNow?'<a target="_blank" rel="noopener" href="'+e(sp.urlNow)+'">今の走行 ↗</a>':'')+(sp.urlEnd?'<a target="_blank" rel="noopener" href="'+e(sp.urlEnd)+'">終了時の走行 ↗</a>':'')+'</div>';
      else if(S.lifeCols)h+='<div class="vl-note">カーセンサーの車種コードが未登録です（初回の調査で自動登録されます）。</div>';
      h+='</section>';
    }
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
      h+='</section>';
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

  function cfgHtml(asSec){
    const c=S.cfg, cls=M_ORDER.filter(k=>k!=="送迎"&&S.v.some(v=>v.type===k));
    return '<div class="vl-cfg"><h4>⚙ 売却・入替のルール（全員共通）</h4>'
      +(S.cfgSaved?'':'<div class="vl-warn">設定を保存するにはデータベースの追加（sql/bt_vehicle_lifecycle.sql）が必要です。今は既定値で計算しています。</div>')
      +'<label class="vl-f"><span>走行リミット（既定）</span><span class="in"><input inputmode="numeric" data-cfg="default_limit_km" value="'+km(c.default_limit_km)+'"><i>km</i></span></label>'
      +'<label class="vl-f"><span>すでに既定を超えていた車のリミット</span><span class="in"><input inputmode="numeric" data-cfg="over_limit_km" value="'+km(c.over_limit_km)+'"><i>km</i></span></label>'
      +'<div class="vl-sub">クラス別のリミット（空欄＝既定）</div><div class="vl-cls">'+cls.map(k=>'<label><span class="m-badge" style="background:'+clsCol(k)+'">'+k+'</span><input inputmode="numeric" data-cls="'+k+'" value="'+(c.class_limits&&c.class_limits[k]?km(c.class_limits[k]):'')+'" placeholder="'+km(c.default_limit_km)+'"></label>').join("")+'</div>'
      +'<label class="vl-f"><span>買取見込み＝小売相場の何％か</span><span class="in"><input inputmode="numeric" data-cfg="buy_rate" value="'+(c.buy_rate||DEF.buy_rate)+'"><i>%</i></span></label>'
      +'<label class="vl-f"><span>仕入れを動かす時期</span><span class="in"><select data-cfg="lead_months">'+[1,2,3,4,5,6].map(m=>'<option value="'+m+'"'+(+c.lead_months===m?" selected":"")+'>売却の'+m+'ヶ月前</option>').join("")+'</select></span></label>'
      +'<label class="vl-f"><span>車検の扱い</span><span class="in"><select data-cfg="shaken_rule">'+[["next","次の車検期間中にリミットに達するなら、車検前に売る"],["always","車検の前に必ず売る"],["ignore","車検は見ない（走行だけ）"]].map(([k,l])=>'<option value="'+k+'"'+(c.shaken_rule===k?" selected":"")+'>'+l+'</option>').join("")+'</select></span></label>'
      +'<div class="vl-cfg-ft">'+(asSec?'':'<button class="btn" data-cfgclose="1">閉じる</button>')+'<button class="btn p" data-cfgsave="1"'+(S.cfgSaved?'':' disabled')+'>保存</button></div></div>';
  }

  // ---------- 入替タブ ----------
  function swapHtml(){
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
    return h;
  }

  // ---------- 入替リレー ----------
  const dstr=t=>new Date(t).toISOString().slice(0,10);
  function relayOf(code){const v=S.v.find(x=>x.code===code);return v&&v.relay_to?S.v.find(x=>x.code===v.relay_to)||{code:v.relay_to,name:v.relay_to}:null;}
  function isSucc(code){return S.v.some(x=>x.relay_to===code);}
  // 切替日 d をまたぐ予約（d より前に出て d 以降に返る）＝そのままでは切り替えられない
  function spanning(code,d){const t=ts(d);return (S.res[code]||[]).filter(r=>ts(r.start_date)<t&&ts(r.end_date)>=t);}
  function relayHtml(){
    const t0=T0();
    const due=S.v.filter(v=>{const c=S.calc[v.code];return c.st!=="sold"&&!isSucc(v.code)&&(v.relay_to||["sell","prep","soon"].includes(c.st));})
      .sort((a,b)=>(S.calc[a.code].stopT??9e15)-(S.calc[b.code].stopT??9e15));
    const miss=due.filter(v=>!v.relay_to&&["sell","prep"].includes(S.calc[v.code].st));
    let h='<h4 class="vl-h4">🔁 リレー入替（販売を止めない）</h4><div class="vl-relay">';
    h+='<div class="vl-note">新しい車を先に車両マスターに登録し、ここで「前の車 → 後継車」と切替日を決めます。切替日から後継車が配車表の同じ行に入り、それ以降の予約も自動で移るので、クラスの台数（OTA・BUDDICA管理画面の在庫）は減りません。'
      +(miss.length?'<br><b class="red">後継車が決まっていない入替が '+miss.length+' 台あります。</b>':'')+'</div>';
    if(!S.relayCols)h+='<div class="vl-warn">リレー用の列がまだDBにありません（sql/bt_vehicle_lifecycle.sql を適用すると使えます）。</div>';
    if(!due.length)h+='<div class="vl-note">半年以内に入れ替える車はありません。</div>';
    due.forEach(v=>{const c=S.calc[v.code], nx=relayOf(v.code);
      const head='<span class="m-badge" style="background:'+clsCol(v.type)+'">'+e(v.type)+'</span><span class="nm">'+e(v.name)+' <small>'+e(plate4(v))+'</small></span>';
      if(nx){const sw=v.service_to?dstr(ts(v.service_to)+DAY):null, sp=sw?spanning(v.code,sw):[];
        h+='<div class="vl-rl ok" data-code="'+e(v.code)+'">'+head+'<span class="ar">→</span><span class="nm">'+e(nx.name||nx.code)+' <small>'+e(plate4(nx))+'</small></span>'
          +'<span class="dt">切替 '+(sw?ymd(ts(sw)):'—')+'</span>'+(sp.length?'<span class="vl-warn">切替日をまたぐ予約 '+sp.length+'件</span>':'')
          +'<button class="vl-mini" data-unrelay="'+e(v.code)+'">解除</button></div>';
        return;}
      const cands=S.v.filter(x=>x.code!==v.code&&x.type===v.type&&String(x.brand||"")===String(v.brand||"")&&!x.relay_to&&!isSucc(x.code)&&S.calc[x.code].st!=="sold")
        .sort((a,b)=>(S.calc[a.code].rents-S.calc[b.code].rents)||String(b.created_at||"").localeCompare(String(a.created_at||"")));
      const def=c.stopT!=null?dstr(Math.max(c.stopT,t0+DAY)):dstr(t0+DAY);
      h+='<div class="vl-rl '+(["sell","prep"].includes(c.st)?'miss':'')+'" data-code="'+e(v.code)+'">'+head+'<span class="ar">→</span>'
        +'<select class="vl-rsel"'+(S.relayCols?'':' disabled')+'><option value="">後継車を選ぶ…</option>'+cands.map(x=>'<option value="'+e(x.code)+'">'+e(x.name)+' '+e(plate4(x))+(S.calc[x.code].rents?'（予約'+S.calc[x.code].rents+'件）':'（新規）')+'</option>').join("")+'</select>'
        +'<label class="dt">切替日 <input type="date" class="vl-rdate" value="'+def+'"'+(S.relayCols?'':' disabled')+'></label>'
        +'<button class="vl-mini go" data-relay="'+e(v.code)+'"'+(S.relayCols?'':' disabled')+'>リレー登録</button>'
        +'<small class="sub">売り止め目安 '+(c.stopT!=null?ymd(c.stopT):'—')+'</small></div>';});
    return h+'</div>';
  }
  async function doRelay(code,row){
    const old=S.v.find(x=>x.code===code), to=row.querySelector(".vl-rsel").value, d=row.querySelector(".vl-rdate").value;
    const nv=S.v.find(x=>x.code===to);
    if(!old||!nv){alert("後継車を選んでください。新しい車は先に車両マスターに登録してください。");return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||ts(d)<=T0()){alert("切替日は明日以降の日付にしてください。");return;}
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
    setStatus(err?"⚠ 一部の予約を移せませんでした（"+moved+"/"+moving.length+"件）："+err.message:"✅ リレーを登録しました（予約 "+moved+" 件を移動）");
    S.loaded=false; await load(true); render();
  }
  async function undoRelay(code){
    const old=S.v.find(x=>x.code===code), nx=relayOf(code); if(!old||!nx)return;
    const t=old.service_to?ts(old.service_to)+DAY:null, back=t?(S.res[nx.code]||[]).filter(r=>ts(r.start_date)>=t):[];
    if(!confirm(old.name+" "+plate4(old)+" → "+(nx.name||nx.code)+" のリレーを解除しますか？\n\n予約は "+(nx.name||nx.code)+" に入ったまま残ります（"+back.length+"件）。必要なら配車表で戻してください。"))return;
    const now=new Date().toISOString();
    let r1=await sb.from("bt_vehicles").update({service_to:null,relay_to:null,updated_at:now}).eq("code",code);
    if(!r1.error)r1=await sb.from("bt_vehicles").update({service_from:null,updated_at:now}).eq("code",nx.code);
    setStatus(r1.error?"解除できませんでした："+r1.error.message:"✅ リレーを解除しました");
    S.loaded=false; await load(true); render();
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
  async function saveOdo(box){
    const code=box.dataset.code, v=S.v.find(x=>x.code===code), ki=box.querySelector('[data-odo="km"]'), di=box.querySelector('[data-odo="at"]');
    const val=Number(String(ki.value).replace(/[^\d]/g,"")), at=di.value||todayStr();
    if(!v||!val){ki.classList.add("err");ki.focus();setStatus("メーターの数字を入れてください");return;}
    if(at>todayStr()){di.classList.add("err");setStatus("未来の日付は入れられません");return;}
    const old=n(v.current_mileage);
    if(old!=null&&Math.abs(val-old)>50000&&!confirm(km(old)+"km → "+km(val)+"km に変えます。合っていますか？"))return;
    const specs=Object.assign({},spOf(v),{odo_at:at});
    box.classList.add("saving");
    const {error}=await sb.from("bt_vehicles").update({current_mileage:val,specs,updated_at:new Date().toISOString()}).eq("code",code);
    box.classList.remove("saving");
    if(error){ki.classList.add("err");setStatus("保存できませんでした："+error.message);return;}
    if(box.closest(".vl-odobox"))S.odoOpen=true;
    v.current_mileage=val; v.specs=specs; compute(); setStatus("✅ "+(v.name||code)+"の走行を "+km(val)+"km にしました"); render();
  }
  async function saveCfg(root){
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
      if(t.closest(".vl-odobox>summary")){S.odoOpen=!t.closest("details").open;return;}
      const os=t.closest("[data-odosave]"); if(os){saveOdo(os.closest(".vl-odo"));return;}
      const sc=t.closest("[data-sec]"); if(sc){goSec(sc.dataset.sec);return;}
      const rl=t.closest("[data-relay]"); if(rl&&!rl.disabled){doRelay(rl.dataset.relay,rl.closest(".vl-rl"));return;}
      const ur=t.closest("[data-unrelay]"); if(ur){undoRelay(ur.dataset.unrelay);return;}
      const g=t.closest("[data-goto]"); if(g&&!t.closest(".vl-card")&&!t.closest("input,select,label")){gotoCard(g.dataset.goto);return;}
      const sf=t.closest("[data-stf]"); if(sf){S.stf=S.stf===sf.dataset.stf?"all":sf.dataset.stf;S.sec="karte";saveUi();render();return;}
      const br=t.closest("[data-br]"); if(br){S.brand=br.dataset.br;saveUi();render();return;}
      if(t.closest(".vl-gear")){S.showCfg=!S.showCfg;render();return;}
      if(t.closest("[data-cfgclose]")){S.showCfg=false;render();return;}
      if(t.closest("[data-cfgsave]")){saveCfg(t.closest(".vl-cfg"));return;}
      const ex=t.closest("[data-exit]"); if(ex&&!ex.disabled){const code=ex.closest(".vl-card").dataset.code;saveVal(code,"exit_type",ex.dataset.exit);return;}
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
