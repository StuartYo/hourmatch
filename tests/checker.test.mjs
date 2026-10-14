import test from "node:test";
import assert from "node:assert/strict";
import { checkClaim, pctText } from "../src/checker.mjs";
import { devScn, claim } from "./helpers.mjs";

const scn = devScn();

test("percentages are rounded half up to one decimal, not floored", () => {
  assert.equal(pctText(8193), "81.9%");
  assert.equal(pctText(8196), "82.0%");
  assert.equal(pctText(8303), "83.0%");
  assert.equal(pctText(10000), "100.0%");
});

test("headline numbers: 103% on paper, 83.0% hour by hour", () => {
  const r = checkClaim(scn, claim({ consumer_id: "NORTHBAY-FAB" }));
  assert.equal(r.volumeBps, 10300);
  assert.equal(r.hourlyBps, 8303);
  assert.equal(r.verdict, "NOT_SUPPORTED");
});

test("a SUPPORTED volume claim gets a rewrite on the volume basis, not the hourly number", () => {
  const r = checkClaim(scn, claim({ consumer_id: "NORTHBAY-FAB", standard: "volume" }));
  assert.equal(r.verdict, "SUPPORTED");
  assert.match(r.rewrite, /^Certificates bought for .* equal 103\.0% of its use in total\./);
  assert.match(r.rewrite, /Matched hour by hour, the share is 83\.0%\./);
});

test("an hourly rewrite states the hourly share it was judged on", () => {
  const r = checkClaim(scn, claim({ consumer_id: "HARBOR-OFFICE", standard: "hourly" }));
  assert.equal(r.hourlyBps, 8193);
  assert.match(r.rewrite, /^81\.9% of Harbor Office/);
  assert.ok(r.reasons[0].includes("81.9%"));
});

test("every rewrite number is within rounding of the share on the claim's basis", () => {
  for (const consumer_id of ["NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"])
    for (const standard of ["hourly", "volume"])
      for (const re100 of [false, true]) {
        const r = checkClaim(scn, claim({ consumer_id, standard, re100, claimed_pct: 50 }));
        const shown = Math.round(Number(r.rewrite.match(/(\d+\.\d)%/)[1]) * 100);
        const basisBps = r.re100 ? (standard === "volume" ? r.re100.volumeBps : r.re100.hourlyBps) : standard === "volume" ? r.volumeBps : r.hourlyBps;
        assert.ok(Math.abs(shown - basisBps) <= 5, `${consumer_id} ${standard} ${re100}: ${shown} vs ${basisBps}`);
      }
});

test("RE100: plants older than 15 years may cover at most 15% of use", () => {
  const r = checkClaim(scn, claim({ consumer_id: "HARBOR-OFFICE", standard: "volume", re100: true }));
  assert.equal(r.verdict, "NOT_SUPPORTED");
  assert.ok(r.re100.oldBoughtBps > 1500);
  assert.ok(r.re100.volumeBps < r.volumeBps);
  assert.ok(r.reasons.some((x) => x.includes("Old Creek Hydro") && x.includes("15%")));
  const nb = checkClaim(scn, claim({ consumer_id: "NORTHBAY-FAB", standard: "volume", re100: true }));
  assert.equal(nb.verdict, "SUPPORTED");
  assert.equal(nb.re100.volumeBps, nb.volumeBps);
});

test("unknown company and empty periods cannot be checked", () => {
  assert.equal(checkClaim(scn, claim({ consumer_id: "ACME" })).ok, false);
  assert.equal(checkClaim(scn, claim({ consumer_id: "NORTHBAY-FAB", start_date: "2027-01-01", end_date: "2027-01-02" })).ok, false);
});
