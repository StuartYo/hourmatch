// Deploy the registry to a testnet and write one demo day on chain with SEPARATE wallets:
// operator (deployer), Issuer A, Issuer B, and one wallet per company.
// Testnet only. Secrets:
//   CLIMATECHAIN_TESTNET_PK  operator key, from the user environment only
//   .env.local               demo wallet keys, generated here on first run (git-ignored, never printed)
// Usage: npx hardhat run scripts/deploy.cjs --network sepolia   (hardhat = local dry run with gas estimate)
// Output: deployments/<network>.json (addresses, tx hashes, gas; no secrets)
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const hre = require("hardhat");
const { ethers } = hre;

const ROOT = path.join(__dirname, "..");
const ENV_LOCAL = path.join(ROOT, ".env.local");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const b32 = (s) => ethers.encodeBytes32String(s);

const ROLES = [
  ["HM_ISSUER_A_PK", "issuer-a"],
  ["HM_ISSUER_B_PK", "issuer-b"],
  ["HM_NORTHBAY_PK", "NORTHBAY-FAB"],
  ["HM_HARBOR_PK", "HARBOR-OFFICE"],
  ["HM_CLOUDLINE_PK", "CLOUDLINE-DC"],
];
const FUND_EACH = ethers.parseEther(process.env.HM_FUND_EACH || "0.0003");
const MAX_FEE = ethers.parseUnits(process.env.HM_MAX_FEE_GWEI || "0.01", "gwei"); // refuse to run above this
const PRIO_FEE = ethers.parseUnits("0.002", "gwei");

