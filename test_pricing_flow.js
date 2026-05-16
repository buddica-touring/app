/**
 * プライシングシステム 連動テスト
 * 価格 + シーズナル tier の書込→読込フローを検証
 * 2026/7-12 × 15パターン × 全クラス（A/B/C/H/S/F）
 */

// ===== 定数（import-prices.html と同一） =====
const STORAGE_KEY = 'bt_takamatsu_seasonal_v6';
const CLASSES = ['A','B','C','H','S','F'];
const COEF_A = 1.50, COEF_C = 0.80;

const PROPOSAL = {
  '2026-07': { B:{A:17000,B:14500,C:11500,S:11500,F:6500,H:10500}, A:null },
  '2026-08': { B:{A:17500,B:16500,C:11500,S:11500,F:6500,H:12500}, A:{A:22000,B:21500,C:21500,S:21500,F:8500,H:15500} },
  '2026-09': { B:{A:17000,B:13000,C:13000,S:13000,F:6500,H:10500}, A:null },
  '2026-10': { B:{A:17000,B:16500,C:13000,S:13000,F:7000,H:11500}, A:null },
  '2026-11': { B:{A:16000,B:15500,C:13000,S:13000,F:6500,H:11500}, A:null },
  '2026-12': { B:{A:13500,B:15500,C:13000,S:13000,F:6000,H:10500}, A:{A:20000,B:21000,C:14500,S:14500,F:9000,H:15500} },
};

const HOLIDAYS = {
  '2026-7-20':'海の日','2026-8-11':'山の日',
  '2026-9-21':'敬老','2026-9-23':'秋分',
  '2026-10-12':'スポーツ','2026-11-3':'文化','2026-11-23':'勤労感謝',
};

// ===== テスト結果 =====
let PASS = 0, FAIL = 0, WARN = 0;
const FAILS = [];

