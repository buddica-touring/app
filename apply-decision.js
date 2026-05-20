// apply-decision.js
// 価格決定MD → bt_takamatsu_seasonal_v6 反映 共通モジュール
// price-decision.html と price-pipeline.html から利用

(function(global){
  const STORAGE_KEY = 'bt_takamatsu_seasonal_v6';
  const HISTORY_KEY = 'bt_tkm_apply_history_v1';
  const MAPPING_KEY = 'bt_tkm_season_to_tier_v4';  // v4: 命名統一・自明な同名対応

  // シーズン名と tier 名を完全統一 (C繁忙/B通常/A閑散) → マッピングは自明
  // pricing.html / seasonal-config.html / 決定MD すべて同じ命名
  const DEFAULT_MAPPING = {
    'C繁忙シーズン': 'C',
    'B通常シーズン': 'B',
    'A閑散シーズン': 'A',
  };
  const TIER_CHOICES = ['A','B','C'];

  // 決定MDをパース
  function parseDecisionMd(md){
    const result = { seasons: {}, raw: md };
    if(!md) return result;
    const lines = md.split(/\r?\n/);
    let curSeason = null;
    for(let i=0;i<lines.length;i++){
      const ln = lines[i].trim();
      const sm = ln.match(/^###\s+(.+?シーズン)/);  // 「シーズン」までで切る（カッコ等を除外）
      if(sm){
        curSeason = sm[1].trim().replace(/[（(].*?[）)]/g,'').trim();  // 念のためカッコ削除
        result.seasons[curSeason] = [];
        continue;
      }
      if(curSeason && ln.startsWith('|') && !ln.startsWith('|--') && !/クラス/.test(ln)){
        const cells = ln.split('|').map(s=>s.trim()).filter(s=>s.length>0);
        if(cells.length >= 3){
          const row = {
            cls: cells[0],
            base: parsePrice(cells[1]),
            recommended: parsePrice(cells[2]),
            current: cells[3] ? parsePrice(cells[3]) : null,
            diff: cells[4] || '',
            note: cells[5] || '',
          };
          if(/^(AA|A|B|C|S|H|F)$/.test(row.cls)) result.seasons[curSeason].push(row);
        }
      }
      if(curSeason && (ln.startsWith('## ') || (ln.startsWith('### ') && !sm))) curSeason = null;
    }
    return result;
  }
  function parsePrice(s){
    if(!s || s==='—' || s.includes('未定')) return null;
    const m = s.match(/¥?\s*([\d,]+)/);
    if(!m) return null;
    return parseInt(m[1].replace(/,/g,''),10);
  }

  // 月リスト生成（当月から N ヶ月）
  function genMonths(start, n){
    const arr = [];
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    for(let i=0;i<n;i++){
      arr.push(d.getFullYear() + '-' + (d.getMonth()+1));  // non-padded (pricing.html仕様)
      d.setMonth(d.getMonth()+1);
    }
    return arr;
  }
  function fmtMonth(ym){
    const [y,m] = ym.split('-');
    return `${y}年${m}月`;
  }

  // マッピング保存/読込
  function loadMapping(){
    try{
      const raw = localStorage.getItem(MAPPING_KEY);
      return raw ? Object.assign({}, DEFAULT_MAPPING, JSON.parse(raw)) : Object.assign({}, DEFAULT_MAPPING);
    }catch(e){ return Object.assign({}, DEFAULT_MAPPING); }
  }
  function saveMapping(mapping){
    localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping));
  }

  // 書込実行（ プロパー / CP 両方に同値を反映）
  // 🔴 改修 2026-05-20: parsed.byMonth (月別マトリクス) を優先使用・月別独立反映
  // 旧: 全月に同じ monthData を書き込む = 整合性破綻 (画面④の月別表示と⑤の反映が不一致)
  // 新: 月別 monthData を持って各月独立に書き込む = ④と⑤が完全に一致
  function applyDecision(parsed, mapping, months){
    const raw = localStorage.getItem(STORAGE_KEY) || '{}';
    let state;
    try{ state = JSON.parse(raw); }catch(e){ state = {}; }
    if(!state.segments) state.segments = {};
    ['proper','cp'].forEach(seg=>{
      if(!state.segments[seg]) state.segments[seg] = {};
      if(!state.segments[seg].monthlyTierClassPrices) state.segments[seg].monthlyTierClassPrices = {};
    });
    if(!state.monthlyTierClassPrices) state.monthlyTierClassPrices = {};

    // 旧仕様 fallback: parsed.byMonth がない時だけ全月同一の monthData を使う
    const fallbackMonthData = {};
    if (!parsed.byMonth || !Object.keys(parsed.byMonth).length) {
      Object.entries(mapping).forEach(([season, tier])=>{
        const rows = (parsed.seasons||{})[season] || [];
        fallbackMonthData[tier] = fallbackMonthData[tier] || {};
        rows.forEach(r=>{
          if(r.recommended != null && r.cls) fallbackMonthData[tier][r.cls] = r.recommended;
        });
      });
    }

    const writtenByMonth = {};
    months.forEach(ym=>{
      // 🔴 新仕様: 月別データを優先・なければ fallback
      const monthData = (parsed.byMonth && parsed.byMonth[ym])
        ? parsed.byMonth[ym]
        : fallbackMonthData;
      writtenByMonth[ym] = monthData;
      state.segments.proper.monthlyTierClassPrices[ym] = JSON.parse(JSON.stringify(monthData));
      state.segments.cp.monthlyTierClassPrices[ym] = JSON.parse(JSON.stringify(monthData));
      state.monthlyTierClassPrices[ym] = JSON.parse(JSON.stringify(monthData));
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    // 履歴
    const hist = loadHistory();
    hist.unshift({
      at: new Date().toISOString(),
      months,
      mapping,
      monthly: writtenByMonth, // 月別反映データを履歴に記録
      summary: months.map(ym => {
        const md = writtenByMonth[ym] || {};
        return `${fmtMonth(ym)}: ` + Object.entries(md).map(([t,cls])=>
          `${t}=${Object.entries(cls).map(([k,v])=>`${k}¥${v.toLocaleString()}`).join(',')}`
        ).join(' / ');
      }).join(' || '),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0,50)));
    return { writtenByMonth, months };
  }

  // 確認⑧（書込後チェック）
  // 🔴 改修 2026-05-20: byMonth 対応・月別期待値で検証
  function verifyApply(parsed, mapping, months){
    const raw = localStorage.getItem(STORAGE_KEY) || '{}';
    let state; try{ state = JSON.parse(raw); }catch(e){ return [{name:'JSON parse', ok:false, detail:e.message}]; }
    const results = [];
    months.forEach(ym=>{
      const proper = state?.segments?.proper?.monthlyTierClassPrices?.[ym];
      const cp = state?.segments?.cp?.monthlyTierClassPrices?.[ym];
      const root = state?.monthlyTierClassPrices?.[ym];
      results.push({name:`${fmtMonth(ym)} プロパー書込`, ok: !!proper});
      results.push({name:`${fmtMonth(ym)} CP書込`, ok: !!cp});
      results.push({name:`${fmtMonth(ym)} ルート互換書込`, ok: !!root});

      // 🔴 新仕様: byMonth がある月は月別期待値で検証
      if (parsed.byMonth && parsed.byMonth[ym]) {
        const expected = parsed.byMonth[ym];
        ['A','B','C'].forEach(tier => {
          const tierExpected = expected[tier] || {};
          if (!Object.keys(tierExpected).length) return;
          const tierStored = proper?.[tier] || {};
          const mismatch = Object.entries(tierExpected).filter(([cls, v]) => tierStored[cls] !== v);
          results.push({
            name: `${fmtMonth(ym)} tier ${tier} 値整合 (月別・${Object.keys(tierExpected).length}件中)`,
            ok: mismatch.length === 0,
            detail: mismatch.length ? mismatch.map(([c,v])=>`${c}:推奨¥${v} 実¥${tierStored[c]||'なし'}`).join(',') : '',
          });
        });
      } else {
        // 旧仕様 fallback
        Object.entries(mapping).forEach(([season, tier])=>{
          const rows = (parsed.seasons||{})[season] || [];
          const stored = proper?.[tier] || {};
          const mismatch = rows.filter(r => r.recommended != null && stored[r.cls] !== r.recommended);
          results.push({
            name: `${fmtMonth(ym)} ${season}→tier ${tier} 値整合 (${rows.length}件中)`,
            ok: mismatch.length === 0,
            detail: mismatch.length ? mismatch.map(r=>`${r.cls}:推奨¥${r.recommended} 実¥${stored[r.cls]}`).join(',') : '',
          });
        });
      }
    });
    return results;
  }

  // 履歴
  function loadHistory(){
    try{ return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); }catch(e){ return []; }
  }

  // ===== モーダルUI =====
  function ensureModalStyles(){
    if(document.getElementById('apply-decision-styles')) return;
    const style = document.createElement('style');
    style.id = 'apply-decision-styles';
    style.textContent = `
      .ad-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px}
      .ad-modal{background:#1e293b;border:1px solid #475569;border-radius:14px;max-width:880px;width:100%;max-height:90vh;overflow:auto;padding:24px;color:#f1f5f9;font-family:-apple-system,sans-serif}
      .ad-title{font-size:14pt;font-weight:800;color:#fff;margin-bottom:6px}
      .ad-sub{font-size:9pt;color:#94a3b8;margin-bottom:18px}
      .ad-sec{margin-bottom:18px}
      .ad-sec-h{font-size:9.5pt;font-weight:800;color:#94a3b8;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
      .ad-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .ad-map-item{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px}
      .ad-map-item label{display:block;font-size:8.5pt;color:#94a3b8;font-weight:700;margin-bottom:4px}
      .ad-map-item select{width:100%;background:#1e293b;border:1px solid #475569;border-radius:6px;color:#e2e8f0;padding:6px 8px;font-size:9.5pt;font-family:inherit}
      .ad-month-list{display:flex;flex-wrap:wrap;gap:6px;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px}
      .ad-month-chip{display:flex;align-items:center;gap:4px;background:#1e293b;border:1px solid #475569;border-radius:6px;padding:6px 10px;font-size:9pt;cursor:pointer}
      .ad-month-chip input{cursor:pointer}
      .ad-month-chip.checked{background:#1e40af;border-color:#3b82f6;color:#fff}
      .ad-month-actions{margin-top:6px;display:flex;gap:6px;font-size:8.5pt}
      .ad-link{background:none;border:none;color:#60a5fa;cursor:pointer;font-size:8.5pt;text-decoration:underline;padding:0}
      table.ad-tbl{width:100%;border-collapse:collapse;font-size:9pt}
      table.ad-tbl th{background:#0f172a;color:#94a3b8;padding:6px 8px;text-align:left;border-bottom:2px solid #334155;font-size:8.5pt}
      table.ad-tbl td{padding:6px 8px;border-bottom:1px solid #1e293b;color:#e2e8f0}
      table.ad-tbl .pc{font-family:Menlo,monospace;text-align:right}
      .ad-warn{background:#3a1f0a;border:1px solid #d97706;border-radius:6px;padding:8px 12px;font-size:8.5pt;color:#fde68a;margin-top:10px}
      .ad-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid #334155}
      .ad-btn{border:none;border-radius:8px;padding:10px 20px;font-size:10pt;font-weight:800;cursor:pointer;font-family:inherit}
      .ad-btn.cancel{background:#475569;color:#fff}
      .ad-btn.cancel:hover{background:#334155}
      .ad-btn.go{background:#16a34a;color:#fff;padding:12px 28px}
      .ad-btn.go:hover{background:#15803d}
      .ad-btn:disabled{opacity:.4;cursor:not-allowed}
      .ad-result{background:#0b1020;border:1px solid #1e293b;border-radius:8px;padding:12px;font-family:Menlo,monospace;font-size:8.5pt;color:#cbd5e1;max-height:200px;overflow:auto;margin-top:10px;line-height:1.5}
      .ad-result .ok{color:#22c55e}
      .ad-result .ng{color:#f87171}
    `;
    document.head.appendChild(style);
  }

  function openGoSignModal(parsedDecision, opts){
    // 🔴 改修 2026-05-20: byMonth (新仕様) or seasons (旧仕様) のどちらかがあればOK
    const hasByMonth = parsedDecision && parsedDecision.byMonth && Object.keys(parsedDecision.byMonth).length;
    const hasSeasons = parsedDecision && parsedDecision.seasons && Object.keys(parsedDecision.seasons).length;
    if(!parsedDecision || (!hasByMonth && !hasSeasons)){
      alert('決定MDがパースできません。先に価格決定を実行してください。');
      return;
    }
    ensureModalStyles();
    const mapping = loadMapping();
    const today = new Date();
    // ②調査日 (bt_tkm_survey_dates_v1) から「月のユニーク集合」を抽出して反映先に固定
    const surveyDatesRaw = (()=>{ try{ return JSON.parse(localStorage.getItem('bt_tkm_survey_dates_v1')||'[]'); }catch(e){return [];} })();
    const excludeSet = (()=>{ try{ return new Set(JSON.parse(localStorage.getItem('bt_tkm_survey_exclude_v1')||'[]')); }catch(e){return new Set();} })();
    const validReps = (surveyDatesRaw||[]).filter(r=>r && r.day!==null && r.month && !excludeSet.has(`${r.month}-${r.tier}`));
    const year = today.getFullYear();
    const monthSetTmp = new Set();
    validReps.forEach(r => monthSetTmp.add(`${year}-${parseInt(r.month,10)}`));  // non-padded
    const months = Array.from(monthSetTmp).sort((a,b)=>{
      const [ay,am]=a.split('-').map(Number); const [by,bm]=b.split('-').map(Number);
      return ay-by||am-bm;
    });

    const back = document.createElement('div');
    back.className = 'ad-backdrop';
    const modal = document.createElement('div');
    modal.className = 'ad-modal';
    back.appendChild(modal);

    function rerender(){
      modal.innerHTML = `
        <div class="ad-title">★ Goサイン — 価格反映の確認</div>
        <div class="ad-sub">プライシングシステム（プロパー / CP）に推奨価格を反映します。<strong style="color:#f87171">この操作は不可逆です。</strong></div>

        <div class="ad-sec">
          <div class="ad-sec-h">① シーズン → tier マッピング</div>
          <div class="ad-grid">
            ${Object.keys(parsedDecision.seasons).map(season => `
              <div class="ad-map-item">
                <label>${season}</label>
                <select data-season="${season.replace(/"/g,'&quot;')}">
                  ${TIER_CHOICES.map(t => `<option value="${t}" ${mapping[season]===t?'selected':''}>tier ${t}</option>`).join('')}
                </select>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="ad-sec">
          <div class="ad-sec-h">② 反映先の月（②調査日 と自動連動・変更不可）</div>
          <div style="font-size:8.5pt;color:#94a3b8;margin-bottom:6px">②調査日設定で選んだ調査日の月にのみ反映します。月を変えたい場合は ②調査日 を見直してください。</div>
          <div style="font-size:11pt;color:#bbf7d0;font-weight:700;padding:8px 12px;background:#0a2818;border-radius:5px">
            ${months.length ? '📅 ' + months.map(fmtMonth).join('・') : '<span style="color:#f87171">⚠️ ②調査日 が未設定です。①〜② を完了してから Goサインを押してください</span>'}
          </div>
        </div>

        <div class="ad-sec">
          <div class="ad-sec-h">③ 反映プレビュー <span style="font-size:8.5pt;color:#94a3b8;font-weight:400">${hasByMonth ? '— 月別独立反映（④画面と完全一致）' : '— 全月共通反映（旧仕様）'}</span></div>
          <table class="ad-tbl">
            <thead><tr>${hasByMonth ? '<th>月</th>' : ''}<th>tier</th>${['AA','A','B','C','S','H','F'].map(c=>`<th class="pc">${c}</th>`).join('')}</tr></thead>
            <tbody id="ad-preview-body"></tbody>
          </table>
        </div>

        <div class="ad-warn">⚠️ プロパー価格 / CP価格 の両方に同じ推奨価格が書き込まれます。${hasByMonth ? '<strong style="color:#fde68a">月別に異なる価格</strong>が反映されます（④マトリクスと完全一致）。' : ''}後から import-prices.html で個別調整可能。</div>

        <div id="ad-result-area"></div>

        <div class="ad-actions">
          <button class="ad-btn cancel" id="ad-cancel">キャンセル</button>
          <button class="ad-btn go" id="ad-confirm">★ 承認・反映</button>
        </div>
      `;

      // マッピング選択
      modal.querySelectorAll('select[data-season]').forEach(sel=>{
        sel.addEventListener('change', e=>{
          mapping[sel.getAttribute('data-season')] = sel.value;
          renderPreview();
        });
      });
      // 月選択ハンドラは廃止 (②調査日 と自動連動・変更不可)
      // ボタン
      modal.querySelector('#ad-cancel').addEventListener('click', ()=>{ document.body.removeChild(back); });
      modal.querySelector('#ad-confirm').addEventListener('click', ()=>{
        if(!months.length){ alert('② 調査日が設定されていません。①〜② を完了してから Goサインを押してください'); return; }
        if(!confirm(`${months.length}ヶ月分の価格を反映します。\n承認しますか？（不可逆）`)) return;
        saveMapping(mapping);
        const res = applyDecision(parsedDecision, mapping, months);
        const checks = verifyApply(parsedDecision, mapping, months);
        const ok = checks.filter(c=>c.ok).length;
        const ng = checks.length - ok;
        const html = `
          <div class="ad-sec">
            <div class="ad-sec-h">確認⑧ 結果: ${ok}/${checks.length} OK ${ng>0?'<span class="ng">('+ng+' NG)</span>':''}</div>
            <div class="ad-result">${checks.map(c=>`<div class="${c.ok?'ok':'ng'}">${c.ok?'✓':'✗'} ${c.name}${c.detail?' — '+c.detail:''}</div>`).join('')}</div>
            <div style="margin-top:10px;font-size:9pt;color:#22c55e">✅ 反映完了。<a href="pricing.html?area=tkm" target="_blank" style="color:#60a5fa">→ カレンダー確認</a> / <a href="import-prices.html?area=tkm" target="_blank" style="color:#60a5fa">→ プライシングシステム</a></div>
          </div>`;
        modal.querySelector('#ad-result-area').innerHTML = html;
        modal.querySelector('#ad-confirm').disabled = true;
        modal.querySelector('#ad-cancel').textContent = '閉じる';
        if(opts && typeof opts.onApplied === 'function') opts.onApplied(res, checks);
      });

      renderPreview();
    }

    function renderPreview(){
      const body = modal.querySelector('#ad-preview-body');
      if(!body) return;
      // 🔴 改修 2026-05-20: byMonth があれば月別マトリクスを表示 (④画面と完全一致)
      if (hasByMonth) {
        const rows = [];
        months.forEach(ym => {
          const mdata = parsedDecision.byMonth[ym] || {};
          const tiersForMonth = ['A','B','C'].filter(t => mdata[t] && Object.keys(mdata[t]).length);
          if (!tiersForMonth.length) {
            rows.push(`<tr><td colspan="9" style="color:#94a3b8;font-style:italic;text-align:center">${fmtMonth(ym)} — 反映データなし（サンプル不足等）</td></tr>`);
            return;
          }
          tiersForMonth.forEach((tier, idx) => {
            const row = mdata[tier] || {};
            const monthCell = idx === 0
              ? `<td rowspan="${tiersForMonth.length}" style="background:#0a2818;font-weight:800;color:#bbf7d0;border-right:2px solid #166534">${fmtMonth(ym)}</td>`
              : '';
            const tierBadge = {A:'#3b82f6',B:'#fbbf24',C:'#dc2626'}[tier];
            const tierColor = tier==='B' ? '#78350f' : '#fff';
            rows.push(`<tr>${monthCell}<td><span style="background:${tierBadge};color:${tierColor};padding:2px 8px;border-radius:3px;font-weight:800;font-size:8.5pt">${tier}</span></td>${['AA','A','B','C','S','H','F'].map(cls => {
              const v = row[cls];
              return `<td class="pc">${v!=null ? '¥'+v.toLocaleString() : '<span style="color:#475569">—</span>'}</td>`;
            }).join('')}</tr>`);
          });
        });
        body.innerHTML = rows.join('');
        return;
      }
      // 旧仕様 fallback (seasons ベース・全月共通)
      const monthData = {};
      Object.entries(mapping).forEach(([season, tier])=>{
        const rows = (parsedDecision.seasons||{})[season] || [];
        monthData[tier] = monthData[tier] || {};
        rows.forEach(r=>{ if(r.recommended != null) monthData[tier][r.cls] = r.recommended; });
      });
      body.innerHTML = ['A','B','C'].map(tier=>{
        const row = monthData[tier] || {};
        return `<tr><td><strong>${tier}</strong></td>${['AA','A','B','C','S','H','F'].map(cls=>{
          const v = row[cls];
          return `<td class="pc">${v!=null ? '¥'+v.toLocaleString() : '<span style="color:#475569">—</span>'}</td>`;
        }).join('')}</tr>`;
      }).join('');
    }

    rerender();
    document.body.appendChild(back);
  }

  global.ApplyDecision = {
    STORAGE_KEY, HISTORY_KEY, MAPPING_KEY,
    parseDecisionMd, parsePrice,
    genMonths, fmtMonth,
    loadMapping, saveMapping,
    applyDecision, verifyApply,
    loadHistory,
    openGoSignModal,
  };
})(window);
