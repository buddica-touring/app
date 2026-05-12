# CONFIG-REFERENCE — 設定項目詳細リファレンス

SPK v3.9.0 の全設定箇所と変更方法のリファレンス。

---

## 1. Supabase設定（行84-85）

| 項目 | 変数名 | 説明 |
|------|--------|------|
| URL | `SUPABASE_URL` | SupabaseプロジェクトのURL |
| Key | `SUPABASE_KEY` | Supabase anon key（公開鍵） |

```javascript
const SUPABASE_URL = "https://xxxxx.supabase.co";
const SUPABASE_KEY = "eyJhbGci...";
```

**注意**: 那覇店用に新規Supabaseプロジェクトを作成すること。札幌店と共有不可。

---

## 2. 駐車場Supabase（行93-94）

札幌店は別プロジェクトで駐車場管理を行っている。那覇店で不要なら削除またはコメントアウト可。

```javascript
const PARKING_SB_URL = "https://xxxxx.supabase.co";
const PARKING_SB_KEY = "eyJhbGci...";
```

---

## 3. タイムスロット（行520）

OPシートのシフト時間枠。営業時間に合わせて変更。

```javascript
const SLOTS=["08:00","08:30","09:00", ... ,"19:00"];
```

---

## 4. タスク種別・色定義（行521）

タスクの種別ごとの表示色と背景色。種別を追加/変更する場合はここを編集。

```javascript
const TASK_META={
  DEL:{c:"#2563eb",bg:"#eff6ff"},     // お届け（青）
  PU:{c:"#059669",bg:"#ecfdf5"},      // ピックアップ（緑）
  "来店":{c:"#7c3aed",bg:"#f5f3ff"}, // 来店（紫）
  COL:{c:"#ea580c",bg:"#fff7ed"},     // 回収（オレンジ）
  BD:{c:"#e11d48",bg:"#fff1f2"},      // 誕生日（赤）
  "返却":{c:"#d97706",bg:"#fffbeb"}, // 返却（黄）
  "洗車":{c:"#64748b",bg:"#f8fafc"}, // 洗車（グレー）
  "送り":{c:"#0891b2",bg:"#ecfeff"}, // 送り（シアン）
  "鍵入れ":{c:"#a855f7",bg:"#faf5ff"},
  "回収":{c:"#f97316",bg:"#fff7ed"},
  "事前駐車":{c:"#6366f1",bg:"#eef2ff"},
  "持ち帰り":{c:"#84cc16",bg:"#f7fee7"},
  MTG:{c:"#f59e0b",bg:"#fffbeb"},
  "その他":{c:"#6b7280",bg:"#f9fafb"}
};
```

---

## 5. スタッフマスター（行523）

```javascript
const INIT_STAFF=[
  {
    name: "スタッフ名",      // 表示名
    type: "正社員",           // "正社員" or "アルバイト"
    memo: "",                 // メモ
    hourlyWage: 0,            // 時給（アルバイト用）
    transportCost: 0,         // 交通費/日
    monthlySalary: 280000     // 月給（正社員用）
  },
  // ...
];
```

---

## 6. 車両クラスマスター（行527-534）

```javascript
const INIT_CLASSES=[
  {
    type: "A",                              // クラスコード（1文字推奨）
    label: "トヨタ アルファード/ヴェルファイア", // 表示名
    seats: 8                                // 定員
  },
  // ...
];
```

---

## 7. 車両マスター（行535-544）

```javascript
const INIT_VEHICLES=[
  {
    id: "v1",          // 内部ID（ユニーク）
    code: "VEL",       // 車両コード（3文字、配車表・CARMONで使用）
    name: "ヴェルファイア", // 車種名
    no: "7673",        // ナンバー（下4桁）
    type: "A",         // クラスコード（INIT_CLASSESのtypeと一致）
    seats: 8           // 定員
  },
  // ...
];
```

**55台の場合**: `id` は "v1" 〜 "v55" のようにユニークに。`code` は3文字で重複なく設定。

---

## 8. 車両カラー（行545）

配車表での車両色分け。キーは車両コード。

```javascript
const V_COLORS={
  VEL: "#7c3aed",  // 紫
  NRH: "#0284c7",  // 青
  // ... 車両コードごとに色を指定
};
```

