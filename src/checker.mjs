// Deterministic claim checker. The language model only turns a sentence into the
// structured claim below; every number and the verdict come from this file.
import { GENERATORS, CONSUMERS } from "./scenario.mjs";
import { generatorOf, hourIso } from "./ledger.mjs";

export const TOLERANCE_BPS = 50; // 0.5 percentage point rounding allowance
// RE100 Technical Criteria (24 March 2025), section 4.2: procurement must come from projects commissioned
// or re-powered on or after 1 January of the year fifteen years before the claim year (2026 claim: 2011
// or later). Buyers may allocate up to 15% of total consumption to older projects. Exempt procurement
// types (self-generation, original off-taker PPAs, grandfathered contracts that began before 2024, ...)
// are NOT modelled here; the demo plants are all treated as ordinary purchases.
// https://www.there100.org/technical-guidance
export const RE100_MAX_AGE_YEARS = 15;
export const RE100_OLD_ALLOWANCE_BPS = 1500;

// one decimal, half up, never more than the integer basis points allow (82.96% -> "83.0%")
export function pctText(bps) {
  return (Math.round(bps / 10) / 10).toFixed(1) + "%";
}

/**
 * Structured claim:
 * { consumer_id, start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" (inclusive),
 *   hour_from: 0-23, hour_to: 1-24 (exclusive), weekdays_only: bool,
 *   claimed_pct: number, standard: "hourly"|"volume"|"unspecified", re100: bool, claim_year: number }
 */
