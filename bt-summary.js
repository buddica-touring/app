// サマリ（オーナー指示 2026-11-01）：本部ダッシュボード（nosh2318.github.io/spk-task/hq.html#home）のサマリを高松だけで表示。
// 集計は本部と同じ：売上＝返却月（予約＋予約外）／件数＝返却月の予約数／稼働率＝貸出日数÷稼働可能日数。翌月以降は今日時点で入っている予約の分。
// データ＝bt_mtg_h2（店舗KPIと同じ関数）、目標＝店舗KPI画面 bt-mtg-2026h2.html の定数（T_REV など）を毎回読む。本日の状況＝本部と同じ bt_company_* 関数。
window.BTSUM=(function(){
  const KPI_PAGE="https://nosh2318.github.io/spk-task/bt-mtg-2026h2.html", T_UTIL=0.5;
  const yen=n=>'¥'+Math.round(+n||0).toLocaleString(), pct=(a,b)=>b?Math.round(a/b*100)+'%':'—';
  const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const ymNow=()=>{const d=new Date(Date.now()+9*3600e3);return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');};
  const addYm=(ym,n)=>{let y=+ym.slice(0,4),m=+ym.slice(5)-1+n;y+=Math.floor(m/12);m=((m%12)+12)%12;return y+'-'+String(m+1).padStart(2,'0');};
  const utilOf=m=>{const u=(m&&m.util)||{};let rd=0,ad=0;Object.keys(u).forEach(c=>{rd+=u[c].rd||0;ad+=u[c].ad||0;});return {rd,ad,p:ad?rd/ad:null};};
  const rpc=async(fn,body)=>{try{const {data,error}=await sb.rpc(fn,body||{});return error?null:data;}catch(e){return null;}};
  async function targets(){
    const t=await fetch(KPI_PAGE,{cache:"no-store"}).then(r=>r.text());
    const num=k=>{const m=t.match(new RegExp('\\b'+k+'\\s*=\\s*(\\d+)'));return m?+m[1]:0;}, str=k=>{const m=t.match(new RegExp('\\b'+k+'\\s*=\\s*"([0-9-]+)"'));return m?m[1]:'9999-99';};
    const T={rev:num('T_REV'),revOct:num('T_REV_OCT'),from:str('T_FROM'),cnt:num('T_CNT'),cntFrom:str('T_CNT_FROM')};
    T.revT=m=>m<T.from?0:(m==='2026-10'?T.revOct:T.rev); T.cntT=m=>(T.cnt&&m>=T.cntFrom)?T.cnt:0; return T;
  }
  const row=(l,v,cls)=>'<div class="bs-r'+(cls?' '+cls:'')+'"><span>'+l+'</span><b>'+v+'</b></div>';
  const un='<span class="bs-m">未設定</span>';
  async function today(){
    const el=document.getElementById("bsToday"); if(!el)return;
    const [tc,al,st,nb,am,sh]=await Promise.all([rpc("bt_company_task_counts"),rpc("bt_company_alerts"),rpc("bt_company_staff_tasks"),rpc("bt_company_new_bookings"),rpc("bt_company_new_bookings_amt"),rpc("bt_company_shift_today")]);
    const t=tc||{}, a=al||{}, shl=sh&&Array.isArray(sh.bt)?sh.bt:null, n=nb&&nb.bt!=null?nb.bt:null, m=am&&am.bt&&typeof am.bt.amt==="number"?am.bt:null;
    const AL={未配車:'🚗 未配車',未入金:'💴 未入金',車検接近:'🔧 車検',点検接近:'🔩 点検'};
    const alerts=Object.keys(AL).filter(k=>(a[k]||0)>0).map(k=>'<span class="bs-al">'+AL[k]+' <b>'+a[k]+'</b></span>').join('');
    const net=m?m.amt-(m.camt||0):null;
    el.innerHTML='<div class="bs-big">'
      +[["貸出",t['貸出計']],["返却",t['返却計']],["洗車",t['洗車']],["他",t['その他']],["新規予約",n]].map(([l,v])=>'<div><span>'+l+'</span><b>'+(v==null?'—':v)+'</b></div>').join('')+'</div>'
      +(m?'<div class="bs-line">新規予約の金額　増 <b class="g">+'+yen(m.amt)+'</b>'+(m.cn?'　キャンセル '+m.cn+'件 <b class="r">−'+yen(m.camt)+'</b>':'')+'　増減 <b class="'+(net<0?'r':'g')+'">'+(net<0?'−':'+')+yen(Math.abs(net))+'</b></div>':'')
      +(shl?'<div class="bs-line">出勤 '+(Array.isArray(st)?'<span class="bs-m">'+st.length+'名・残タスク '+st.reduce((s,x)=>s+(+x.cnt||0),0)+'</span>　':'')+(shl.length?shl.map(r=>'<b>'+esc(r.nm)+'</b> <span class="bs-m">'+esc(r.st||'')+(r.en?'-'+esc(r.en):'')+'</span>').join('　'):'<span class="bs-m">シフト登録なし</span>')+'</div>':'')
      +(alerts?'<div class="bs-line">'+alerts+'</div>':'');
  }
  let timer=null, busy=false;
  async function show(){
    const body=document.getElementById("sumBody"); if(!body||busy)return; busy=true;
    const ym=ymNow(), yr=ym.slice(0,4), M3=[[ym,'当月'],[addYm(ym,1),'翌月'],[addYm(ym,2),'翌々月']];
    if(!body.dataset.done)body.innerHTML='<div class="bs-n">売上＝返却月（予約＋予約外）／件数＝返却月の予約数／稼働率＝貸出日数÷稼働可能日数。翌月以降は今日時点で入っている予約の分です。</div>'
      +'<div class="bs-h">本日の状況 <small>1分ごとに自動更新</small></div><div class="bs-c" id="bsToday"><span class="bs-m">読み込み中…</span></div>'
      +'<div class="bs-h">直近3か月</div><div class="bs-g" id="bsM3"><div class="bs-c"><span class="bs-m">読み込み中…</span></div></div>'
      +'<div class="bs-h">年間（'+yr+'年1〜12月・仮）</div><div class="bs-c" id="bsYr"><span class="bs-m">読み込み中…</span></div><div class="bs-n" id="bsSrc"></div>';
    body.dataset.done="1";
    today(); clearInterval(timer); timer=setInterval(()=>{if(document.getElementById("viewSum").style.display!=="none")today();else clearInterval(timer);},60000);
    try{
      const [d,T]=await Promise.all([rpc("bt_mtg_h2"),targets()]);
      const o=(d&&d.data)||{}, gen=d&&d.generated;
      document.getElementById("bsM3").innerHTML=M3.map(([k,l])=>{const m=o[k]||{},t=T.revT(k),c=T.cntT(k),u=utilOf(m);
        return '<div class="bs-c"><div class="bs-ch">'+l+'<small>'+(+k.slice(5))+'月</small></div>'
          +'<div class="bs-kpi"><b>'+yen(m.tot_r)+'</b><span>'+(t?'目標 '+yen(t)+'・<em>'+pct(m.tot_r||0,t)+'</em>':'目標 未設定')+'</span></div>'
          +'<div class="bs-bar"><i style="width:'+(t?Math.min(100,Math.round((m.tot_r||0)/t*100)):0)+'%"></i></div>'
          +row('稼働率',(u.p==null?'—':Math.round(u.p*100)+'%')+' <small>/ 目標 '+Math.round(T_UTIL*100)+'%</small>')
          +row('予約件数',(m.tot_c||0)+'件'+(c?' <small>/ 目標 '+c+'件</small>':''))
          +row('稼働台数',(m.nveh||0)+'台')+'</div>';}).join('');
      const a={tR:0,aR:0,aRall:0,fR:0,tC:0,aC:0,aCall:0,rd:0,ad:0};
      for(let i=1;i<=12;i++){const k=yr+'-'+String(i).padStart(2,'0');a.tR+=T.revT(k);a.tC+=T.cntT(k);}
      Object.keys(o).filter(k=>k.slice(0,4)===yr).forEach(k=>{const mm=o[k];
        if(k<=ym){a.aRall+=mm.tot_r||0;a.aCall+=mm.tot_c||0;if(T.revT(k))a.aR+=mm.tot_r||0;if(T.cntT(k))a.aC+=mm.tot_c||0;const u=utilOf(mm);a.rd+=u.rd;a.ad+=u.ad;}else a.fR+=mm.tot_r||0;});
      document.getElementById("bsYr").innerHTML='<div class="bs-kpi"><b>'+yen(a.aRall)+'</b><span>1月〜今月の実績・'+(a.tR?'年間目標 '+yen(a.tR)+'・<em>'+pct(a.aR,a.tR)+'</em>':'目標 未設定')+'</span></div>'
        +'<div class="bs-bar"><i style="width:'+(a.tR?Math.min(100,Math.round(a.aR/a.tR*100)):0)+'%"></i></div>'
        +row('先の月の予約済み売上（年内）',yen(a.fR))
        +row('稼働率（1月〜今月）',(a.ad?Math.round(a.rd/a.ad*100)+'%':'—')+' <small>/ 目標 '+Math.round(T_UTIL*100)+'%</small>')
        +row('予約件数（1月〜今月）',a.aCall.toLocaleString()+'件'+(a.tC?' <small>/ 年間目標 '+a.tC+'件・'+pct(a.aC,a.tC)+'</small>':''))
        +'<div class="bs-n">進捗＝目標を置いた月の実績÷年間目標</div>';
      document.getElementById("bsSrc").textContent='出所：bt_mtg_h2（'+(gen||'')+'）・目標＝bt-mtg-2026h2.html';
    }catch(e){const y=document.getElementById("bsYr");if(y)y.innerHTML='<span class="bs-m">読み込めませんでした：'+esc(e.message||e)+'</span>';}
    busy=false;
  }
  return {show};
})();