**55台の場合**: 色が似すぎないよう注意。HEXカラーを一覧で準備しておくと良い。

---

## 9. Googleスプレッドシート連携

### 場所・時間データ（行568）
OPシートの場所・時間情報をGoogleスプレッドシートから取得。

```javascript
const PLACE_SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/xxxxx/pub?gid=xxx&output=csv";
```

**CSV列構成（期待値）:**
- H列（index 7）: DEL時間
- I列（index 8）: DEL場所
- K列（index 10）: COL時間
- L列（index 11）: COL場所
- 予約番号列: 自動検出（ヘッダーに「予約番号」「予約ID」「Reservation」を含む列）

### じゃらん決済データ（行659）
```javascript
const JALAN_PAY_SHEET_CSV = "https://docs.google.com/spreadsheets/d/e/xxxxx/pub?gid=xxx&output=csv";
```

**設定手順:**
1. Googleスプレッドシートを作成
2. 「ファイル」→「ウェブに公開」→ CSV形式で公開
3. 公開URLをここに貼り付け

---

## 10. CARMON連携

アプリ内のCARMONボタンで車両追跡サービスを開く。

**関連箇所:**
- CARMONダッシュボードURL（モーダル内）: `https://web.carmon.alpine-srv.net/`
- localStorage に ID/PAS を保存: `spk_carmon_id`, `spk_carmon_pas`

那覇店のCARMONアカウントが異なる場合はURLとlocalStorageキーを変更。

---

## 11. APP_VERSION（行5503）

```javascript
const APP_VERSION = "v1.0.0-BT";  // 那覇店初版
```

バージョンが変わると自動リロードが発動する仕組み。

---

## 12. localStorageキー一覧

| キー | 用途 | 那覇店変更後 |
|------|------|-------------|
| `spk_auth` | ログイン状態 | `bt_auth` |
| `spk_fleet` | 配車データキャッシュ | `bt_fleet` |
| `spk_sb_url` | Supabase URL保存 | `bt_sb_url` |
| `spk_sb_key` | Supabase Key保存 | `bt_sb_key` |
| `spk_app_version` | バージョン管理 | `bt_app_version` |
| `spk_carmon_id` | CARMON ログインID | `bt_carmon_id` |
| `spk_carmon_pas` | CARMON パスワード | `bt_carmon_pas` |

**一括置換コマンド（エディタ）:** `spk_` → `nha_` で検索置換

---

## 13. LINE送信テンプレート

モーダル内のLINEテンプレート文面（行3204付近）。那覇店の文面に変更が必要な場合はここを編集。

**DELテンプレート:**
- ①到着のお知らせ — お届け時のLINE送信文
- ②位置情報のお知らせ — 車両位置情報テンプレート

**COLテンプレート:**
- ①返却場所到着のお知らせ — 回収時のLINE送信文
- ②乗り捨て依頼 — 乗り捨て対応テンプレート

---

## 14. ポーリング間隔

DB同期のポーリング間隔（デフォルト30秒）。55台規模でも問題ないが、変更する場合はコード内の `setInterval` を検索。

---

## 15. 日付タブ表示範囲

OPシートの日付タブは最大60日先まで表示（行3023付近）。変更する場合は `i<=60` の数値を調整。

---

## セットアップチェックリスト

- [ ] Supabaseプロジェクト作成 & テーブル作成（SETUP-GUIDE.md参照）
- [ ] `SUPABASE_URL` / `SUPABASE_KEY` 差し替え
- [ ] 駐車場Supabase 削除 or 設定
- [ ] `INIT_STAFF` を那覇店スタッフに変更
- [ ] `INIT_CLASSES` を那覇店車両クラスに変更
- [ ] `INIT_VEHICLES` に55台分登録
- [ ] `V_COLORS` に55台分の色を設定
- [ ] Googleスプレッドシート作成 & URL設定
- [ ] CARMON設定確認
- [ ] `APP_VERSION` を `v1.0.0-NHA` に変更
- [ ] `spk_` → `nha_` のlocalStorageキー一括置換
- [ ] LINEテンプレート文面確認
- [ ] GitHub & Vercel デプロイ
