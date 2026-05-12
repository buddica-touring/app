# BUDDICA TOURING 高松店 タスク管理APP セットアップガイド

## 概要
札幌店（SPK）v3.9.0をベースにBUDDICA TOURING 高松店用にカスタマイズするためのガイド。

---

## ファイル構成

```
naha-project/
├── index.html          ← メインアプリ（単一HTMLファイル、v3.9.0ベース）
├── SETUP-GUIDE.md      ← このファイル
└── CONFIG-REFERENCE.md ← 設定項目の詳細リファレンス
```

---

## 那覇店用に変更が必要な箇所（行番号はv3.9.0基準）

### 1. Supabase設定（行84-85）★必須
那覇店用に**新しいSupabaseプロジェクト**を作成し、URL/Keyを差し替え。
```javascript
const SUPABASE_URL = "https://xxxxx.supabase.co";  // 那覇店用
const SUPABASE_KEY = "eyJhbGci...";                 // 那覇店用anon key
```

**Supabaseテーブル構成（同じスキーマで作成）:**
- `tasks` - 日次タスク
- `fleet` - 車両配車マッピング
- `reservations` - 予約データ
- `shifts` - シフトデータ
- `maintenance` - メンテナンス
- `settings` - 各種設定
- `salary_settings` - 給与設定

### 2. スタッフマスター（行523）★必須
那覇店のスタッフに差し替え。
```javascript
const INIT_STAFF=[
  {name:"スタッフ名",type:"正社員",memo:"",hourlyWage:0,transportCost:0,monthlySalary:280000},
  // ... 那覇店スタッフを追加
];
```

### 3. 車両クラスマスター（行527-534）★必須
那覇店の車両クラスに変更。55台規模なのでクラス追加の可能性あり。
```javascript
const INIT_CLASSES=[
  {type:"A",label:"車種名",seats:8},
  // ... 那覇店のクラス構成
];
```

### 4. 車両マスター（行535-544）★必須
那覇店の全55台を登録。
```javascript
const INIT_VEHICLES=[
  {id:"v1",code:"車両コード",name:"車種名",no:"ナンバー",type:"クラス",seats:5},
  // ... 55台分
];
```

### 5. 車両カラー（行545）
配車表の色分け。車両コードに対応する色を設定。
```javascript
const V_COLORS={車両コード1:"#色コード", ...};
```

### 6. Googleスプレッドシート連携（行568, 659）
那覇店用のスプレッドシートURLに変更。
```javascript
// 場所・時間データ取得用
const PLACE_SHEET_CSV="https://docs.google.com/spreadsheets/d/e/xxxxx/pub?gid=xxx&output=csv";

// じゃらん決済データ取得用
const JALAN_PAY_SHEET_CSV="https://docs.google.com/spreadsheets/d/e/xxxxx/pub?gid=xxx&output=csv";
```

### 7. CARMON URL（モーダル内）
那覇店のCARMONアカウントURLが異なる場合は変更。
現在: `https://web.carmon.alpine-srv.net/`

### 8. APP_VERSION（行5503）
那覇店バージョンに変更。
```javascript
const APP_VERSION="v1.0.0-BT";
```

### 9. localStorage キープレフィックス
札幌店と同じブラウザで使う場合、キーが競合する可能性あり。
以下のキーを検索して `spk_` → `nha_` に一括置換を推奨：
- `spk_auth` → `bt_auth`
- `spk_fleet` → `bt_fleet`
- `spk_sb_url` → `bt_sb_url`
- `spk_sb_key` → `bt_sb_key`
- `spk_app_version` → `bt_app_version`
- `spk_carmon_id` → `bt_carmon_id`
- `spk_carmon_pas` → `bt_carmon_pas`

---

## Supabase テーブル作成SQL

```sql
-- tasks テーブル
CREATE TABLE tasks (
  _id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT,
  time TEXT,
  name TEXT,
  assignee TEXT,
  vehicle TEXT,
  place TEXT,
  people INTEGER DEFAULT 0,
  insurance TEXT,
  flight TEXT,
  reservation_id TEXT,
  ota TEXT,
  tel TEXT,
  mail TEXT,
  done BOOLEAN DEFAULT FALSE,
  memo TEXT,
  assigned_vehicle TEXT,
  plate_no TEXT,
  insurance_change TEXT,
  opts_json TEXT,
  changed_json TEXT,
  yakkan BOOLEAN DEFAULT FALSE,
  line BOOLEAN DEFAULT FALSE,
  payment BOOLEAN DEFAULT FALSE,
  return_date TEXT,
  return_time TEXT,
  return_type TEXT,
  col_place TEXT,
  manual BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX idx_tasks_date ON tasks(date);

-- fleet テーブル
CREATE TABLE fleet (
  reservation_id TEXT PRIMARY KEY,
  vehicle_code TEXT NOT NULL
);

-- reservations テーブル
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  data_json TEXT
);

-- shifts テーブル
CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  data_json TEXT
);

-- maintenance テーブル
CREATE TABLE maintenance (
  id TEXT PRIMARY KEY,
  vehicle_code TEXT,
  start_date TEXT,
  end_date TEXT,
  label TEXT
);

-- settings テーブル
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- salary_settings テーブル
CREATE TABLE salary_settings (
  name TEXT PRIMARY KEY,
  data_json TEXT
);
```

---

## 55台規模の注意点

1. **localStorage 5MB制限**: 55台×予約データが多いとLSが溢れる可能性。定期的にLS清掃を推奨。
2. **配車表の描画速度**: 55台の場合、列が多くなるためスクロール操作が重要。
3. **Supabase Free Tier**: 500MB DB / 50,000行まで。55台規模だと有料プラン検討。
4. **ポーリング間隔**: 30秒ごとのDB同期。55台でも問題ないが、同時接続数に注意。

---

## デプロイ方法

1. GitHubに新リポジトリ作成（例: `nha-task-manager`）
2. `index.html` をプッシュ
3. Vercelに接続して自動デプロイ
4. 独自ドメイン設定（任意）