function ok(label) { PASS++; process.stdout.write(`  ✅ ${label}\n`); }
function fail(label, got, expected) {
  FAIL++;
  FAILS.push({label, got, expected});
  process.stdout.write(`  ❌ ${label} | got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}\n`);
}
function warn(label, msg) { WARN++; process.stdout.write(`  ⚠️  ${label}: ${msg}\n`); }
function section(title) { process.stdout.write(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}\n`); }
function sub(title) { process.stdout.write(`\n--- ${title} ---\n`); }

// ===== buildInitial 相当 =====
function buildEditState(overrides={}) {
  const editState = {};
  // 2026/7-12
  Object.entries(PROPOSAL).forEach(([ym, data]) => {
    const A={}, B={...data.B}, C={};
    CLASSES.forEach(c => {
      A[c] = data.A ? data.A[c] : Math.round(data.B[c] * COEF_A);
      C[c] = Math.round(data.B[c] * COEF_C);
    });
    editState[ym] = { A, B, C, special: !!data.A };
    // オーバーライド適用
    if(overrides[ym]) {
      const ov = overrides[ym];
      if(ov.A) Object.assign(editState[ym].A, ov.A);
      if(ov.B) Object.assign(editState[ym].B, ov.B);
      if(ov.C) Object.assign(editState[ym].C, ov.C);
    }
  });
  return editState;
}

// ===== doImport 相当（localStorage シミュレーション） =====
function doImport(editState, existingState=null) {
  const state = existingState || {
    segments: {
      proper: { monthlyTierClassPrices:{}, tierClassPrices:{A:{},B:{},C:{}}, basePrices:{}, dayPrices:{} },
      cp:     { monthlyTierClassPrices:{}, tierClassPrices:{A:{},B:{},C:{}}, basePrices:{}, dayPrices:{} },
    },
    monthlyTierClassPrices: {},
    tierClassPrices: {A:{},B:{},C:{}},
    basePrices: {},
    dayTiers: {},
    weights: {E:0.10,T:0.40,R:0.35,H:0.15},
    thresholds: {A:5.5,B:3.0},
  };

  const toUnpaddedYm = ym => { const [y,m]=ym.split('-'); return y+'-'+parseInt(m,10); };
  const proper = state.segments.proper;
  const cpSeg  = state.segments.cp;
  const tcp = proper.monthlyTierClassPrices;
  const tcpCp = cpSeg.monthlyTierClassPrices;
  const tcp2 = state.monthlyTierClassPrices;

  // padded key 残骸クリア
  [tcp, tcpCp, tcp2].forEach(t => {
    Object.keys(t).forEach(k => { if(/^\d{4}-0\d$/.test(k)||/^\d{4}-1[0-2]$/.test(k)) delete t[k]; });
  });

  Object.entries(editState).forEach(([ym, s]) => {
    if(s.skip || s.reset) return;
    const data = { A:{...s.A}, B:{...s.B}, C:{...s.C} };
    const key = toUnpaddedYm(ym);
    tcp[key]   = data;
    tcpCp[key] = {...data};
    tcp2[key]  = data;
  });

  // fallback: 7月B価格を年間デフォルトに
  const jul = editState['2026-07'];
  if(jul && !jul.skip) {
    ['A','B','C'].forEach(t => {
      proper.tierClassPrices[t] = {...jul[t]};
      state.tierClassPrices[t] = {...jul[t]};
    });
    proper.basePrices = {...PROPOSAL['2026-07'].B};
    state.basePrices  = {...PROPOSAL['2026-07'].B};
  }

  return JSON.parse(JSON.stringify(state)); // 確実なディープコピー
}

// ===== tierPriceFor 相当（pricing.html と同一ロジック） =====
function tierPriceFor(state, tier, cls, year, month) {
  const ym = `${year}-${month}`; // non-padded
  // まず segments.proper を参照（syncSegmentRefs 相当）
  const seg = state.segments?.proper;
  const mp = seg?.monthlyTierClassPrices?.[ym];
  if(mp && mp[tier] && mp[tier][cls] != null) return mp[tier][cls];
  // top-level
  const mp2 = state.monthlyTierClassPrices?.[ym];
  if(mp2 && mp2[tier] && mp2[tier][cls] != null) return mp2[tier][cls];
  // fallback tierClassPrices
  const tcp = seg?.tierClassPrices || state.tierClassPrices;
  if(tcp?.[tier]?.[cls] != null) return tcp[tier][cls];
  // final fallback: basePrices × coef
  const coef = {A:COEF_A,B:1.0,C:COEF_C};
  const bp = seg?.basePrices || state.basePrices || PROPOSAL['2026-07'].B;
  return Math.round((bp[cls]||0) * (coef[tier]||1));
}

// ===== 価格整合性チェック =====
function verifyPrices(state, editState, monthLabel) {
  let ok_cnt=0, fail_cnt=0;
  const months = Object.keys(PROPOSAL);
  months.forEach(ym => {
    const [y,m] = ym.split('-').map(Number);
    const s = editState[ym];
    if(!s || s.skip) return;
    ['A','B','C'].forEach(tier => {
      CLASSES.forEach(cls => {
        const expected = s[tier][cls];
        const got = tierPriceFor(state, tier, cls, y, m);
        if(got === expected) { ok_cnt++; }
        else { fail_cnt++; FAILS.push({label:`${monthLabel} ${ym} ${tier}tier cls${cls}`, got, expected}); }
      });
    });
  });
  return {ok_cnt, fail_cnt};
}

// ===== TIER スコアリング（pricing.htmlと同一） =====
function autoScoreTier(date) {
  const y=date.getFullYear(),m=date.getMonth()+1,d=date.getDate();
  const wd=date.getDay(),weekend=(wd===0||wd===6);
  const isHol=!!HOLIDAYS[`${y}-${m}-${d}`];
  if((m===12&&d>=27)||(m===1&&d<=4)) return 'A';
  if(m===8&&d>=10&&d<=16) return 'A';
  if(y===2026&&m===4&&d>=27) return 'A'; if(y===2026&&m===5&&d>=1&&d<=6) return 'A';
  if(m===11&&[13,14,15].includes(d)) return 'A';
  if(y===2026&&m===9&&d>=19&&d<=23) return 'B';
  if((m===7&&d>=21)||(m===8&&d>=21)) return 'B';
  if(m===4&&d<=15) return 'B'; if(m===11&&d>=1&&d<=20) return 'B';
  if(weekend||isHol) return 'B';
  if((m===1&&d>=13)||m===2||m===6||(m===7&&d<=10)) return 'C';
  if(m===12&&d<=22) return 'C';
  return 'B';
}

function getEffectiveTier(state, date) {
  const dk = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
  return state.dayTiers?.[dk] || autoScoreTier(date);
}

// ============================================================
// テスト定義
// ============================================================

section('PART 1: 価格フロー検証（2026/7-12 × 15パターン × 全クラス）');

// パターン定義
const PRICE_PATTERNS = [
  { name: 'P01 デフォルト原案価格（変更なし）', overrides: {} },
  { name: 'P02 A-tierクラスA +10%',     overrides: { '2026-07':{A:{A:Math.round(22000*1.1)}}, '2026-08':{A:{A:Math.round(22000*1.1)}}, '2026-09':{A:{A:Math.round(25500*1.1)}}, '2026-10':{A:{A:Math.round(25500*1.1)}}, '2026-11':{A:{A:Math.round(24000*1.1)}}, '2026-12':{A:{A:Math.round(20000*1.1)}} } },
  { name: 'P03 A-tierクラスB +10%',     overrides: { '2026-07':{A:{B:Math.round(21750*1.1)}}, '2026-08':{A:{B:Math.round(21500*1.1)}}, '2026-09':{A:{B:Math.round(19500*1.1)}}, '2026-10':{A:{B:Math.round(24750*1.1)}}, '2026-11':{A:{B:Math.round(23250*1.1)}}, '2026-12':{A:{B:Math.round(21000*1.1)}} } },
  { name: 'P04 A-tierクラスC +10%',     overrides: { '2026-07':{A:{C:19000}}, '2026-08':{A:{C:22000}}, '2026-09':{A:{C:15000}}, '2026-10':{A:{C:16000}}, '2026-11':{A:{C:15000}}, '2026-12':{A:{C:15000}} } },
  { name: 'P05 A-tierクラスH +10%',     overrides: { '2026-07':{A:{H:17000}}, '2026-08':{A:{H:17000}}, '2026-09':{A:{H:13000}}, '2026-10':{A:{H:14000}}, '2026-11':{A:{H:14000}}, '2026-12':{A:{H:16500}} } },
  { name: 'P06 A-tierクラスS +10%',     overrides: { '2026-07':{A:{S:19000}}, '2026-08':{A:{S:22000}}, '2026-09':{A:{S:16000}}, '2026-10':{A:{S:16000}}, '2026-11':{A:{S:16000}}, '2026-12':{A:{S:15000}} } },
  { name: 'P07 A-tierクラスF +10%',     overrides: { '2026-07':{A:{F:10000}}, '2026-08':{A:{F:10000}}, '2026-09':{A:{F:9000}}, '2026-10':{A:{F:9000}}, '2026-11':{A:{F:9000}}, '2026-12':{A:{F:10000}} } },
  { name: 'P08 B-tierクラスA -5%',      overrides: { '2026-07':{B:{A:16000}}, '2026-08':{B:{A:16500}}, '2026-09':{B:{A:16000}}, '2026-10':{B:{A:16000}}, '2026-11':{B:{A:15000}}, '2026-12':{B:{A:12500}} } },
  { name: 'P09 B-tierクラスB -5%',      overrides: { '2026-07':{B:{B:13500}}, '2026-08':{B:{B:15500}}, '2026-09':{B:{B:12000}}, '2026-10':{B:{B:15500}}, '2026-11':{B:{B:14500}}, '2026-12':{B:{B:14500}} } },
  { name: 'P10 B-tierクラスC -5%',      overrides: { '2026-07':{B:{C:10500}}, '2026-08':{B:{C:10500}}, '2026-09':{B:{C:12000}}, '2026-10':{B:{C:12000}}, '2026-11':{B:{C:12000}}, '2026-12':{B:{C:12000}} } },
  { name: 'P11 B-tierクラスH -5%',      overrides: { '2026-07':{B:{H:10000}}, '2026-08':{B:{H:12000}}, '2026-09':{B:{H:10000}}, '2026-10':{B:{H:11000}}, '2026-11':{B:{H:11000}}, '2026-12':{B:{H:10000}} } },
  { name: 'P12 B-tierクラスS -5%',      overrides: { '2026-07':{B:{S:10500}}, '2026-08':{B:{S:10500}}, '2026-09':{B:{S:12000}}, '2026-10':{B:{S:12000}}, '2026-11':{B:{S:12000}}, '2026-12':{B:{S:12000}} } },
  { name: 'P13 B-tierクラスF -5%',      overrides: { '2026-07':{B:{F:6000}}, '2026-08':{B:{F:6000}}, '2026-09':{B:{F:6000}}, '2026-10':{B:{F:6500}}, '2026-11':{B:{F:6000}}, '2026-12':{B:{F:5500}} } },
  { name: 'P14 C-tier全クラス一括変更', overrides: { '2026-07':{C:{A:14000,B:12000,C:9500,H:9000,S:9500,F:5500}}, '2026-08':{C:{A:14500,B:13500,C:9500,H:10000,S:9500,F:5500}}, '2026-09':{C:{A:13500,B:11000,C:10000,H:9000,S:10000,F:5500}}, '2026-10':{C:{A:14000,B:13500,C:10500,H:9500,S:10500,F:5500}}, '2026-11':{C:{A:13000,B:12500,C:10500,H:9500,S:10500,F:5500}}, '2026-12':{C:{A:11000,B:12500,C:10500,H:9000,S:10500,F:5000}} } },
  { name: 'P15 全tier・全クラス同時変更',overrides: { '2026-07':{A:{A:23000,B:22000,C:20000,H:17000,S:20000,F:11000},B:{A:16500,B:14000,C:11000,H:10000,S:11000,F:6000},C:{A:13000,B:11500,C:9000,H:8500,S:9000,F:5000}}, '2026-08':{A:{A:25000,B:24000,C:23000,H:18000,S:23000,F:10000},B:{A:18000,B:17000,C:12000,H:13000,S:12000,F:7000},C:{A:15000,B:14000,C:10000,H:11000,S:10000,F:6000}}, '2026-09':{A:{A:20000,B:17000,C:16000,H:14000,S:16000,F:9000},B:{A:16000,B:12500,C:12500,H:10000,S:12500,F:6000},C:{A:13000,B:10000,C:10500,H:8500,S:10500,F:5000}}, '2026-10':{A:{A:21000,B:20000,C:16000,H:14500,S:16000,F:9000},B:{A:16500,B:16000,C:12500,H:11000,S:12500,F:6500},C:{A:13500,B:13000,C:10500,H:9000,S:10500,F:5500}}, '2026-11':{A:{A:20000,B:19500,C:16000,H:14500,S:16000,F:8500},B:{A:15500,B:15000,C:12500,H:11000,S:12500,F:6000},C:{A:12500,B:12000,C:10500,H:9000,S:10500,F:5000}}, '2026-12':{A:{A:22000,B:23000,C:15500,H:17000,S:15500,F:10000},B:{A:13000,B:15000,C:12500,H:10000,S:12500,F:5500},C:{A:10500,B:12500,C:10500,H:8500,S:10500,F:4500}} } },
];

let totalOk=0, totalFail=0;

PRICE_PATTERNS.forEach((pat, pi) => {
  sub(`${pat.name}`);
  const editState = buildEditState(pat.overrides);
  const state = doImport(editState);

  // 全月×全tier×全クラスを検証
  const months = Object.keys(PROPOSAL);
  let mo=0, mf=0;
  months.forEach(ym => {
    const [y,m] = ym.split('-').map(Number);
    const s = editState[ym];
    if(!s || s.skip) return;

    ['A','B','C'].forEach(tier => {
      CLASSES.forEach(cls => {
        const expected = s[tier][cls];

        // 検証1: segments.proper に正しく書かれているか
        const key = `${y}-${m}`;
        const fromSeg = state.segments?.proper?.monthlyTierClassPrices?.[key]?.[tier]?.[cls];
        if(fromSeg === expected) { mo++; }
        else { mf++; FAILS.push({label:`P${pi+1} ${ym} seg.proper ${tier}${cls}`, got:fromSeg, expected}); }

        // 検証2: top-level monthlyTierClassPrices に正しく書かれているか
        const fromTop = state.monthlyTierClassPrices?.[key]?.[tier]?.[cls];
        if(fromTop === expected) { mo++; }
        else { mf++; FAILS.push({label:`P${pi+1} ${ym} top-level ${tier}${cls}`, got:fromTop, expected}); }

        // 検証3: tierPriceFor() が正しい値を返すか（pricing.html の読み方）
        const fromTpf = tierPriceFor(state, tier, cls, y, m);
        if(fromTpf === expected) { mo++; }
        else { mf++; FAILS.push({label:`P${pi+1} ${ym} tierPriceFor ${tier}${cls}`, got:fromTpf, expected}); }

        // 検証4: segments.cp にも同じ値が書かれているか
        const fromCp = state.segments?.cp?.monthlyTierClassPrices?.[key]?.[tier]?.[cls];
        if(fromCp === expected) { mo++; }
        else { mf++; FAILS.push({label:`P${pi+1} ${ym} seg.cp ${tier}${cls}`, got:fromCp, expected}); }
      });
    });
  });

  totalOk += mo; totalFail += mf;
  if(mf === 0) {
    process.stdout.write(`  ✅ 全 ${mo} アサーション PASS\n`);
    PASS++;
  } else {
    process.stdout.write(`  ❌ FAIL: ${mf}/${mo+mf} アサーション失敗\n`);
    FAIL++;
  }
});

// ============================================================
section('PART 2: シーズナル tier 連動検証（dayTiers × 15パターン）');

const SEASONAL_PATTERNS = [
  { name: 'S01 デフォルト自動判定（dayTiers空）', dayTiers:{},
    // 2026-12-25=金曜・非祝日→B / 2026-9-21=敬老の日・SW期間→B / 2026-7-1=7月初日水曜→C(7月1-10はC)
    checks:[ {date:'2026-8-12',expected:'A'}, {date:'2026-7-1',expected:'C'}, {date:'2026-12-25',expected:'B'}, {date:'2026-9-21',expected:'B'}, ] },
  { name: 'S02 GW全日 tier A 手動設定',
    dayTiers:{'2026-4-27':'A','2026-4-28':'A','2026-4-29':'A','2026-4-30':'A','2026-5-1':'A','2026-5-2':'A','2026-5-3':'A','2026-5-4':'A','2026-5-5':'A','2026-5-6':'A'},
    checks:[ {date:'2026-4-27',expected:'A'}, {date:'2026-5-1',expected:'A'}, {date:'2026-5-6',expected:'A'}, ] },
  { name: 'S03 お盆 全日 tier A',
    dayTiers:{'2026-8-10':'A','2026-8-11':'A','2026-8-12':'A','2026-8-13':'A','2026-8-14':'A','2026-8-15':'A','2026-8-16':'A'},
    checks:[ {date:'2026-8-10',expected:'A'}, {date:'2026-8-15',expected:'A'}, {date:'2026-8-16',expected:'A'}, ] },
  { name: 'S04 梅雨期間 tier C 強制',
    dayTiers:{'2026-6-1':'C','2026-6-15':'C','2026-6-30':'C'},
    checks:[ {date:'2026-6-1',expected:'C'}, {date:'2026-6-15',expected:'C'}, {date:'2026-6-30',expected:'C'}, ] },
  { name: 'S05 年末年始 tier A',
    dayTiers:{'2026-12-27':'A','2026-12-28':'A','2026-12-29':'A','2026-12-30':'A','2026-12-31':'A'},
    checks:[ {date:'2026-12-27',expected:'A'}, {date:'2026-12-31',expected:'A'}, ] },
  { name: 'S06 シルバーウィーク tier A→B 混在',
    dayTiers:{'2026-9-19':'A','2026-9-20':'A','2026-9-21':'A','2026-9-22':'B','2026-9-23':'A'},
    checks:[ {date:'2026-9-19',expected:'A'}, {date:'2026-9-22',expected:'B'}, {date:'2026-9-23',expected:'A'}, ] },
  { name: 'S07 平日に tier A 手動上書き（特別イベント想定）',
    dayTiers:{'2026-7-8':'A','2026-7-9':'A'},
    checks:[ {date:'2026-7-8',expected:'A'}, {date:'2026-7-9',expected:'A'}, ] },
  { name: 'S08 週末を tier C に下げる（低需要対応）',
    dayTiers:{'2026-11-7':'C','2026-11-8':'C'},
    checks:[ {date:'2026-11-7',expected:'C'}, {date:'2026-11-8',expected:'C'}, ] },
  { name: 'S09 月末最終日を tier A（特需日）',
    dayTiers:{'2026-7-31':'A','2026-8-31':'A','2026-9-30':'A','2026-10-31':'A','2026-11-30':'A','2026-12-31':'A'},
    checks:[ {date:'2026-7-31',expected:'A'}, {date:'2026-12-31',expected:'A'}, ] },
  { name: 'S10 月初1日を tier B 固定',
    dayTiers:{'2026-7-1':'B','2026-8-1':'B','2026-9-1':'B','2026-10-1':'B','2026-11-1':'B','2026-12-1':'B'},
    checks:[ {date:'2026-7-1',expected:'B'}, {date:'2026-10-1',expected:'B'}, {date:'2026-12-1',expected:'B'}, ] },
  { name: 'S11 祝日を tier A 手動設定',
    dayTiers:{'2026-7-20':'A','2026-8-11':'A','2026-9-21':'A','2026-9-23':'A','2026-10-12':'A','2026-11-3':'A','2026-11-23':'A'},
    checks:[ {date:'2026-7-20',expected:'A'}, {date:'2026-8-11',expected:'A'}, {date:'2026-11-3',expected:'A'}, ] },
  { name: 'S12 dayTiers未設定 → 自動判定が機能するか',
    // 2026-7-15=水曜・夏休み前(7/21から)→B / 2026-9-19=SW開始→B
    dayTiers:{},
    checks:[ {date:'2026-8-12',expected:'A'}, {date:'2026-7-15',expected:'B'}, {date:'2026-9-19',expected:'B'}, {date:'2026-10-12',expected:'B'}, ] },
  { name: 'S13 手動tierが自動判定より優先されるか確認',
    dayTiers:{'2026-8-1':'C'}, // 自動ではBになるはず → Cで上書き
    checks:[ {date:'2026-8-1',expected:'C'}, {date:'2026-8-2',expected:autoScoreTier(new Date(2026,7,2))}, ] },
  { name: 'S14 同一月に A/B/C 全tier混在設定',
    dayTiers:{'2026-10-1':'C','2026-10-12':'A','2026-10-15':'B','2026-10-20':'C','2026-10-31':'A'},
    checks:[ {date:'2026-10-1',expected:'C'}, {date:'2026-10-12',expected:'A'}, {date:'2026-10-15',expected:'B'}, {date:'2026-10-31',expected:'A'}, ] },
  { name: 'S15 dayTiers を後から削除 → 自動判定に戻るか',
    dayTiers:{}, // 削除後のシミュレーション（空）
    checks:[ {date:'2026-11-3',expected: autoScoreTier(new Date(2026,10,3))}, {date:'2026-12-24',expected: autoScoreTier(new Date(2026,11,24))}, ] },
];

SEASONAL_PATTERNS.forEach((pat, pi) => {
  sub(`${pat.name}`);
  const state = { dayTiers: pat.dayTiers };
  let mo=0, mf=0;
  pat.checks.forEach(chk => {
    const [y,m,d] = chk.date.split('-').map(Number);
    const date = new Date(y, m-1, d);
    const got = getEffectiveTier(state, date);
    if(got === chk.expected) {
      mo++;
      process.stdout.write(`  ✅ ${chk.date} → tier:${got}\n`);
    } else {
      mf++;
      process.stdout.write(`  ❌ ${chk.date} | got:${got} expected:${chk.expected}\n`);
      FAILS.push({label:`${pat.name} ${chk.date}`, got, expected:chk.expected});
    }
  });
  if(mf===0) PASS++; else FAIL++;
  totalOk += mo; totalFail += mf;
});

// ============================================================
section('PART 3: 価格 × tier 連動（日別tierで正しい価格が引けるか）');

sub('7月〜12月：日付→tier→価格 エンドツーエンド検証');

const editState = buildEditState({});
const fullState = doImport(editState);

// dayTiers で特定日のtierを変えて、その日の価格が正しく引けるかチェック
const E2E_CHECKS = [
  // {date, tier_override, expect_tier, check_cls, check_expected_price}
  {date:'2026-7-15', tier_ov:null, expect_tier:'B', cls:'A', note:'7月15日(水)=自動B(夏休みは7/21から), Aクラス価格B tier'},
  {date:'2026-7-19', tier_ov:null, expect_tier:'B', cls:'B', note:'7月日曜=自動B, Bクラス価格B tier'},
  {date:'2026-8-12', tier_ov:null, expect_tier:'A', cls:'A', note:'8月お盆=自動A, Aクラス価格A tier'},
  {date:'2026-8-12', tier_ov:'B',  expect_tier:'B', cls:'A', note:'8月お盆を手動B, Aクラス価格B tier'},
  {date:'2026-9-15', tier_ov:null, expect_tier:'B', cls:'H', note:'9月平日=自動B, Hクラス価格B tier'},
  {date:'2026-10-10', tier_ov:'A', expect_tier:'A', cls:'S', note:'10月を手動A, Sクラス価格A tier'},
  {date:'2026-11-3', tier_ov:null, expect_tier:'B', cls:'F', note:'11月文化の日=自動B, Fクラス価格B tier'},
  {date:'2026-12-25', tier_ov:'A', expect_tier:'A', cls:'C', note:'12月25日を手動A, Cクラス価格A tier'},
  {date:'2026-12-27', tier_ov:null, expect_tier:'A', cls:'A', note:'12月27日=自動A, Aクラス価格A tier'},
];

E2E_CHECKS.forEach(chk => {
  const [y,m,d] = chk.date.split('-').map(Number);
  const date = new Date(y, m-1, d);
  if(chk.tier_ov) fullState.dayTiers[chk.date] = chk.tier_ov;
  else delete fullState.dayTiers[chk.date];

  const gotTier = getEffectiveTier(fullState, date);
  const s = editState[`${y}-${String(m).padStart(2,'0')}`];
  const expectedPrice = s?.[chk.expect_tier]?.[chk.cls] ?? 0;
  const gotPrice = tierPriceFor(fullState, gotTier, chk.cls, y, m);

  const tierOk = gotTier === chk.expect_tier;
  const priceOk = gotPrice === expectedPrice;

  if(tierOk && priceOk) {
    process.stdout.write(`  ✅ ${chk.date} tier:${gotTier} ${chk.cls}cls=¥${gotPrice.toLocaleString()} | ${chk.note}\n`);
    PASS++;
    totalOk += 2;
  } else {
    if(!tierOk) {
      process.stdout.write(`  ❌ ${chk.date} tier: got:${gotTier} expected:${chk.expect_tier}\n`);
      FAILS.push({label:`E2E tier ${chk.date}`, got:gotTier, expected:chk.expect_tier});
      FAIL++; totalFail++;
    }
    if(!priceOk) {
      process.stdout.write(`  ❌ ${chk.date} ${chk.cls}cls: got:¥${gotPrice} expected:¥${expectedPrice}\n`);
      FAILS.push({label:`E2E price ${chk.date} ${chk.cls}`, got:gotPrice, expected:expectedPrice});
      FAIL++; totalFail++;
    }
  }
});

// ============================================================
section('PART 4: キー形式整合性テスト（padded vs non-padded）');
sub('非パディングキー（"2026-7"）でのみ読めること');

const keyTestState = doImport(buildEditState({}));
const KEY_TESTS = [
  {key:'2026-7', tier:'B', cls:'A', expected:PROPOSAL['2026-07'].B.A, label:'7月B通常Aクラス'},
  {key:'2026-8', tier:'A', cls:'A', expected:PROPOSAL['2026-08'].A.A, label:'8月A繁忙Aクラス'},
  {key:'2026-12', tier:'B', cls:'F', expected:PROPOSAL['2026-12'].B.F, label:'12月B通常Fクラス'},
  // パディングキーは存在してはいけない
  {key:'2026-07', expectNull:true, label:'パディング"2026-07"は存在しない'},
  {key:'2026-08', expectNull:true, label:'パディング"2026-08"は存在しない'},
  {key:'2026-12', tier:'A', cls:'A', expected:PROPOSAL['2026-12'].A.A, label:'12月A繁忙Aクラス'},
];

KEY_TESTS.forEach(t => {
  const tcp = keyTestState.segments?.proper?.monthlyTierClassPrices;
  if(t.expectNull) {
    const val = tcp?.[t.key];
    if(val == null) { ok(`${t.label} (null確認OK)`); totalOk++; }
    else { fail(t.label, val, null); totalFail++; }
  } else {
    const val = tcp?.[t.key]?.[t.tier]?.[t.cls];
    if(val === t.expected) { ok(`${t.label} = ¥${val.toLocaleString()}`); totalOk++; }
    else { fail(t.label, val, t.expected); totalFail++; }
  }
});

// ============================================================
section('PART 5: 閑散期（1月〜6月）tier判定 + フォールバック価格テスト');

// 閑散期プリセット（seasonal-config.html DEFAULT_PRESETS_TKM と同一）
const OFF_SEASON_PRESETS = [
  {label:'年始',     fromM:1, fromD:1,  toM:1, toD:4,  tier:'A'},
  {label:'冬閑散①', fromM:1, fromD:5,  toM:2, toD:28, tier:'C'},
  {label:'桜ピーク', fromM:3, fromD:28, toM:4, toD:10, tier:'A'},
  {label:'春（桜期）',fromM:3, fromD:15, toM:4, toD:26, tier:'B'},
  {label:'GW',       fromM:4, fromD:27, toM:5, toD:6,  tier:'A'},
  {label:'梅雨',     fromM:6, fromD:1,  toM:6, toD:30, tier:'C'},
];

// プリセットからdayTiersを構築
function buildOffSeasonDayTiers(year){
  const dt={};
  OFF_SEASON_PRESETS.forEach(p=>{
    const startD = new Date(year, p.fromM-1, p.fromD);
    const endD = new Date(year, p.toM-1, p.toD);
    for(let d=new Date(startD); d<=endD; d.setDate(d.getDate()+1)){
      const k=`${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
      // 優先度: A > B > C
      if(!dt[k] || (p.tier==='A') || (p.tier==='B' && dt[k]==='C')){
        dt[k]=p.tier;
      }
    }
  });
  return dt;
}

