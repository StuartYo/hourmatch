// Deterministic claim checker. The language model only turns a sentence into the
// structured claim below; every number and the verdict come from this file.
import { GENERATORS, CONSUMERS } from "./scenario.mjs";
import { generatorOf, hourIso } from "./ledger.mjs";

export const TOLERANCE_BPS = 50; // 0.5 percentage point rounding allowance
export const RE100_MAX_AGE_YEARS = 15; // RE100 technical criteria (2025): plants commissioned/repowered within 15 years

/**
 * Structured claim:
 * { consumer_id, start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" (inclusive),
 *   hour_from: 0-23, hour_to: 1-24 (exclusive), weekdays_only: bool,
 *   claimed_pct: number, standard: "hourly"|"volume"|"unspecified", re100: bool, claim_year: number }
 */
export function validateClaim(c) {
  const errors = [];
  if (!CONSUMERS.some((x) => x.id === c.consumer_id)) errors.push("unknown consumer_id");
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
  const errors = validateClaim(c);
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

  // RE100 plant-age rule
  const oldPlants = new Set();
  if (c.re100) {
    const hourSet = new Set(sel.map((s) => s.h));
    for (const e of scn.ledger.retirementsBy(c.consumer_id)) {
      if (!hourSet.has(e.hour)) continue;
      const g = GENERATORS.find((x) => x.id === generatorOf(e.id));
      if (g && (c.claim_year ?? 2026) - g.commissionYear > RE100_MAX_AGE_YEARS) oldPlants.add(g.name);
    }
  }

  const claimedBps = Math.round(c.claimed_pct * 100);
  const basis = c.standard === "volume" ? "volume" : "hourly";
  const shownBps = basis === "volume" ? volumeBps : hourlyBps;
  const reasons = [];
  if (claimedBps > shownBps + TOLERANCE_BPS) {
    reasons.push(
      basis === "volume"
        ? `certificates bought cover ${(volumeBps / 100).toFixed(1)}% of use, claim says ${c.claimed_pct}%`
        : `only ${(hourlyBps / 100).toFixed(1)}% of use was matched in the same hour, claim says ${c.claimed_pct}%`
    );
  }
  if (oldPlants.size) reasons.push(`RE100 claim relies on plants older than ${RE100_MAX_AGE_YEARS} years: ${[...oldPlants].join(", ")}`);
  const verdict = reasons.length ? "NOT_SUPPORTED" : "SUPPORTED";

  const consumer = CONSUMERS.find((x) => x.id === c.consumer_id);
  const safePct = Math.floor(hourlyBps / 100);
  const window = c.hour_from === 0 && c.hour_to === 24 ? "" : ` between ${String(c.hour_from).padStart(2, "0")}:00 and ${String(c.hour_to).padStart(2, "0")}:00`;
  const rewrite = `${safePct}% of ${consumer.name}'s electricity from ${c.start_date} to ${c.end_date}${c.weekdays_only ? " (weekdays)" : ""}${window} was matched hour by hour with renewable certificates retired on the shared ledger.`;

  return {
    ok: true,
    verdict,
    basis,
    reasons,
    claimedBps,
    hourlyBps,
    volumeBps,
    consumedKwh: Number(consumed),
    matchedKwh: Number(matched),
    hours: hourly.length,
    fullyMatchedHours,
    zeroHours,
    rewrite,
    hourly,
  };
}
