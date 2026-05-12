#!/usr/bin/env python3
"""
那覇店 全予約 オプション(opt_b/opt_c/opt_j) 整合性パトロール

NHA は札幌と異なり:
- nha_tasks の B/C/J/USB カラムは 文字列 ("0"/"1"/"2"等)
- カラム名は日本語（B/C/J/USB はASCII、他は「予約番号」「クラス」等日本語）
- 予約紐付けは nha_tasks.「予約番号」(reservation_id ではない)

Pattern A: nha_reservations.opt_X と nha_tasks の B/C/J 文字列のズレ
           → 自動修正可能
Pattern B: option_price > 0 / opt 全0 / 補償なし or 日割>1200
           → 元メール再パース必要
Pattern C: 異常値 (シート > 8)
"""
import json
import urllib.request
import urllib.parse
import sys

SUPA_URL = "https://ckrxttbnawkclshczsia.supabase.co"
SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrcnh0dGJuYXdrY2xzaGN6c2lhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4Nzg1NTAsImV4cCI6MjA4NzQ1NDU1MH0.kDC_UDVWvcrS97wzqQ3NXP79ewjgYwF4vSFdV7y06S8"


def sb_get(path):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{path}",
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def sb_patch(path, body):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{path}",
        method="PATCH",
        headers={
            "apikey": SUPA_KEY,
            "Authorization": f"Bearer {SUPA_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        data=json.dumps(body).encode()
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def fetch_all(table, select, extra="", id_col="id"):
    """1000件超対応 ページネーション (Range header方式)"""
    rows = []
    offset = 0
    chunk = 1000
    while True:
        path = f"{table}?select={select}&order={id_col}.asc"
        if extra:
            path += "&" + extra
        req = urllib.request.Request(
            f"{SUPA_URL}/rest/v1/{path}",
            headers={
                "apikey": SUPA_KEY,
                "Authorization": f"Bearer {SUPA_KEY}",
                "Range-Unit": "items",
                "Range": f"{offset}-{offset+chunk-1}",
            }
        )
        try:
            with urllib.request.urlopen(req) as r:
                batch = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (416, 200):
                break
            raise
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < chunk:
            break
        offset += chunk
    return rows


print("[1/3] nha_reservations 取得中...")
resvs = fetch_all(
    "nha_reservations",
    "id,name,ota,start_date,end_date,opt_b,opt_c,opt_j,option_price,base_price,discount,price,insurance,status",
    extra="status=eq.confirmed"
)
print(f"    {len(resvs)} 件取得")

print("[2/3] nha_tasks 取得中...")
# NHA tasks は select 句で日本語カラム名を扱う必要あり
# reservation_id (those tasks have it via 「予約番号」) and B/C/J/USB
tasks_all = fetch_all(
    "nha_tasks",
    "_id," + urllib.parse.quote("予約番号") + ",B,C,J,USB,changed_json",
    id_col="_id"
)
print(f"    {len(tasks_all)} 件取得")

from collections import defaultdict
tasks_by_resv = defaultdict(list)
for t in tasks_all:
    rid = t.get("予約番号")
    if rid:
        tasks_by_resv[rid].append(t)

pattern_a = []  # tasks 同期漏れ
pattern_b = []  # option_price>0 / opt全0
pattern_c = []  # 異常値

for r in resvs:
    rid = r["id"]
    rb = int(r.get("opt_b") or 0)
    rc = int(r.get("opt_c") or 0)
    rj = int(r.get("opt_j") or 0)
    opt_price = float(r.get("option_price") or 0)
    insurance = (r.get("insurance") or "").strip()

    # Pattern C
    if rb > 8 or rc > 8 or rj > 8:
        pattern_c.append({
            "id": rid, "name": r["name"], "ota": r["ota"],
            "lend": r["start_date"], "opts": f"B={rb}/C={rc}/J={rj}",
            "reason": "シート数 > 8"
        })

    # Pattern A: tasks 同期チェック
    ts = tasks_by_resv.get(rid, [])
    sync_issues = []
    for t in ts:
        tid = t["_id"]
        # B/C/J は文字列。"0" or "1" or "2"
        try:
            tb = int(str(t.get("B") or "0"))
            tc = int(str(t.get("C") or "0"))
            tj = int(str(t.get("J") or "0"))
        except (ValueError, TypeError):
            tb, tc, tj = 0, 0, 0

        if tb != rb or tc != rc or tj != rj:
            sync_issues.append({
                "task_id": tid,
                "want": {"B": str(rb), "C": str(rc), "J": str(rj)},
                "got": {"B": str(tb), "C": str(tc), "J": str(tj)},
            })

    if sync_issues:
        pattern_a.append({
            "id": rid, "name": r["name"], "ota": r["ota"],
            "lend": r["start_date"],
            "resv_opts": f"B={rb}/C={rc}/J={rj}",
            "task_count": len(ts),
            "issues": sync_issues,
        })

    # Pattern B
    if opt_price > 0 and rb == 0 and rc == 0 and rj == 0:
        try:
            from datetime import date
            ld = r.get("start_date")
            rd = r.get("end_date")
            d1 = date.fromisoformat(ld) if ld else None
            d2 = date.fromisoformat(rd) if rd else None
            days = max(1, (d2 - d1).days) if (d1 and d2) else 1
        except Exception:
            ld = r.get("start_date") or ""
            rd = r.get("end_date") or ""
            days = 1
        per_day = opt_price / days
        if per_day > 1200 or insurance in ("", "なし"):
            pattern_b.append({
                "id": rid, "name": r["name"], "ota": r["ota"],
                "lend": ld, "return": rd, "days": days,
                "opt_price": opt_price, "per_day": round(per_day),
                "insurance": insurance,
                "reason": "補償なしでも option_price > 0" if insurance in ("", "なし") else f"日割¥{round(per_day)} > ¥1,200",
            })

print()
print("=" * 80)
print(f"📊 那覇店 全予約 {len(resvs)} 件 パトロール結果")
print("=" * 80)
print()

print(f"🔴 Pattern A: tasks 同期漏れ — {len(pattern_a)} 件")
for x in pattern_a[:50]:
    issues_summary = []
    for i in x["issues"][:3]:
        issues_summary.append(f"{i['task_id']} {i['got']}→{i['want']}")
    print(f"   - {x['id']:18s} {x['name']:14s} {x['ota']} {x['lend']} resv:{x['resv_opts']}")
    for s in issues_summary:
        print(f"       └ {s}")
if len(pattern_a) > 50:
    print(f"   ... 他 {len(pattern_a)-50} 件")
print()

print(f"🟡 Pattern B: option_price > 0 / opt全0 — {len(pattern_b)} 件")
from datetime import date
today = date.today().isoformat()
future_b = [x for x in pattern_b if x["lend"] >= today]
print(f"   うち未来日: {len(future_b)} 件")
for x in future_b[:30]:
    print(f"   - {x['id']:18s} {x['name']:14s} {x['ota']} {x['lend']} {x['days']}日 opt¥{int(x['opt_price'])}=¥{x['per_day']}/日 ins='{x['insurance']}' ({x['reason']})")
if len(future_b) > 30:
    print(f"   ... 他 {len(future_b)-30} 件")
print()

print(f"⚠️  Pattern C: シート数異常値 — {len(pattern_c)} 件")
for x in pattern_c:
    print(f"   - {x['id']:18s} {x['name']:14s} {x['ota']} {x['lend']} {x['opts']} ({x['reason']})")
print()

# JSON保存
out = {
    "summary": {
        "total_reservations": len(resvs),
        "pattern_a_count": len(pattern_a),
        "pattern_b_count": len(pattern_b),
        "pattern_b_future_count": len(future_b),
        "pattern_c_count": len(pattern_c),
    },
    "pattern_a": pattern_a,
    "pattern_b": pattern_b,
    "pattern_c": pattern_c,
}
with open("/tmp/nha_opts_patrol_result.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(f"💾 詳細: /tmp/nha_opts_patrol_result.json")

# Pattern A 自動修正
if pattern_a and "--fix" in sys.argv:
    print()
    print("=" * 80)
    print("🔧 Pattern A 自動修正開始")
    print("=" * 80)
    fixed = 0
    failed = 0
    for x in pattern_a:
        rid = x["id"]
        r = next((rr for rr in resvs if rr["id"] == rid), None)
        if not r:
            continue
        rb = int(r.get("opt_b") or 0)
        rc = int(r.get("opt_c") or 0)
        rj = int(r.get("opt_j") or 0)
        for t in tasks_by_resv.get(rid, []):
            tid = t["_id"]
            body = {
                "B": str(rb),
                "C": str(rc),
                "J": str(rj),
            }
            try:
                sb_patch(f"nha_tasks?_id=eq.{urllib.parse.quote(tid)}", body)
                fixed += 1
            except Exception as e:
                print(f"   ❌ {tid}: {e}")
                failed += 1
    print(f"✅ 修正完了: {fixed} tasks 更新 / 失敗: {failed}")
else:
    print()
    print(f"💡 自動修正するには: python3 {sys.argv[0]} --fix")
