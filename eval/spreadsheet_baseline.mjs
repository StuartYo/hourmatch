// Spreadsheet baseline: what a careful analyst gets with SUMPRODUCT, given the same hourly data
// and the claim fields read by a person (the gold fields). No HourMatch checker code is used for the
// numbers; the formulas below are written out in eval/SPREADSHEET.md and in spreadsheet_baseline.xlsx.
//
// Usage: node eval/spreadsheet_baseline.mjs   -> eval/spreadsheet/*.csv, eval/results_spreadsheet.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario, GENERATORS, CONSUMERS } from "../src/scenario.mjs";
import { loadWeek, instantiate } from "./run_eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD_BEFORE = 2026 - 15; // RE100: commissioned before 2011 counts as old for a 2026 claim

// One row per company per hour, the columns a spreadsheet would hold.
export function sheetRows(scn) {
  const rows = [];
  const firstDate = scn.hours[0].hour.slice(0, 10);
  for (const c of CONSUMERS) {
    for (let i = 0; i < scn.n; i++) {
      const iso = scn.hours[i].hour;
      const date = iso.slice(0, 10);
      const day = Math.round((Date.parse(date) - Date.parse(firstDate)) / 86400000) + 1;
      const dow = ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1; // 1 = Monday ... 7 = Sunday
      const certs = GENERATORS.map((g) => scn.bought[c.id]?.[g.id]?.[i] ?? 0);
      const oldCerts = GENERATORS.reduce((a, g, k) => a + (g.commissionYear < OLD_BEFORE ? certs[k] : 0), 0);
      const use = scn.consumption[c.id][i];
      const total = certs.reduce((a, b) => a + b, 0);
      rows.push({
        company: c.id, date, day, hour: Number(iso.slice(11, 13)), dow, use,
        solar: certs[0], wind: certs[1], hydro: certs[2], certs: total, old_certs: oldCerts,
        matched: Math.min(use, total), // =MIN(F,G)
        old_matched: Math.min(oldCerts, Math.max(0, use - (total - oldCerts))), // =MIN(H,MAX(0,F-(G-H))) old plants used last
      });
    }
  }
  return rows;
}

// The same arithmetic as the spreadsheet formulas (see SPREADSHEET.md), row filter then SUMPRODUCT.
export function sheetVerdict(rows, q) {
  const m = rows.filter(
    (r) => r.company === q.company && r.day >= q.day_from && r.day <= q.day_to && r.hour >= q.hour_from && r.hour < q.hour_to && (!q.weekdays_only || r.dow <= 5)
  );
  const sum = (k) => m.reduce((a, r) => a + r[k], 0);
  const use = sum("use");
  const hourly = Math.floor((sum("matched") * 10000) / use);
  const volume = Math.floor((sum("certs") * 10000) / use);
  const allow = Math.floor(use * 0.15);
  const reHourly = Math.floor(((sum("matched") - Math.max(0, sum("old_matched") - allow)) * 10000) / use);
  const reVolume = Math.floor(((sum("certs") - Math.max(0, sum("old_certs") - allow)) * 10000) / use);
  const plain = q.basis === "volume" ? volume : hourly;
  const share = q.re100 ? (q.basis === "volume" ? reVolume : reHourly) : plain;
  const claimed = Math.round(q.claimed_pct * 100);
  const verdict = claimed <= plain + 50 && claimed <= share + 50 ? "SUPPORTED" : "NOT_SUPPORTED";
  return { use, hourly_bps: hourly, volume_bps: volume, share_bps: share, verdict };
}

export function claimRows(scn, items) {
  const firstDate = scn.hours[0].hour.slice(0, 10);
  const dayNo = (d) => Math.round((Date.parse(d) - Date.parse(firstDate)) / 86400000) + 1;
  return items.map((it) => {
    const inst = instantiate(scn, it);
    const g = inst.gold;
    return {
      id: it.id,
      text: inst.text,
      company: g.consumer_id,
      day_from: dayNo(g.start_date),
      day_to: dayNo(g.end_date),
      hour_from: g.hour_from,
      hour_to: g.hour_to,
      weekdays_only: g.weekdays_only ? 1 : 0,
      claimed_pct: g.claimed_pct,
      basis: g.standard === "volume" ? "volume" : "hourly",
      re100: g.re100 ? 1 : 0,
      truth: inst.truth.verdict,
    };
  });
}

function toCsv(rows) {
  const keys = Object.keys(rows[0]);
  return keys.join(",") + "\n" + rows.map((r) => keys.map((k) => (typeof r[k] === "string" && /[",]/.test(r[k]) ? `"${r[k].replace(/"/g, '""')}"` : r[k])).join(",")).join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const claims = JSON.parse(fs.readFileSync(path.join(here, "claims.json"), "utf8"));
  const outDir = path.join(here, "spreadsheet");
  fs.mkdirSync(outDir, { recursive: true });
  const result = { note: "Spreadsheet baseline: same hourly data, claim fields read by a person (gold), SUMPRODUCT formulas.", sets: {} };
  for (const set of ["dev", "holdout"]) {
    const scn = buildScenario(loadWeek(set));
    const rows = sheetRows(scn);
    const qs = claimRows(scn, claims[set]);
    fs.writeFileSync(path.join(outDir, `data_${set}.csv`), toCsv(rows));
    fs.writeFileSync(path.join(outDir, `claims_${set}.csv`), toCsv(qs));
    const out = qs.map((q) => ({ id: q.id, truth: q.truth, ...sheetVerdict(rows, q) }));
    const correct = out.filter((o) => o.verdict === o.truth).length;
    result.sets[set] = { correct, n: out.length, rows: out };
    console.log(set, `spreadsheet baseline ${correct} / ${out.length}`);
  }
  fs.writeFileSync(path.join(here, "results_spreadsheet.json"), JSON.stringify(result, null, 1));
}
