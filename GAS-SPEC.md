# 那覇空港店 GAS自動配車 仕様書
**バージョン: v3.2.8-NHA**
**最終更新: 2026-03-31**
**ファイル: gas-email-import.gs (1298行)**

---

## 1. システム概要

Gmail（reserve@rent-handyman.jp）に届くOTA予約メールを15分間隔で自動取込し、
Supabase DBに登録、空車への自動配車、Slack通知を行うGoogle Apps Scriptシステム。

### 対象店舗
那覇空港店のみ。札幌店は別GASプロジェクト（gas-email-import-v2.gs）で処理。
同一Gmailアカウントを共有し、`processed_naha` / `processed` ラベルで区別。

---

## 2. 接続先・設定

| 項目 | 値 |
|------|-----|
| Supabase URL | https://ckrxttbnawkclshczsia.supabase.co |
| Gmailラベル | `processed_naha` |
| Slack通知先 | x-aaaatppttzyrldnhjt5el4jj3i@gl-oke5175.slack.com（メール→Slack転送） |
| GASプロジェクトID | 1Z1Vb6BzZAdzB_ZEvcR66K0h1W8zG-hirGJPLOj7RvubblYyYLPjxuLsX |
| DBテーブル | 全て `nha_` プレフィックス（札幌はプレフィックスなし） |

---

## 3. OTA送信元・件名パターン

| OTAキー | 送信元メール | 予約件名パターン | OTAコード | パーサー |
|---------|-------------|-----------------|----------|---------|
| jalan | info@jalan-rentacar.jalan.net | じゃらんnetレンタカー 予約通知 | J | parseJalan_ |
| rakuten | travel@mail.travel.rakuten.co.jp | 【楽天トラベル】予約受付のお知らせ | R | parseRakuten_ |
| skyticket | rentacar@skyticket.com | 【skyticket】 新規予約 | S | parseSkyticket_ |
| airtrip | info@rentacar-mail.airtrip.jp | 【予約確定】エアトリレンタカー | O | parseAirtrip_ |
| airtrip_dp | info@skygate.co.jp | 【予約確定】エアトリプラス | O | parseAirtrip_（共用） |
| official | noreply@rent-handyman.jp | ご予約完了のお知らせ | HP | parseOfficial_ |

### キャンセル判定
件名に `予約キャンセル受付` または `キャンセル` を含むメール → OTA問わずキャンセル処理。

---

## 4. 処理フロー

### 4.1 メイン処理 `processNewEmails()`（15分間隔トリガー）

```
1. Gmail検索: OTA送信元 & ラベルなし & 直近2日
2. 全メッセージを時系列順にソート（新規→CXL→取り直しの順序保証）
3. 各メッセージに対して processMessage_() 実行
4. 処理済みスレッドに processed_naha ラベル付与
5. Slack通知送信（成功/失敗/キャンセル別）
6. ハートビート書込み（nha_app_settings）
7. 未知送信元チェック checkUnknownSenders_()
```

### 4.2 メッセージ処理 `processMessage_()`

```
1. 送信元からOTA判定
2. キャンセル判定 → handleCancellation_()
3. 件名パターン照合 → 不一致ならスキップ
4. OTA別パーサーで予約情報抽出
5. isNahaReservation_() で那覇店フィルター
6. 重複チェック:
   - 既に登録済み(active) → スキップ
   - キャンセル済み同一ID → 再有効化（取り直し対応）
   - 未登録 → insert
7. autoAssignVehicle_() で自動配車
```

### 4.3 キャンセル処理 `handleCancellation_()`

```
1. 予約番号抽出
2. DB未登録 → スキップ（札幌の予約）
3. 既にキャンセル済み → スキップ（二重CXL防止）
4. nha_fleet 削除 → nha_tasks 削除 → nha_reservations status='cancelled'
```

---

## 5. 店舗フィルター `isNahaReservation_()`

優先順位順に判定。最初にマッチしたルールで確定：

