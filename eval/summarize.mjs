// Writes eval/RESULTS.md from results_dev.json and results_holdout.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (s) => {
  const p = path.join(here, `results_${s}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const sets = { dev: load("dev"), holdout: load("holdout") };
let md = "# Evaluation results\n\n";
md += "All companies and plants are fictional; generation curves are real Taipower open data. Ground truth comes from `src/checker.mjs` applied to hand-written gold fields, never from a model.\n\n";
md += "- **HourMatch**: the model turns the sentence into fields; ledger code computes the share and the verdict.\n";
md += "- **Model alone**: the same model gets the claim, the full hourly table for that company (use and certificates per hour per plant), plant ages, and the exact matching rules in its prompt. No tools.\n\n";
md += "| Set | Setup | Correct verdicts | Share within 1 point |\n|---|---|---|---|\n";
for (const [name, r] of Object.entries(sets)) {
  if (!r) continue;
  md += `| ${name} (${r.rows.length} claims) | HourMatch | ${r.system.correct} / ${r.system.n} | ${r.system.shareWithin1pt} / ${r.system.n} |\n`;
  md += `| ${name} | Model alone | ${r.pure.correct} / ${r.pure.n} | ${r.pure.shareWithin1pt} / ${r.pure.n} |\n`;
}
const any = sets.dev || sets.holdout;
if (any) md += `\nModel: \`${any.model}\` (PublicAI free inference, temperature 0). Run: ${any.date.slice(0, 10)}.\n`;
for (const [name, r] of Object.entries(sets)) {
  if (!r) continue;
  md += `\n## ${name}\n\n| id | truth | true share | HourMatch | model alone (share) |\n|---|---|---|---|---|\n`;
  for (const row of r.rows) {
    const sys = row.system ? `${row.system.verdict}${Number.isFinite(row.system.share) ? ` (${row.system.share})` : ""}` : "";
    const pure = row.pure ? `${row.pure.verdict}${Number.isFinite(row.pure.share) ? ` (${row.pure.share})` : ""}` : "";
    md += `| ${row.id} | ${row.truth} | ${row.truthShare} | ${sys} | ${pure} |\n`;
  }
}
fs.writeFileSync(path.join(here, "RESULTS.md"), md);
console.log(md.split("\n").slice(0, 14).join("\n"));
