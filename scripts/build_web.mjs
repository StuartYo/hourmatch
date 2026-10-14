// Copies the browser-safe engine and data into public/ so the demo runs fully client-side.
// The only server call is the optional AI parse (api/parse.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
fs.mkdirSync(path.join(pub, "lib"), { recursive: true });
for (const f of ["ledger.mjs", "scenario.mjs", "checker.mjs"]) {
  fs.copyFileSync(path.join(root, "src", f), path.join(pub, "lib", f));
}
fs.copyFileSync(path.join(root, "data", "taipower_hourly_2026-10-06_7d.json"), path.join(pub, "lib", "week.json"));

// evaluation summary + cached model parses for the example claims (from eval/results_dev.json)
const resPath = path.join(root, "eval", "results_dev.json");
const summary = { available: false };
const cached = {};
if (fs.existsSync(resPath)) {
  const r = JSON.parse(fs.readFileSync(resPath, "utf8"));
  Object.assign(summary, { available: true, model: r.model, date: r.date, system: r.system, pure: r.pure });
  for (const row of r.rows) if (row.system?.parsed) cached[row.text] = row.system.parsed;
}
const holdPath = path.join(root, "eval", "results_holdout.json");
if (fs.existsSync(holdPath)) {
  const r = JSON.parse(fs.readFileSync(holdPath, "utf8"));
  summary.holdout = { system: r.system, pure: r.pure };
}
const depDir = path.join(root, "deployments");
const deployments = {};
if (fs.existsSync(depDir)) {
  for (const f of fs.readdirSync(depDir)) if (f.endsWith(".json")) deployments[f.replace(".json", "")] = JSON.parse(fs.readFileSync(path.join(depDir, f), "utf8"));
}
fs.writeFileSync(path.join(pub, "lib", "meta.json"), JSON.stringify({ summary, cached, deployments }, null, 1));
console.log("public/lib ready; cached parses:", Object.keys(cached).length);
