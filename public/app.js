import { buildScenario, CONSUMERS, GENERATORS } from "./lib/scenario.mjs";
import { checkClaim, validateClaim } from "./lib/checker.mjs";
import { generatorOf, hourIso } from "./lib/ledger.mjs";

const $ = (id) => document.getElementById(id);
const pct = (bps) => (bps / 100).toFixed(1) + "%";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const EXAMPLES = [
  "Northbay Fab ran on 100% renewable electricity this week.",
  "Renewable energy certificates purchased by Northbay Fab covered 100% of its electricity consumption this week.",
  "Northbay Fab's night shift (00:00 to 06:00) on 2026-10-09 ran on 100% solar and wind power.",
  "All of Harbor Office's electricity this week was RE100-eligible renewable electricity, matched hour by hour.",
  "Cloudline Data Center matched 90% of its load with renewable electricity on an hourly basis this week.",
];

// theme toggle (per-viewer convenience only)
try {
  const t = localStorage.getItem("hm-theme");
  if (t) document.documentElement.dataset.theme = t;
} catch {}
$("theme").onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("hm-theme", next); } catch {}
};

const [week, meta] = await Promise.all([fetch("lib/week.json").then((r) => r.json()), fetch("lib/meta.json").then((r) => r.json())]);
const scn = buildScenario(week);
const days = [];
for (let i = 0; i < scn.n; i += 24) days.push(scn.hours[i].hour.slice(0, 10));

// ---------- step 1: examples
for (const ex of EXAMPLES) {
  const b = document.createElement("button");
  b.className = "chip";
  b.type = "button";
  b.textContent = ex.length > 64 ? ex.slice(0, 62) + "..." : ex;
  b.title = ex;
  b.onclick = () => { $("claim").value = ex; run(); };
  $("chips").append(b);
}

// ---------- step 2: fields form
const FIELD_DEF = [
  ["consumer_id", "Company", CONSUMERS.map((c) => [c.id, c.name])],
  ["standard", "Judged on", [["hourly", "hour by hour"], ["volume", "certificate volume"], ["unspecified", "not stated (hour by hour)"]]],
  ["start_date", "From", days.map((d) => [d, d])],
  ["end_date", "To", days.map((d) => [d, d])],
  ["hour_from", "Daily from (hour)", null],
  ["hour_to", "Daily to (hour)", null],
  ["claimed_pct", "Claimed %", null],
  ["weekdays_only", "Weekdays only", [["false", "no"], ["true", "yes"]]],
  ["re100", "Says RE100", [["false", "no"], ["true", "yes"]]],
];
for (const [key, label, opts] of FIELD_DEF) {
  const l = document.createElement("label");
  l.textContent = label;
  let el;
  if (opts) {
    el = document.createElement("select");
    for (const [v, t] of opts) el.append(new Option(t, v));
  } else {
    el = document.createElement("input");
    el.type = "number";
    el.min = 0;
    el.max = key === "claimed_pct" ? 100 : 24;
  }
  el.id = "f_" + key;
  el.onchange = () => { $("parseSrc").textContent = "Fields edited by hand."; render(readFields()); };
  l.append(el);
  $("fields").append(l);
}
function setFields(c) {
  for (const [key] of FIELD_DEF) $("f_" + key).value = String(c[key]);
}
function readFields() {
  const v = (k) => $("f_" + k).value;
  return {
    consumer_id: v("consumer_id"), standard: v("standard"), start_date: v("start_date"), end_date: v("end_date"),
    hour_from: Number(v("hour_from")), hour_to: Number(v("hour_to")), claimed_pct: Number(v("claimed_pct")),
    weekdays_only: v("weekdays_only") === "true", re100: v("re100") === "true", claim_year: 2026,
  };
}

