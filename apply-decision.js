// apply-decision.js
// 価格決定MD → bt_takamatsu_seasonal_v6 反映 共通モジュール
// price-decision.html と price-pipeline.html から利用

(function(global){
  const STORAGE_KEY = 'bt_takamatsu_seasonal_v6';
  const HISTORY_KEY = 'bt_tkm_apply_history_v1';
  const MAPPING_KEY = 'bt_tkm_season_to_tier_v2';  // v2: 1:1対応に変更 (旧v1は破棄)

  // デフォルトのシーズン→tierマッピング (1:1対応・MD命名 = pricing tier命名)
  // pricing.html / seasonal-config.html の Tier規約: A=閑散 / B=通常 / C=繁忙
  // 決定MD: C最繁忙 / A繁忙 / B通常
  // → 同じ文字で対応 (Aの意味が違うのは要運用判断)
  const DEFAULT_MAPPING = {
    'C最繁忙シーズン': 'C',
    'A繁忙シーズン':   'A',
    'B通常シーズン':   'B',
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

    const monthData = {};  // tier別クラス価格
    Object.entries(mapping).forEach(([season, tier])=>{
      const rows = (parsed.seasons||{})[season] || [];
      monthData[tier] = monthData[tier] || {};
      rows.forEach(r=>{
        if(r.recommended != null && r.cls) monthData[tier][r.cls] = r.recommended;
      });
    });

    months.forEach(ym=>{
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
      summary: Object.entries(monthData).map(([t,cls])=>`${t}: ${Object.entries(cls).map(([k,v])=>`${k}=¥${v.toLocaleString()}`).join(' ')}`).join(' / '),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0,50)));
    return { monthData, months };
  }

  // 確認⑧（書込後チェック）
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
      // 値整合性
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
    if(!parsedDecision || !parsedDecision.seasons || !Object.keys(parsedDecision.seasons).length){
      alert('決定MDがパースできません。先に価格決定を実行してください。');
      return;
    }
    ensureModalStyles();
    const mapping = loadMapping();
    const today = new Date();
    let months = genMonths(today, 3);
    const allMonths = genMonths(today, 12);

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
          <div class="ad-sec-h">② 価格を書き込む月（複数選択可）</div>
          <div style="font-size:8.5pt;color:#94a3b8;margin-bottom:6px">推奨価格マトリクスをプライシングシステムの「何月」に書き込むかを選びます。チェックしなかった月には反映されません。</div>
          <div class="ad-month-list" id="ad-months">
            ${allMonths.map(ym => `
              <label class="ad-month-chip ${months.includes(ym)?'checked':''}">
                <input type="checkbox" data-ym="${ym}" ${months.includes(ym)?'checked':''}>
                ${fmtMonth(ym)}
              </label>
            `).join('')}
          </div>
          <div class="ad-month-actions">
            <button class="ad-link" data-quick="3">直近3ヶ月</button>
            <button class="ad-link" data-quick="6">直近6ヶ月</button>
            <button class="ad-link" data-quick="12">全12ヶ月</button>
            <button class="ad-link" data-quick="0">全解除</button>
          </div>
        </div>

        <div class="ad-sec">
          <div class="ad-sec-h">③ 反映プレビュー</div>
          <table class="ad-tbl">
            <thead><tr><th>tier</th>${['AA','A','B','C','S','H','F'].map(c=>`<th class="pc">${c}</th>`).join('')}</tr></thead>
            <tbody id="ad-preview-body"></tbody>
          </table>
        </div>

        <div class="ad-warn">⚠️ プロパー価格 / CP価格 の両方に同じ推奨価格が書き込まれます。後から import-prices.html で個別調整可能。</div>

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
      // 月チェック
      modal.querySelectorAll('#ad-months input[type=checkbox]').forEach(cb=>{
        cb.addEventListener('change', e=>{
          const ym = cb.getAttribute('data-ym');
          months = cb.checked ? [...months, ym].sort() : months.filter(x=>x!==ym);
          cb.parentElement.classList.toggle('checked', cb.checked);
        });
      });
      // クイック選択
      modal.querySelectorAll('button[data-quick]').forEach(btn=>{
        btn.addEventListener('click', e=>{
          e.preventDefault();
          const n = parseInt(btn.getAttribute('data-quick'),10);
          months = n>0 ? genMonths(today, n) : [];
          rerender();
        });
      });
      // ボタン
      modal.querySelector('#ad-cancel').addEventListener('click', ()=>{ document.body.removeChild(back); });
      modal.querySelector('#ad-confirm').addEventListener('click', ()=>{
        if(!months.length){ alert('書き込み先の月を1つ以上選択してください'); return; }
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
      const monthData = {};
      Object.entries(mapping).forEach(([season, tier])=>{
        const rows = (parsedDecision.seasons||{})[season] || [];
        monthData[tier] = monthData[tier] || {};
        rows.forEach(r=>{ if(r.recommended != null) monthData[tier][r.cls] = r.recommended; });
      });
      const body = modal.querySelector('#ad-preview-body');
      if(!body) return;
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
