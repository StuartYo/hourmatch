// Builds a demo week on the ledger.
// REAL: hourly solar / wind / hydro generation shapes come from Taiwan Power Company open data.
// FICTIONAL: every company, power plant and contract below is made up for the demo
// (also stated in README.md and on the web page).
import { Ledger, LedgerError, certificateId, hourIndexOf } from "./ledger.mjs";

export const ISSUER = "issuer";

export const GENERATORS = [
  { id: 1, key: "solar", name: "Sunfield Solar (fictional)", owner: "sunfield", commissionYear: 2021, peakKw: 30000 },
  { id: 2, key: "wind", name: "Strait Wind (fictional)", owner: "straitwind", commissionYear: 2024, peakKw: 40000 },
  { id: 3, key: "hydro", name: "Old Creek Hydro (fictional)", owner: "oldcreek", commissionYear: 1998, peakKw: 3000 },
];

export const CONSUMERS = [
  { id: "NORTHBAY-FAB", name: "Northbay Fab (fictional)", profile: "24-hour chip plant, flat load" },
  { id: "HARBOR-OFFICE", name: "Harbor Office (fictional)", profile: "office, weekdays 08:00-19:00" },
  { id: "CLOUDLINE-DC", name: "Cloudline Data Center (fictional)", profile: "data center, flat load" },
];

// who receives what share of each plant's certificates (bilateral contracts, fictional)
export const CONTRACTS = [
  { generatorId: 1, buyer: "NORTHBAY-FAB", share: 0.85 },
  { generatorId: 1, buyer: "HARBOR-OFFICE", share: 0.15 },
  { generatorId: 2, buyer: "NORTHBAY-FAB", share: 0.5 },
  { generatorId: 2, buyer: "CLOUDLINE-DC", share: 0.5 },
  { generatorId: 3, buyer: "HARBOR-OFFICE", share: 1.0 },
];

function shape(hours, key) {
  const vals = hours.map((h) => Math.max(0, h.mwh[key] ?? 0));
  const max = Math.max(...vals) || 1;
  return vals.map((v) => v / max);
}

function weekdayAndHour(hourIso) {
  // hourIso like 2026-10-06T13:00+08:00
  const d = new Date(hourIso);
  const local = new Date(d.getTime() + 8 * 3600 * 1000);
  return { dow: local.getUTCDay(), hour: local.getUTCHours() };
}

export function buildScenario(taipower, { withDoubleSale = true } = {}) {
  const hours = taipower.hours;
  const firstHour = hourIndexOf(hours[0].hour);
  const n = hours.length;
  const ledger = new Ledger(ISSUER);
  const log = [];
  const ops = []; // every ledger write, replayed on the real contract by tests/chain

  // 1) plants and hourly certificates (one batch per day, like one tx per day on chain)
  const generation = {};
  for (const g of GENERATORS) {
    ledger.registerGenerator(ISSUER, g.id, g.name, g.owner, g.commissionYear);
    ops.push({ op: "registerGenerator", sender: ISSUER, args: [g.id, g.name, g.owner, g.commissionYear] });
    const s = shape(hours, g.key);
    generation[g.id] = s.map((x) => Math.round(x * g.peakKw));
    for (let d = 0; d < n; d += 24) {
      const day = generation[g.id].slice(d, d + 24);
      ledger.issueBatch(ISSUER, g.id, firstHour + BigInt(d), day);
      ops.push({ op: "issueBatch", sender: ISSUER, args: [g.id, firstHour + BigInt(d), day] });
    }
  }

  // 2) contracts: transfer each buyer's share hour by hour
  const bought = {}; // buyer -> generatorId -> kWh[] per hour
  for (const c of CONTRACTS) {
    const g = GENERATORS.find((x) => x.id === c.generatorId);
    const arr = generation[c.generatorId].map((v) => Math.floor(v * c.share));
    (bought[c.buyer] ??= {})[c.generatorId] = arr;
    arr.forEach((v, i) => {
      if (v <= 0) return;
      const id = certificateId(g.id, firstHour + BigInt(i));
      ledger.transfer(g.owner, id, c.buyer, v);
      ops.push({ op: "transfer", sender: g.owner, args: [id, c.buyer, v] });
    });
  }

  // 3) metered consumption (fictional profiles). Loads are sized so that each buyer's certificate
  //    VOLUME covers a bit more than 100% of its use: "100% renewable" on an annual-style tally.
  const totalBought = (buyer) =>
    Object.values(bought[buyer] ?? {}).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0);
  // Office and data center are sized the same way (105% and 104% of use on paper).
  const fabFlat = Math.floor(totalBought("NORTHBAY-FAB") / n / 1.03);
  const officeShape = hours.map((h) => {
    const { dow, hour } = weekdayAndHour(h.hour);
    const weekday = dow >= 1 && dow <= 5;
    return weekday && hour >= 8 && hour < 19 ? 1 : 0.2;
  });
  const officeUnit = totalBought("HARBOR-OFFICE") / 1.05 / officeShape.reduce((a, b) => a + b, 0);
  const dcVar = hours.map((_, i) => 1 + (((i * 37) % 5) - 2) * 0.02);
  const dcUnit = totalBought("CLOUDLINE-DC") / 1.04 / dcVar.reduce((a, b) => a + b, 0);
  const consumption = {
    "NORTHBAY-FAB": hours.map(() => fabFlat),
    "HARBOR-OFFICE": officeShape.map((x) => Math.round(x * officeUnit)),
    "CLOUDLINE-DC": dcVar.map((x) => Math.round(x * dcUnit)),
  };
  for (const c of CONSUMERS) {
    for (let d = 0; d < n; d += 24) {
      const day = consumption[c.id].slice(d, d + 24);
      ledger.recordConsumption(ISSUER, c.id, firstHour + BigInt(d), day);
      ops.push({ op: "recordConsumption", sender: ISSUER, args: [c.id, firstHour + BigInt(d), day] });
    }
  }

  // 4) a double sale: Strait Wind tries to sell day-3 midday certificates, already sold
  //    to Northbay and Cloudline, to Harbor Office as well. The ledger must refuse.
  if (withDoubleSale) {
    const day3 = 2 * 24;
    for (let hh = 11; hh < 15; hh++) {
      const i = day3 + hh;
      const id = certificateId(2, firstHour + BigInt(i));
      const want = Math.max(1, Math.floor(generation[2][i] * 0.5));
      ops.push({ op: "transfer", sender: "straitwind", args: [id, "HARBOR-OFFICE", want], expectRevert: "InsufficientBalance" });
      try {
        ledger.transfer("straitwind", id, "HARBOR-OFFICE", want);
        log.push({ type: "double-sale-accepted", hour: hours[i].hour, kwh: want });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        log.push({ type: "double-sale-rejected", hour: hours[i].hour, kwh: want, error: e.code });
      }
    }
  }

  // 5) each buyer retires same-hour certificates against that hour's use (greedy, plant id order)
  for (const c of CONSUMERS) {
    for (let i = 0; i < n; i++) {
      let need = consumption[c.id][i];
      for (const g of GENERATORS) {
        if (need <= 0) break;
        const id = certificateId(g.id, firstHour + BigInt(i));
        const have = Number(ledger.balanceOf(id, c.id));
        const use = Math.min(have, need);
        if (use > 0) {
          ledger.retire(c.id, id, use, c.id, firstHour + BigInt(i));
          ops.push({ op: "retire", sender: c.id, args: [id, use, c.id, firstHour + BigInt(i)] });
          need -= use;
        }
      }
    }
  }

  return { ledger, firstHour, n, hours, generation, bought, consumption, log, ops, totalBought };
}
