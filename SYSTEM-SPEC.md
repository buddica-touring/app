# HANDYMAN 那覇空港店 レンタカー管理APP システム仕様書

**バージョン:** v3.2.8-NHA
**対象店舗:** 那覇空港店（NHA）
**公開URL:** https://handyman-fleet.vercel.app/
**作成日:** 2026-03-31
**リポジトリ:** https://github.com/nosh2318/naha-task

---

## 目次

1. [システム概要](#1-システム概要)
2. [アーキテクチャ図](#2-アーキテクチャ図)
3. [ファイル構成と役割](#3-ファイル構成と役割)
4. [技術スタック詳細](#4-技術スタック詳細)
5. [DB設計](#5-db設計)
6. [機能一覧](#6-機能一覧)
7. [データフロー](#7-データフロー)
8. [外部連携](#8-外部連携)
9. [セキュリティ](#9-セキュリティ)
10. [デプロイ・運用](#10-デプロイ運用)

---

## 1. システム概要

### 1.1 目的

株式会社Global Lines（レンタカーショップ HANDYMAN）の那覇空港店向けに構築した、社内専用レンタカー業務管理アプリケーション。予約管理・配車・スタッフシフト・売上集計・タスク管理を一元化し、OTA（オンライン旅行代理店）からの予約メールを自動取込・自動配車することで業務効率を最大化する。

### 1.2 主要機能サマリー

| カテゴリ | 機能 |
|---------|------|
| 予約管理 | CSV/TSVインポート・手動登録・OTA自動取込・変更履歴管理 |
| 配車管理 | タイムライン配車表・自動配車・メンテナンス管理 |
| 業務管理 | OPシート・タスク管理・タイムテーブル |
| スタッフ管理 | スタッフ登録・シフトカレンダー・出勤退勤管理 |
| 売上・会計 | ダッシュボード・損益計算・じゃらん決済照合・Square連携 |
| 分析 | エリア分析・外国人利用率・タスク分析・顧客分析 |
| 自動化 | GAS 15分間隔メール取込・自動配車・Slack通知 |

### 1.3 対応OTA

| コード | OTA名 | 送信元メール |
|--------|-------|------------|
| J | じゃらん | info@jalan-rentacar.jalan.net |
| R | 楽天トラベル | travel@mail.travel.rakuten.co.jp |
| S | skyticket | rentacar@skyticket.com |
| O | エアトリ | info@rentacar-mail.airtrip.jp |
| O | エアトリプラスDP | info@skygate.co.jp |
| HP | オフィシャル（直予約） | noreply@rent-handyman.jp |

---

## 2. アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────┐
│                        クライアント (ブラウザ/スマホ)                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  PWA (Service Worker: nha-v6 / nha-cdn-v1)                  │    │
│  │  ┌─────────────────────────────────────────────────────┐    │    │
│  │  │  React 18.2.0 + Tailwind CSS 2.2.19 (Single HTML)  │    │    │
│  │  │  app.js (Babel+terser プリコンパイル済み / 10446行) │    │    │
│  │  └─────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────┘    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS
┌───────────────────────────────▼─────────────────────────────────────┐
│                          Vercel (CDN/Edge)                           │
│  main ブランチ push → 自動デプロイ                                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ REST API / Realtime (WebSocket)
┌───────────────────────────────▼─────────────────────────────────────┐
│                    Supabase (PostgreSQL)                             │
│  URL: ckrxttbnawkclshczsia.supabase.co                              │
│  テーブル: nha_reservations / nha_fleet / nha_tasks /               │
│           nha_vehicles / nha_maintenance / nha_staff /              │
│           nha_shifts / nha_attendance / nha_app_settings /          │
│           nha_reservation_changes                                    │
│  Realtime: 全テーブル購読（全端末間リアルタイム同期）                   │
│  Storage: 免許証画像アップロード                                       │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │ REST API (UrlFetchApp)              │ REST API
         │                                    │
┌────────┴────────────────┐        ┌──────────┴──────────────┐
│  Google Apps Script     │        │  外部スプレッドシート    │
│  (GAS / Code.gs)        │        │  - 場所データ           │
│                         │        │  - DEL/COL時間          │
│  15分間隔トリガー        │        │  - じゃらん決済         │
│  Gmail取込              │        └─────────────────────────┘
│  → OTA判別・パース       │
│  → nha_reservations登録  │
│  → 自動配車             │
│  → Slack通知            │
│  → ハートビート記録     │
└─────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  CDN (読込専用)                                                      │
│  cdnjs.cloudflare.com: React 18.2.0 / ReactDOM / Babel 7.23.9      │
│  cdn.jsdelivr.net: Supabase JS / encoding-japanese                  │
│  cdn.tailwindcss.com: Tailwind CSS 2.2.19                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Realtimeアーキテクチャ

```
端末A (スタッフ)                 Supabase Realtime               端末B (管理者)
    │                                  │                              │
    │── DB更新 (例: 配車変更) ─────────►│                              │
    │                                  │── INSERT/UPDATE イベント ────►│
    │◄─ エコー防止 (2秒以内は無視) ─────│                              │
    │                                  │                              │
```

---

## 3. ファイル構成と役割

```
naha-project/
├── index.html          (143行)   本番ローダー
├── index.html.bak      (10446行) JSXソースコード本体（編集対象）
├── app.js                        Babel+terser圧縮済み本番ファイル（build.jsで生成）
├── build.js            (32行)    ビルドスクリプト
├── sw.js               (71行)    Service Worker
├── package.json                  npm依存関係定義
├── package-lock.json             ロックファイル
├── gas/
│   ├── Code.gs                   GAS本体（予約メール取込・自動配車）
│   └── appsscript.json           GASプロジェクト設定
└── SYSTEM-SPEC.md                本仕様書
```

### 3.1 各ファイル詳細

#### index.html（本番ローダー）
- Service Worker 強制更新チェーン（旧SW解除 → キャッシュ全削除 → 新SW登録）
- ワンタイム localStorageキャッシュクリア（キー: `nha_cache_cleared_v3`）
- スプラッシュスクリーン表示
- CDN同期読込（React, ReactDOM, Supabase, Tailwind）
- `app.js` の動的読込（プリコンパイル済み本体）

#### index.html.bak（JSXソース本体）
- 全コンポーネント・ビジネスロジックを含む10446行のJSXファイル
- Babel変換対象（`<script type="text/babel">`）
- 本番運用時はビルド後のapp.jsを使用

#### app.js（本番バイナリ）
- `build.js` により `index.html.bak` のJSX部分を抽出してBabel変換し、terserで圧縮
- Babel設定: `@babel/preset-react`
- 本番環境ではこのファイルが読み込まれる

#### build.js（ビルドスクリプト）
- Node.js製 32行のシンプルなビルドスクリプト
- `index.html.bak` からJSXを抽出 → Babel変換 → terser圧縮 → `app.js` 出力

#### sw.js（Service Worker）
- キャッシュ名: `nha-v6`（アプリファイル）、`nha-cdn-v1`（CDNライブラリ）
- 戦略:
  - CDN（cdnjs.cloudflare.com, cdn.jsdelivr.net）: **cache-first** (stale-while-revalidate)
  - app.js: **network-first**（常に最新取得、オフライン時はキャッシュフォールバック）
  - HTML: **network-first**
- インストール時に `'/'`, `'/index.html'`, `'/app.js'` をプリキャッシュ
- アクティベート時に旧キャッシュを自動削除

#### gas/Code.gs（GAS本体）
- Gmail `reserve@rent-handyman.jp` から予約メールを15分間隔で取込
- OTA別パーサー実装（じゃらん/楽天/skyticket/エアトリ/エアトリプラスDP/オフィシャル）
- 那覇店フィルタリング（住所・営業所名・お届け先・車両クラスコードで判定）
- 自動配車・Slack通知・ハートビート記録
- 未知送信元監視（OTA未登録の予約系メールをSlackアラート）

---

## 4. 技術スタック詳細

### 4.1 フロントエンド

| 技術 | バージョン | 用途 |
|------|-----------|------|
| React | 18.2.0 | UIコンポーネント・状態管理 |
| ReactDOM | 18.2.0 | DOM描画 |
| Babel | 7.23.9 | JSX → JS変換（CDN経由） |
| @babel/core | ^7.29.0 | ビルド時JSX変換 |
| @babel/preset-react | ^7.28.5 | Reactプリセット |
| Tailwind CSS | 2.2.19 | ユーティリティCSS |
| terser | ^5.46.1 | JS圧縮（devDependency） |

### 4.2 バックエンド / BaaS

| 技術 | 用途 |
|------|------|
| Supabase (PostgreSQL) | メインDB（予約・配車・スタッフ・車両） |
| Supabase Realtime | WebSocketによる全端末間リアルタイム同期 |
| Supabase Storage | 免許証画像保存 |
| Google Apps Script | 予約メール自動取込・自動配車バックエンド |

### 4.3 インフラ

| 技術 | 用途 |
|------|------|
| Vercel | ホスティング・CDN・自動デプロイ（mainブランチ連動） |
| GitHub (nosh2318/naha-task) | ソースコード管理 |
| PWA / Service Worker | オフライン対応・キャッシュ制御 |

### 4.4 外部API・サービス

| サービス | 用途 |
|---------|------|
| Square API | 決済管理（SquarePaymentPanel） |
| Slack (メール経由) | GAS処理結果通知・アラート |
| Google スプレッドシート | 場所データ・DEL/COL時間・じゃらん決済データ取得 |
| encoding-japanese (CDN) | SJIS/UTF8自動判定でCSV読込 |

### 4.5 Supabase 接続情報

| 項目 | 値 |
|------|-----|
| メインURL | ckrxttbnawkclshczsia.supabase.co |
| 駐車場URL | rkrvjpipvpybkmqadmrb.supabase.co |
| テーブルプレフィックス | `nha_`（札幌店と同一Supabaseプロジェクト内で分離） |

---

## 5. DB設計

### 5.1 テーブル一覧

| テーブル名 | 用途 |
|-----------|------|
| nha_reservations | 予約マスター |
| nha_fleet | 配車（予約×車両の紐付け） |
| nha_tasks | タスク |
| nha_vehicles | 車両マスター |
| nha_maintenance | メンテナンス記録 |
| nha_staff | スタッフマスター |
| nha_shifts | シフト |
| nha_attendance | 出勤退勤 |
| nha_app_settings | アプリ設定・ハートビート記録 |
| nha_reservation_changes | 予約変更履歴 |

### 5.2 主要テーブル詳細

#### nha_reservations（予約マスター）

| カラム | 説明 |
|--------|------|
| id | 予約番号（OTA予約番号またはシステム採番） |
| ota | OTAコード（J/R/S/O/HP） |
| name | 顧客名 |
| phone | 電話番号 |
| email | メールアドレス |
| lend_date | 貸出日 |
| return_date | 返却日 |
| lend_time | 貸出時刻 |
| return_time | 返却時刻 |
| vehicle | 車両クラス（A/A2/B/B2/C/D/F/H/S） |
| pax | 人数 |
| price | 料金 |
| del_place | お届け場所 |
| col_place | 回収場所 |
| status | 予約ステータス（active/cancelled 等） |
| child_seat | チャイルドシート |
| created_at | 登録日時 |

#### nha_fleet（配車）

| カラム | 説明 |
|--------|------|
| id | 配車ID |
| reservation_id | 予約ID（nha_reservations.id） |
| vehicle_code | 車両コード（nha_vehicles.code） |
| created_at | 配車日時 |

#### nha_vehicles（車両マスター）

| カラム | 説明 |
|--------|------|
| id | 車両ID |
| code | 車両コード |
| name | 車両名 |
| class | 車両クラス（A/A2/B/B2/C/D/F/H/S） |
| plate_no | ナンバープレート |
| status | 稼働ステータス |

#### nha_maintenance（メンテナンス）

| カラム | 説明 |
|--------|------|
| id | メンテナンスID |
| vehicle_code | 対象車両コード |
| start_date | 開始日 |
| end_date | 終了日 |
| note | メモ |

#### nha_app_settings（アプリ設定）

| カラム | 説明 |
|--------|------|
| key | 設定キー |
| value | 設定値（JSON文字列） |

GASハートビートは `key = 'heartbeat_nha_gas_email'` で管理。
value例: `{"last_run":"ISO8601","status":"ok","processed":5,"errors":0}`

### 5.3 車両クラス定義（9クラス / 56台）

| クラス | 表示名 | 主要車種 |
|-------|--------|---------|
| A | アルファードHクラス | アルファード |
| A2 | アルファードHクラス(A2) | アルファード |
| B | ワンボックスB | ヴェルファイア / セレナH / ヴォクシー / ノアH / アルファードM |
| B2 | ワンボックスB2 | 同上 |
| C | コンパクトSUV | ヤリスクロス / ライズ |
| D | ワンボックスD | セレナM / ノアM / エスクァイア |
| F | コンパクト | ヴィッツ / ノート / アクア |
| H | ハイブリッド | プリウス / プリウスアルファ |
| S | ハリアー | ハリアー |

---

## 6. 機能一覧

### 6.1 認証

- **LoginScreen**: パスワード認証（シンプルパスワード照合）
- **PASGuard**: 全画面を保護する認証ガードラッパー
- **Root**: 認証チェック + バージョン表示

### 6.2 OPシート（メイン業務画面）

- **OPScreen**: 本日の業務一覧（全画面表示）
  - 当日の貸出・返却一覧
  - 予約詳細表示・編集
  - 免許証アップロード（Supabase Storage連携）
  - お届け・回収場所・時間の管理
  - バス送迎スロット表示（isBusRequired / computeBusSlots）

### 6.3 配車管理

- **FleetManager**: 配車表タイムライン
  - 月別表示（車両行 × 日付列のカレンダー形式）
  - 予約バー表示・ドラッグ＆ドロップによる配車
  - メンテナンスバー表示（上部ストライプ、配車表に重ねて表示）
  - 予約番号検索 + 自動スクロール
  - 未配車リスト + 配車ボタン
- **FleetTimeline**: 当日配車タイムライン（時間軸ビジュアル）
- **MaintForm**: メンテナンス登録フォーム

### 6.4 タスク管理

- **generateTasks**: 予約からタスクを自動生成
- **TimeTable**: 当日タスクタイムテーブル
- **AddTaskForm**: 手動タスク追加フォーム
- **PastTasksTable**: 過去タスク参照
- **TaskAnalyticsCard**: タスク分析カード

### 6.5 車両管理

- **VehicleManager**: 車両CRUD（登録・編集・削除）
- **VehicleMaintenanceBook**: 車両保守管理台帳
- **VehicleFleetStatus**: 車両稼働状況一覧
- **VehicleTab**: 車両管理タブ統合（上記3コンポーネントの統合画面）

### 6.6 スタッフ・勤怠管理

- **StaffManager**: スタッフCRUD
- **AttendanceManager**: 出勤・退勤打刻管理
- **ShiftCalendar**: シフトカレンダー（月別スケジュール）
- **MemoBox**: 日別メモ（スタッフ向け共有メモ）

### 6.7 予約インポート・登録

- **CSVPanel**: CSVファイル取込UI
  - parseCSV: CSV/TSV自動判別パース
  - readFile: encoding-japanese使用、SJIS/UTF8自動判定
  - parsePrice: 多様な金額フォーマット対応
  - normClass: 車両クラス正規化
  - detectSeats: チャイルドシート等オプション検出
  - detectDelCol: お届け/回収場所検出
- **detectParse**: OTA自動判別 + パース（6 OTA対応）
- **ReservationForm**: 手動予約登録フォーム

### 6.8 売上・会計

- **Dashboard**: 売上ダッシュボード（KPI・グラフ）
- **AccountingPanel**: 売上集計・損益計算
- **SquarePaymentPanel**: Square API連携（決済管理）
- **JalanPayment**: じゃらん決済照合（スプレッドシートデータと照合）

### 6.9 分析・レポート

- **AnalyticsTab**: エリア分析・出発/到着場所分布
- **ForeignVisitorAnalysis**: 外国人利用率分析
  - isJapaneseName: 漢字・ひらがな・カタカナで日本人名判定
- **CustomerList**: 顧客一覧
- **buildRepeaterMap**: リピーター検知（電話・メールで過去予約マッチング）

### 6.10 データ管理

- **DataTable**: 統合データ一覧
  - 全予約の検索・ソート・フィルター・インライン編集
- **App**: 全画面統合・ルーティング・Supabase Realtime購読・データ管理

---

## 7. データフロー

### 7.1 GAS自動取込フロー（15分間隔）

```
Gmail (reserve@rent-handyman.jp)
    │
    ▼ GmailApp.search() — 2日以内・未処理ラベル
OTA別メール
    │
    ▼ 送信元アドレスでOTA特定
OTA判別 (J/R/S/O/HP)
    │
    ├─ キャンセルメール → nha_reservations.status = 'cancelled'
    │                   → nha_fleet / nha_tasks 削除
    │
    └─ 予約メール
        │
        ▼ OTA別パーサー (parseJalan_ / parseRakuten_ / parseSkyticket_ 等)
        │
        ▼ isNahaReservation_() — 那覇フィルタ
        │   判定要素: 住所 / 営業所名 / お届け先 / 車両クラスコード
        │
        ├─ 那覇外 → スキップ
        │
        └─ 那覇 → 重複チェック
                   │
                   ├─ 既存(active) → スキップ
                   ├─ 既存(cancelled) → 再有効化
                   └─ 新規 → INSERT
                              │
                              ▼ autoAssignVehicle_()
                              │   同期間・同クラスの空車検索
                              │
                              ▼ Slack通知 (成功/失敗/キャンセル)
                              │
                              ▼ ハートビート更新 (nha_app_settings)
```

### 7.2 CSVインポートフロー（手動）

```
ユーザーがCSVファイルを選択
    │
    ▼ readFile() — encoding-japaneseでSJIS/UTF8自動判定
    │
    ▼ parseCSV() — CSV/TSV自動判別
    │
    ▼ detectParse() — OTA形式自動判別
    │
    ▼ 各フィールド正規化 (normClass / detectSeats / detectDelCol 等)
    │
    ▼ Supabase nha_reservations INSERT (バッチ)
    │
    ▼ generateTasks() — タスク自動生成
    │
    ▼ 画面リフレッシュ
```

### 7.3 Realtimeデータ同期フロー

```
端末A: DB更新（INSERT/UPDATE/DELETE）
    │
    ▼ Supabase Realtime WebSocket
    │
    ▼ 全接続端末にイベント配信
    │
    ▼ エコー防止チェック（同端末の更新から2秒以内はスキップ）
    │
    ▼ Reactステート更新 → 画面再描画
```

### 7.4 デプロイフロー

```
index.html.bak を編集（JSXソース）
    │
    ▼ node build.js
    │   1. index.html.bak からJSXブロック抽出
    │   2. @babel/core + @babel/preset-react で変換
    │   3. terser で圧縮 → app.js 生成
    │
    ▼ git commit & push → main ブランチ
    │
    ▼ Vercel 自動デプロイ（数分）
    │
    ▼ クライアント: Service Worker が app.js を network-first で取得
    │
    ▼ APP_VERSION チェック: localStorageと比較、変更時は自動リロード
```

---

## 8. 外部連携

### 8.1 Google Apps Script

| 項目 | 値 |
|------|-----|
| トリガー | 15分間隔（timeBased().everyMinutes(15)） |
| 対象メールボックス | reserve@rent-handyman.jp |
| 処理上限 | 最新50スレッド / 2日以内 |
| 処理済みラベル | `processed_naha` |
| 通知先 | Slack（メール経由） |

#### GAS トリガー一覧

| 関数名 | トリガー | 用途 |
|--------|---------|------|
| processNewEmails | 15分間隔 | メール取込・自動配車メイン |
| checkHeartbeats | 30分間隔 | GAS停止監視（閾値: 30分） |
| checkUnknownSenders_ | processNewEmails 内 | 未登録OTA送信元の監視 |

#### ハートビート監視

- GAS実行完了ごとに `nha_app_settings` テーブルへ記録
- 別トリガー `checkHeartbeats` が30分間隔で `last_run` を検証
- 30分以上更新がない場合 → Slack アラート送信
- 復旧検知時 → Slack 復旧通知

### 8.2 Supabase Realtime

- 全テーブル対象でリアルタイム購読
- INSERT / UPDATE / DELETE イベントを全接続端末へブロードキャスト
- エコー防止: 自端末更新から2秒以内の受信イベントは無視

### 8.3 Supabase Storage

- 免許証画像のアップロード・表示
- OPシート内から直接アップロード可能

### 8.4 Google スプレッドシート

| データ | 用途 |
|--------|------|
| 場所データ | お届け・回収場所のマスタ参照 |
| DEL/COL時間データ | お届け・回収の時刻データ |
| じゃらん決済データ | じゃらん決済と予約の照合 |

### 8.5 Square API

- SquarePaymentPanel コンポーネントで連携
- 決済情報の取得・管理

### 8.6 Slack 通知

| 通知種別 | トリガー |
|---------|---------|
| 予約取込成功 | 配車完了時 |
| 配車失敗 | 空車なし時 |
| キャンセル処理 | キャンセルメール取込時 |
| GAS停止アラート | ハートビート途絶30分超過時 |
| GAS復旧通知 | ハートビート再開検知時 |
| 未知送信元アラート | 未登録OTA送信元検知時 |

Slack への通知は `MailApp.sendEmail(SLACK_EMAIL, ...)` による Slack メール統合経由。

---

## 9. セキュリティ

### 9.1 認証・認可

| 項目 | 実装 |
|------|------|
| アプリ認証 | パスワード認証（LoginScreen / PASGuard） |
| Supabase認証 | anon key（クライアントサイド） |
| GAS認証 | Supabase anon key（ヘッダー埋め込み） |

### 9.2 アクセス制御

- パスワード認証により社内スタッフのみアクセス可能
- Supabase Row Level Security (RLS) の適用はSupabase側設定に依存
- Vercel: mainブランチからの自動デプロイ（GitHubリポジトリアクセス制御）

### 9.3 データ保護

- Supabase StorageへのアクセスはSupabaseの認証トークンで保護
- HTTPS通信（Vercel標準TLS）
- GASとSupabase間の通信はHTTPS（UrlFetchApp）

### 9.4 注意事項

- Supabase anon keyはクライアントサイドコードに含まれる（公開鍵の性質を持つが、RLS設定が重要）
- GAS内のanon keyはスクリプトプロパティでの管理が推奨（現状はコード内埋め込み）

---

## 10. デプロイ・運用

### 10.1 デプロイ手順

```bash
# 1. ソースコード編集
vi index.html.bak  # JSXコンポーネントを編集

# 2. ビルド
node build.js  # app.js を生成

# 3. バージョン更新（必要時）
# index.html.bak 末尾の APP_VERSION を更新
# APP_VERSION = "v3.2.8-NHA" → "v3.2.9-NHA" 等

# 4. Service Workerキャッシュ名更新（必要時）
# sw.js の CACHE_NAME = 'nha-v6' → 'nha-v7' 等

# 5. Git push
git add index.html.bak app.js sw.js
git commit -m "v3.2.x: 変更内容"
git push origin main
# → Vercel が自動デプロイ
```

### 10.2 バージョン管理

- `APP_VERSION` 定数（index.html.bak末尾, 10424行）
- アプリ起動時にlocalStorageの保存バージョンと比較
- バージョン変更を検知した場合、自動的にページリロードを実行
- 現行バージョン: `v3.2.8-NHA`

### 10.3 キャッシュ更新戦略

| リソース | 更新方法 |
|---------|---------|
| app.js | ファイル内容変更でnetwork-firstにより自動取得 |
| CDNライブラリ | キャッシュ名変更（nha-cdn-v1 → nha-cdn-v2）で強制更新 |
| 全キャッシュクリア | sw.jsのCACHE_NAME変更でアクティベート時に旧キャッシュ削除 |
| localStorage | `nha_cache_cleared_v3` キーのバージョン変更でワンタイムクリア |

### 10.4 GAS運用

```
Google Apps Script プロジェクト設定
├── トリガー: processNewEmails — 15分間隔
├── トリガー: checkHeartbeats — 30分間隔
├── ラベル: processed_naha（自動作成）
└── Slack通知先: x-aaaatppttzyrldnhjt5el4jj3i@gl-oke5175.slack.com
```

#### GAS初回セットアップ

```javascript
// GASエディタから実行
setup()  // トリガー作成 + ラベル作成
```

#### テスト実行

```javascript
// 最新7日分のメールをdryRunで処理（DB書込なし）
testProcessLatest()
```

### 10.5 監視・障害対応

| 監視項目 | 方法 | アラート条件 |
|---------|------|------------|
| GAS実行 | ハートビート（nha_app_settings） | 30分以上停止 |
| 未知OTA | checkUnknownSenders_ | 未登録送信元検知時 |
| 配車失敗 | Slack通知 | 空車なし・DB登録失敗時 |

### 10.6 ローカル開発環境

```bash
# 依存インストール
npm install

# ビルド
node build.js

# ローカルサーバー（任意のHTTPサーバー）
# Service Workerはlocalhost環境でも動作
```

### 10.7 環境・依存ツールバージョン

| ツール | バージョン |
|--------|----------|
| Node.js | v24.x（package-lock.json実績） |
| @babel/core | ^7.29.0 |
| @babel/preset-react | ^7.28.5 |
| terser | ^5.46.1 |

---

## 付録A: GASパーサー対応OTAフォーマット

| OTA | 予約番号抽出フィールド | 特記事項 |
|-----|---------------------|---------|
| じゃらん | `予約番号` | 件名: `じゃらんnetレンタカー 予約通知` |
| 楽天 | `・予約番号` | 件名: `【楽天トラベル】予約受付のお知らせ` |
| skyticket | `予約番号` | 件名: `【skyticket】 新規予約` |
| エアトリ | `予約番号` | 件名: `【予約確定】エアトリレンタカー` |
| エアトリプラスDP | `予約番号` | 件名: `【予約確定】エアトリプラス` |
| オフィシャル | `予約番号` | 件名: `ご予約完了のお知らせ` |

キャンセルキーワード: `予約キャンセル受付`, `キャンセル`

---

## 付録B: 那覇店判定ロジック（isNahaReservation_）

優先順位順に判定し、最初に合致した結果を採用。全項目で判定不能な場合は那覇として取り込む（札幌GASも判定不能時はfalseを返すため、どちらにも入らない問題を防ぐフェイルセーフ）。

1. 住所に「沖縄県/那覇市/沖縄」→ **那覇**
2. 住所に「北海道/札幌市」→ **札幌**
3. 営業所名に「那覇/沖縄」→ **那覇**
4. 営業所名に「札幌」→ **札幌**
5. お届け・回収場所に沖縄地名 → **那覇**
6. お届け・回収場所に北海道地名 → **札幌**
7. 車両クラスコードに `_OKA/_OKI` → **那覇**
8. 車両クラスコードに `_SPK` → **札幌**
9. 車両クラスがD/A2/B2（那覇専用）→ **那覇**
10. 判定不能 → **那覇**（フェイルセーフ、Warningログ出力）

---

## 付録C: コンポーネント行番号マップ（index.html.bak）

| 行番号 | コンポーネント/機能 |
|--------|------------------|
| 1-100 | Supabase接続設定・DBヘルパー（fetchAllRows, DB object） |
| 594 | LoginScreen（パスワード認証） |
| 641 | CSVパーサー（parseCSV / readFile / parsePrice） |
| 815 | OTAパーサー定義・detectParse |
| 834 | buildRepeaterMap（リピーター検知） |
| 868 | CustomerList / ForeignVisitorAnalysis |
| 966 | AccountingPanel（売上集計・損益） |
| 1634 | SquarePaymentPanel |
| 1763 | AnalyticsTab / TaskAnalyticsCard |
| 2202 | 定数・ユーティリティ（車両クラス定義・バスロジック・日付関数） |
| 2499 | 外部スプレッドシートデータ取得 |
| 2627 | generateTasks（タスク自動生成） |
| 2666 | autoAssign（自動配車ロジック） |
| 2801 | CSVPanel（CSVインポートUI） |
| 2879 | VehicleManager / VehicleMaintenanceBook / VehicleFleetStatus / VehicleTab |
| 3539 | FleetManager（配車表タイムライン） |
| 4039 | PASGuard（認証ガード） |
| 4066 | JalanPayment（じゃらん決済照合） |
| 4149 | StaffManager |
| 4260 | MemoBox |
| 4411 | AttendanceManager |
| 4798 | ShiftCalendar |
| 5348 | ReservationForm（予約登録フォーム） |
| 5451 | TimeTable |
| 5460 | FleetTimeline / MaintForm |
| 5787 | OPScreen（OPシート） |
| 8122 | AddTaskForm |
| 8138 | Dashboard |
| 8953 | PastTasksTable |
| 9006 | DataTable（統合データ一覧） |
| 9183 | App（メインコンポーネント）/ Root |
| 10424 | APP_VERSION = "v3.2.8-NHA" |
