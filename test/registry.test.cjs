// Contract tests + consistency check: the same demo week is replayed on the Solidity
// contract and on the in-memory mirror (src/ledger.mjs); every result must be identical.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ethers } = require("hardhat");

const ACTORS = ["issuer", "sunfield", "straitwind", "oldcreek", "NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"];
const b32 = (s) => ethers.encodeBytes32String(s);
const imp = (p) => import(pathToFileURL(path.join(__dirname, "..", p)).href);

async function deploy() {
  const signers = await ethers.getSigners();
  const who = Object.fromEntries(ACTORS.map((a, i) => [a, signers[i]]));
  const F = await ethers.getContractFactory("HourlyCertificateRegistry", who.issuer);
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

describe("HourlyCertificateRegistry", function () {
  this.timeout(600000);

  it("enforces same-hour, retire-once and consumption cap", async () => {
    const { c, who } = await deploy();
    const h = 494000n;
    await c.registerGenerator(1, "Test Solar (fictional)", who.sunfield.address, 2021);
    await c.issueBatch(1, h, [1000, 500]);
    await c.recordConsumption(b32("NORTHBAY-FAB"), h, [700, 700]);
    const id0 = await c.certificateId(1, h);
    const id1 = await c.certificateId(1, h + 1n);
    await c.connect(who.sunfield).transfer(id0, who["NORTHBAY-FAB"].address, 1000);

    // wrong hour
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(id0, 100, b32("NORTHBAY-FAB"), h + 1n), "HourMismatch");
    // more than that hour's unmatched use
    await expectRevert(c.connect(who["NORTHBAY-FAB"]).retire(id0, 800, b32("NORTHBAY-FAB"), h), "ExceedsUnmatchedConsumption");
    await c.connect(who["NORTHBAY-FAB"]).retire(id0, 700, b32("NORTHBAY-FAB"), h);
    // the same certificates cannot be retired again for another buyer
    await c.connect(who["NORTHBAY-FAB"]).transfer(id0, who["CLOUDLINE-DC"].address, 300);
    await expectRevert(c.connect(who["CLOUDLINE-DC"]).transfer(id0, who.sunfield.address, 301), "InsufficientBalance");
    // seller cannot sell hour-1 certificates twice
    await c.connect(who.sunfield).transfer(id1, who["NORTHBAY-FAB"].address, 500);
    await expectRevert(c.connect(who.sunfield).transfer(id1, who["CLOUDLINE-DC"].address, 1), "InsufficientBalance");
    // only the issuer meters
    await expectRevert(c.connect(who.sunfield).issueBatch(1, h, [1]), "NotIssuer");

    const [bps, consumed, matched] = await c.matchedBps(b32("NORTHBAY-FAB"), h, h + 2n);
    assert.equal(consumed, 1400n);
    assert.equal(matched, 700n);
    assert.equal(bps, 5000n);

    const claimHash = ethers.id("Northbay Fab ran on 100% renewable electricity.");
    await c.anchorClaim(claimHash, b32("NORTHBAY-FAB"), h, h + 2n, 10000);
    assert.ok((await c.claimAnchoredAt(claimHash)) > 0n);
    await expectRevert(c.anchorClaim(claimHash, b32("NORTHBAY-FAB"), h, h + 2n, 10000), "AlreadyAnchored");
  });

  it("matches the in-memory ledger on the full demo week (real Taipower shapes, fictional parties)", async () => {
    const { buildScenario, CONSUMERS } = await imp("src/scenario.mjs");
    const { loadWeek } = await imp("eval/run_eval.mjs");
    const scn = buildScenario(loadWeek("dev"));
    const { c, who } = await deploy();

    // group consecutive transfers / retirements by sender and day into batch calls
    let gasUsed = 0n;
    const send = async (txp) => {
      const r = await (await txp).wait();
      gasUsed += r.gasUsed;
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
      if (o.op === "registerGenerator") {
        const [gid, name, owner, year] = o.args;
        await send(c.connect(s).registerGenerator(gid, name, who[owner].address, year));
        i++;
      } else if (o.op === "issueBatch") {
        await send(c.connect(s).issueBatch(o.args[0], o.args[1], o.args[2]));
        i++;
      } else if (o.op === "recordConsumption") {
        await send(c.connect(s).recordConsumption(b32(o.args[0]), o.args[1], o.args[2]));
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
        if (o.op === "transfer") await send(c.connect(s).transferBatch(ids, who[o.args[1]].address, kwh));
        else await send(c.connect(s).retireBatch(ids, kwh, b32(o.args[2])));
      } else {
        throw new Error("unknown op " + o.op);
      }
    }

    for (const cons of CONSUMERS) {
      // whole week and every single day
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
  });
});
