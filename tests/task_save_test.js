// 高松APP タスク保存の「戻らない試験」16項目（2026-10-17 受け渡し箱0020/0021・オーナー指示で build.js が毎回実行＝NGならビルド停止）
// index.html.bak から DB オブジェクトだけを取り出し、仮のDB(メモリ)に対して保存経路を流す。本番DBには一切触れない。
// 守ること: 人が入れた値(時間・メモ・確認・担当・場所・種別・補償・約款)が ①部分保存 ②当日の作り直し ③古い端末の保存 で戻らない
//           新規行・配車などの正当な更新は通る／墓標(削除済み)は復活しない
// 使い方: node tests/task_save_test.js [index.html.bak]   （v1.0.542 では 4/16＝巻き戻りを再現する試験）
const fs=require('fs');const path=require('path');
const srcPath=process.argv[2]||path.join(__dirname,'..','index.html.bak');
const src=fs.readFileSync(srcPath,'utf8').split('\n');
const _s=src.findIndex(l=>/^const DB = \{/.test(l));const _e=src.findIndex((l,i)=>i>_s&&/^\};/.test(l));
if(_s<0||_e<0){console.error('❌ index.html.bak に const DB = { ... }; が見つからない（試験を更新すること）');process.exit(2);}
const dbSrc=src.slice(_s,_e+1).join('\n');
const pick=(re)=>src.find(l=>re.test(l))||'';
const helpers=[pick(/^function deriveRetType/),pick(/^function deriveLendType/),pick(/^function norm\(d\)/)].join('\n');

// ---- 仮のDB（PostgREST の select/in/eq/neq/update/upsert を最小限まね）----
let store={};const writes=[];
const LS={};global.localStorage={getItem:k=>LS[k]??null,setItem:(k,v)=>{LS[k]=String(v)},removeItem:k=>{delete LS[k]}};
function q(tbl){const st={tbl,f:[],op:'select'};
  const exec=()=>{let rows=Object.values(store).map(r=>({...r}));
    for(const [k,op,v] of st.f){rows=rows.filter(r=>op==='eq'?String(r[k])===String(v):op==='neq'?String(r[k])!==String(v):op==='in'?v.includes(r[k]):true);}
    if(st.op==='select')return{data:rows,error:null};
    if(st.op==='update'){rows.forEach(r=>{writes.push({op:'update',id:r._id,cols:Object.keys(st.body)});Object.assign(store[r._id],st.body);});return{data:rows.map(r=>({_id:r._id})),error:null};}
  };
  const b={select(){return b},eq(k,v){st.f.push([k,'eq',v]);return b},neq(k,v){st.f.push([k,'neq',v]);return b},in(k,v){st.f.push([k,'in',v]);return b},order(){return b},limit(){return b},gte(){return b},lte(){return b},
    update(body){st.op='update';st.body=body;return b},
    upsert(rows,opt){rows.forEach(r=>{if(store[r._id]){if(opt&&opt.ignoreDuplicates)return;writes.push({op:'upsert-over',id:r._id,cols:Object.keys(r)});Object.assign(store[r._id],r);}else{writes.push({op:'insert',id:r._id});store[r._id]={deleted:false,...r};}});return Promise.resolve({error:null});},
    then(res,rej){return Promise.resolve(exec()).then(res,rej)}};
  return b;}
global.sb={from:q};
eval(helpers+'\nfunction dbLog(){}\nfunction _btAirportBus(p){return /空港/.test(String(p||""))}\nfunction _btOkPlace(){return false}\n'+dbSrc.replace('const DB = {','global.DB = {'));

const clone=o=>JSON.parse(JSON.stringify(o));
let pass=0,fail=0;const ok=(c,m,x)=>{if(c){pass++;console.log('✅',m)}else{fail++;console.log('❌',m,x!==undefined?JSON.stringify(x).slice(0,600):'')}};

