// Deploy the registry to a testnet and write one demo day on chain.
// Testnet only. The key is read from the user environment (CLIMATECHAIN_TESTNET_PK), never from a file.
// Usage: npx hardhat run scripts/deploy.cjs --network sepolia   (Ethereum Sepolia, chain id 11155111)
// Output: deployments/<network>.json (addresses and tx hashes only, no secrets)
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const hre = require("hardhat");
const { ethers } = hre;

const MAX_TX = Number(process.env.CLIMATECHAIN_MAX_TX || 60); // hard cap on writes per run
const imp = (p) => import(pathToFileURL(path.join(__dirname, "..", p)).href);

async function main() {
  const net = hre.network.name;
  if (!["sepolia", "hardhat"].includes(net)) throw new Error("testnets only (sepolia; hardhat = local dry run)");
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("network", net, "deployer", deployer.address, "balance", ethers.formatEther(bal));
  if (bal === 0n) throw new Error("deployer has no testnet ETH; use a faucet first");

  const { buildScenario } = await imp("src/scenario.mjs");
  const { loadWeek } = await imp("eval/run_eval.mjs");
  const scn = buildScenario(loadWeek("dev"));

  // One demo day (day 3, the day of the attempted double sale). Every fictional party is the
  // deployer's own address on testnet, so ownership is shown by consumer ids, not wallets.
  const DAY = 2;
  const from = scn.firstHour + BigInt(DAY * 24);
  const to = from + 24n;

  const F = await ethers.getContractFactory("HourlyCertificateRegistry");
  const c = await F.deploy();
  await c.waitForDeployment();
  const out = { network: net, contract: await c.getAddress(), deployTx: c.deploymentTransaction().hash, day: { from: String(from), to: String(to) }, txs: [] };
  let n = 0;
  const send = async (label, p) => {
    if (++n > MAX_TX) throw new Error("tx cap reached");
    const tx = await p;
    const r = await tx.wait();
    out.txs.push({ label, hash: tx.hash, gas: String(r.gasUsed) });
    console.log(label, tx.hash);
  };
  const b32 = (s) => ethers.encodeBytes32String(s);
  const me = deployer.address;

  for (const o of scn.ops.filter((o) => o.op === "registerGenerator")) {
    const [gid, name, , year] = o.args;
    await send(`register ${name}`, c.registerGenerator(gid, name, me, year));
  }
  const inDay = (h) => BigInt(h) >= from && BigInt(h) < to;
  for (const o of scn.ops.filter((o) => o.op === "issueBatch" && BigInt(o.args[1]) === from)) {
    await send(`issue generator ${o.args[0]}`, c.issueBatch(o.args[0], o.args[1], o.args[2]));
  }
  for (const o of scn.ops.filter((o) => o.op === "recordConsumption" && BigInt(o.args[1]) === from)) {
    await send(`meter ${o.args[0]}`, c.recordConsumption(b32(o.args[0]), o.args[1], o.args[2]));
  }
  // retirements of that day, batched per consumer (transfers are implicit: one test wallet)
  const { hourOf } = await imp("src/ledger.mjs");
  const byConsumer = {};
  for (const o of scn.ops.filter((o) => o.op === "retire" && inDay(hourOf(o.args[0])))) {
    (byConsumer[o.args[2]] ??= []).push(o);
  }
  for (const [cons, list] of Object.entries(byConsumer)) {
    await send(`retire ${cons}`, c.retireBatch(list.map((o) => o.args[0]), list.map((o) => o.args[1]), b32(cons)));
  }
  // the double sale: try to retire one more kWh than is left of a certificate; must revert
  const first = byConsumer["NORTHBAY-FAB"]?.[0];
  if (first) {
    const left = await c.balanceOf(first.args[0], me);
    try {
      await c.retire.staticCall(first.args[0], left + 1n, b32("CLOUDLINE-DC"), hourOf(first.args[0]));
      out.doubleSale = "NOT REVERTED (bug)";
    } catch (e) {
      out.doubleSale = "reverted: " + (e.shortMessage || e.message).slice(0, 160);
    }
    // the same consumption cannot be matched twice either (pick an hour that is fully matched)
    const full = byConsumer["NORTHBAY-FAB"].find((o) => {
      const r = scn.ledger.hourly("NORTHBAY-FAB", o.args[3], o.args[3] + 1n)[0];
      return r.consumed > 0n && r.matched === r.consumed;
    }) || first;
    try {
      await c.retire.staticCall(full.args[0], 1n, b32("NORTHBAY-FAB"), hourOf(full.args[0]));
      out.doubleMatch = "accepted (hour still had unmatched use)";
    } catch (e) {
      out.doubleMatch = "reverted: " + (e.shortMessage || e.message).slice(0, 160);
    }
  }
  // Real on-chain attempts that must fail, so the rejection is visible on the block explorer.
  // gasLimit is set by hand because gas estimation would refuse to send a reverting tx.
  const sendExpectFail = async (label, make) => {
    if (net === "hardhat") return; // local dry run: the static calls above already prove it
    if (++n > MAX_TX) throw new Error("tx cap reached");
    const tx = await make();
    let status = "mined";
    try {
      const r = await tx.wait();
      status = r.status === 1 ? "SUCCEEDED (bug)" : "reverted";
    } catch (e) {
      status = "reverted";
    }
    out.txs.push({ label, hash: tx.hash, status });
    console.log(label, tx.hash, status);
  };
  if (first) {
    const left = await c.balanceOf(first.args[0], me);
    await sendExpectFail("rejected: sell/retire more than is left", () => c.retire(first.args[0], left + 1n, b32("CLOUDLINE-DC"), hourOf(first.args[0]), { gasLimit: 120000 }));
    const full = byConsumer["NORTHBAY-FAB"].find((o) => {
      const r = scn.ledger.hourly("NORTHBAY-FAB", o.args[3], o.args[3] + 1n)[0];
      return r.consumed > 0n && r.matched === r.consumed;
    });
    if (full) await sendExpectFail("rejected: retire again for an hour already fully matched", () => c.retire(full.args[0], 1n, b32("NORTHBAY-FAB"), hourOf(full.args[0]), { gasLimit: 120000 }));
  }
  // anchor one public claim; the contract computes the matched share itself
  const claimText = `Northbay Fab ran on 100% renewable electricity on ${scn.hours[DAY * 24].hour.slice(0, 10)}.`;
  out.anchoredClaim = { text: claimText, hash: ethers.id(claimText) };
  await send("anchor claim", c.anchorClaim(ethers.id(claimText), b32("NORTHBAY-FAB"), from, to, 10000));
  out.anchoredClaim.matchedBps = Number((await c.matchedBps(b32("NORTHBAY-FAB"), from, to))[0]);
  out.explorer = net === "sepolia" ? "https://sepolia.etherscan.io" : null;
  out.chainId = Number((await ethers.provider.getNetwork()).chainId);
  for (const cons of Object.keys(byConsumer)) {
    const [bps] = await c.matchedBps(b32(cons), from, to);
    out[`matchedBps_${cons}`] = Number(bps);
    const js = scn.ledger.matchedBps(cons, from, to).bps;
    if (Number(bps) !== js) throw new Error(`chain/engine mismatch for ${cons}: ${bps} vs ${js}`);
  }
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), JSON.stringify(out, null, 1));
  console.log("done", out.contract);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
