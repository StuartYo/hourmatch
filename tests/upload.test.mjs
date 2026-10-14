import test from "node:test";
import assert from "node:assert/strict";
import { buildFromCsv, sampleCsv, parseHour, UPLOAD_ID } from "../src/upload.mjs";
import { checkClaim } from "../src/checker.mjs";
import { devScn, claim } from "./helpers.mjs";

const scn = devScn();

test("the sample CSV of each demo company reproduces the demo numbers", () => {
  for (const id of ["NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"]) {
    const s = sampleCsv(scn, id);
    const u = buildFromCsv({ useCsv: s.use, certCsv: s.cert, company: id });
    assert.equal(u.ok, true, JSON.stringify(u.errors));
    const a = checkClaim(scn, claim({ consumer_id: id }));
    const b = checkClaim(u.scn, claim({ consumer_id: UPLOAD_ID }));
    assert.equal(b.hourlyBps, a.hourlyBps, id);
    assert.equal(b.volumeBps, a.volumeBps, id);
    assert.equal(b.consumedKwh, a.consumedKwh, id);
  }
});

test("times are read as Taiwan time unless an offset is given", () => {
  assert.equal(parseHour("2026-10-06 00:00").h, parseHour("2026-10-05T16:00Z").h);
  assert.equal(parseHour("2026/10/6 08:00:00").h, parseHour("2026-10-06T08:00+08:00").h);
  assert.match(parseHour("2026-10-06 08:30").error, /full hour/);
});

test("bad files give row-level errors", () => {
  const r = buildFromCsv({ useCsv: "hour,kwh\n2026-10-06 00:00,abc\n2026-10-06 00:00,5\n", certCsv: "hour,kwh\n" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("row 2")));
  const h = buildFromCsv({ useCsv: "time,usage\n", certCsv: "hour,kwh\n" });
  assert.equal(h.ok, false);
});

test("a tiny hand-checkable upload: surplus in one hour, gap in the other", () => {
  const useCsv = "hour,kwh\n2026-10-06 12:00,100\n2026-10-06 13:00,100\n";
  const certCsv = "hour,kwh,plant,commission_year\n2026-10-06 12:00,150,Roof Solar,2022\n2026-10-06 13:00,50,Roof Solar,2022\n";
  const u = buildFromCsv({ useCsv, certCsv, company: "Test Co" });
  const r = checkClaim(u.scn, claim({ consumer_id: UPLOAD_ID, start_date: "2026-10-06", end_date: "2026-10-06" }));
  assert.equal(r.volumeBps, 10000); // 200 / 200
  assert.equal(r.hourlyBps, 7500); // (100 + 50) / 200
});

test("unknown commission years count as old for RE100", () => {
  const useCsv = "hour,kwh\n2026-10-06 12:00,100\n";
  const certCsv = "hour,kwh,plant\n2026-10-06 12:00,100,Mystery Plant\n";
  const u = buildFromCsv({ useCsv, certCsv });
  const r = checkClaim(u.scn, claim({ consumer_id: UPLOAD_ID, start_date: "2026-10-06", end_date: "2026-10-06", re100: true }));
  assert.equal(r.verdict, "NOT_SUPPORTED");
  assert.equal(r.re100.hourlyBps, 1500);
});
