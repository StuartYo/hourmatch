// Evaluation: HourMatch (model parses, code decides) vs. the same model alone with the same data.
// Usage: node eval/run_eval.mjs dev|holdout [system|pure|both]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario, GENERATORS, CONSUMERS } from "../src/scenario.mjs";
import { checkClaim } from "../src/checker.mjs";
import { parseClaim } from "../src/parse.mjs";
import { chat, extractJson, LLM_MODEL } from "../src/llm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
export const WEEKS = { dev: "taipower_hourly_2026-10-06_7d.json", holdout: "taipower_hourly_2026-09-22_7d.json" };

export function loadWeek(set) {
  return JSON.parse(fs.readFileSync(path.join(root, "data", WEEKS[set]), "utf8"));
}

function days(scn) {
  const out = [];
  for (let i = 0; i < scn.n; i += 24) out.push(scn.hours[i].hour.slice(0, 10));
  return out;
}

function fill(template, vars) {
  return template.replace(/\{(d\d|H|V)(\+(\d+))?\}/g, (_, name, __, add) => {
    if (name.startsWith("d")) return vars[name];
    const v = vars[name] + (add ? Number(add) : 0);
    return String(Math.min(100, v));
  });
}

export function instantiate(scn, item) {
  const ds = days(scn);
  const dvars = Object.fromEntries(ds.map((d, i) => [`d${i + 1}`, d]));
  const g = { ...item.gold, start_date: dvars[item.gold.start], end_date: dvars[item.gold.end], claim_year: 2026 };
  delete g.start;
  delete g.end;
  // base numbers from the gold claim at 100% to get H and V
  const probe = checkClaim(scn, { ...g, claimed_pct: 0 });
  const vars = { ...dvars, H: Math.floor(probe.hourlyBps / 100), V: Math.floor(probe.volumeBps / 100) };
  if (typeof g.claimed_pct === "string") {
    const m = g.claimed_pct.match(/^(H|V)(\+(\d+))?$/);
    g.claimed_pct = Math.min(100, vars[m[1]] + (m[3] ? Number(m[3]) : 0));
  }
  const text = fill(item.text, vars);
  const truth = checkClaim(scn, g);
  return { id: item.id, text, gold: g, truth };
}

function dataTable(scn, consumerId) {
  const lines = ["hour (UTC+8) | use kWh | certificates held for this hour, kWh: " + GENERATORS.map((g) => g.key).join(" / ")];
  for (let i = 0; i < scn.n; i++) {
    const per = GENERATORS.map((g) => scn.bought[consumerId]?.[g.id]?.[i] ?? 0);
    lines.push(`${scn.hours[i].hour.slice(0, 16).replace("T", " ")} | ${scn.consumption[consumerId][i]} | ${per.join(" / ")}`);
  }
  return lines.join("\n");
}

export function purePrompt(scn, inst) {
  const c = CONSUMERS.find((x) => x.id === inst.gold.consumer_id);
  const plants = GENERATORS.map((g) => `- ${g.key}: ${g.name}, commissioned ${g.commissionYear}`).join("\n");
  return [
    { role: "system", content: "You are an auditor of corporate green-electricity claims. Answer with one JSON object only." },
    {
      role: "user",
      content: `Rules:
1. A renewable certificate only counts against electricity used in the SAME hour. Certificates left over in one hour cannot cover another hour.
2. Hour-by-hour share = (sum over the claim's hours of min(use, certificates held that hour)) / (sum of use in those hours).
3. Volume share = (sum of certificates held in the claim's hours) / (sum of use in those hours).
4. If the claim explicitly talks about certificates or purchases covering/equal to a share of consumption, judge it on volume share. Otherwise judge it on hour-by-hour share.
5. If the claim says RE100, every plant whose certificates were used in the claim's hours must have been commissioned within 15 years of 2026 (2011 or later); otherwise the claim is NOT_SUPPORTED.
6. A claim is SUPPORTED if the claimed percentage is at most the relevant share plus 0.5 percentage points, and rule 5 is not broken. Otherwise NOT_SUPPORTED.
7. Weekdays are Monday to Friday. "Business hours" are 08:00 to 19:00. Hours run from HH:00 to HH:59.

Plants:
${plants}

Company: ${c.name} (${c.profile})
Hourly data for the whole week:
${dataTable(scn, c.id)}

Claim: """${inst.text}"""

Return JSON: {"verdict": "SUPPORTED" or "NOT_SUPPORTED", "basis": "hourly" or "volume", "share_pct": number with one decimal, "reason": short string}`,
    },
  ];
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function main() {
  const set = process.argv[2] || "dev";
  const mode = process.argv[3] || "both";
  const claims = JSON.parse(fs.readFileSync(path.join(here, "claims.json"), "utf8"))[set];
  const scn = buildScenario(loadWeek(set));
  const insts = claims.map((it) => instantiate(scn, it));
  const range = { firstDate: days(scn)[0], lastDate: days(scn).at(-1) };

  const rows = await pool(insts, 2, async (inst) => {
    const row = { id: inst.id, text: inst.text, truth: inst.truth.verdict, truthBasis: inst.truth.basis, truthShare: (inst.truth.basis === "volume" ? inst.truth.volumeBps : inst.truth.hourlyBps) / 100 };
    if (mode !== "pure") {
      try {
        const p = await parseClaim(inst.text, range);
        if (!p.ok) row.system = { verdict: "PARSE_ERROR", errors: p.errors };
        else {
          const r = checkClaim(scn, p.claim);
          row.system = r.ok
            ? { verdict: r.verdict, share: (r.basis === "volume" ? r.volumeBps : r.hourlyBps) / 100, parsed: p.claim }
            : { verdict: "CHECK_ERROR", errors: r.errors, parsed: p.claim };
        }
      } catch (e) {
        row.system = { verdict: "API_ERROR", error: String(e.message || e) };
      }
    }
    if (mode !== "system") {
      try {
        const r = await chat(purePrompt(scn, inst), { maxTokens: 400 });
        const j = extractJson(r.text);
        row.pure = j ? { verdict: j.verdict, share: Number(j.share_pct), basis: j.basis } : { verdict: "NOT_JSON", raw: r.text.slice(0, 200) };
      } catch (e) {
        row.pure = { verdict: "API_ERROR", error: String(e.message || e) };
      }
    }
    process.stderr.write(`${inst.id} truth=${row.truth} sys=${row.system?.verdict} pure=${row.pure?.verdict}\n`);
    return row;
  });

  const score = (key) => {
    const answered = rows.filter((r) => r[key]);
    const correct = answered.filter((r) => r[key].verdict === r.truth).length;
    const shareOk = answered.filter((r) => Number.isFinite(r[key].share) && Math.abs(r[key].share - r.truthShare) <= 1).length;
    return { n: answered.length, correct, shareWithin1pt: shareOk };
  };
  const result = { set, model: LLM_MODEL, date: new Date().toISOString(), system: score("system"), pure: score("pure"), rows };
  fs.writeFileSync(path.join(here, `results_${set}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ set, system: result.system, pure: result.pure }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
