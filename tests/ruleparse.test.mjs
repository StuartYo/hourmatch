import test from "node:test";
import assert from "node:assert/strict";
import { ruleParse, findWindow } from "../src/ruleparse.mjs";
import { devScn, daysOf, CONSUMERS } from "./helpers.mjs";

const ctx = { consumers: CONSUMERS, days: daysOf(devScn()) };

test("an unknown company is an error, never a default company", () => {
  const r = ruleParse("Acme Steel ran on 100% renewable power this week.", ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no known company/);
});

test("time windows: 9 to 18, between, am/pm, colon forms", () => {
  assert.deepEqual(findWindow("ran on solar from 9 to 18 every weekday"), { from: 9, to: 18 });
  assert.deepEqual(findWindow("ran on solar 9 to 18"), { from: 9, to: 18 });
  assert.deepEqual(findWindow("between 9 and 18"), { from: 9, to: 18 });
  assert.deepEqual(findWindow("9am to 6pm"), { from: 9, to: 18 });
  assert.deepEqual(findWindow("09:00-18:00 on 2026-10-07"), { from: 9, to: 18 });
  assert.deepEqual(findWindow("from 18:00 to midnight"), { from: 18, to: 24 });
  assert.equal(findWindow("100% renewable on 2026-10-07"), null);
});

test("unsupported windows say so instead of being ignored", () => {
  assert.match(findWindow("from 22:00 to 06:00").error, /crosses midnight/);
  assert.match(findWindow("9:30 to 18:00").error, /full hour/);
});

test("reviewer case: Harbor Office 9 to 18 on weekdays", () => {
  const r = ruleParse("Harbor Office ran on 95% renewable power from 9 to 18 on weekdays.", ctx);
  assert.equal(r.ok, true);
  assert.equal(r.claim.consumer_id, "HARBOR-OFFICE");
  assert.equal(r.claim.hour_from, 9);
  assert.equal(r.claim.hour_to, 18);
  assert.equal(r.claim.weekdays_only, true);
  assert.equal(r.claim.claimed_pct, 95);
});

test("volume wording, dates and RE100", () => {
  const r = ruleParse("Certificates bought by Cloudline Data Center covered 100% of its use on 2026-10-11, RE100-eligible.", ctx);
  assert.equal(r.claim.standard, "volume");
  assert.equal(r.claim.start_date, "2026-10-11");
  assert.equal(r.claim.end_date, "2026-10-11");
  assert.equal(r.claim.re100, true);
  const m = ruleParse("Northbay Fab was 100% renewable on 8 October.", ctx);
  assert.equal(m.claim.start_date, "2026-10-08");
});