// ---- A. 洗車/その他タスク（12項目）----
async function caseOther(){
  DB._resIdx={};DB._base={};writes.length=0;
  const D='2026-10-20';
  const row=(id,o)=>Object.assign({_id:id,date:D,sort_order:0,"内容":"その他","時間":"","変更":"","内案":"","予約者":"","担当":"","確認":"false","メモ":"","予約番号":"","OTA":"","TEL":"","MAIL":"",assigned_vehicle:"","No":"","人数":"0","送迎場所":"","クラス":"","確定":"","便名":"","返却日":"","返却":"","送迎":"","集客":"","B":"0","C":"0","J":"0","USB":"0","約款":"false","LINE":"false","決済":"false",changed_json:"{}",deleted:false},o);
  store={"w-1":row("w-1",{"内容":"洗車","時間":"10:00"}),"o-2":row("o-2",{"内容":"その他","メモ":"元"}),"w-3":row("w-3",{"内容":"洗車"})};
  // 端末A（古い端末）が読み込む
  const A=await DB.fetchTasks(D); const Abase=clone(A);
  // 端末B（他のスタッフ）が手入力（＝DBが変わる。Aは知らない）
  const S=store; Object.assign(S["w-1"],{"時間":"11:15","変更":"11:15","メモ":"B入力","担当":"山田","確認":"true","確定":"フル","約款":"同意(太郎) 10/17","送迎場所":"高松空港","内容":"洗車"});
  // ① 部分保存
  writes.length=0; await DB.updateTaskFields("o-2",D,{memo:"A入力"});
  ok(writes.length===1&&writes[0].id==="o-2"&&writes[0].cols.join()==="メモ","①部分保存は1件・メモ列だけ書く",writes);
  ok(S["w-1"]["時間"]==="11:15"&&S["w-1"]["メモ"]==="B入力","①部分保存で他タスクの手入力は不変");
  // ② 当日の作り直し（protect）
  writes.length=0; const regen=clone(Abase).map(t=>({...t,assignedVehicle:t._id==="w-3"?"プリウ1016":t.assignedVehicle}));
  regen.push({...clone(Abase[0]),_id:"w-9",type:"洗車",time:"",memo:""});
  await DB.upsertTasks(regen,D,{protect:true});
  const w1=S["w-1"];
  ok(w1["時間"]==="11:15"&&w1["変更"]==="11:15"&&w1["メモ"]==="B入力"&&w1["担当"]==="山田"&&w1["確認"]==="true"&&w1["確定"]==="フル"&&/^同意/.test(w1["約款"])&&w1["送迎場所"]==="高松空港"&&w1["内容"]==="洗車","②作り直しで手入力(時間/メモ/確認/担当/場所/種別/補償/約款)が戻らない",w1);
  ok(!writes.some(w=>w.id==="w-1"),"②作り直しは手入力された行に書かない",writes);
  ok(writes.some(w=>w.op==="insert"&&w.id==="w-9"),"②新規行は挿入される",writes);
  ok(writes.some(w=>w.id==="w-3"&&w.cols.join()==="assigned_vehicle"),"②システムの正当な更新(配車)は通る",writes);
  ok(!writes.some(w=>w.op==="upsert-over"),"②既存行の丸ごと上書きが無い",writes);
  // ③ 古い端末の通常保存（全行渡し）：Aの手元＝自分の作り直し後の状態(手入力は古いまま)・o-2 の確認だけ変更
  writes.length=0; const A2=clone(regen).map(t=>t._id==="o-2"?{...t,done:true,memo:"A入力"}:t);
  await DB.upsertTasks(A2,D);
  ok(S["w-1"]["メモ"]==="B入力"&&S["w-1"]["時間"]==="11:15","③古い端末の全行保存でも他人の手入力は戻らない",S["w-1"]);
  ok(writes.length===1&&writes[0].id==="o-2"&&writes[0].cols.includes("確認")&&!writes[0].cols.includes("時間"),"③書くのは変えた行の変えた列だけ",writes);
  // ④ 古い端末の1件保存(updateTask＝全列渡し)：担当だけ変更
  writes.length=0; const t1={...clone(Abase.find(t=>t._id==="w-1")),assignee:"佐藤"};
  await DB.updateTask(t1,D);
  ok(S["w-1"]["担当"]==="佐藤"&&S["w-1"]["メモ"]==="B入力"&&S["w-1"]["時間"]==="11:15"&&S["w-1"]["確定"]==="フル","④1件保存は変えた列(担当)だけ・他はDBのまま",{w:writes,row:S["w-1"]});
  // ⑤ 墓標
  S["w-3"].deleted=true; writes.length=0; await DB.upsertTasks(clone(Abase),D,{protect:true});
  ok(S["w-3"].deleted===true&&!writes.some(w=>w.id==="w-3"),"⑤削除済み(墓標)は作り直しで復活しない",writes);
  // ⑥ 読み込んでいない端末
  DB._base={}; writes.length=0; await DB.upsertTasks(clone(Abase).map(t=>({...t,memo:"古い"})),D,{protect:true});
  ok(!writes.some(w=>w.op!=="insert"),"⑥読み込んでいない端末の作り直しは既存行に書かない",writes);
}

