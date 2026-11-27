#!/usr/bin/env python3
"""국회의원 인적사항 Open API → docs/data 갱신 + 전날 대비 변동 기록.

매일 GitHub Actions가 실행합니다. 직접 실행할 수도 있습니다.

    # 인증키로 API 호출
    ASSEMBLY_KEY=발급받은키 python scripts/update_members.py

    # API 호출이 막힐 때: 브라우저에서 저장한 JSON 파일로 갱신
    python scripts/update_members.py --input page1.json page2.json page3.json

만드는 파일 (docs/data/):
    members.json  현재 명단 (의원별 정당·사무실·선거구·직책·위원회·보좌진)
    changes.json  날짜별 변동 내역 (최근 180일, 최신순)
    meta.json     마지막 갱신 시각, 인원 수
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

SERVICE = "nwvrqwxyaytdsfvhu"
ENDPOINT = f"https://open.assembly.go.kr/portal/openapi/{SERVICE}"
KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")
KEEP_DAYS = 180
ROLES = ("보좌관", "비서관", "비서")
SCALAR_FIELDS = (("party", "정당"), ("role", "직책"), ("office", "사무실"), ("district", "선거구"))
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class ApiError(Exception):
    pass


# ---------------------------------------------------------------- 수집
def split_names(text):
    """'김홍, 서용선' → ['김홍', '서용선']"""
    if not text:
        return []
    return [n.strip() for n in re.split(r"[,、·/\n]+", str(text)) if n.strip()]


def parse_api_json(data):
    """API 응답 JSON → (row 목록, 전체 건수)."""
    if SERVICE not in data:
        result = data.get("RESULT", {})
        raise ApiError(f"{result.get('CODE')} {result.get('MESSAGE')}")
    parts = data[SERVICE]
    total = parts[0]["head"][0]["list_total_count"]
    rows = []
    for part in parts[1:]:
        rows.extend(part.get("row", []))
    return rows, total


def http_get_json(url, retries=3):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "ko-KR,ko;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:300]
            last = ApiError(f"HTTP {e.code}: {body}")
            if e.code < 500:  # 4xx는 재시도해도 소용없음
                raise last
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = ApiError(f"접속 실패: {e}")
        time.sleep(2 * (attempt + 1))
    raise last


def fetch_all(key):
    """모든 페이지를 순회해 row를 모은다. 400이 나면 더 작은 pSize로 다시 시도."""
    errors = []
    for psize in (100, 50, 20):
        rows, page, total = [], 1, None
        try:
            while page <= 60:
                qs = urllib.parse.urlencode({"KEY": key, "Type": "json", "pIndex": page, "pSize": psize})
                got, total = parse_api_json(http_get_json(f"{ENDPOINT}?{qs}"))
                if not got:
                    break
                rows.extend(got)
                if len(rows) >= total:
                    break
                page += 1
            if rows and total and len(rows) >= total:
                return rows
            errors.append(f"pSize={psize}: {len(rows)}/{total}건만 수집")
        except ApiError as e:
            errors.append(f"pSize={psize}: {e}")
    raise ApiError("API 수집 실패 — " + " | ".join(errors))


def normalize(rows):
    members = {}
    for r in rows:
        name = (r.get("HG_NM") or "").strip()
        code = (r.get("MONA_CD") or "").strip()
        if not name or not code:
            continue
        members[code] = {
            "code": code,
            "name": name,
            "party": (r.get("POLY_NM") or "").strip(),
            "office": (r.get("ASSEM_ADDR") or "").strip(),
            "district": (r.get("ORIG_NM") or "").strip(),
            "role": (r.get("JOB_RES_NM") or "").strip(),
            "committees": split_names(r.get("CMIT_NM") or r.get("CMITS")),
            "staff": {
                "보좌관": split_names(r.get("STAFF")),
                "비서관": split_names(r.get("SECRETARY")),
                "비서": split_names(r.get("SECRETARY2")),
            },
        }
    return [members[c] for c in sorted(members)]


# ---------------------------------------------------------------- 변동 비교
def diff(prev, cur):
    """어제(prev)와 오늘(cur) 명단을 비교해 변동 이벤트 목록을 돌려준다."""
    pb = {m["code"]: m for m in prev}
    cb = {m["code"]: m for m in cur}
    member_events, change_events = [], []

    for code in sorted(cb.keys() - pb.keys()):
        m = cb[code]
        member_events.append({"type": "member_added", "code": code, "name": m["name"], "party": m["party"]})
    for code in sorted(pb.keys() - cb.keys()):
        m = pb[code]
        member_events.append({"type": "member_removed", "code": code, "name": m["name"], "party": m["party"]})

    removed, added = [], []  # (code, 의원이름, 직급, 보좌진이름, 의원 신규·제외 여부)

    for code in sorted(pb.keys() & cb.keys()):
        a, b = pb[code], cb[code]
        for field, label in SCALAR_FIELDS:
            if a.get(field, "") != b.get(field, ""):
                change_events.append({
                    "type": "field_changed", "code": code, "name": b["name"],
                    "field": label, "from": a.get(field, ""), "to": b.get(field, ""),
                })
        sa, sb_ = set(a["committees"]), set(b["committees"])
        for c in sorted(sb_ - sa):
            change_events.append({"type": "committee_added", "code": code, "name": b["name"], "committee": c})
        for c in sorted(sa - sb_):
            change_events.append({"type": "committee_removed", "code": code, "name": b["name"], "committee": c})
        for role in ROLES:
            pa, pb_ = set(a["staff"][role]), set(b["staff"][role])
            for p in sorted(pb_ - pa):
                added.append((code, b["name"], role, p, False))
            for p in sorted(pa - pb_):
                removed.append((code, a["name"], role, p, False))

    # 신규·제외 의원실의 보좌진도 '이동' 짝 맞추기에는 쓴다 (단독으로는 기록하지 않음)
    for code in sorted(cb.keys() - pb.keys()):
        for role in ROLES:
            for p in cb[code]["staff"][role]:
                added.append((code, cb[code]["name"], role, p, True))
    for code in sorted(pb.keys() - cb.keys()):
        for role in ROLES:
            for p in pb[code]["staff"][role]:
                removed.append((code, pb[code]["name"], role, p, True))

    staff_events = []

    # 1) 같은 의원실 안에서 직급만 바뀐 경우
    rem_idx = {(c, p): (c, n, r, p, v) for c, n, r, p, v in removed}
    add_idx = {(c, p): (c, n, r, p, v) for c, n, r, p, v in added}
    role_changed = rem_idx.keys() & add_idx.keys()
    for key in sorted(role_changed):
        c, n, r_from, p, _ = rem_idx[key]
        r_to = add_idx[key][2]
        staff_events.append({"type": "staff_role_changed", "code": c, "name": n, "person": p,
                             "from_role": r_from, "to_role": r_to})
    removed = [x for x in removed if (x[0], x[3]) not in role_changed]
    added = [x for x in added if (x[0], x[3]) not in role_changed]

    # 2) 다른 의원실로 옮긴 경우 (같은 이름이 한쪽에서 빠지고 다른 쪽에 생김)
    rem_by, add_by = defaultdict(list), defaultdict(list)
    for x in removed:
        rem_by[x[3]].append(x)
    for x in added:
        add_by[x[3]].append(x)
    moved_rem, moved_add = set(), set()
    for person in sorted(rem_by.keys() & add_by.keys()):
        for r, a in zip(rem_by[person], add_by[person]):
            staff_events.append({
                "type": "staff_moved", "person": person,
                "from": {"code": r[0], "name": r[1], "role": r[2]},
                "to": {"code": a[0], "name": a[1], "role": a[2]},
            })
            moved_rem.add(r)
            moved_add.add(a)

    # 3) 나머지는 단순 추가/제외 (신규·제외 의원의 보좌진은 의원 이벤트로 갈음)
    for x in sorted(added):
        if x in moved_add or x[4]:
            continue
        staff_events.append({"type": "staff_added", "code": x[0], "name": x[1], "role": x[2], "person": x[3]})
    for x in sorted(removed):
        if x in moved_rem or x[4]:
            continue
        staff_events.append({"type": "staff_removed", "code": x[0], "name": x[1], "role": x[2], "person": x[3]})

    return member_events + change_events + staff_events


# ---------------------------------------------------------------- 파일 입출력
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def dump_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def merge_changes(entries, events, today):
    """오늘 날짜 항목에 변동을 기록한다. 같은 날 다시 실행해도 중복되지 않는다."""
    entries = [e for e in entries if isinstance(e, dict) and e.get("date")]
    if events:
        today_entry = next((e for e in entries if e["date"] == today), None)
        if today_entry is None:
            entries.append({"date": today, "events": list(events)})
        else:
            seen = {json.dumps(e, sort_keys=True, ensure_ascii=False) for e in today_entry["events"]}
            for e in events:
                k = json.dumps(e, sort_keys=True, ensure_ascii=False)
                if k not in seen:
                    today_entry["events"].append(e)
                    seen.add(k)
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    entries = [e for e in entries if e["date"] >= cutoff]
    entries.sort(key=lambda e: e["date"], reverse=True)
    return entries


def staff_count(members):
    return sum(len(m["staff"][r]) for m in members for r in ROLES)


def run(rows, data_dir=DATA_DIR, now=None):
    """수집한 rows로 파일을 갱신하고 (이벤트 수, 신규 기준 여부)를 돌려준다."""
    now = now or datetime.now(KST)
    today = now.strftime("%Y-%m-%d")
    cur = normalize(rows)
    if not cur:
        raise ApiError("의원 데이터가 비어 있습니다.")

    prev = load_json(os.path.join(data_dir, "members.json"), [])
    if len(prev) >= 100 and len(cur) < len(prev) * 0.8:
        raise ApiError(f"수집 인원이 갑자기 줄었습니다({len(prev)}명 → {len(cur)}명). 갱신을 중단합니다.")

    prev_meta = load_json(os.path.join(data_dir, "meta.json"), {})
    prev_changes = load_json(os.path.join(data_dir, "changes.json"), {}).get("entries", [])

    baseline = not prev
    events = [] if baseline else diff(prev, cur)
    entries = merge_changes(prev_changes, events, today)

    meta = {
        "updatedAt": now.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
        "memberCount": len(cur),
        "staffCount": staff_count(cur),
        "baselineDate": prev_meta.get("baselineDate") or today,
        "lastChangeDate": entries[0]["date"] if entries else None,
    }
    dump_json(os.path.join(data_dir, "members.json"), cur)
    dump_json(os.path.join(data_dir, "changes.json"), {"entries": entries})
    dump_json(os.path.join(data_dir, "meta.json"), meta)
    return len(events), baseline


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", nargs="+", metavar="JSON", help="API 대신 브라우저에서 저장한 JSON 파일로 갱신")
    args = ap.parse_args()

    try:
        if args.input:
            rows, seen = [], set()
            for path in args.input:
                with open(path, encoding="utf-8") as f:
                    part, _ = parse_api_json(json.load(f))
                for r in part:
                    if r.get("MONA_CD") not in seen:
                        seen.add(r.get("MONA_CD"))
                        rows.append(r)
        else:
            key = (os.environ.get("ASSEMBLY_KEY") or "").strip().strip("\"'").strip()
            if not key:
                sys.exit("환경변수 ASSEMBLY_KEY(국회 Open API 인증키)가 없습니다.")
            rows = fetch_all(key)
        n_events, baseline = run(rows)
    except ApiError as e:
        sys.exit(f"오류: {e}")

    if baseline:
        print("첫 수집이라 기준 데이터만 저장했습니다. 변동은 내일부터 기록됩니다.")
    else:
        print(f"갱신 완료. 오늘 감지된 변동 {n_events}건.")


if __name__ == "__main__":
    main()
