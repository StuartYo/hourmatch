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
const sheet = fs.existsSync(path.join(here, "results_spreadsheet.json")) ? JSON.parse(fs.readFileSync(path.join(here, "results_spreadsheet.json"), "utf8")) : null;
const hand = fs.existsSync(path.join(here, "handcalc.json")) ? JSON.parse(fs.readFileSync(path.join(here, "handcalc.json"), "utf8")) : [];
md += `
## Stronger baselines added after review (no model was re-run)

**Spreadsheet.** The same hourly data in a spreadsheet, the claim fields read by a person, and SUMPRODUCT formulas
(see SPREADSHEET.md and spreadsheet_baseline.xlsx; Excel recalculated the file and agreed on every row, results_spreadsheet_excel.json).
`;
if (sheet) md += `Result: dev ${sheet.sets.dev.correct} / ${sheet.sets.dev.n}, holdout ${sheet.sets.holdout.correct} / ${sheet.sets.holdout.n}.\n`;
md += `
**Hand calculation.** HANDCALC.md works out three claims hour by hour. It is written by handcalc.py, which imports no HourMatch code.
tests/eval.test.mjs checks that the checker gives the same totals.

| id | hour by hour | volume | verdict |
|---|---|---|---|
${hand.map((h) => `| ${h.id} | ${(h.hourly_bps / 100).toFixed(2)}% | ${(h.volume_bps / 100).toFixed(2)}% | ${h.verdict} |`).join("\n")}

**Rule change check.** After review the RE100 rule was corrected to the March 2025 text (15-year limit plus a 15% allowance for older plants).
The truth labels were recomputed with the corrected rule and none changed; the cached model parses rescore to the same verdicts (tests/eval.test.mjs).
The model-alone prompt used the stricter rule without the 15% allowance; on these claims both rules give the same verdicts.

## What this evaluation measures and what it does not

- It measures whether a language model given the hourly table and the rules gets the verdict and the share right, compared with
  letting code do the arithmetic. It does: the model alone is unreliable on 168-row arithmetic.
- The spreadsheet ties HourMatch on every claim once a person has read the claim into fields. The arithmetic is not the hard part.
  What a spreadsheet does not have is a shared state: it trusts its certificate column, and nothing stops the same certificate
  from appearing in two companies' sheets. That part is tested by the contract tests, not by this evaluation.
- Truth labels use the same matching rule as HourMatch by definition. The hand calculation and the spreadsheet check the
  arithmetic independently; they do not check whether the rule is the right policy.
- All companies are fictional, the loads were designed so that certificate volume is a little over 100% of use, and the claims
  were written by the author. Nothing here is measured on real company data.
- The model results come from one run on 2026-10-14 and were not repeated. Typed sentences on the web page are read by keyword
  rules, which are covered only by unit tests (tests/ruleparse.test.mjs).
`;
fs.writeFileSync(path.join(here, "RESULTS.md"), md);
console.log(md.split("\n").slice(0, 14).join("\n"));