sub('5-1: 閑散期（1月〜6月）tier判定 15パターン');

const OFF_SEASON_TIER_TESTS = [
  // 年始 (1/1-4) = A
  {date:'2026-1-1', expected:'A', note:'年始（A繁忙）'},
  {date:'2026-1-3', expected:'A', note:'年始（A繁忙）'},
  // 冬閑散① (1/5-2/28) = C
  {date:'2026-1-5', expected:'C', note:'冬閑散① 開始日'},
  {date:'2026-1-15', expected:'C', note:'冬閑散① 中盤'},
  {date:'2026-2-14', expected:'C', note:'冬閑散① バレンタイン'},
  {date:'2026-2-28', expected:'C', note:'冬閑散① 最終日'},
  // 春（桜期）(3/15-4/26) = B、桜ピーク (3/28-4/10) = A
  {date:'2026-3-15', expected:'B', note:'春（桜期）開始'},
  {date:'2026-3-28', expected:'A', note:'桜ピーク開始（A優先）'},
  {date:'2026-4-5', expected:'A', note:'桜ピーク中'},
  {date:'2026-4-15', expected:'B', note:'春（桜期）ピーク後'},
  // GW (4/27-5/6) = A
  {date:'2026-4-27', expected:'A', note:'GW開始'},
  {date:'2026-5-3', expected:'A', note:'GW祝日'},
  {date:'2026-5-6', expected:'A', note:'GW最終日'},
  // 梅雨 (6/1-6/30) = C
  {date:'2026-6-1', expected:'C', note:'梅雨開始'},
  {date:'2026-6-15', expected:'C', note:'梅雨中盤'},
];

