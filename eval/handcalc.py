"""Independent hand calculation for three claims (no HourMatch code is imported).

It rebuilds the demo week from the raw Taipower file using only the rules written in README.md
(plant size, contract shares, demo load profiles), then works each claim out row by row:
matched kWh in an hour = min(use, certificates held for that hour), share = sum(matched) / sum(use).
Every row is printed to eval/HANDCALC.md so the arithmetic can be checked with a calculator.
tests/handcalc.test.mjs compares the totals with src/checker.mjs.

Usage: python -I eval/handcalc.py
"""
import datetime as dt
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
week = json.loads((ROOT / "data" / "taipower_hourly_2026-10-06_7d.json").read_text(encoding="utf-8"))
hours = week["hours"]
n = len(hours)


def js_round(x):  # JavaScript Math.round for x >= 0
    return math.floor(x + 0.5)


# plants (fictional): peak kW, contract shares
PLANTS = {"solar": 30000, "wind": 40000, "hydro": 3000}
SHARES = {
    "NORTHBAY-FAB": {"solar": 0.85, "wind": 0.5},
    "HARBOR-OFFICE": {"solar": 0.15, "hydro": 1.0},
    "CLOUDLINE-DC": {"wind": 0.5},
}
VOLUME_RATIO = {"NORTHBAY-FAB": 1.03, "HARBOR-OFFICE": 1.05, "CLOUDLINE-DC": 1.04}

gen = {}
for key, peak in PLANTS.items():
    vals = [max(0.0, h["mwh"].get(key) or 0.0) for h in hours]
    mx = max(vals) or 1.0
    gen[key] = [js_round((v / mx) * peak) for v in vals]

held = {c: {k: [math.floor(g * s) for g in gen[k]] for k, s in sh.items()} for c, sh in SHARES.items()}
total_bought = {c: sum(sum(a) for a in held[c].values()) for c in SHARES}


def local(h):
    date = h["hour"][:10]
    hour = int(h["hour"][11:13])
    dow = dt.date.fromisoformat(date).isoweekday()  # 1 = Monday ... 7 = Sunday
    return date, hour, dow


fab_flat = math.floor(total_bought["NORTHBAY-FAB"] / n / VOLUME_RATIO["NORTHBAY-FAB"])
office_shape = []
for h in hours:
    _, hr, dow = local(h)
    office_shape.append(1.0 if dow <= 5 and 8 <= hr < 19 else 0.2)
office_unit = total_bought["HARBOR-OFFICE"] / VOLUME_RATIO["HARBOR-OFFICE"] / sum(office_shape)
dc_var = [1 + (((i * 37) % 5) - 2) * 0.02 for i in range(n)]
dc_unit = total_bought["CLOUDLINE-DC"] / VOLUME_RATIO["CLOUDLINE-DC"] / sum(dc_var)
use = {
    "NORTHBAY-FAB": [fab_flat] * n,
    "HARBOR-OFFICE": [js_round(x * office_unit) for x in office_shape],
    "CLOUDLINE-DC": [js_round(x * dc_unit) for x in dc_var],
}

CLAIMS = [
    {
        "id": "HC1",
        "text": "Northbay Fab's night shift (00:00 to 06:00) on 2026-10-09 ran on 100% renewable electricity.",
        "consumer": "NORTHBAY-FAB", "date_from": "2026-10-09", "date_to": "2026-10-09", "hour_from": 0, "hour_to": 6,
        "claimed_pct": 100, "basis": "hourly",
    },
    {
        "id": "HC2",
        "text": "Harbor Office ran on 100% renewable electricity from 08:00 to 19:00 on 2026-10-07.",
        "consumer": "HARBOR-OFFICE", "date_from": "2026-10-07", "date_to": "2026-10-07", "hour_from": 8, "hour_to": 19,
        "claimed_pct": 100, "basis": "hourly",
    },
    {
        "id": "HC3",
        "text": "Certificates bought by Cloudline Data Center covered 100% of its electricity use on 2026-10-11.",
        "consumer": "CLOUDLINE-DC", "date_from": "2026-10-11", "date_to": "2026-10-11", "hour_from": 0, "hour_to": 24,
        "claimed_pct": 100, "basis": "volume",
    },
]

md = [
    "# Hand calculation of three claims",
    "",
    "Written by `eval/handcalc.py`, which does not import any HourMatch code. It rebuilds the demo week from the raw",
    "Taipower file with the rules in README.md and works each claim out hour by hour. All companies and plants are",
    "fictional; the generation curves are real Taiwan Power Company data.",
    "",
    "Rules used: matched kWh in an hour = min(use, certificates held for that hour). Hour-by-hour share =",
    "sum(matched) / sum(use). Volume share = sum(certificates held) / sum(use). A claim holds if the claimed",
    "percentage is at most the share on its basis plus 0.5 points. Shares are cut to basis points (floor), as the",
    "contract does.",
    "",
]
out = []
for c in CLAIMS:
    cid = c["consumer"]
    plants = list(held[cid].keys())
    rows = []
    for i, h in enumerate(hours):
        date, hr, _ = local(h)
        if not (c["date_from"] <= date <= c["date_to"] and c["hour_from"] <= hr < c["hour_to"]):
            continue
        certs = {k: held[cid][k][i] for k in plants}
        tot = sum(certs.values())
        u = use[cid][i]
        rows.append((h["hour"][:16].replace("T", " "), u, certs, tot, min(u, tot)))
    su = sum(r[1] for r in rows)
    sc = sum(r[3] for r in rows)
    sm = sum(r[4] for r in rows)
    hourly_bps = (sm * 10000) // su
    volume_bps = (sc * 10000) // su
    share = volume_bps if c["basis"] == "volume" else hourly_bps
    verdict = "SUPPORTED" if c["claimed_pct"] * 100 <= share + 50 else "NOT_SUPPORTED"
    md += [f"## {c['id']}: {c['text']}", "", f"Basis: {c['basis']}. Company: {cid}. Hours: {len(rows)}.", ""]
    md.append("| hour (UTC+8) | use kWh | " + " | ".join(f"{k} certs kWh" for k in plants) + " | certs total | matched = min(use, total) |")
    md.append("|---|---|" + "---|" * len(plants) + "---|---|")
    for t, u, certs, tot, m in rows:
        md.append(f"| {t} | {u} | " + " | ".join(str(certs[k]) for k in plants) + f" | {tot} | {m} |")
    md.append(f"| **sum** | **{su}** | " + " | ".join(f"**{sum(r[2][k] for r in rows)}**" for k in plants) + f" | **{sc}** | **{sm}** |")
    md += [
        "",
        f"- Hour-by-hour share = {sm} / {su} = {sm / su * 100:.4f}% -> {hourly_bps} basis points",
        f"- Volume share = {sc} / {su} = {sc / su * 100:.4f}% -> {volume_bps} basis points",
        f"- Claimed {c['claimed_pct']}% on the {c['basis']} basis: {c['claimed_pct'] * 100} <= {share} + 50 is "
        f"{'true' if verdict == 'SUPPORTED' else 'false'}, so **{verdict}**",
        "",
    ]
    out.append({**c, "hours": len(rows), "use_kwh": su, "certs_kwh": sc, "matched_kwh": sm,
                "hourly_bps": hourly_bps, "volume_bps": volume_bps, "verdict": verdict})

(ROOT / "eval" / "HANDCALC.md").write_text("\n".join(md), encoding="utf-8")
(ROOT / "eval" / "handcalc.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
for o in out:
    print(o["id"], o["hourly_bps"], o["volume_bps"], o["verdict"])
