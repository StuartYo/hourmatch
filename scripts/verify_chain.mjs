// Re-reads every transaction in deployments/sepolia.json from a public Sepolia RPC and checks that
// the receipt status matches what the file claims (ok = 1, refused = 0). Also fills in gas used for
// refused transactions. No keys needed. Usage: node scripts/verify_chain.mjs [--write]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "deployments", "sepolia.json");
const dep = JSON.parse(fs.readFileSync(file, "utf8"));
const provider = new ethers.JsonRpcProvider(process.env.CLIMATECHAIN_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", 11155111);

let bad = 0;
for (const t of dep.txs) {
  if (!t.hash) continue;
  const r = await provider.getTransactionReceipt(t.hash);
  const want = t.refused ? 0 : 1;
  const ok = r && r.status === want;
  if (!ok) bad++;
  if (r && t.refused) t.gas = String(r.gasUsed);
  if (r) t.block = r.blockNumber;
  console.log(ok ? "ok " : "BAD", r?.status, t.label);
}
const c = new ethers.Contract(dep.contract, ["function matchedBps(bytes32,uint64,uint64) view returns (uint16,uint256,uint256)", "function isIssuer(address) view returns (bool)", "function consumerWallet(bytes32) view returns (address)"], provider);
for (const [cons, m] of Object.entries(dep.matched)) {
  const [bps, consumed, matched] = await c.matchedBps(ethers.encodeBytes32String(cons), BigInt(dep.day.from), BigInt(dep.day.to));
  const same = Number(bps) === m.bps && String(consumed) === m.consumedKwh && String(matched) === m.matchedKwh;
  if (!same) bad++;
  console.log(same ? "ok " : "BAD", cons, Number(bps), String(consumed), String(matched));
  const wallet = await c.consumerWallet(ethers.encodeBytes32String(cons));
  if (wallet !== dep.wallets[cons]) bad++;
}
for (const role of ["issuer-a", "issuer-b"]) if (!(await c.isIssuer(dep.wallets[role]))) bad++;
dep.verifiedAt = new Date().toISOString();
const okGas = dep.txs.filter((t) => t.gas).reduce((a, t) => a + BigInt(t.gas), 0n);
dep.gasTotal = String(okGas);
if (process.argv.includes("--write") && !bad) fs.writeFileSync(file, JSON.stringify(dep, null, 1));
console.log(bad ? `${bad} problem(s)` : "all transactions and reads match", "gas incl. refused:", String(okGas));
process.exit(bad ? 1 : 0);
