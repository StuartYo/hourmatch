// Contract tests + consistency check: the same demo week is replayed on the Solidity
// contract and on the in-memory mirror (src/ledger.mjs); every result must be identical.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ethers } = require("hardhat");

const ACTORS = [
  "operator", "issuer-a", "issuer-b", "sunfield", "straitwind", "oldcreek",
  "NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC", "stranger",
];
const b32 = (s) => ethers.encodeBytes32String(s);
const imp = (p) => import(pathToFileURL(path.join(__dirname, "..", p)).href);

async function deploy() {
  const signers = await ethers.getSigners();
  const who = Object.fromEntries(ACTORS.map((a, i) => [a, signers[i]]));
  const F = await ethers.getContractFactory("HourlyCertificateRegistry", who.operator);
  const c = await F.deploy();
  await c.waitForDeployment();
  return { c, who };
}

async function expectRevert(promise, name) {
  try {
    await promise;
  } catch (e) {
    assert.match(String(e.message), new RegExp(name));
    return;
  }
  assert.fail(`expected revert ${name}`);
}

const NB = b32("NORTHBAY-FAB");
const CL = b32("CLOUDLINE-DC");

// two issuers, two plants, one company; returns ids for hour h and h+1
async function twoIssuers() {
  const { c, who } = await deploy();
  const h = 494000n;
  await c.addIssuer(who["issuer-a"].address);
  await c.addIssuer(who["issuer-b"].address);
  await c.registerConsumer(NB, who["NORTHBAY-FAB"].address);
  await c.registerConsumer(CL, who["CLOUDLINE-DC"].address);
  await c.connect(who["issuer-a"]).registerGenerator(1, "Test Solar (fictional)", who.sunfield.address, 2021);
  await c.connect(who["issuer-b"]).registerGenerator(2, "Test Wind (fictional)", who.straitwind.address, 2024);
  return { c, who, h };
}

