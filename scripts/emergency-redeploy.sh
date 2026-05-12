#!/bin/bash
# ==============================================================================
# 緊急復旧スクリプト (Vercel 403 mitigated:deny / Bot mitigation 誤検知用)
# ==============================================================================
# 使い方:
#   ~/Desktop/naha-project/scripts/emergency-redeploy.sh
#
# 動作:
#   1. NHA / SPK の Production URL 死活確認
#   2. 403 mitigated:deny を検知したら:
#      a. 新規デプロイ実行 (alias リフレッシュ)
#      b. それでもダメなら別 alias 名を即時発行
#   3. 結果サマリ表示
#
# 既知の primary URL:
#   NHA: https://handyman-naha.vercel.app/  (2026-05-02 緊急切替)
#   SPK: https://spk-task.vercel.app/
#
# 旧 alias (ブロック対象):
#   handyman-fleet.vercel.app — Vercel 自動防御に登録され使用不可 (2026-05-02)
# ==============================================================================

set -e

NHA_PRIMARY="https://handyman-naha.vercel.app"
NHA_OLD="https://handyman-fleet.vercel.app"
SPK_PRIMARY="https://spk-task.vercel.app"

NHA_DIR="$HOME/Desktop/naha-project"
SPK_DIR="$HOME/spk-task"

check_url() {
  local url=$1
  local code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 10 2>/dev/null || echo "000")
  local mitig=$(curl -sI "$url" --max-time 10 2>/dev/null | grep -i "x-vercel-mitigated" | awk '{print $2}' | tr -d '\r\n')
  echo "$code|$mitig"
}

emergency_alias() {
  local proj_dir=$1
  local proj_name=$2
  local new_alias=$3
  echo ""
  echo "=== Creating emergency alias for $proj_name ==="
  cd "$proj_dir"
  # 最新 production deployment URL を取得
  local latest=$(vercel ls --yes 2>/dev/null | grep -E "https://${proj_name}-[a-z0-9]+-nosh2318s" | head -1 | awk '{print $3}')
  if [ -z "$latest" ]; then
    echo "❌ 最新デプロイURL取得失敗"
    cd - > /dev/null
    return 1
  fi
  echo "Latest deploy: $latest"
  vercel alias set "$latest" "$new_alias" 2>&1 | tail -3
  cd - > /dev/null
}

redeploy() {
  local proj_dir=$1
  local proj_name=$2
  echo ""
  echo "=== Redeploying $proj_name ==="
  cd "$proj_dir"
  vercel deploy --prod --yes 2>&1 | tail -5
  cd - > /dev/null
}

echo "==============================================="
echo "HANDYMAN APP 死活確認 $(date '+%Y-%m-%d %H:%M:%S')"
echo "==============================================="

# === NHA ===
nha_result=$(check_url "$NHA_PRIMARY/")
nha_code=$(echo "$nha_result" | cut -d'|' -f1)
nha_mitig=$(echo "$nha_result" | cut -d'|' -f2)
echo "[NHA] $NHA_PRIMARY -> HTTP $nha_code ${nha_mitig:+(mitigated: $nha_mitig)}"

if [ "$nha_code" != "200" ] || [ "$nha_mitig" = "deny" ]; then
  echo "⚠️  NHA 異常検知 → Step1: 再デプロイで alias リフレッシュ試行"
  redeploy "$NHA_DIR" "handyman-fleet"
  sleep 5
  nha_after=$(check_url "$NHA_PRIMARY/")
  nha_code2=$(echo "$nha_after" | cut -d'|' -f1)
  echo "[NHA] 再デプロイ後: HTTP $nha_code2"

  if [ "$nha_code2" != "200" ]; then
    # Step2: 別 alias を緊急発行
    EMERG_ALIAS="handyman-naha-$(date +%s).vercel.app"
    echo "⚠️  Step2: 緊急 alias $EMERG_ALIAS を発行"
    emergency_alias "$NHA_DIR" "handyman-fleet" "$EMERG_ALIAS"
    sleep 3
    final=$(check_url "https://$EMERG_ALIAS/")
    final_code=$(echo "$final" | cut -d'|' -f1)
    echo ""
    echo "🚨 NHA 復旧URL: https://$EMERG_ALIAS/  (HTTP $final_code)"
    echo "   このURLをスタッフに案内してください"
  fi
fi

# === SPK ===
spk_result=$(check_url "$SPK_PRIMARY/")
spk_code=$(echo "$spk_result" | cut -d'|' -f1)
spk_mitig=$(echo "$spk_result" | cut -d'|' -f2)
echo ""
echo "[SPK] $SPK_PRIMARY -> HTTP $spk_code ${spk_mitig:+(mitigated: $spk_mitig)}"

if [ "$spk_code" != "200" ] || [ "$spk_mitig" = "deny" ]; then
  echo "⚠️  SPK 異常検知 → 再デプロイ試行"
  redeploy "$SPK_DIR" "spk-task"
  sleep 5
  spk_after=$(check_url "$SPK_PRIMARY/")
  echo "[SPK] 再デプロイ後: HTTP $(echo $spk_after | cut -d'|' -f1)"
fi

# === 旧URL (参考表示) ===
old_result=$(check_url "$NHA_OLD/")
old_code=$(echo "$old_result" | cut -d'|' -f1)
old_mitig=$(echo "$old_result" | cut -d'|' -f2)
echo ""
echo "[REF] $NHA_OLD -> HTTP $old_code ${old_mitig:+(mitigated: $old_mitig)}  ※旧URL（使用不可・参照のみ）"

echo ""
echo "==============================================="
echo "完了 $(date '+%Y-%m-%d %H:%M:%S')"
echo "==============================================="