// ---- B. 送迎タスク（予約から時間を導出する行・4項目）----
async function caseLeg(){
  DB._base={};writes.length=0;
  const D='2026-10-21';
  const base={date:D,sort_order:0,"時間":"","変更":"","内案":"","予約者":"テスト","担当":"","確認":"false","メモ":"","OTA":"じゃらん","TEL":"","MAIL":"",assigned_vehicle:"プリウ1016","No":"1731","人数":"2","送迎場所":"","クラス":"E","確定":"免責","便名":"","返却日":"","返却":"","送迎":"","集客":"","B":"0","C":"0","J":"0","USB":"0","約款":"false","LINE":"false","決済":"false",deleted:false};
  DB._resIdx={R1:{id:"R1",visitType:"PU",returnType:"BD",delTime:"10:00",colTime:"18:00",delPlace:"高松空港",colPlace:"高松空港"}};
  store={"d-R1":{...base,_id:"d-R1","内容":"PU","予約番号":"R1","時間":"09:30","変更":"09:30",changed_json:'{"_src":"customer","_ssTime":"09:30"}'},
         "c-R1":{...base,_id:"c-R1","内容":"BD","予約番号":"R1",changed_json:"{}"}};
  const A=await DB.fetchTasks(D);
  const S=store;
  Object.assign(S["d-R1"],{"時間":"11:00","変更":"11:00","担当":"山田","確定":"フル","約款":"同意(テスト) 10/17",changed_json:'{"_src":"human","_ssTime":"09:30","_manualTimeAt":"2026-10-17T06:00:00Z","assignee":true}'});
  writes.length=0; await DB.upsertTasks(clone(A),D,{protect:true});
  ok(!writes.some(w=>w.id==="d-R1"),"送迎: 作り直しは手入力された行に書かない",writes);
  ok(S["d-R1"]["時間"]==="11:00"&&S["d-R1"]["担当"]==="山田"&&S["d-R1"]["確定"]==="フル","送迎: 手入力が残る",S["d-R1"]);
  ok(!writes.some(w=>w.id==="c-R1"&&w.cols.includes("時間")),"送迎: 予約から導出した時間を書き込まない",writes);
  writes.length=0; const A2=clone(A).map(t=>t._id==="d-R1"?{...t,memo:"A入力"}:t); await DB.upsertTasks(A2,D);
  ok(writes.length===1&&writes[0].cols.join()==="メモ"&&S["d-R1"]["時間"]==="11:00"&&S["d-R1"]["確定"]==="フル"&&/^同意/.test(S["d-R1"]["約款"]),"送迎: 古い端末のメモ保存はメモだけ・時間/補償/約款は残る",{writes,row:S["d-R1"]});
}

(async()=>{
  await caseOther();
  await caseLeg();
  console.log(`\nタスク保存の戻らない試験: ${pass}件OK / ${fail}件NG`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2)});
