// In-memory mirror of contracts/HourlyCertificateRegistry.sol.
// Same rules, same integer arithmetic. tests/consistency.test.mjs replays one scenario
// through both and asserts identical state, so the web demo can run without a chain.

export const HOUR = 3600;

export function hourIndexOf(isoOrDate) {
  const ms = typeof isoOrDate === "number" ? isoOrDate : new Date(isoOrDate).getTime();
  return BigInt(Math.floor(ms / 1000 / HOUR));
}

export function hourIso(hourIndex) {
  // Taiwan time label, e.g. 2026-10-06T13:00+08:00
  const d = new Date(Number(hourIndex) * HOUR * 1000 + 8 * HOUR * 1000);
  return d.toISOString().slice(0, 13) + ":00+08:00";
}

export function certificateId(generatorId, hourIndex) {
  return (BigInt(generatorId) << 64n) | BigInt(hourIndex);
}
export function hourOf(id) {
  return BigInt(id) & 0xffffffffffffffffn;
}
export function generatorOf(id) {
  return Number(BigInt(id) >> 64n);
}

export class LedgerError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.code = code;
  }
}

const k = (...parts) => parts.map(String).join("|");

export class Ledger {
  constructor(issuer = "issuer") {
    this.issuer = issuer;
    this.generators = new Map(); // id -> {name, owner, commissionYear}
    this.balance = new Map(); // id|holder -> bigint
    this.issued = new Map(); // id -> bigint
    this.retired = new Map(); // id -> bigint
    this.consumption = new Map(); // consumer|hour -> bigint
    this.matched = new Map(); // consumer|hour -> bigint
    this.claims = new Map(); // hash -> {consumer, fromHour, toHour, claimedBps, matchedBps}
    this.events = [];
  }

  #get(map, key) {
    return map.get(key) ?? 0n;
  }
  #onlyIssuer(sender) {
    if (sender !== this.issuer) throw new LedgerError("NotIssuer");
  }

  registerGenerator(sender, generatorId, name, owner, commissionYear) {
    this.#onlyIssuer(sender);
    if (this.generators.has(generatorId)) throw new LedgerError("GeneratorExists");
    this.generators.set(generatorId, { name, owner, commissionYear });
    this.events.push({ type: "GeneratorRegistered", generatorId, name, owner, commissionYear });
  }

  issueBatch(sender, generatorId, firstHour, kwh) {
    this.#onlyIssuer(sender);
    const g = this.generators.get(generatorId);
    if (!g) throw new LedgerError("UnknownGenerator");
    kwh.forEach((v, i) => {
      const amount = BigInt(v);
      if (amount === 0n) return;
      const id = certificateId(generatorId, BigInt(firstHour) + BigInt(i));
      this.issued.set(id, this.#get(this.issued, id) + amount);
      const bk = k(id, g.owner);
      this.balance.set(bk, this.#get(this.balance, bk) + amount);
    });
    this.events.push({ type: "IssuedBatch", generatorId, firstHour: BigInt(firstHour), hours: kwh.length });
  }

  recordConsumption(sender, consumer, firstHour, kwh) {
    this.#onlyIssuer(sender);
    kwh.forEach((v, i) => {
      const h = BigInt(firstHour) + BigInt(i);
      const key = k(consumer, h);
      if (BigInt(v) < this.#get(this.matched, key)) throw new LedgerError("ExceedsUnmatchedConsumption");
      this.consumption.set(key, BigInt(v));
    });
    this.events.push({ type: "ConsumptionRecorded", consumer, firstHour: BigInt(firstHour), hours: kwh.length });
  }

  balanceOf(id, holder) {
    return this.#get(this.balance, k(id, holder));
  }

  transfer(sender, id, to, kwh) {
    const amount = BigInt(kwh);
    const fk = k(id, sender);
    const have = this.#get(this.balance, fk);
    if (have < amount) throw new LedgerError("InsufficientBalance", `${id} have ${have} want ${amount}`);
    this.balance.set(fk, have - amount);
    const tk = k(id, to);
    this.balance.set(tk, this.#get(this.balance, tk) + amount);
    this.events.push({ type: "Transferred", id, from: sender, to, kwh: amount });
  }

  retire(sender, id, kwh, consumer, consumptionHour) {
    const amount = BigInt(kwh);
    const h = hourOf(id);
    if (h !== BigInt(consumptionHour)) throw new LedgerError("HourMismatch", `${h} vs ${consumptionHour}`);
    const bk = k(id, sender);
    const have = this.#get(this.balance, bk);
    if (have < amount) throw new LedgerError("InsufficientBalance", `${id} have ${have} want ${amount}`);
    const ck = k(consumer, h);
    const unmatched = this.#get(this.consumption, ck) - this.#get(this.matched, ck);
    if (amount > unmatched) throw new LedgerError("ExceedsUnmatchedConsumption", `unmatched ${unmatched} want ${amount}`);
    this.balance.set(bk, have - amount);
    this.retired.set(id, this.#get(this.retired, id) + amount);
    this.matched.set(ck, this.#get(this.matched, ck) + amount);
    this.events.push({ type: "Retired", id, holder: sender, consumer, hour: h, kwh: amount });
  }

  matchedBps(consumer, fromHour, toHour) {
    if (BigInt(toHour) <= BigInt(fromHour)) throw new LedgerError("BadRange");
    let consumedKwh = 0n;
    let matchedKwh = 0n;
    for (let h = BigInt(fromHour); h < BigInt(toHour); h++) {
      consumedKwh += this.#get(this.consumption, k(consumer, h));
      matchedKwh += this.#get(this.matched, k(consumer, h));
    }
    const bps = consumedKwh === 0n ? 0 : Number((matchedKwh * 10000n) / consumedKwh);
    return { bps, consumedKwh, matchedKwh };
  }

  anchorClaim(claimHash, consumer, fromHour, toHour, claimedBps) {
    if (this.claims.has(claimHash)) throw new LedgerError("AlreadyAnchored");
    const { bps } = this.matchedBps(consumer, fromHour, toHour);
    this.claims.set(claimHash, { consumer, fromHour: BigInt(fromHour), toHour: BigInt(toHour), claimedBps, matchedBps: bps });
    return bps;
  }

  // Read helpers for the checker (not in the contract, derived from the same state)
  hourly(consumer, fromHour, toHour) {
    const rows = [];
    for (let h = BigInt(fromHour); h < BigInt(toHour); h++) {
      rows.push({
        hour: h,
        consumed: this.#get(this.consumption, k(consumer, h)),
        matched: this.#get(this.matched, k(consumer, h)),
      });
    }
    return rows;
  }

  retirementsBy(consumer) {
    return this.events.filter((e) => e.type === "Retired" && e.consumer === consumer);
  }
}
