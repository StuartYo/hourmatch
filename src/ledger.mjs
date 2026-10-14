// In-memory mirror of contracts/HourlyCertificateRegistry.sol.
// Same rules, same integer arithmetic, same error names. test/registry.test.cjs replays the whole
// demo week through both and asserts identical results, so the web demo can run without a chain.
// Senders are plain names here ("operator", "issuer-a", "NORTHBAY-FAB"); on chain they are wallets.

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
  constructor(operator = "operator") {
    this.operator = operator;
    this.issuers = new Set();
    this.consumerWallet = new Map(); // consumer id -> sender name
    this.generators = new Map(); // id -> {name, owner, issuer, commissionYear}
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
  #onlyOperator(sender) {
    if (sender !== this.operator) throw new LedgerError("NotOperator");
  }
  #onlyIssuer(sender) {
    if (!this.issuers.has(sender)) throw new LedgerError("NotIssuer");
  }

  addIssuer(sender, issuer) {
    this.#onlyOperator(sender);
    this.issuers.add(issuer);
    this.events.push({ type: "IssuerAdded", issuer });
  }

  removeIssuer(sender, issuer) {
    this.#onlyOperator(sender);
    this.issuers.delete(issuer);
    this.events.push({ type: "IssuerRemoved", issuer });
  }

  registerConsumer(sender, consumer, wallet) {
    this.#onlyOperator(sender);
    if (this.consumerWallet.has(consumer)) throw new LedgerError("ConsumerExists");
    this.consumerWallet.set(consumer, wallet);
    this.events.push({ type: "ConsumerRegistered", consumer, wallet });
  }

  registerGenerator(sender, generatorId, name, owner, commissionYear) {
    this.#onlyIssuer(sender);
    if (this.generators.has(generatorId)) throw new LedgerError("GeneratorExists");
    this.generators.set(generatorId, { name, owner, issuer: sender, commissionYear });
    this.events.push({ type: "GeneratorRegistered", generatorId, name, owner, issuer: sender, commissionYear });
  }

  issueBatch(sender, generatorId, firstHour, kwh) {
    this.#onlyIssuer(sender);
    const g = this.generators.get(generatorId);
    if (!g) throw new LedgerError("UnknownGenerator");
    if (g.issuer !== sender) throw new LedgerError("NotGeneratorIssuer");
    // check every hour first so a failed batch changes nothing (a reverted tx changes nothing either)
    const ids = kwh.map((v, i) => [certificateId(generatorId, BigInt(firstHour) + BigInt(i)), BigInt(v)]);
    for (const [id, amount] of ids) if (amount !== 0n && this.#get(this.issued, id) !== 0n) throw new LedgerError("AlreadyIssued", String(id));
    for (const [id, amount] of ids) {
      if (amount === 0n) continue;
      this.issued.set(id, amount);
      const bk = k(id, g.owner);
      this.balance.set(bk, this.#get(this.balance, bk) + amount);
    }
    this.events.push({ type: "IssuedBatch", generatorId, firstHour: BigInt(firstHour), hours: kwh.length });
  }

  recordConsumption(sender, consumer, firstHour, kwh) {
    this.#onlyOperator(sender);
    if (!this.consumerWallet.has(consumer)) throw new LedgerError("UnknownConsumer");
    kwh.forEach((v, i) => {
      const key = k(consumer, BigInt(firstHour) + BigInt(i));
      if (BigInt(v) < this.#get(this.matched, key)) throw new LedgerError("ExceedsUnmatchedConsumption");
    });
    kwh.forEach((v, i) => this.consumption.set(k(consumer, BigInt(firstHour) + BigInt(i)), BigInt(v)));
    this.events.push({ type: "ConsumptionRecorded", consumer, firstHour: BigInt(firstHour), hours: kwh.length });
  }

  balanceOf(id, holder) {
    return this.#get(this.balance, k(id, holder));
  }

  // Only the plant account can transfer: each certificate changes hands at most once (T-REC "transfer once").
  transfer(sender, id, to, kwh) {
    const amount = BigInt(kwh);
    const g = this.generators.get(generatorOf(id));
    if (!g || g.owner !== sender) throw new LedgerError("OnlyOneTransfer", String(id));
    const fk = k(id, sender);
    const have = this.#get(this.balance, fk);
    if (have < amount) throw new LedgerError("InsufficientBalance", `${id} have ${have} want ${amount}`);
    this.balance.set(fk, have - amount);
    const tk = k(id, to);
    this.balance.set(tk, this.#get(this.balance, tk) + amount);
    this.events.push({ type: "Transferred", id, from: sender, to, kwh: amount });
  }

  retire(sender, id, kwh, consumer, consumptionHour) {
    if (this.consumerWallet.get(consumer) !== sender) throw new LedgerError("NotConsumerWallet", consumer);
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

  anchorClaim(sender, claimHash, consumer, fromHour, toHour, claimedBps) {
    if (this.consumerWallet.get(consumer) !== sender) throw new LedgerError("NotConsumerWallet", consumer);
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
