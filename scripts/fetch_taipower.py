"""Download Taipower 10-minute generation snapshots (public open data, archived by
github.com/kiang/taipower_data) and aggregate them into hourly MWh per fuel type.

Source dataset: Taiwan Power Company, "各機組發電量即時資訊" (data.gov.tw/dataset/8931).
Only the per-fuel subtotal rows are kept. Output: data/taipower_hourly_<start>_<days>d.json

Usage: python -I scripts/fetch_taipower.py 2026-10-06 7
"""
import datetime as dt
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://raw.githubusercontent.com/kiang/taipower_data/master/docs/genary/{y}/{ymd}/{hms}.json"
FUEL_KEYS = {
    "solar": "太陽能",
    "wind": "風力",
    "hydro": "水力",
    "other_renewable": "其它再生能源",
    "lng": "燃氣(LNG)",
    "ipp_lng": "民營電廠-燃氣",
    "coal": "燃煤(Coal)",
    "ipp_coal": "民營電廠-燃煤",
    "cogen": "汽電共生",
    "fuel_oil": "燃料油",
    "storage": "儲能(Energy Storage System)",
}


def fetch(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            continue
    return None


def subtotals(snapshot):
    out = {}
    for row in snapshot.get("aaData", []):
        if not str(row[2]).startswith("小計"):
            continue
        label = re.sub(r"<[^>]+>", "", row[0])
        net = float(str(row[4]).split("(")[0] or 0)
        for key, needle in FUEL_KEYS.items():
            if needle in label and key not in out:
                # "儲能(Energy Storage System)" must not match "儲能負載"
                if key == "storage" and "負載" in label:
                    continue
                out[key] = net
                break
    return out


def main():
    start = dt.date.fromisoformat(sys.argv[1])
    days = int(sys.argv[2])
    jobs = []
    for d in range(days):
        day = start + dt.timedelta(days=d)
        for h in range(24):
            for m in range(0, 60, 10):
                hms = f"{h:02d}{m:02d}00"
                url = BASE.format(y=day.year, ymd=day.strftime("%Y%m%d"), hms=hms)
                jobs.append((day.isoformat(), h, m, url))

    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lambda j: (j, fetch(j[3])), jobs))

    hourly = {}
    missing = 0
    for (day, h, m, url), snap in results:
        key = f"{day}T{h:02d}:00+08:00"
        bucket = hourly.setdefault(key, {"samples": 0, "mw_sum": {}})
        if snap is None:
            missing += 1
            continue
        st = subtotals(snap)
        bucket["samples"] += 1
        for k, v in st.items():
            bucket["mw_sum"][k] = bucket["mw_sum"].get(k, 0.0) + v

    hours = []
    for key in sorted(hourly):
        b = hourly[key]
        n = b["samples"]
        # mean MW over the hour = MWh for that hour
        mwh = {k: round(v / n, 1) for k, v in b["mw_sum"].items()} if n else {}
        hours.append({"hour": key, "samples": n, "mwh": mwh})

    out = {
        "source": "Taiwan Power Company open data (data.gov.tw/dataset/8931), 10-minute snapshots archived at github.com/kiang/taipower_data",
        "method": "hourly MWh = mean of the six 10-minute net-generation snapshots in that hour (subtotal rows per fuel type)",
        "start": start.isoformat(),
        "days": days,
        "missing_snapshots": missing,
        "hours": hours,
    }
    path = Path(__file__).resolve().parent.parent / "data" / f"taipower_hourly_{start.isoformat()}_{days}d.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(path, "hours", len(hours), "missing", missing)


if __name__ == "__main__":
    main()
