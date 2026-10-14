// Your own data: hourly use CSV + certificate CSV -> the same ledger and checker as the demo.
// Runs entirely in the browser. Nothing is uploaded and nothing is written on chain.
import { Ledger, certificateId, hourIndexOf, hourIso } from "./ledger.mjs";

export const UPLOAD_ID = "YOUR-COMPANY";
export const MAX_HOURS = 24 * 400; // a bit over one year

export function parseCsv(text) {
  const rows = [];
  for (const raw of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === "," && !q) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

// "2026-10-06 13:00", "2026-10-06T13:00", "2026/10/6 13:00:00", optional "Z" or "+08:00".
// Without an offset the time is read as Taiwan time (UTC+8).
export function parseHour(s) {
  const m = String(s)
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return { error: `cannot read time "${s}" (use YYYY-MM-DD HH:00)` };
  if (m[5] !== "00" || (m[6] && m[6] !== "00")) return { error: `"${s}" is not on a full hour` };
  let off = m[7] || "+08:00";
  if (off.toUpperCase() === "Z") off = "+00:00";
  if (!off.includes(":")) off = off.slice(0, 3) + ":" + off.slice(3);
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T${m[4].padStart(2, "0")}:00:00${off}`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { error: `cannot read time "${s}"` };
  return { h: hourIndexOf(ms) };
}

function num(s) {
  const v = Number(String(s).replace(/[\s_]/g, ""));
  return Number.isFinite(v) ? v : NaN;
}

function header(rows, want) {
  if (!rows.length) return { error: "the file is empty" };
  const h = rows[0].map((x) => x.toLowerCase().replace(/[^a-z_]/g, ""));
  const idx = {};
  for (const [key, names] of Object.entries(want)) {
    const i = h.findIndex((x) => names.includes(x));
    idx[key] = i;
  }
  return { idx, body: rows.slice(1) };
}

/**
 * @param {{useCsv: string, certCsv: string, company?: string}} input
 * @returns {{ok: true, scn: object, warnings: string[]} | {ok: false, errors: string[]}}
 */
export function buildFromCsv({ useCsv, certCsv, company = "Your company" }) {
  const errors = [];
  const warnings = [];

  const U = header(parseCsv(useCsv), { hour: ["hour", "time", "datetime", "timestamp"], kwh: ["kwh", "use_kwh", "usekwh", "consumption_kwh", "consumptionkwh"] });
  if (U.error) return { ok: false, errors: ["use file: " + U.error] };
  if (U.idx.hour < 0 || U.idx.kwh < 0) return { ok: false, errors: ['use file needs the columns "hour" and "kwh"'] };
  const C = header(parseCsv(certCsv), {
    hour: ["hour", "time", "datetime", "timestamp"],
    kwh: ["kwh", "certificate_kwh", "certificatekwh"],
    plant: ["plant", "source", "generator", "plant_name", "plantname"],
    year: ["commission_year", "commissionyear", "commissioned", "year"],
  });
  if (C.error) return { ok: false, errors: ["certificate file: " + C.error] };
  if (C.idx.hour < 0 || C.idx.kwh < 0) return { ok: false, errors: ['certificate file needs the columns "hour" and "kwh" (and optionally "plant", "commission_year")'] };

  const use = new Map();
  U.body.forEach((r, i) => {
    const t = parseHour(r[U.idx.hour]);
    const v = num(r[U.idx.kwh]);
    if (t.error) return errors.push(`use row ${i + 2}: ${t.error}`);
    if (!(v >= 0)) return errors.push(`use row ${i + 2}: kWh must be a number of 0 or more`);
    if (use.has(t.h)) return errors.push(`use row ${i + 2}: the same hour appears twice`);
    use.set(t.h, Math.round(v));
  });
  const plants = new Map(); // name -> {year, byHour: Map}
  C.body.forEach((r, i) => {
    const t = parseHour(r[C.idx.hour]);
    const v = num(r[C.idx.kwh]);
    if (t.error) return errors.push(`certificate row ${i + 2}: ${t.error}`);
    if (!(v >= 0)) return errors.push(`certificate row ${i + 2}: kWh must be a number of 0 or more`);
    const name = (C.idx.plant >= 0 && r[C.idx.plant]) || "Unnamed plant";
    const yr = C.idx.year >= 0 ? num(r[C.idx.year]) : NaN;
    const p = plants.get(name) || { year: null, byHour: new Map() };
    if (Number.isInteger(yr) && yr > 1900) {
      if (p.year !== null && p.year !== yr) errors.push(`certificate row ${i + 2}: plant "${name}" has two commission years`);
      p.year = yr;
    }
    p.byHour.set(t.h, (p.byHour.get(t.h) || 0) + Math.round(v));
    plants.set(name, p);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 12).concat(errors.length > 12 ? [`... and ${errors.length - 12} more`] : []) };
  if (!use.size) return { ok: false, errors: ["the use file has no data rows"] };

  const allHours = [...use.keys(), ...[...plants.values()].flatMap((p) => [...p.byHour.keys()])];
  const first = allHours.reduce((a, b) => (b < a ? b : a));
  const last = allHours.reduce((a, b) => (b > a ? b : a));
  const n = Number(last - first) + 1;
  if (n > MAX_HOURS) return { ok: false, errors: [`the files span ${n} hours; the limit is ${MAX_HOURS} (about 13 months)`] };
  const missing = n - use.size;
  if (missing > 0) warnings.push(`${missing} hour(s) between the first and last row have no use value and are counted as 0 kWh`);

  // Same ledger rules as the demo: one issuer, plants in order of commission year (newest first,
  // unknown years last) so newer plants are retired first. Unknown commission years count as
  // older than 15 years for RE100, as the RE100 criteria do for unknown dates.
  const generators = [...plants.entries()]
    .map(([name, p]) => ({ name, commissionYear: p.year ?? 0, yearKnown: p.year !== null, byHour: p.byHour }))
    .sort((a, b) => b.commissionYear - a.commissionYear)
    .map((g, i) => ({ id: i + 1, key: "p" + (i + 1), name: g.name, owner: "plant-" + (i + 1), issuer: "issuer", commissionYear: g.commissionYear, yearKnown: g.yearKnown, byHour: g.byHour }));
  const consumers = [{ id: UPLOAD_ID, name: company.trim() || "Your company", profile: "uploaded data" }];

  const ledger = new Ledger("operator");
  ledger.addIssuer("operator", "issuer");
  ledger.registerConsumer("operator", UPLOAD_ID, UPLOAD_ID);
  const bought = { [UPLOAD_ID]: {} };
  const generation = {};
  for (const g of generators) {
    ledger.registerGenerator("issuer", g.id, g.name, g.owner, g.commissionYear);
    const arr = Array.from({ length: n }, (_, i) => g.byHour.get(first + BigInt(i)) || 0);
    generation[g.id] = arr;
    bought[UPLOAD_ID][g.id] = arr;
    ledger.issueBatch("issuer", g.id, first, arr);
    arr.forEach((v, i) => {
      if (v > 0) ledger.transfer(g.owner, certificateId(g.id, first + BigInt(i)), UPLOAD_ID, v);
    });
  }
  const consumption = Array.from({ length: n }, (_, i) => use.get(first + BigInt(i)) || 0);
  ledger.recordConsumption("operator", UPLOAD_ID, first, consumption);
  for (let i = 0; i < n; i++) {
    let need = consumption[i];
    for (const g of generators) {
      if (need <= 0) break;
      const id = certificateId(g.id, first + BigInt(i));
      const have = Number(ledger.balanceOf(id, UPLOAD_ID));
      const take = Math.min(have, need);
      if (take > 0) {
        ledger.retire(UPLOAD_ID, id, take, UPLOAD_ID, first + BigInt(i));
        need -= take;
      }
    }
  }
  const hours = Array.from({ length: n }, (_, i) => ({ hour: hourIso(first + BigInt(i)) }));
  const scn = {
    ledger,
    firstHour: first,
    n,
    hours,
    generation,
    bought,
    consumption: { [UPLOAD_ID]: consumption },
    log: [],
    ops: [],
    generators: generators.map(({ byHour, ...g }) => g),
    consumers,
    source: "upload",
  };
  return { ok: true, scn, warnings };
}

// Sample files built from the demo week for one company (fictional company, real Taipower curves).
export function sampleCsv(scn, consumerId) {
  const use = ["hour,kwh"];
  const cert = ["hour,kwh,plant,commission_year"];
  for (let i = 0; i < scn.n; i++) {
    const t = scn.hours[i].hour.slice(0, 16).replace("T", " ");
    use.push(`${t},${scn.consumption[consumerId][i]}`);
    for (const g of scn.generators) {
      const v = scn.bought[consumerId]?.[g.id]?.[i] ?? 0;
      if (v > 0) cert.push(`${t},${v},${g.name.replace(/,/g, " ")},${g.commissionYear}`);
    }
  }
  return { use: use.join("\n") + "\n", cert: cert.join("\n") + "\n" };
}