function readEnvLocal() {
  const out = {};
  if (!fs.existsSync(ENV_LOCAL)) return out;
  for (const line of fs.readFileSync(ENV_LOCAL, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function ensureWallets() {
  const env = readEnvLocal();
  const add = [];
  for (const [key] of ROLES) {
    if (!env[key]) {
      env[key] = ethers.Wallet.createRandom().privateKey;
      add.push(`${key}=${env[key]}`);
    }
  }
  if (add.length) {
    const head = fs.existsSync(ENV_LOCAL) ? "" : "# HourMatch demo wallets for Ethereum Sepolia testnet only. Git-ignored. Never commit or print.\n";
    fs.appendFileSync(ENV_LOCAL, head + add.join("\n") + "\n");
    console.log(`generated ${add.length} new testnet wallet(s) into .env.local`);
  }
  return env;
}

async function main() {
  const net = hre.network.name;
  if (!["sepolia", "hardhat"].includes(net)) throw new Error("testnets only (sepolia; hardhat = local dry run)");
  const live = net === "sepolia";
  const [operator] = await ethers.getSigners();
  const provider = ethers.provider;
  const env = ensureWallets();
  const w = { operator };
  for (const [key, role] of ROLES) w[role] = new ethers.Wallet(env[key], provider);
  // plant accounts are held by their issuer's wallet in this demo
  w.sunfield = w["issuer-a"];
  w.oldcreek = w["issuer-a"];
  w.straitwind = w["issuer-b"];

  const startBal = await provider.getBalance(operator.address);
  console.log("network", net, "operator", operator.address, "balance", ethers.formatEther(startBal));

  let fee = {};
  if (live) {
    const fd = await provider.getFeeData();
    const block = await provider.getBlock("latest");
    const need = block.baseFeePerGas * 2n + PRIO_FEE;
    if (need > MAX_FEE) throw new Error(`gas too expensive right now (base ${ethers.formatUnits(block.baseFeePerGas, "gwei")} gwei); cap is ${ethers.formatUnits(MAX_FEE, "gwei")} gwei`);
    fee = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIO_FEE };
    console.log("base fee gwei", ethers.formatUnits(block.baseFeePerGas, "gwei"), "suggested", ethers.formatUnits(fd.maxFeePerGas, "gwei"));
  }

  const { buildScenario } = await imp("src/scenario.mjs");
  const { loadWeek } = await imp("eval/run_eval.mjs");
  const { hourOf } = await imp("src/ledger.mjs");
  const scn = buildScenario(loadWeek("dev"));
  const DAY = 2; // 8 October 2026, the day of the attempted double sale
  const from = scn.firstHour + BigInt(DAY * 24);
  const to = from + 24n;
  const inDay = (h) => BigInt(h) >= from && BigInt(h) < to;

  const out = {
    network: net,
    chainId: Number((await provider.getNetwork()).chainId),
    explorer: live ? "https://sepolia.etherscan.io" : null,
    day: { from: String(from), to: String(to), date: scn.hours[DAY * 24].hour.slice(0, 10) },
    wallets: Object.fromEntries(["operator", ...ROLES.map((r) => r[1])].map((r) => [r, w[r].address])),
    txs: [],
  };

  // fund the demo wallets with a little test ETH from the operator
  for (const [, role] of ROLES) {
    const bal = await provider.getBalance(w[role].address);
    if (bal < FUND_EACH / 2n) {
      const tx = await operator.sendTransaction({ to: w[role].address, value: FUND_EACH - bal, ...fee });
      const r = await tx.wait();
      out.txs.push({ label: `fund ${role} wallet`, hash: tx.hash, from: "operator", gas: String(r.gasUsed), status: "ok" });
    }
  }

  const F = await ethers.getContractFactory("HourlyCertificateRegistry", operator);
  const c0 = await F.deploy(fee);
  await c0.waitForDeployment();
  const addr = await c0.getAddress();
  const dr = await c0.deploymentTransaction().wait();
  out.contract = addr;
  out.deployTx = c0.deploymentTransaction().hash;
  out.txs.push({ label: "deploy contract", hash: out.deployTx, from: "operator", gas: String(dr.gasUsed), status: "ok" });
  const as = (role) => c0.connect(w[role]);
  console.log("contract", addr);

  let gasTotal = dr.gasUsed;
  const send = async (label, role, fn) => {
    const tx = await fn(as(role));
    const r = await tx.wait();
    gasTotal += r.gasUsed;
    out.txs.push({ label, hash: tx.hash, from: role, gas: String(r.gasUsed), status: "ok" });
    console.log("ok  ", label, r.gasUsed.toString());
    return r;
  };
  // A write that MUST fail. First a static call to learn the contract's error name, then a real
  // transaction with a fixed gas limit so the refusal is visible on the block explorer.
  const refuse = async (label, role, method, args) => {
    let error = "none";
    try {
      await as(role)[method].staticCall(...args);
      error = "ACCEPTED (bug)";
    } catch (e) {
      let parsed = null;
      try {
        parsed = e.data ? c0.interface.parseError(e.data)?.name : null;
      } catch {}
      const msg = String(e.shortMessage || e.message || "");
      error = e.revert?.name || parsed || (msg.match(/custom error '?([A-Za-z]+)/) || [])[1] || msg.slice(0, 80);
    }
    if (error === "ACCEPTED (bug)") throw new Error(`${label}: contract accepted a write it must refuse`);
    let hash = null;
    let status = "refused (static call)";
    if (live) {
      const tx = await as(role)[method](...args, { gasLimit: 400000, ...fee });
      hash = tx.hash;
      try {
        const r = await tx.wait();
        status = r.status === 1 ? "SUCCEEDED (bug)" : "reverted";
        gasTotal += r.gasUsed;
      } catch (e) {
        status = "reverted";
        if (e.receipt) gasTotal += e.receipt.gasUsed;
      }
    }
    out.txs.push({ label, hash, from: role, status, error, refused: true });
    console.log("FAIL", label, error, status);
  };
  const ov = live ? [fee] : [];

  // governance
  await send("add Issuer A", "operator", (c) => c.addIssuer(w["issuer-a"].address, ...ov));
  await send("add Issuer B", "operator", (c) => c.addIssuer(w["issuer-b"].address, ...ov));
  for (const id of ["NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"]) {
    await send(`bind ${id} to its wallet`, "operator", (c) => c.registerConsumer(b32(id), w[id].address, ...ov));
  }
  // plants, each registered by its own issuer
  for (const o of scn.ops.filter((o) => o.op === "registerGenerator")) {
    const [gid, name, owner, year] = o.args;
    await send(`${o.sender === "issuer-a" ? "Issuer A" : "Issuer B"} registers ${name}`, o.sender, (c) => c.registerGenerator(gid, name, w[owner].address, year, ...ov));
  }
  // one day of hourly certificates per plant
  const issueOps = scn.ops.filter((o) => o.op === "issueBatch" && BigInt(o.args[1]) === from);
  for (const o of issueOps) {
    const gname = scn.generators.find((g) => g.id === o.args[0]).name;
    await send(`${o.sender === "issuer-a" ? "Issuer A" : "Issuer B"} issues one day of hourly certificates for ${gname}`, o.sender, (c) => c.issueBatch(o.args[0], o.args[1], o.args[2], ...ov));
  }
  const solarDay = issueOps.find((o) => o.args[0] === 1);
  await refuse("a company wallet tries to issue certificates", "NORTHBAY-FAB", "issueBatch", [1, from, [1]]);
  await refuse("Issuer B tries to issue for Issuer A's plant", "issuer-b", "issueBatch", [1, from, [1]]);
  await refuse("Issuer A issues the same day again", "issuer-a", "issueBatch", [1, from, solarDay.args[2]]);
  // metered use
  for (const o of scn.ops.filter((o) => o.op === "recordConsumption" && BigInt(o.args[1]) === from)) {
    await send(`meter data for ${o.args[0]}`, "operator", (c) => c.recordConsumption(b32(o.args[0]), o.args[1], o.args[2], ...ov));
  }
  // sales: plant account -> buyer, grouped by seller wallet and buyer
  const groups = new Map();
  for (const o of scn.ops.filter((o) => o.op === "transfer" && !o.expectRevert && inDay(hourOf(o.args[0])))) {
    const seller = w[o.sender] === w["issuer-a"] ? "issuer-a" : "issuer-b";
    const key = `${seller}|${o.args[1]}`;
    if (!groups.has(key)) groups.set(key, { seller, buyer: o.args[1], ids: [], kwh: [] });
    groups.get(key).ids.push(o.args[0]);
    groups.get(key).kwh.push(o.args[2]);
  }
  for (const g of groups.values()) {
    await send(`${g.seller === "issuer-a" ? "Issuer A" : "Issuer B"} plant account sells ${g.ids.length} hourly certificates to ${g.buyer}`, g.seller, (c) => c.transferBatch(g.ids, w[g.buyer].address, g.kwh, ...ov));
  }
  const dbl = scn.ops.find((o) => o.op === "transfer" && o.expectRevert && inDay(hourOf(o.args[0])));
  if (dbl) await refuse("Strait Wind sells an already sold hour again (double sale)", "issuer-b", "transfer", [dbl.args[0], w["HARBOR-OFFICE"].address, dbl.args[2]]);
  const nbSolar = groups.get("issuer-a|NORTHBAY-FAB");
  await refuse("Northbay resells a certificate it bought", "NORTHBAY-FAB", "transfer", [nbSolar.ids[0], w["CLOUDLINE-DC"].address, 1]);

  // retirements, each company from its own wallet
  const byConsumer = {};
  for (const o of scn.ops.filter((o) => o.op === "retire" && inDay(hourOf(o.args[0])))) (byConsumer[o.args[2]] ??= []).push(o);
  for (const [cons, list] of Object.entries(byConsumer)) {
    await send(`${cons} retires ${list.length} same-hour certificates`, cons, (c) => c.retireBatch(list.map((o) => o.args[0]), list.map((o) => o.args[1]), b32(cons), ...ov));
  }
  // someone else tries to retire Northbay's certificates
  const nbRet = byConsumer["NORTHBAY-FAB"];
  const withLeft = [];
  for (const o of nbRet) {
    const left = await c0.balanceOf(o.args[0], w["NORTHBAY-FAB"].address);
    const row = scn.ledger.hourly("NORTHBAY-FAB", o.args[3], o.args[3] + 1n)[0];
    if (left > 0n && row.matched === row.consumed) withLeft.push(o);
  }
  const t = withLeft[0] || nbRet[0];
  await refuse("Cloudline's wallet tries to retire Northbay's certificates for Northbay", "CLOUDLINE-DC", "retire", [t.args[0], 1, b32("NORTHBAY-FAB"), hourOf(t.args[0])]);
  await refuse("Cloudline's wallet tries to retire Northbay's certificates for itself", "CLOUDLINE-DC", "retire", [t.args[0], 1, b32("CLOUDLINE-DC"), hourOf(t.args[0])]);
  await refuse("Northbay retires again for an hour already fully matched", "NORTHBAY-FAB", "retire", [t.args[0], 1, b32("NORTHBAY-FAB"), hourOf(t.args[0])]);

  // claim anchoring: only the company itself
  const claimText = `Northbay Fab ran on 100% renewable electricity on ${out.day.date}.`;
  const hash = ethers.id(claimText);
  await refuse("Cloudline's wallet tries to anchor a claim about Northbay", "CLOUDLINE-DC", "anchorClaim", [hash, b32("NORTHBAY-FAB"), from, to, 10000]);
  await send("Northbay anchors its own claim", "NORTHBAY-FAB", (c) => c.anchorClaim(hash, b32("NORTHBAY-FAB"), from, to, 10000, ...ov));
  out.anchoredClaim = { text: claimText, hash, matchedBps: Number((await c0.matchedBps(b32("NORTHBAY-FAB"), from, to))[0]) };

  // chain state vs the browser ledger
  out.matched = {};
  for (const cons of ["NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"]) {
    const [bps, consumed, matched] = await c0.matchedBps(b32(cons), from, to);
    const js = scn.ledger.matchedBps(cons, from, to);
    if (Number(bps) !== js.bps || consumed !== js.consumedKwh || matched !== js.matchedKwh) throw new Error(`chain/engine mismatch for ${cons}`);
    out.matched[cons] = { bps: Number(bps), consumedKwh: String(consumed), matchedKwh: String(matched) };
  }
  out.gasTotal = String(gasTotal);
  const endBal = await provider.getBalance(operator.address);
  out.operatorSpentEth = ethers.formatEther(startBal - endBal);
  if (live) {
    const fd = await provider.getFeeData();
    out.gasPriceGwei = ethers.formatUnits(fd.gasPrice, "gwei");
  }
  fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "deployments", `${net}.json`), JSON.stringify(out, null, 1));
  console.log("done", addr, "gas total", gasTotal.toString(), "operator spent", out.operatorSpentEth, "ETH");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