| 優先度 | 判定条件 | 結果 |
|--------|---------|------|
| 1 | 住所に「沖縄県/那覇市/沖縄」 | 那覇 (true) |
| 2 | 住所に「北海道/札幌市」 | 札幌 (false) |
| 3 | 営業所名に「那覇/沖縄」 | 那覇 (true) |
| 4 | 営業所名に「札幌」 | 札幌 (false) |
| 5 | お届け/回収場所に「那覇/沖縄/豊見城/宜野湾/浦添/北谷」 | 那覇 (true) |
| 6 | お届け/回収場所に「札幌/千歳/北海道」 | 札幌 (false) |
| 7 | クラスコードに `_OKA` / `_OKI` | 那覇 (true) |
| 8 | クラスコードに `_SPK` | 札幌 (false) |
| 9 | 車両クラスが D / A2 / B2（那覇専用） | 那覇 (true) |
| 10 | **判定不能 → 那覇として取り込む**（札幌GASが独自に除外するため漏れ防止） | 那覇 (true) |

---

## 6. 車両クラス抽出

### 6.1 `extractVehicleClass_(rawClass)` — 全OTA共通

判定順序：
1. `A2` / `B2` キーワード → A2 / B2
2. オフィシャル名マッピング（下表）
3. `_X★` / `_X_` / `_X(末尾)` パターン（★等の記号許容）
4. `X_` 先頭パターン
5. `(スペース)X_` パターン
6. `_X(末尾)` パターン
7. `Xクラス` パターン

### 6.2 オフィシャル名 → クラスコード マッピング

| メール表記 | クラスコード | 車種 |
|-----------|------------|------|
| アルファードHクラス | **A** | アルファード |
| アルファードHクラス(A2) | **A2** | アルファード |
| ワンボックスB | **B** | ヴェルファイア/セレナH/ヴォクシー/ノアH/アルファードM |
| ワンボックスB2 | **B2** | 同上 |
| コンパクトSUV | **C** | ヤリスクロス/ライズ |
| ワンボックスD | **D** | セレナM/ノアM/エスクァイア |
| コンパクト | **F** | ヴィッツ/ノート/アクア |
| ハイブリッド | **H** | プリウス/プリウスアルファ |
| ハリアー | **S** | ハリアー |

**注意**: 「アルファードHクラス」の「H」はHybridではなく車種名の一部。Hクラスではない。

### 6.3 `parseOfficial_()` 専用クラス抽出

`ご予約車両クラス` 行を取得 → マッピングテーブルで照合（長い名前を優先）
→ 見つからなければ `^(A2|B2|[ABCDSFH])クラス` regex → さらに本文全体で `Xクラス` 検索

---

## 7. 日時パース `parseDateTime_()`

対応フォーマット（優先順）：

| フォーマット | 例 | 使用OTA |
|-------------|---|---------|
| `YYYY年M月D日 HH時MM分` | 2026年4月22日 15時00分 | じゃらん |
| `YYYY-MM-DD HH:MM` | 2026-04-22 15:00 | 楽天, skyticket |
| `YYYY/MM/DD (曜) HH:MM` | 2026/06/20 (土) 09:55 | エアトリプラスDP |

---

## 8. 自動配車 `autoAssignVehicle_()`

```
1. vehicle_class が空 → 未配車で終了
2. A2→A, B2→B にフォールバック（同じ車種構成のため）
3. nha_vehicles からクラス一致 & insurance_veh=false の車両リスト取得
4. 期間重複チェック:
   a. getOverlappingFleetVehicles_(): DB側 !inner join で重複fleet取得
      → nha_reservations.start_date <= returnDate AND end_date >= lendDate
   b. getOverlappingMaintenance_(): メンテナンス期間重複
5. 空車の先頭を配車 → nha_fleet に INSERT
6. 空車なし → 未配車（Slack失敗通知）
```

### 重要: Supabase 1000件制限対策
- `supabaseGet_()` はlimit未指定時に自動で `limit=5000` を付与
- `getOverlappingFleetVehicles_()` はDB側 `!inner` joinで絞り込み（全件取得を回避）

---

## 9. OTA別パーサー詳細