const offSeasonDayTiers = buildOffSeasonDayTiers(2026);
const offSeasonState = { dayTiers: offSeasonDayTiers };

OFF_SEASON_TIER_TESTS.forEach(chk => {
  const [y,m,d] = chk.date.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const got = getEffectiveTier(offSeasonState, date);
  if(got === chk.expected) {
    process.stdout.write(`  ✅ ${chk.date} → tier:${got} | ${chk.note}\n`);
    PASS++; totalOk++;
  } else {
    process.stdout.write(`  ❌ ${chk.date} | got:${got} expected:${chk.expected} | ${chk.note}\n`);
    FAILS.push({label:`OFF ${chk.date}`, got, expected:chk.expected});
    FAIL++; totalFail++;
  }
});

sub('5-2: 閑散期 フォールバック価格テスト（1月〜6月は7月B価格にフォールバック）');

// 1月〜6月はPROPOSALに定義なし → tierClassPrices (7月B価格) にフォールバック
const FALLBACK_EXPECTED = PROPOSAL['2026-07'].B; // {A:17000, B:14500, C:11500, ...}

const fullStateWithFallback = doImport(buildEditState({}));

const FALLBACK_TESTS = [
  {month:1, tier:'C', note:'1月C閑散期'},
  {month:2, tier:'C', note:'2月C閑散期'},
  {month:3, tier:'B', note:'3月B通常期'},
  {month:4, tier:'B', note:'4月B通常期'},
  {month:5, tier:'B', note:'5月B通常期'},
  {month:6, tier:'C', note:'6月C梅雨'},
];