describe("HourlyCertificateRegistry", function () {
  this.timeout(600000);

  it("two authorized issuers write into one shared retirement state; others cannot issue", async () => {
    const { c, who, h } = await twoIssuers();
    await c.connect(who["issuer-a"]).issueBatch(1, h, [600]);
    await c.connect(who["issuer-b"]).issueBatch(2, h, [600]);
    await c.recordConsumption(NB, h, [1000]);
    const solar = await c.certificateId(1, h);
    const wind = await c.certificateId(2, h);
    await c.connect(who.sunfield).transfer(solar, who["NORTHBAY-FAB"].address, 600);
    await c.connect(who.straitwind).transfer(wind, who["NORTHBAY-FAB"].address, 600);
    await c.connect(who["NORTHBAY-FAB"]).retire(solar, 600, NB, h);
    // the second issuer's certificates hit the SAME matched counter: only 400 kWh of use is left
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(wind, 600, NB, h), "ExceedsUnmatchedConsumption");
    await c.connect(who["NORTHBAY-FAB"]).retire(wind, 400, NB, h);
    const [bps, consumed, matched] = await c.matchedBps(NB, h, h + 1n);
    assert.equal(consumed, 1000n);
    assert.equal(matched, 1000n);
    assert.equal(bps, 10000n);
    assert.equal(await c.retiredOf(solar), 600n);
    assert.equal(await c.retiredOf(wind), 400n);

    // not an issuer
    await expectRevert(c.connect(who.stranger).issueBatch(1, h + 1n, [1]), "NotIssuer");
    await expectRevert(c.connect(who.stranger).registerGenerator(9, "Fake (fictional)", who.stranger.address, 2025), "NotIssuer");
    // an issuer cannot issue for a plant registered by the other issuer
    await expectRevert(c.connect(who["issuer-b"]).issueBatch(1, h + 1n, [1]), "NotGeneratorIssuer");
    // only the operator manages the issuer list
    await expectRevert(c.connect(who["issuer-a"]).addIssuer(who.stranger.address), "NotOperator");
    // a removed issuer cannot issue again, but what it issued before stays valid
    await c.removeIssuer(who["issuer-a"].address);
    await expectRevert(c.connect(who["issuer-a"]).issueBatch(1, h + 1n, [1]), "NotIssuer");
    assert.equal(await c.issued(solar), 600n);
  });

  it("each plant-hour can be issued only once", async () => {
    const { c, who, h } = await twoIssuers();
    await c.connect(who["issuer-a"]).issueBatch(1, h, [100, 0, 300]);
    await expectRevert(c.connect(who["issuer-a"]).issueBatch(1, h, [100]), "AlreadyIssued");
    // overlapping batch: hour h+2 already issued, whole tx reverts and h+3 stays empty
    await expectRevert(c.connect(who["issuer-a"]).issueBatch(1, h + 2n, [5, 5]), "AlreadyIssued");
    assert.equal(await c.issued(await c.certificateId(1, h + 3n)), 0n);
    // a zero hour leaves no record, so it can still be issued later
    await c.connect(who["issuer-a"]).issueBatch(1, h + 1n, [50]);
    assert.equal(await c.issued(await c.certificateId(1, h + 1n)), 50n);
    assert.equal(await c.balanceOf(await c.certificateId(1, h), who.sunfield.address), 100n);
  });

  it("transfer once: plant to buyer, no resale, no double sale", async () => {
    const { c, who, h } = await twoIssuers();
    await c.connect(who["issuer-a"]).issueBatch(1, h, [1000]);
    const id = await c.certificateId(1, h);
    await c.connect(who.sunfield).transfer(id, who["NORTHBAY-FAB"].address, 1000);
    // the plant already sold the whole hour
    await expectRevert(c.connect(who.sunfield).transfer(id, who["CLOUDLINE-DC"].address, 1), "InsufficientBalance");
    // the buyer cannot pass it on
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).transfer(id, who["CLOUDLINE-DC"].address, 10), "OnlyOneTransfer");
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).transferBatch([id], who["CLOUDLINE-DC"].address, [10, 10]), "LengthMismatch");
  });

  it("only the company's own wallet retires and anchors for it; same hour; once", async () => {
    const { c, who, h } = await twoIssuers();
    await c.connect(who["issuer-a"]).issueBatch(1, h, [1000, 500]);
    await c.recordConsumption(NB, h, [700, 700]);
    const id0 = await c.certificateId(1, h);
    const id1 = await c.certificateId(1, h + 1n);
    await c.connect(who.sunfield).transfer(id0, who["NORTHBAY-FAB"].address, 1000);

    // someone else tries to retire Northbay's certificates against Northbay's use
    await expectRevert(c.connect(who["CLOUDLINE-DC"]).retire(id0, 100, NB, h), "NotConsumerWallet");
    await expectRevert(c.connect(who.stranger).retire(id0, 100, NB, h), "NotConsumerWallet");
    // ... or against its own use: it holds none of them
    await c.recordConsumption(CL, h, [500]);
    await expectRevert(c.connect(who["CLOUDLINE-DC"]).retire(id0, 100, CL, h), "InsufficientBalance");
    // the plant cannot retire on the company's behalf either
    await expectRevert(c.connect(who.sunfield).retire(id0, 100, NB, h), "NotConsumerWallet");

    // wrong hour, then more than the hour's unmatched use
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(id0, 100, NB, h + 1n), "HourMismatch");
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(id0, 800, NB, h), "ExceedsUnmatchedConsumption");
    await c.connect(who["NORTHBAY-FAB"]).retire(id0, 700, NB, h);
    // retire again for an hour that is already fully matched
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(id0, 1, NB, h), "ExceedsUnmatchedConsumption");
    // a meter correction cannot drop below what is already matched
    await expectRevert(c.recordConsumption(NB, h, [600]), "ExceedsUnmatchedConsumption");
    // only the operator writes meter data and binds wallets; unknown companies have no meter data
    await expectRevert(c.connect(who.stranger).recordConsumption(NB, h, [9999]), "NotOperator");
    await expectRevert(c.connect(who.stranger).registerConsumer(b32("X"), who.stranger.address), "NotOperator");
    await expectRevert(c.registerConsumer(NB, who.stranger.address), "ConsumerExists");
    await expectRevert(c.recordConsumption(b32("NOBODY"), h, [1]), "UnknownConsumer");

    await c.connect(who.sunfield).transfer(id1, who["NORTHBAY-FAB"].address, 500);
    const [bps, consumed, matched] = await c.matchedBps(NB, h, h + 2n);
    assert.equal(consumed, 1400n);
    assert.equal(matched, 700n);
    assert.equal(bps, 5000n);

    const claimHash = ethers.id("Northbay Fab ran on 100% renewable electricity.");
    await expectRevert(c.connect(who["CLOUDLINE-DC"]).anchorClaim(claimHash, NB, h, h + 2n, 10000), "NotConsumerWallet");
    await c.connect(who["NORTHBAY-FAB"]).anchorClaim(claimHash, NB, h, h + 2n, 10000);
    assert.ok((await c.claimAnchoredAt(claimHash)) > 0n);
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).anchorClaim(claimHash, NB, h, h + 2n, 10000), "AlreadyAnchored");
  });

  it("matches the in-memory ledger on the full demo week (real Taipower shapes, fictional parties)", async () => {
    const { buildScenario, CONSUMERS } = await imp("src/scenario.mjs");
    const { loadWeek } = await imp("eval/run_eval.mjs");
    const scn = buildScenario(loadWeek("dev"));
    const { c, who } = await deploy();

    let gasUsed = 0n;
    const gasByOp = {};
    const send = async (label, txp) => {
      const r = await (await txp).wait();
      gasUsed += r.gasUsed;
      (gasByOp[label] ??= []).push(r.gasUsed);
    };
    const ops = scn.ops;
    let i = 0;
    while (i < ops.length) {
      const o = ops[i];
      const s = who[o.sender];
      if (o.expectRevert) {
        const [id, to, kwh] = o.args;
        await expectRevert(c.connect(s).transfer(id, who[to].address, kwh), o.expectRevert);
        i++;
        continue;
      }
      if (o.op === "addIssuer") {
        await send("addIssuer", c.connect(s).addIssuer(who[o.args[0]].address));
        i++;
      } else if (o.op === "registerConsumer") {
        await send("registerConsumer", c.connect(s).registerConsumer(b32(o.args[0]), who[o.args[1]].address));
        i++;
      } else if (o.op === "registerGenerator") {
        const [gid, name, owner, year] = o.args;
        await send("registerGenerator", c.connect(s).registerGenerator(gid, name, who[owner].address, year));
        i++;
      } else if (o.op === "issueBatch") {
        await send(`issueBatch g${o.args[0]} (24 h)`, c.connect(s).issueBatch(o.args[0], o.args[1], o.args[2]));
        i++;
      } else if (o.op === "recordConsumption") {
        await send("recordConsumption (24 h)", c.connect(s).recordConsumption(b32(o.args[0]), o.args[1], o.args[2]));
        i++;
      } else if (o.op === "transfer" || o.op === "retire") {
        const ids = [];
        const kwh = [];
        const key = (x) => `${x.op}|${x.sender}|${x.op === "transfer" ? x.args[1] : x.args[2]}`;
        const k0 = key(o);
        while (i < ops.length && !ops[i].expectRevert && key(ops[i]) === k0 && ids.length < 48) {
          ids.push(ops[i].args[0]);
          kwh.push(ops[i].args[o.op === "transfer" ? 2 : 1]);
          i++;
        }
        if (o.op === "transfer") await send("transferBatch", c.connect(s).transferBatch(ids, who[o.args[1]].address, kwh));
        else await send("retireBatch", c.connect(s).retireBatch(ids, kwh, b32(o.args[2])));
      } else {
        throw new Error("unknown op " + o.op);
      }
    }

    for (const cons of CONSUMERS) {
      const ranges = [[scn.firstHour, scn.firstHour + BigInt(scn.n)]];
      for (let d = 0; d < scn.n; d += 24) ranges.push([scn.firstHour + BigInt(d), scn.firstHour + BigInt(d + 24)]);
      for (const [a, b] of ranges) {
        const js = scn.ledger.matchedBps(cons.id, a, b);
        const [bps, consumed, matched] = await c.matchedBps(b32(cons.id), a, b);
        assert.equal(Number(bps), js.bps, `${cons.id} bps ${a}-${b}`);
        assert.equal(consumed, js.consumedKwh);
        assert.equal(matched, js.matchedKwh);
      }
    }
    console.log(`      replayed ${ops.length} ledger writes, total gas ${gasUsed}`);
    for (const [k, v] of Object.entries(gasByOp)) {
      const max = v.reduce((a, b) => (b > a ? b : a), 0n);
      const avg = v.reduce((a, b) => a + b, 0n) / BigInt(v.length);
      console.log(`      gas ${k}: ${v.length} tx, avg ${avg}, max ${max}`);
    }
  });
});