// simple fallback parser, used only when the AI step is unavailable
function ruleParse(text) {
  const t = text.toLowerCase();
  const consumer = CONSUMERS.find((c) => t.includes(c.name.replace(" (fictional)", "").toLowerCase().split(" ")[0])) || CONSUMERS[0];
  const dates = [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  const m = t.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  let claimed = m ? Number(m[1]) : /(fully|all of|entirely|every kwh)/.test(t) ? 100 : 100;
  let hf = 0, ht = 24;
  const hm = t.match(/(\d{1,2}):00\s*(?:to|and|-)\s*(\d{1,2}):00/);
  if (hm) { hf = Number(hm[1]); ht = Number(hm[2]) || 24; }
  else if (/night/.test(t)) { hf = 0; ht = 6; }
  else if (/business hours|office hours/.test(t)) { hf = 8; ht = 19; }
  const volume = /(certificate|purchase)[^.]*(cover|equal|total)/.test(t) && !/hour/.test(t);
  const hourly = /(hour by hour|hourly|every hour|24\/7|around the clock|same-hour)/.test(t);
  return {
    consumer_id: consumer.id,
    start_date: dates[0] || days[0], end_date: dates[1] || dates[0] || days.at(-1),
    hour_from: hf, hour_to: ht, weekdays_only: /weekday/.test(t), claimed_pct: Math.min(100, claimed),
    standard: volume ? "volume" : hourly ? "hourly" : "unspecified", re100: /re100/.test(t), claim_year: 2026,
  };
}

async function parse(text) {
  if (meta.cached[text]) return { claim: { ...meta.cached[text], claim_year: 2026 }, src: `AI parse (cached output of ${meta.summary.model}).` };
  try {
    const r = await fetch("api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (r.ok) {
      const j = await r.json();
      const c = { ...j.claim, claim_year: 2026 };
      for (const f of ["hour_from", "hour_to", "claimed_pct"]) c[f] = Number(c[f]);
      c.weekdays_only = c.weekdays_only === true || c.weekdays_only === "true";
      c.re100 = c.re100 === true || c.re100 === "true";
      if (!validateClaim(c).length) return { claim: c, src: `AI parse (live, ${j.model}).` };
    }
  } catch {}
  return { claim: ruleParse(text), src: "AI parse is off on this deployment: simple keyword rules filled the fields. Check them, then edit if needed." };
}

async function run() {
  $("go").disabled = true;
  const text = $("claim").value.trim();
  const { claim, src } = await parse(text);
  setFields(claim);
  $("parseSrc").textContent = src;
  render(readFields());
  $("go").disabled = false;
}
$("go").onclick = run;

// ---------- step 3: verdict + chart
function render(c) {
  const r = checkClaim(scn, c);
  if (!r.ok) {
    $("verdict").innerHTML = `<div class="verdict bad"><div><b>CANNOT CHECK</b><div>${esc(r.errors.join("; "))}</div></div></div>`;
    $("big").innerHTML = "";
    $("chart").innerHTML = "";
    return;
  }
  const good = r.verdict === "SUPPORTED";
  $("verdict").innerHTML = `<div class="verdict ${good ? "good" : "bad"}"><div>
    <b>${good ? "SUPPORTED" : "NOT SUPPORTED"}</b> <span class="muted">judged on ${r.basis === "volume" ? "certificate volume" : "hour-by-hour matching"}</span>
    <div>${good ? "The ledger backs this claim." : esc(r.reasons.join(". ")) + "."}</div>
    <div class="rewrite"><span class="muted">A sentence the ledger supports:</span><br>${esc(r.rewrite)}</div></div></div>`;
  $("big").innerHTML = `
    <div class="stat"><div class="v">${pct(r.volumeBps)}</div><div class="k">on paper: certificates bought / use</div></div>
    <div class="stat"><div class="v">${pct(r.hourlyBps)}</div><div class="k">hour by hour: retired in the same hour / use</div></div>
    <div class="stat"><div class="v">${r.fullyMatchedHours}<span style="font-size:16px"> / ${r.hours} h</span></div><div class="k">hours fully covered by same-hour certificates</div></div>`;
  drawChart(c);
  drawDaily(r);
}

function drawDaily(r) {
  const byDay = new Map();
  for (const h of r.hourly) {
    const d = h.hour.slice(0, 10);
    const x = byDay.get(d) || { use: 0, matched: 0, bought: 0 };
    x.use += h.consumed;
    x.matched += h.matched;
    x.bought += h.bought;
    byDay.set(d, x);
  }
  const mwh = (k) => (k / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  $("daily").innerHTML = `<table><tr><th>Day</th><th>Use, MWh</th><th>On paper</th><th>Hour by hour</th></tr>${[...byDay]
    .map(([d, x]) => `<tr><td class="num">${d.slice(5)}</td><td class="num">${mwh(x.use)}</td><td class="num">${x.use ? ((x.bought / x.use) * 100).toFixed(1) : "0.0"}%</td><td class="num">${x.use ? (Math.floor((x.matched * 10000) / x.use) / 100).toFixed(1) : "0.0"}%</td></tr>`)
    .join("")}</table>`;
}

function drawChart(c) {
  const sel = new Set();
  const allRows = scn.ledger.hourly(c.consumer_id, scn.firstHour, scn.firstHour + BigInt(scn.n));
  const r = checkClaim(scn, c);
  for (const h of r.hourly) sel.add(h.hour);
  // matched kWh per hour per plant
  const byHour = new Map();
  for (const e of scn.ledger.retirementsBy(c.consumer_id)) {
    const key = String(e.hour);
    const m = byHour.get(key) || {};
    const g = GENERATORS.find((x) => x.id === generatorOf(e.id));
    m[g.key] = (m[g.key] || 0) + Number(e.kwh);
    byHour.set(key, m);
  }
  const W = 1000, H = 400, padL = 70, padB = 34, padT = 12;
  const max = Math.max(...allRows.map((x) => Number(x.consumed))) * 1.08 || 1;
  const bw = (W - padL) / allRows.length;
  const y = (v) => H - padB - (v / max) * (H - padB - padT);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly use and matched renewable certificates">`;
  allRows.forEach((row, i) => {
    const x = padL + i * bw;
    const iso = hourIso(row.hour);
    if (!sel.has(iso)) s += `<rect x="${x}" y="${padT}" width="${bw}" height="${H - padB - padT}" fill="var(--night)"/>`;
    s += `<rect x="${x + 0.5}" y="${y(Number(row.consumed))}" width="${Math.max(0.5, bw - 1)}" height="${H - padB - y(Number(row.consumed))}" fill="var(--use)"/>`;
    let base = 0;
    const m = byHour.get(String(row.hour)) || {};
    for (const k of ["solar", "wind", "hydro"]) {
      const v = m[k] || 0;
      if (!v) continue;
      s += `<rect x="${x + 0.5}" y="${y(base + v)}" width="${Math.max(0.5, bw - 1)}" height="${y(base) - y(base + v)}" fill="var(--${k === "solar" ? "sun" : k})"/>`;
      base += v;
    }
  });
  for (let d = 0; d < allRows.length; d += 24) {
    const x = padL + d * bw;
    s += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" stroke="var(--line)"/>`;
    s += `<text x="${x + 4}" y="${H - 8}" font-size="19" fill="var(--muted)" font-family="IBM Plex Mono">${days[d / 24].slice(5)}</text>`;
  }
  const top = Math.round(max / 1.08);
  s += `<text x="${padL - 6}" y="${y(top) + 4}" font-size="17" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono">${(top / 1000).toFixed(0)} MWh</text>`;
  s += `<text x="${padL - 6}" y="${H - padB}" font-size="17" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono">0</text>`;
  s += `</svg>`;
  $("chart").innerHTML = s;
}

// ---------- refusals and evaluation
$("refusals").innerHTML = `<p style="margin-top:0">Strait Wind (fictional) had already sold each hour's full output to Northbay Fab and Cloudline Data Center. It then tried to sell the same hours again to Harbor Office.</p>
  <table><tr><th>Hour (UTC+8)</th><th>Second sale tried</th><th>Ledger answer</th></tr>${scn.log
  .map((l) => `<tr><td class="num">${esc(l.hour.slice(0, 16).replace("T", " "))}</td><td class="num">${l.kwh.toLocaleString()} kWh</td><td class="num">${l.type === "double-sale-rejected" ? "refused (" + esc(l.error) + ")" : "accepted"}</td></tr>`)
  .join("")}</table>`;

const S = meta.summary;
if (S.available) {
  const row = (name, x) => `<tr><td>${name}</td><td class="num">${x.correct} / ${x.n}</td><td class="num">${x.shareWithin1pt} / ${x.n}</td></tr>`;
  $("evalBox").innerHTML = `<p style="margin-top:0">Same model (${esc(S.model)}), same 18 fictional claims about this week. The model alone gets the full hourly table and the exact matching rules in its prompt; HourMatch lets the model only fill in the fields, then the ledger code decides.</p>
  <table><tr><th>Setup</th><th>Correct verdicts</th><th>Share within 1 point</th></tr>
  ${row("HourMatch (model parses, code decides)", S.system)}${row("Model alone, with the same data", S.pure)}
  ${S.holdout ? row("HourMatch, held-out week (22 to 28 Sep)", S.holdout.system) + row("Model alone, held-out week", S.holdout.pure) : ""}</table>
  <p style="font-size:14px">For scale: answering "NOT SUPPORTED" to every dev claim would also get 10 of 18 right. The model alone mostly said no; it rejected 5 of the 8 true claims, and its percentages were off by more than one point in 13 of 18 cases.</p>
  <p class="muted" style="font-size:13px">Run on ${esc(S.date.slice(0, 10))}. Script: eval/run_eval.mjs. Raw answers: eval/results_dev.json.</p>`;
} else {
  $("evalBox").textContent = "Evaluation not run yet.";
}

const dep = meta.deployments.sepolia;
if (dep) {
  const ex = dep.explorer || "https://sepolia.etherscan.io";
  const link = (h, t) => `<a href="${ex}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  const pick = (re) => dep.txs.find((t) => re.test(t.label));
  const rows = [
    ["Certificates issued for one day (Strait Wind, 24 hourly ids)", pick(/^issue generator 2/), "succeeded"],
    ["Northbay Fab retires same-hour certificates", pick(/^retire NORTHBAY/), "succeeded"],
    ["Retire more certificates than are left for that hour", pick(/more than is left/), "refused by the contract"],
    ["Retire again for an hour that is already fully matched", pick(/already fully matched/), "refused by the contract"],
    ["Anchor the claim \"" + dep.anchoredClaim.text + "\"", pick(/^anchor claim/), `stored with ${(dep.anchoredClaim.matchedBps / 100).toFixed(1)}% computed on chain`],
  ].filter((r) => r[1]);
  $("chainBox").innerHTML = `<p style="margin-top:0">Contract <a class="mono" href="${ex}/address/${esc(dep.contract)}" target="_blank" rel="noopener">${esc(dep.contract)}</a> on Ethereum Sepolia testnet (chain id ${esc(dep.chainId || 11155111)}). One demo day, 8 October 2026, written on chain; test money only.</p>
  <table><tr><th>What happened</th><th>Transaction</th><th>Result</th></tr>${rows
    .map((r) => `<tr><td>${esc(r[0])}</td><td class="mono">${link(r[1].hash, r[1].hash.slice(0, 10) + "...")}</td><td>${esc(r[2])}</td></tr>`)
    .join("")}</table>`;
  $("chainInfo").innerHTML = `Contract on Ethereum Sepolia: <span class="mono">${esc(dep.contract)}</span>`;
} else {
  $("chainBox").textContent = "Not deployed yet.";
  $("chainInfo").textContent = "Contract: tested on a local Hardhat chain.";
}

run();