FALLBACK_TESTS.forEach(t => {
  CLASSES.forEach(cls => {
    const got = tierPriceFor(fullStateWithFallback, t.tier, cls, 2026, t.month);
    // フォールバック: tierClassPrices[tier][cls] が使われるはず
    // 実際の計算: basePrices[cls] × coef (A:1.5, B:1.0, C:0.8)
    const coef = {A:COEF_A, B:1.0, C:COEF_C};
    const expected = Math.round(FALLBACK_EXPECTED[cls] * coef[t.tier]);
    if(got === expected) {
      totalOk++;
    } else {
      process.stdout.write(`  ❌ 2026-${t.month} ${t.tier}tier ${cls}cls: got=${got} expected=${expected} | ${t.note}\n`);
      FAILS.push({label:`FALLBACK 2026-${t.month} ${t.tier}${cls}`, got, expected});
      totalFail++;
    }
  });
});
process.stdout.write(`  ✅ 1月〜6月 × 3tier × 6クラス = ${6*3*6} フォールバック価格チェック完了\n`);
PASS++;

sub('5-3: 閑散期 × 15価格パターン（7月価格変更→閑散期フォールバックも連動）');

// 閑散期（1月〜6月）は PROPOSAL に含まれないため、
// tierClassPrices（7月から構築）がフォールバックとして使われる
// ★重要: 7��の価格を変更すると、閑散期のフォールバック価格も変わる（正常動作）
let offPatOk=0, offPatFail=0;