### 9.1 parseJalan_(body)
| フィールド | 抽出ラベル |
|-----------|-----------|
| 予約番号 | `予約番号` |
| 名前 | `運転者氏名カナ` (fallback: `予約者氏名`) |
| 電話 | `運転者電話番号` |
| メール | `予約者メールアドレス` |
| 貸出日時 | `貸出日時` |
| 返却日時 | `返却日時` |
| 営業所 | `貸出営業所` |
| クラス | `車両クラス` (fallback: `料金プラン`) |
| 補償 | `補償（任意加入）` → 「免責」含む→免責 / それ以外→なし |
| 人数 | `乗車人数` → 大人+子供 |
| 金額 | `合計金額` |
| フライト | `到着便` / `出発便` |

### 9.2 parseRakuten_(body)
| フィールド | 抽出ラベル |
|-----------|-----------|
| 予約番号 | `・予約番号` |
| 名前 | `・予約者氏名（カナ）` |
| 貸出日時 | `□貸出日時` |
| 返却日時 | `□返却日時` |
| 営業所 | `・貸渡営業所名` |
| クラス | `・詳細車両クラス` (fallback: `プラン_X` パターン) |
| 補償 | `・オプション/車両の特徴` → 「免責」含む→免責 |
| 金額 | `（合計）` |
| オプション | ベビー/チャイルド/ジュニアシート台数抽出 |

### 9.3 parseSkyticket_(body)
| フィールド | 抽出ラベル |
|-----------|-----------|
| 予約番号 | `予約番号` |
| 名前 | `ご利用者名` |
| 電話 | `電話番号` |
| メール | `メールアドレス` |
| 貸出日時 | `受取日時` |
| 返却日時 | `返却日時` |
| 営業所 | `受取店舗` |
| クラス | `車両タイプ / クラス` (fallback: `プラン名`) |
| 補償 | `免責補償料金` > 0 → 免責 |
| 金額 | `合計料金` |

### 9.4 parseAirtrip_(body) — エアトリ通常 & エアトリプラスDP共用
| フィールド | 抽出ラベル |
|-----------|-----------|
| 予約番号 | `予約番号` |
| 名前 | `予約者名` |
| 電話 | `電話番号` |
| メール | `メールアドレス` |
| 貸出日時 | `貸出日時` |
| 返却日時 | `返却日時` |
| 営業所 | `出発営業所` |
| クラス | `詳細車両クラス` (fallback: `プラン名`) |
| 補償 | `補償オプション` → 「免責」含む→免責 |
| 金額 | `合計金額` |
| フライト | `到着便` / `出発便` |

### 9.5 parseOfficial_(body)
| フィールド | 抽出方法 |
|-----------|---------|
| 予約番号 | `【予約番号】\n` の次行 |
| 名前 | `XXX様` パターン |
| 貸出日時 | `ご利用開始日時\n YYYY/MM/DD HH:MM` |
| 返却日時 | `ご利用終了日時\n YYYY/MM/DD HH:MM` |
| 人数 | `大人: N` + `子ども: N` |
| クラス | `ご予約車両クラス\n` → マッピングテーブル照合 |
| 補償 | `免責補償制度(CDW): あり` → 免責 / `レンタカー安心パック: あり` → NOC |
| チャイルドシート | `チャイルドシート(チャイルド): N台` / `(ジュニア): N台` |
| 金額 | `料金\n N円` |
| 電話 | `【電話番号】\n` の次行 |
| メール | `【メールアドレス】\n` の次行 |
| お届け場所 | `【お届け場所名】\n` / `【回収場所名】\n` |
| 住所 | `【お届け場所住所】\n` |

---

## 10. DB操作

### 使用テーブル
| テーブル | 用途 |
|---------|------|
| nha_reservations | 予約マスター（INSERT/UPDATE/DELETE） |
| nha_fleet | 配車（reservation_id + vehicle_code） |
| nha_tasks | タスク（キャンセル時に削除） |
| nha_vehicles | 車両マスター（参照のみ: code, name, plate_no, type, insurance_veh） |
| nha_maintenance | メンテナンス（参照のみ: 重複チェック） |
| nha_app_settings | ハートビート書込み |

### GAS内部フィールド → DBカラム変換 `toDbRow_()`
| GAS内部 | DBカラム |
|---------|---------|
| lend_date | start_date |
| return_date | end_date |
| lend_time | start_time, del_time |
| return_time | end_time, col_time |
| vehicle | vehicle_class |
| price | amount, price |
| opt_c | car_seat (String) |
| opt_j | junior_seat (String) |

---

