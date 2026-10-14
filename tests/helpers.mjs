import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario, CONSUMERS } from "../src/scenario.mjs";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8").replace(/^﻿/, ""));
export const devScn = () => buildScenario(readJson("data/taipower_hourly_2026-10-06_7d.json"));
export const holdScn = () => buildScenario(readJson("data/taipower_hourly_2026-09-22_7d.json"));
export const daysOf = (scn) => {
  const d = [];
  for (let i = 0; i < scn.n; i += 24) d.push(scn.hours[i].hour.slice(0, 10));
  return d;
};
export const claim = (o) => ({
  start_date: "2026-10-06",
  end_date: "2026-10-12",
  hour_from: 0,
  hour_to: 24,
  weekdays_only: false,
  claimed_pct: 100,
  standard: "unspecified",
  re100: false,
  claim_year: 2026,
  ...o,
});
export { CONSUMERS };
