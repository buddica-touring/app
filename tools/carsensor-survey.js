// カーセンサー相場の集計（カーセンサーのページ上で実行する）。
// 掲載内容は保存せず、台数と本体価格の25%・中央値・75%・最安・最高だけを返す。
// T = [{code, path, year, disp, fuel, drive, seats, km, limit}]
async function surveyCarsensor(T) {
  const PER = 30, wait = ms => new Promise(r => setTimeout(r, ms));
  const band = (km, w) => { const c = Math.round(km / 10000) * 10000; return [Math.max(0, c - w * 10000), Math.min(150000, c + w * 10000)]; };
  // 5台未満なら 年式±2年 → 走行±2万km の順に広げる（オーナー決定 2026-10-31）
  const STEPS = [[1, 1, ''], [2, 1, '条件を広げた：年式±2年'], [2, 2, '条件を広げた：年式±2年・走行±2万km']];
  const load = async (path, q, page) => {
    const url = '/usedcar/' + path + '/index' + (page > 1 ? page : '') + '.html?' + q;
    const d = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html');
    const tot = d.querySelector('.resultBar__result');
    const prices = [...d.querySelectorAll('div.cassette.js_listTableCassette')].map(c => {
      const n = c.querySelector('.basePrice__mainPriceNum'); if (!n) return null;   // リース広告など本体価格のない枠は除く
      const s = c.querySelector('.basePrice__subPriceNum');
      return Math.round(parseFloat(n.textContent.trim() + (s ? s.textContent.trim() : '')) * 10000);
    }).filter(v => v != null && !isNaN(v));
    await wait(1500);   // 相手サイトに負荷をかけないよう間隔をあける
    return { total: tot ? +tot.textContent.replace(/\D/g, '') : 0, prices };
  };
  const rows = [];
  for (const t of T) {
    for (const [purpose, km] of [['now', t.km], ['end', t.limit]]) {
      let row;
      for (const [yd, kd, wide] of STEPS) {
        const [kmFrom, kmTo] = band(km, kd);
        const q = new URLSearchParams({ YMIN: t.year - yd, YMAX: t.year + yd, SMIN: kmFrom, SMAX: kmTo,
          HMIN: t.disp, HMAX: t.disp, FUEL: t.fuel, KUDO: t.drive, TEIIN: t.seats, OPTCD: 'REP0', SORT: 2 }).toString();
        row = { vehicle_code: t.code, source: 'carsensor', purpose, year_from: t.year - yd, year_to: t.year + yd,
          km_from: kmFrom, km_to: kmTo, query_url: 'https://www.carsensor.net/usedcar/' + t.path + '/index.html?' + q };
        try {
          const p1 = await load(t.path, q, 1), N = p1.total;
          row.n = N;
          if (N < 5 && wide !== STEPS[STEPS.length - 1][2]) continue;
          const notes = [wide, N === 0 ? '該当なし' : N < 5 ? '台数が少ないため参考値' : '', t.guess ? '推定：' + t.guess : ''];
          if (N > 0) {
            const pages = { 1: p1.prices }, lastPage = Math.ceil(N / PER);
            const at = async rank => { const pg = Math.ceil(rank / PER); if (!pages[pg]) pages[pg] = (await load(t.path, q, pg)).prices; return pages[pg][rank - (pg - 1) * PER - 1]; };
            row.min = p1.prices[0];
            row.p25 = await at(Math.max(1, Math.ceil(N * 0.25)));
            row.median = await at(Math.max(1, Math.ceil(N * 0.5)));
            row.p75 = await at(Math.max(1, Math.ceil(N * 0.75)));
            if (!pages[lastPage]) pages[lastPage] = (await load(t.path, q, lastPage)).prices;
            row.max = pages[lastPage][pages[lastPage].length - 1];
            notes.push('開いたページ ' + Object.keys(pages).join(','));
          }
          row.note = notes.filter(Boolean).join('／');
        } catch (e) { row.note = 'エラー: ' + e.message; }
        break;
      }
      rows.push(row);
    }
  }
  return rows;
}
