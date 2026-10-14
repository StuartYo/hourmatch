// Copies the browser-side engine and data into public/ so the demo runs fully client-side.
// There is no server call at all: no AI endpoint, no upload endpoint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { EXAMPLES } from "../src/examples.mjs";
import { buildScenario } from "../src/scenario.mjs";
import { sampleCsv } from "../src/upload.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8").replace(/^\uFEFF/, ""));
fs.mkdirSync(path.join(pub, "lib"), { recursive: true });
fs.mkdirSync(path.join(pub, "samples"), { recursive: true });
for (const f of ["ledger.mjs", "scenario.mjs", "checker.mjs", "ruleparse.mjs", "upload.mjs", "examples.mjs"]) {
  fs.copyFileSync(path.join(root, "src", f), path.join(pub, "lib", f));
}
fs.copyFileSync(path.join(root, "data", "taipower_hourly_2026-10-06_7d.json"), path.join(pub, "lib", "week.json"));

// sample CSV files: the demo company Northbay Fab (fictional), so an upload reproduces the demo numbers
const week = rd("data/taipower_hourly_2026-10-06_7d.json");
const s = sampleCsv(buildScenario(week), "NORTHBAY-FAB");
fs.writeFileSync(path.join(pub, "samples", "sample_use_kwh.csv"), "# Fictional company (Northbay Fab), demo week 6 to 12 Oct 2026, Taiwan time\n" + s.use);
fs.writeFileSync(path.join(pub, "samples", "sample_certificates.csv"), "# Fictional plants; output curves scaled from real Taipower data\n" + s.cert);

// evaluation summary; cached model parses ONLY for the five example sentences
const dev = rd("eval/results_dev.json");
const hold = rd("eval/results_holdout.json");
const sheet = rd("eval/results_spreadsheet.json");
const hand = rd("eval/handcalc.json");
const cached = {};
for (const t of EXAMPLES) {
  const row = dev.rows.find((r) => r.text === t);
  if (!row?.system?.parsed) throw new Error("no cached parse for example: " + t);
  cached[t] = row.system.parsed;
}
const summary = {
  model: dev.model,
  provider: "PublicAI free inference",
  date: dev.date,
  system: dev.system,
  pure: dev.pure,
  holdout: { system: hold.system, pure: hold.pure },
  spreadsheet: { dev: { correct: sheet.sets.dev.correct, n: sheet.sets.dev.n }, holdout: { correct: sheet.sets.holdout.correct, n: sheet.sets.holdout.n } },
  hand: hand.map((h) => ({ id: h.id, text: h.text, hourly_bps: h.hourly_bps, volume_bps: h.volume_bps, verdict: h.verdict })),
};
const dep = rd("deployments/sepolia.json");
const sel = (sig) => ethers.id(sig).slice(0, 10);
const chain = {
  rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
  selectors: {
    matchedBps: sel("matchedBps(bytes32,uint64,uint64)"),
    consumerWallet: sel("consumerWallet(bytes32)"),
    isIssuer: sel("isIssuer(address)"),
  },
};
fs.writeFileSync(path.join(pub, "lib", "meta.json"), JSON.stringify({ summary, cached, deployment: dep, chain }, null, 1));
console.log("public/lib ready; cached parses:", Object.keys(cached).length);