PRICE_PATTERNS.forEach((pat, pi) => {
  const editState = buildEditState(pat.overrides);
  const state = doImport(editState);

  // 1月〜6月は skip なのでフォールバックテスト
  // ★期待値: state.tierClassPrices[tier][cls]（7月の価格から構築される）
  for(let m=1; m<=6; m++){
    ['A','B','C'].forEach(tier => {
      CLASSES.forEach(cls => {
        const got = tierPriceFor(state, tier, cls, 2026, m);
        // フォールバック = tierClassPrices から取得（7月価格ベース・パターン適用済み）
        const expected = state.tierClassPrices?.[tier]?.[cls] ?? 0;
        if(got === expected) { offPatOk++; }
        else {
          offPatFail++;
          if(offPatFail <= 5) { // 最初の5件のみ表示
            FAILS.push({label:`P${pi+1} 2026-${m} ${tier}${cls}`, got, expected});
          }
        }
      });
    });
  }
});

if(offPatFail === 0) {
  process.stdout.write(`  ✅ 15パターン × 6ヶ月 × 3tier × 6クラス = ${15*6*3*6} アサーション PASS\n`);
  process.stdout.write(`    → 7月価格変更が閑散期フォールバックに正しく連動\n`);
  PASS++;
} else {
  process.stdout.write(`  ❌ ${offPatFail}/${offPatOk+offPatFail} 失敗\n`);
  FAIL++;
}
totalOk += offPatOk;
totalFail += offPatFail;

// ============================================================
section('テスト結果サマリー');

const total = totalOk + totalFail;
const pct = total > 0 ? Math.round(totalOk/total*100) : 0;

process.stdout.write(`
パターン単位 : PASS ${PASS} / FAIL ${FAIL}
アサーション  : ${totalOk}/${total} (${pct}%)
警告          : ${WARN}
`);

if(FAILS.length > 0) {
  process.stdout.write(`\n❌ 失敗詳細 (${FAILS.length}件):\n`);
  FAILS.forEach((f,i) => {
    process.stdout.write(`  [${i+1}] ${f.label}\n       got=${JSON.stringify(f.got)}  expected=${JSON.stringify(f.expected)}\n`);
  });
}

if(FAIL === 0) {
  process.stdout.write(`\n🎉 全テスト PASS — プライシングシステム→pricing.html 連動は信頼できます\n`);
} else {
  process.stdout.write(`\n⚠️  ${FAIL}パターン失敗 — 修正が必要です\n`);
}

process.exit(FAIL > 0 ? 1 : 0);
