# カーセンサー相場の週1調査（手順）

毎週月曜 9:46（日本時間）に自動で実行する。判断基準は `docs/market-price-rule.md`。

1. **ブラウザ**：nosh さんの Mac mini の Chrome（Claude in Chrome の「Browser 1」、deviceId `85681659-e6a6-46a3-af05-f42f04f29de6`）を選ぶ。MacBook（Browser 2）は使わない。Mac mini が見つからなければ実行せず、その旨を報告する。
2. **対象**：Supabase（ggqugvyskyiblxiycpci）の `bt_vehicles` で `active` かつ `market_code` がある車。条件は車両マスタの値を優先し、空の項目だけ `tools/carsensor-targets.json` の値（推定）を使う。
   - 年式：`specs.first_reg` の西暦、なければ `year`
   - 排気量：`specs.displacement`（L）をカーセンサーの区分（cc）に直す。例 1.49→1500、2.48→2500、0.65→660、1.99→2000
   - 動力：ガソリン（レギュラー／ハイオク）=1、軽油=2、ハイブリッド=3、電気=4
   - 駆動：2WD=4WD0、4WD=4WD1
   - 定員：`seats`
   - 走行：`current_mileage`。リミットは `life_limit_km`、空なら 100000
   - 年式か走行が分からない車は調べず、報告に「対象外」と書く
3. **実行**：カーセンサーのページ（https://www.carsensor.net/usedcar/）を開き、`tools/carsensor-survey.js` の `surveyCarsensor` を定義してから、バックグラウンドで実行する（1回の実行が45秒を超えると止まるため、`.then()` で結果を `window` に入れ、あとで読み取る）。1ページごとに1.5秒あける。
4. **保存**：返ってきた行をそのまま `bt_market_prices` に insert する（vehicle_code, source, purpose, year_from, year_to, km_from, km_to, query_url, n, median, p25, p75, min, max, note）。掲載文・写真・個別の物件は保存しない。
5. **報告**：調べた台数、条件を広げた車、該当なしの車、前回から中央値が10%以上動いた車を短く報告する。
