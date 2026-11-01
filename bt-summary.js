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

  // 推移グラフ（オーナー指示 2026-11-01）：2026年8月〜予約が入っている先の月まで。売上・予約件数・稼働台数・予約単価を同じ月の軸で縦に並べる（軸は1つずつ）
  //   色：済んだ月＝濃いグレー、今月＝赤、先の月（今日時点の予約分）＝薄いグレー。月にマウス/タップで4つの値をまとめて表示
  function trendHtml(o,ym,cw0){
    const ks=Object.keys(o).filter(k=>k>="2026-08").sort(); let last=ks.filter(k=>(o[k].tot_c||0)>0).pop()||ym; if(last<ym)last=ym;
    const M=[]; for(let k="2026-08";k<=last;k=addYm(k,1))M.push(k);
    const D=M.map(k=>{const m=o[k]||{},c=m.tot_c||0;return {k,r:m.tot_r||0,c,v:m.nveh||0,u:c?(m.tot_r||0)/c:null};});
    const P=[["r","売上",x=>yen(x),"bar"],["c","予約件数",x=>Math.round(x)+'件',"bar"],["v","稼働台数",x=>Math.round(x)+'台',"line"],["u","予約単価",x=>yen(x),"line"]];
    const W=Math.max(320,M.length*46,Math.round((cw0||0)-34)), L=8, R=8, ph=78, gap=30, top=6, cw=(W-L-R)/M.length, H=top+P.length*(ph+gap)+18;
    const col=k=>k<ym?'#57534e':k===ym?'#c0392b':'#d6d3d1';
    let g='';
    P.forEach(([f,lb,fmt,tp],i)=>{const y0=top+i*(ph+gap)+16, mx=Math.max(1,...D.map(d=>d[f]||0))*1.2, Y=x=>y0+ph-(x/mx)*ph;
      g+='<text x="'+L+'" y="'+(y0-5)+'" class="t">'+lb+'</text><line x1="'+L+'" x2="'+(W-R)+'" y1="'+(y0+ph)+'" y2="'+(y0+ph)+'" class="ax"/>';
      if(tp==="bar")D.forEach((d,j)=>{const h=Math.max(0,(d[f]||0)/mx*ph), x=L+j*cw+cw*0.22, w=cw*0.56; if(h>0)g+='<path d="M'+x+','+(y0+ph)+'V'+(y0+ph-h+3)+'q0,-3 3,-3h'+(w-6)+'q3,0 3,3V'+(y0+ph)+'Z" fill="'+col(d.k)+'"/>';});
      else{const pts=D.map((d,j)=>d[f]==null?null:[L+j*cw+cw/2,Y(d[f])]);
        for(let j=1;j<pts.length;j++)if(pts[j-1]&&pts[j])g+='<line x1="'+pts[j-1][0]+'" y1="'+pts[j-1][1]+'" x2="'+pts[j][0]+'" y2="'+pts[j][1]+'" stroke="'+(D[j].k>ym?'#d6d3d1':'#57534e')+'" stroke-width="2"'+(D[j].k>ym?' stroke-dasharray="4 3"':'')+'/>';
        pts.forEach((pt,j)=>{if(pt)g+='<circle cx="'+pt[0]+'" cy="'+pt[1]+'" r="4" fill="'+col(D[j].k)+'" stroke="#fff" stroke-width="2"/>';});}
      // 最大と今月だけ数字を添える（全部には付けない）
      const jm=D.reduce((b,d,j)=>(d[f]||0)>(D[b][f]||0)?j:b,0), jn=M.indexOf(ym);
      [...new Set([jm,jn])].forEach(j=>{if(j<0||D[j][f]==null)return;const yy=tp==="bar"?y0+ph-(D[j][f]/mx)*ph:Y(D[j][f]);g+='<text x="'+(L+j*cw+cw/2)+'" y="'+(yy-7)+'" class="v">'+fmt(D[j][f])+'</text>';});
    });
    M.forEach((k,j)=>{g+='<text x="'+(L+j*cw+cw/2)+'" y="'+(H-4)+'" class="m'+(k===ym?' now':'')+'">'+(k.slice(5)==="01"||j===0?k.slice(2,4)+'/':'')+(+k.slice(5))+'月</text>'
      +'<rect x="'+(L+j*cw)+'" y="0" width="'+cw+'" height="'+(H-16)+'" class="hit" data-j="'+j+'"/>';});
    TR={D,P,ym};
    return '<div class="bs-c bs-tr"><div class="bs-trl"><span><i style="background:#57534e"></i>実績</span><span><i style="background:#c0392b"></i>今月</span><span><i style="background:#d6d3d1"></i>先の月（今日時点の予約分）</span></div>'
      +'<div class="bs-trs"><svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="月別の売上・予約件数・稼働台数・予約単価">'+g+'<line class="xh" x1="0" x2="0" y1="0" y2="'+(H-16)+'" style="display:none"/></svg></div><div class="bs-tip" style="display:none"></div>'
      +'<details class="bs-tbl"><summary>表で見る</summary><table><tr><th>月</th>'+P.map(p=>'<th>'+p[1]+'</th>').join('')+'</tr>'+D.map(d=>'<tr><td>'+d.k.replace('-','/')+(d.k>ym?' 予':'')+'</td>'+P.map(p=>'<td>'+(d[p[0]]==null?'—':p[2](d[p[0]]))+'</td>').join('')+'</tr>').join('')+'</table></details></div>';
  }
  let TR=null;
  function trendHover(box){
    const svg=box.querySelector('svg'), tip=box.querySelector('.bs-tip'), xh=svg.querySelector('.xh');
    const on=j=>{if(!TR||!TR.D[j])return;const d=TR.D[j], r=svg.querySelector('.hit[data-j="'+j+'"]'), x=+r.getAttribute('x')+(+r.getAttribute('width'))/2;
      xh.setAttribute('x1',x);xh.setAttribute('x2',x);xh.style.display='';
      tip.innerHTML='<b>'+d.k.replace('-','年')+'月'+(d.k>TR.ym?' <small>今日時点の予約分</small>':d.k===TR.ym?' <small>今月</small>':'')+'</b>'+TR.P.map(p=>'<div><span>'+p[1]+'</span><b>'+(d[p[0]]==null?'—':p[2](d[p[0]]))+'</b></div>').join('');
      tip.style.display='';const bx=box.getBoundingClientRect(), sx=svg.getBoundingClientRect(), px=sx.left-bx.left+x*(sx.width/svg.viewBox.baseVal.width);
      tip.style.left=Math.max(4,Math.min(bx.width-tip.offsetWidth-4,px+12))+'px';};
    svg.addEventListener('mousemove',ev=>{const h=ev.target.closest('.hit');if(h)on(+h.dataset.j);});
    svg.addEventListener('click',ev=>{const h=ev.target.closest('.hit');if(h)on(+h.dataset.j);});
    svg.addEventListener('mouseleave',()=>{tip.style.display='none';xh.style.display='none';});
  }
  let timer=null, busy=false;
  async function show(){
    const body=document.getElementById("sumBody"); if(!body||busy)return; busy=true;
    const ym=ymNow(), yr=ym.slice(0,4), M3=[[ym,'当月'],[addYm(ym,1),'翌月'],[addYm(ym,2),'翌々月']];
    if(!body.dataset.done)body.innerHTML='<div class="bs-n">売上＝返却月（予約＋予約外）／件数＝返却月の予約数／稼働率＝貸出日数÷稼働可能日数。翌月以降は今日時点で入っている予約の分です。</div>'
      +'<div class="bs-h">本日の状況 <small>1分ごとに自動更新</small></div><div class="bs-c" id="bsToday"><span class="bs-m">読み込み中…</span></div>'
      +'<div class="bs-h">直近3か月</div><div class="bs-g" id="bsM3"><div class="bs-c"><span class="bs-m">読み込み中…</span></div></div>'
      +'<div class="bs-h">推移 <small>2026年8月〜・月の上にマウス（スマホはタップ）で4つの数字</small></div><div id="bsTr"><div class="bs-c"><span class="bs-m">読み込み中…</span></div></div>'
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
      const tr=document.getElementById("bsTr"); tr.innerHTML=trendHtml(o,ym,tr.clientWidth); trendHover(tr.querySelector(".bs-tr"));
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
