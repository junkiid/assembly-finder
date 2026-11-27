"""변동 비교 로직 테스트: python -m unittest scripts/test_update.py"""
import copy
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import update_members as u  # noqa: E402


def member(code, name, party="정당A", staff=None, sec=None, sec2=None, cm="교육위원회", office="의원회관 1호"):
    return {"HG_NM": name, "MONA_CD": code, "POLY_NM": party, "ASSEM_ADDR": office, "ORIG_NM": "서울 " + name,
            "JOB_RES_NM": "위원", "CMIT_NM": cm, "STAFF": staff or "", "SECRETARY": sec or "", "SECRETARY2": sec2 or ""}


def types(events):
    return sorted(e["type"] for e in events)


class DiffTests(unittest.TestCase):
    def base(self):
        return u.normalize([
            member("A1", "가나", staff="김홍, 이철수", sec="박영희", sec2="최민수, 김한올"),
            member("A2", "나다", staff="오세훈", cm="법제사법위원회"),
            member("A3", "다라"),
        ])

    def test_no_change(self):
        b = self.base()
        self.assertEqual(u.diff(b, copy.deepcopy(b)), [])

    def test_staff_added_and_removed(self):
        prev, cur = self.base(), self.base()
        cur[0]["staff"]["비서"].append("새사람")
        cur[0]["staff"]["보좌관"].remove("이철수")
        ev = u.diff(prev, cur)
        self.assertEqual(types(ev), ["staff_added", "staff_removed"])
        self.assertEqual([e["person"] for e in ev if e["type"] == "staff_added"], ["새사람"])
        self.assertEqual([e["person"] for e in ev if e["type"] == "staff_removed"], ["이철수"])

    def test_staff_moved_between_offices(self):
        prev, cur = self.base(), self.base()
        cur[0]["staff"]["보좌관"].remove("김홍")
        cur[1]["staff"]["비서관"].append("김홍")
        ev = u.diff(prev, cur)
        self.assertEqual(types(ev), ["staff_moved"])
        e = ev[0]
        self.assertEqual((e["person"], e["from"]["code"], e["to"]["code"], e["to"]["role"]), ("김홍", "A1", "A2", "비서관"))

    def test_role_change_same_office(self):
        prev, cur = self.base(), self.base()
        cur[0]["staff"]["비서"].remove("최민수")
        cur[0]["staff"]["비서관"].append("최민수")
        ev = u.diff(prev, cur)
        self.assertEqual(types(ev), ["staff_role_changed"])
        self.assertEqual((ev[0]["from_role"], ev[0]["to_role"]), ("비서", "비서관"))

    def test_field_and_committee_changes(self):
        prev, cur = self.base(), self.base()
        cur[1]["party"] = "정당B"
        cur[1]["office"] = "의원회관 9호"
        cur[1]["committees"] = ["법제사법위원회", "정보위원회"]
        ev = u.diff(prev, cur)
        self.assertEqual(types(ev), ["committee_added", "field_changed", "field_changed"])
        self.assertEqual(sorted(e["field"] for e in ev if e["type"] == "field_changed"), ["사무실", "정당"])

    def test_member_replaced_keeps_staff_move_only(self):
        # 의원 A3 퇴직 → 신규 의원 A9, 보좌진 일부는 새 의원실로 이동
        prev = u.normalize([member("A1", "가나", staff="김홍"), member("A3", "다라", staff="이동인, 남은이")])
        cur = u.normalize([member("A1", "가나", staff="김홍"), member("A9", "신규", staff="이동인, 새얼굴")])
        ev = u.diff(prev, cur)
        self.assertEqual(types(ev), ["member_added", "member_removed", "staff_moved"])  # 남은이·새얼굴은 의원 이벤트로 갈음

    def test_same_name_not_confused_when_both_stay(self):
        prev = u.normalize([member("A1", "가나", staff="김홍"), member("A2", "나다", staff="김홍")])
        cur = copy.deepcopy(prev)
        self.assertEqual(u.diff(prev, cur), [])


class RunTests(unittest.TestCase):
    def rows(self, n=120):
        return [member(f"C{i:03d}", f"의원{i}", staff=f"보좌{i}") for i in range(n)]

    def test_baseline_then_change_then_rerun(self):
        with tempfile.TemporaryDirectory() as d:
            n, baseline = u.run(self.rows(), d, datetime(2026, 11, 27, 9, 0, tzinfo=u.KST))
            self.assertTrue(baseline)
            self.assertEqual(n, 0)

            rows = self.rows()
            rows[5]["STAFF"] = "신입"
            n, baseline = u.run(rows, d, datetime(2026, 11, 28, 9, 0, tzinfo=u.KST))
            self.assertFalse(baseline)
            self.assertEqual(n, 2)  # 보좌5 제외 + 신입 추가
            ch = json.load(open(os.path.join(d, "changes.json"), encoding="utf-8"))
            self.assertEqual(ch["entries"][0]["date"], "2026-11-28")
            self.assertEqual(len(ch["entries"][0]["events"]), 2)

            # 같은 날 재실행: 변동 없음 → 기록이 그대로여야 함
            u.run(rows, d, datetime(2026, 11, 28, 10, 0, tzinfo=u.KST))
            ch = json.load(open(os.path.join(d, "changes.json"), encoding="utf-8"))
            self.assertEqual(len(ch["entries"][0]["events"]), 2)

            meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
            self.assertEqual(meta["baselineDate"], "2026-11-27")
            self.assertEqual(meta["lastChangeDate"], "2026-11-28")
            self.assertEqual(meta["memberCount"], 120)

    def test_sudden_drop_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            u.run(self.rows(120), d)
            with self.assertRaises(u.ApiError):
                u.run(self.rows(60), d)

    def test_old_entries_pruned(self):
        entries = [{"date": "2025-01-01", "events": [{"type": "x"}]}, {"date": "2026-11-20", "events": []}]
        out = u.merge_changes(entries, [], "2026-11-28")
        self.assertEqual([e["date"] for e in out], ["2026-11-20"])

    def test_parse_api_error_and_pages(self):
        with self.assertRaises(u.ApiError):
            u.parse_api_json({"RESULT": {"CODE": "ERROR-290", "MESSAGE": "인증키가 유효하지 않습니다."}})
        rows, total = u.parse_api_json({u.SERVICE: [{"head": [{"list_total_count": 1}, {"RESULT": {}}]}, {"row": [member("A", "가")]}]})
        self.assertEqual((len(rows), total), (1, 1))


if __name__ == "__main__":
    unittest.main()