export function validateClaim(c, consumers = CONSUMERS) {
  const errors = [];
  if (!consumers.some((x) => x.id === c.consumer_id)) errors.push("unknown company: it is not in this ledger");
  for (const f of ["start_date", "end_date"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(c[f] ?? "")) errors.push(`bad ${f}`);
  if (!(Number.isInteger(c.hour_from) && c.hour_from >= 0 && c.hour_from <= 23)) errors.push("bad hour_from");
  if (!(Number.isInteger(c.hour_to) && c.hour_to >= 1 && c.hour_to <= 24 && c.hour_to > c.hour_from)) errors.push("bad hour_to");
  if (!(typeof c.claimed_pct === "number" && c.claimed_pct >= 0 && c.claimed_pct <= 100)) errors.push("bad claimed_pct");
  if (!["hourly", "volume", "unspecified"].includes(c.standard)) errors.push("bad standard");
  return errors;
}

function localParts(hourIndex) {
  const iso = hourIso(hourIndex); // 2026-10-06T13:00+08:00
  const date = iso.slice(0, 10);
  const hour = Number(iso.slice(11, 13));
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  return { iso, date, hour, dow };
}

export function selectHours(scn, c) {
  const out = [];
  for (let i = 0; i < scn.n; i++) {
    const h = scn.firstHour + BigInt(i);
    const p = localParts(h);
    if (p.date < c.start_date || p.date > c.end_date) continue;
    if (p.hour < c.hour_from || p.hour >= c.hour_to) continue;
    if (c.weekdays_only && (p.dow === 0 || p.dow === 6)) continue;
    out.push({ i, h, ...p });
  }
  return out;
}

export function checkClaim(scn, c) {
  const generators = scn.generators ?? GENERATORS;
  const consumers = scn.consumers ?? CONSUMERS;
  const errors = validateClaim(c, consumers);
  if (errors.length) return { ok: false, errors };
  const sel = selectHours(scn, c);
  if (!sel.length) return { ok: false, errors: ["claim period is outside the ledger data"] };

  let consumed = 0n;
  let matched = 0n;
  let volume = 0;
  const hourly = [];
  for (const s of sel) {
    const row = scn.ledger.hourly(c.consumer_id, s.h, s.h + 1n)[0];
    consumed += row.consumed;
    matched += row.matched;
    const boughtHere = Object.values(scn.bought[c.consumer_id] ?? {}).reduce((a, arr) => a + (arr[s.i] ?? 0), 0);
    volume += boughtHere;
    hourly.push({ hour: s.iso, consumed: Number(row.consumed), matched: Number(row.matched), bought: boughtHere });
  }
  const hourlyBps = consumed === 0n ? 0 : Number((matched * 10000n) / consumed);
  const volumeBps = consumed === 0n ? 0 : Math.floor((volume * 10000) / Number(consumed));
  const fullyMatchedHours = hourly.filter((r) => r.consumed > 0 && r.matched >= r.consumed).length;
  const zeroHours = hourly.filter((r) => r.consumed > 0 && r.matched === 0).length;

  // RE100 plant-age rule with the 15% allowance (see top of file)
  const oldPlants = new Set();
  let oldMatched = 0;
  let oldBought = 0;
  if (c.re100) {
    const year = c.claim_year ?? 2026;
    const isOld = (g) => g && year - g.commissionYear > RE100_MAX_AGE_YEARS;
    const hourSet = new Set(sel.map((s) => s.h));
    for (const e of scn.ledger.retirementsBy(c.consumer_id)) {
      if (!hourSet.has(e.hour)) continue;
      const g = generators.find((x) => x.id === generatorOf(e.id));
      if (isOld(g)) {
        oldPlants.add(`${g.name} (${g.commissionYear})`);
        oldMatched += Number(e.kwh);
      }
    }
    for (const g of generators) {
      if (!isOld(g)) continue;
      const arr = scn.bought[c.consumer_id]?.[g.id] ?? [];
      const v = sel.reduce((a, s) => a + (arr[s.i] ?? 0), 0);
      if (v > 0) oldPlants.add(`${g.name} (${g.commissionYear})`);
      oldBought += v;
    }
  }
  const cons = Number(consumed);
  const allowance = Math.floor((cons * RE100_OLD_ALLOWANCE_BPS) / 10000);
  const re100 = c.re100
    ? {
        oldMatchedBps: cons ? Math.floor((oldMatched * 10000) / cons) : 0,
        oldBoughtBps: cons ? Math.floor((oldBought * 10000) / cons) : 0,
        // share RE100 still recognizes after dropping old-plant kWh beyond 15% of use
        hourlyBps: cons ? Math.floor(((Number(matched) - Math.max(0, oldMatched - allowance)) * 10000) / cons) : 0,
        volumeBps: cons ? Math.floor(((volume - Math.max(0, oldBought - allowance)) * 10000) / cons) : 0,
        plants: [...oldPlants],
      }
    : null;

  const claimedBps = Math.round(c.claimed_pct * 100);
  const basis = c.standard === "volume" ? "volume" : "hourly";
  const plainBps = basis === "volume" ? volumeBps : hourlyBps;
  const shownBps = re100 ? (basis === "volume" ? re100.volumeBps : re100.hourlyBps) : plainBps;
  const reasons = [];
  if (claimedBps > plainBps + TOLERANCE_BPS) {
    reasons.push(
      basis === "volume"
        ? `certificates bought cover ${pctText(volumeBps)} of use, the claim says ${c.claimed_pct}%`
        : `only ${pctText(hourlyBps)} of use was matched in the same hour, the claim says ${c.claimed_pct}%`
    );
  }
  if (re100 && shownBps < plainBps && claimedBps > shownBps + TOLERANCE_BPS) {
    const oldBps = basis === "volume" ? re100.oldBoughtBps : re100.oldMatchedBps;
    reasons.push(
      `for RE100, plants older than ${RE100_MAX_AGE_YEARS} years (${re100.plants.join(", ")}) supply ${pctText(oldBps)} of use; ` +
        `only 15% of use may come from such plants, so RE100 recognizes ${pctText(shownBps)}`
    );
  }
  const verdict = reasons.length ? "NOT_SUPPORTED" : "SUPPORTED";

  const consumer = consumers.find((x) => x.id === c.consumer_id);
  const window = c.hour_from === 0 && c.hour_to === 24 ? "" : ` between ${String(c.hour_from).padStart(2, "0")}:00 and ${String(c.hour_to).padStart(2, "0")}:00`;
  const scope = `${consumer.name}'s electricity from ${c.start_date} to ${c.end_date}${c.weekdays_only ? " (weekdays only)" : ""}${window}`;
  // The rewrite is stated on the SAME basis the verdict used, with the number the ledger supports.
  const supportedBps = shownBps;
  const re100Tail = re100 ? " counting only what RE100 recognizes (15-year plant-age rule)" : "";
  const rewrite =
    basis === "volume"
      ? `Certificates bought for ${scope} equal ${pctText(supportedBps)} of its use in total${re100Tail}. Matched hour by hour, the share is ${pctText(hourlyBps)}.`
      : `${pctText(supportedBps)} of ${scope} was matched hour by hour with renewable certificates retired on the shared ledger${re100Tail}.`;

  return {
    ok: true,
    verdict,
    basis,
    reasons,
    claimedBps,
    hourlyBps,
    volumeBps,
    re100,
    consumedKwh: Number(consumed),
    matchedKwh: Number(matched),
    hours: hourly.length,
    fullyMatchedHours,
    zeroHours,
    rewrite,
    hourly,
  };
}