## 11. Slack通知

| 種別 | 件名プレフィックス | 内容 |
|------|------------------|------|
| 成功 | ✅ 那覇店新規予約取込完了通知 | OTA, 予約番号, 名前, 日程, クラス, 配車先 |
| 失敗 | ❌ 那覇店新規予約取込失敗通知 | OTA, 予約番号, 名前, 理由（※手動対応が必要） |
| キャンセル | 🔄 那覇店予約キャンセル処理 | OTA, 予約番号 |
| 監視アラート | 🚨 / ⚠️ / ✅ | GAS停止検知, 復旧通知, 未知送信元検知 |

---

## 12. 監視・再発防止

### 12.1 ハートビート `updateHeartbeat_()`
- 毎回実行時に `nha_app_settings` へ最終実行時刻・処理数・エラー数を書込み
- キー: `heartbeat_nha_gas_email`

### 12.2 ハートビート監視 `checkHeartbeats()`（30分間隔トリガー）
- 最終実行から30分超 → Slack `🚨 停止中` 通知
- 復旧検知 → Slack `✅ 復旧しました` 通知
- ScriptPropertiesで重複通知防止

### 12.3 未知送信元監視 `checkUnknownSenders_()`（毎回実行時）
- `reserve@rent-handyman.jp` 宛 + 予約キーワード + `processed_naha` ラベルなし
- OTA_SENDERSに未登録の送信元 → Slack `⚠️ 未知の予約メール検知` 通知
- ScriptPropertiesで同一メール重複通知防止
- **背景**: エアトリプラスDP（info@skygate.co.jp）未登録で取込漏れが発生したため追加

---

## 13. ユーティリティ関数

### セットアップ系（手動実行）
| 関数 | 用途 |
|------|------|
| `setup()` | 15分間隔トリガー作成 + ラベル作成 |
| `setupMonitoring()` | 30分間隔監視トリガー作成 |
| `markAllExistingAsProcessed()` | 既存メール全てにprocessed_nahaラベル付与（初回のみ） |

### テスト・リカバリ系（手動実行）
| 関数 | 用途 |
|------|------|
| `testProcessLatest()` | 直近7日のメールをdryRunでパーステスト |
| `reprocessByIds()` | 特定予約IDのメール再検索→再処理→自動配車 |
| `findEmailByReservationId_()` | 予約番号でGmail検索（OTAフィルター付き→フィルターなしフォールバック） |

---

## 14. 過去の障害と修正履歴

| 日付 | 障害 | 原因 | 修正 |
|------|------|------|------|
| 2026-03-30 | DY00000000919 二重配車 | supabaseGet_ 1000件制限で既存配車を見落とし | DB側!inner join絞り込み + limit=5000 |
| 2026-03-30 | OPX93188/C260301451 取込漏れ | isNahaReservation_ 判定不能→false | デフォルトをtrue（那覇）に変更 |
| 2026-03-30 | LOZ81086 vehicle_class空 | parseOfficial_ regex `[ABCDSFH]クラス` が「アルファードH」のHにマッチ | マッピングテーブル方式に変更 |
| 2026-03-31 | C260301451 メール未発見 | エアトリプラスDP (info@skygate.co.jp) 未登録 | airtrip_dp追加 + 未知送信元監視追加 |
| 2026-03-31 | C260301489 日時空 | parseDateTime_ が YYYY/MM/DD 形式非対応 | `/`区切りパターン追加 |
| 2026-03-31 | RC32461130452460975 クラス空 | extractVehicleClass_ が `★プラン_F★` の★で不一致 | ★等の記号許容 + Xクラスフォールバック |

---

## 15. clasp デプロイ手順

```bash
# 1. ソース編集
vi ~/Downloads/naha-project/gas-email-import.gs

# 2. claspディレクトリにコピー
cp gas-email-import.gs gas/Code.gs

# 3. push
cd gas/
clasp push

# 4. 確認（GASエディタで関数実行 or 次のトリガー実行を待つ）
```

### claspプロジェクト
- ディレクトリ: `~/Downloads/naha-project/gas/`
- scriptId: `1Z1Vb6BzZAdzB_ZEvcR66K0h1W8zG-hirGJPLOj7RvubblYyYLPjxuLsX`
