import test from "node:test";
import assert from "node:assert/strict";
import { checkClaim } from "../src/checker.mjs";
import { buildScenario } from "../src/scenario.mjs";
import { loadWeek, instantiate } from "../eval/run_eval.mjs";
import { sheetRows, sheetVerdict, claimRows } from "../eval/spreadsheet_baseline.mjs";
import { devScn, readJson } from "./helpers.mjs";

test("three independent hand calculations agree with the checker", () => {
  const scn = devScn();
  const hc = readJson("eval/handcalc.json");
  assert.equal(hc.length, 3);
  for (const h of hc) {
    const r = checkClaim(scn, {
      consumer_id: h.consumer, start_date: h.date_from, end_date: h.date_to, hour_from: h.hour_from, hour_to: h.hour_to,
      weekdays_only: false, claimed_pct: h.claimed_pct, standard: h.basis, re100: false, claim_year: 2026,
    });
    assert.equal(r.consumedKwh, h.use_kwh, h.id);
    assert.equal(r.matchedKwh, h.matched_kwh, h.id);
    assert.equal(r.hourlyBps, h.hourly_bps, h.id);
    assert.equal(r.volumeBps, h.volume_bps, h.id);
    assert.equal(r.verdict, h.verdict, h.id);
  }
});

test("stored evaluation: truths still hold with the current checker, and cached parses rescore the same", () => {
  const claims = readJson("eval/claims.json");
  for (const set of ["dev", "holdout"]) {
    const scn = buildScenario(loadWeek(set));
    const stored = readJson(`eval/results_${set}.json`);
    for (const it of claims[set]) {
      const inst = instantiate(scn, it);
      const row = stored.rows.find((r) => r.id === it.id);
      assert.equal(inst.truth.verdict, row.truth, `${set} ${it.id} truth`);
      const r = checkClaim(scn, { ...row.system.parsed, claim_year: 2026 });
      assert.equal(r.verdict, row.system.verdict, `${set} ${it.id} system`);
    }
  }
});

test("spreadsheet baseline (SUMPRODUCT) gets every claim right given hand-read fields; Excel agrees", () => {
  const claims = readJson("eval/claims.json");
  const excel = readJson("eval/results_spreadsheet_excel.json");
  for (const set of ["dev", "holdout"]) {
    const scn = buildScenario(loadWeek(set));
    const rows = sheetRows(scn);
    for (const q of claimRows(scn, claims[set])) {
      const v = sheetVerdict(rows, q);
      assert.equal(v.verdict, q.truth, `${set} ${q.id}`);
      const x = excel.find((e) => e.set === set && e.id === q.id);
      assert.equal(x.verdict, v.verdict, `excel ${set} ${q.id}`);
      assert.equal(x.hourly, v.hourly_bps, `excel ${set} ${q.id}`);
    }
  }
});
