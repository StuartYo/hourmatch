import { buildScenario } from "./lib/scenario.mjs";
import { checkClaim, validateClaim, pctText, RE100_MAX_AGE_YEARS } from "./lib/checker.mjs";
import { generatorOf, hourIso } from "./lib/ledger.mjs";
import { ruleParse } from "./lib/ruleparse.mjs";
import { buildFromCsv, UPLOAD_ID } from "./lib/upload.mjs";
import { EXAMPLES } from "./lib/examples.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Number(n).toLocaleString("en-US");
// table helper: on phones, class "stack" turns each row into a small card and shows the column name
const tbl = (heads, rows, cls = "stack") =>
  `<table class="${cls}"><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c, i) => (typeof c === "object" ? `<td class="${c.cls || ""}" data-l="${esc(c.l ?? strip(heads[i]))}">${c.v}</td>` : `<td data-l="${esc(strip(heads[i]))}">${c}</td>`)).join("")}</tr>`)
    .join("")}</table>`;
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const NAMES = { "NORTHBAY-FAB": "Northbay Fab", "HARBOR-OFFICE": "Harbor Office", "CLOUDLINE-DC": "Cloudline Data Center" };
const nice = (s) => String(s).replace(/NORTHBAY-FAB|HARBOR-OFFICE|CLOUDLINE-DC/g, (m) => NAMES[m]).replace(/^a company wallet/, "Northbay's wallet");
const PALETTE = ["--sun", "--wind", "--hydro", "--p4", "--p5", "--p6"];

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
const demo = buildScenario(week);
let scn = demo;
let lastResult = null;
const daysOf = (s) => [...new Set(s.hours.map((h) => h.hour.slice(0, 10)))];
let days = daysOf(scn);
const colorOf = (g, i) => {
  const t = (g.key + " " + g.name).toLowerCase();
  if (/solar|sun|pv/.test(t)) return "--sun";
  if (/wind/.test(t)) return "--wind";
  if (/hydro|water|river|creek/.test(t)) return "--hydro";
  return ["--p4", "--p5", "--p6"][i % 3];
};
const S = meta.summary;
const runDate = new Date(S.date);
const runText = `${runDate.toISOString().slice(0, 10)} ${runDate.toISOString().slice(11, 16)} UTC`;

// ---------- step 1: examples (full text, wrapped)
function drawChips() {
  $("chips").innerHTML = "";
  const list =
    scn.source === "demo"
      ? EXAMPLES.map((t) => ({ t, note: "model parse cached on " + runText.slice(0, 10) }))
      : [
          { t: `${scn.consumers[0].name} ran on 100% renewable electricity.`, note: "keyword rules" },
          { t: `Certificates bought by ${scn.consumers[0].name} covered 100% of its electricity use.`, note: "keyword rules" },
          { t: `${scn.consumers[0].name} ran on 100% renewable electricity from 9 to 18 on weekdays.`, note: "keyword rules" },
        ];
  for (const { t, note } of list) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.innerHTML = `${esc(t)}<small>${esc(note)}</small>`;
    b.onclick = () => {
      $("claim").value = t;
      run();
    };
    $("chips").append(b);
  }
}

// ---------- step 2: fields form
const FIELD_KEYS = ["consumer_id", "standard", "start_date", "end_date", "hour_from", "hour_to", "claimed_pct", "weekdays_only", "re100"];
function drawFields() {
  const def = [
    ["consumer_id", "Company", [["", "(no company recognised)"], ...scn.consumers.map((c) => [c.id, c.name])]],
    ["standard", "Judged on", [["hourly", "hour by hour"], ["volume", "certificate volume"], ["unspecified", "not stated (hour by hour)"]]],
    ["start_date", "From", days.map((d) => [d, d])],
    ["end_date", "To", days.map((d) => [d, d])],
    ["hour_from", "Daily from (hour)", null],
    ["hour_to", "Daily to (hour)", null],
    ["claimed_pct", "Claimed %", null],
    ["weekdays_only", "Weekdays only", [["false", "no"], ["true", "yes"]]],
    ["re100", "Says RE100", [["false", "no"], ["true", "yes"]]],
  ];
  $("fields").innerHTML = "";
  for (const [key, label, opts] of def) {
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
    el.onchange = () => {
      $("parseSrc").innerHTML = "Fields edited by hand.";
      render(readFields());
    };
    l.append(el);
    $("fields").append(l);
  }
}
function setFields(c) {
  for (const key of FIELD_KEYS) if (c[key] !== undefined) $("f_" + key).value = String(c[key]);
}
function readFields() {
  const v = (k) => $("f_" + k).value;
  return {
    consumer_id: v("consumer_id"), standard: v("standard"), start_date: v("start_date"), end_date: v("end_date"),
    hour_from: Number(v("hour_from")), hour_to: Number(v("hour_to")), claimed_pct: Number(v("claimed_pct")),
    weekdays_only: v("weekdays_only") === "true", re100: v("re100") === "true", claim_year: 2026,
  };
}

// Sentence -> fields. The five demo examples use a model parse made in advance and cached in this page;
// everything else is read by keyword rules in the browser. There is no live AI call.
function parse(text) {
  if (scn.source === "demo" && meta.cached[text]) {
    const c = { ...meta.cached[text], claim_year: 2026 };
    if (!validateClaim(c, scn.consumers).length)
      return { ok: true, claim: c, src: `<b>Cached model parse.</b> This example was parsed in advance by ${esc(S.model)} (${esc(S.provider)}, temperature 0) on ${esc(runText)}, during the evaluation run. The page shows that stored output; no model is called now.` };
  }
  const r = ruleParse(text, { consumers: scn.consumers, days });
  const notes = r.notes.length ? `<ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  return { ...r, src: `<b>Keyword rules, in your browser.</b> Typed sentences are not sent to any AI model. Check the fields and edit them if needed.${notes}` };
}

function cannot(msgs) {
  $("verdict").innerHTML = `<div class="verdict bad"><b class="v">CANNOT CHECK</b><ul class="small" style="margin:6px 0 0">${msgs.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`;
  $("big").innerHTML = "";
  $("chart").innerHTML = "";
  $("legend").innerHTML = "";
  $("daily").innerHTML = "";
  lastResult = null;
}

function run() {
  const text = $("claim").value.trim();
  if (!text) return cannot(["type a claim first"]);
  const p = parse(text);
  $("parseSrc").innerHTML = p.src;
  if (!p.ok) {
    if (p.claim) setFields(p.claim);
    return cannot(p.errors);
  }
  setFields(p.claim);
  render(readFields());
}
$("go").onclick = run;

// ---------- step 3: verdict, numbers, chart, daily table
function render(c) {
  const r = checkClaim(scn, c);
  if (!r.ok) return cannot(r.errors);
  lastResult = { c, r };
  const good = r.verdict === "SUPPORTED";
  const basis = r.basis === "volume" ? "certificate volume" : "hour-by-hour matching";
  $("verdict").innerHTML = `<div class="verdict ${good ? "good" : "bad"}">
    <b class="v">${good ? "SUPPORTED" : "NOT SUPPORTED"}</b> <span class="muted small">judged on ${basis}${c.re100 ? ", RE100 plant-age rule" : ""}</span>
    <div class="small">${good ? "The ledger backs this claim on that basis." : esc(r.reasons.join(". ")) + "."}</div>
    <div class="rewrite"><span class="muted">A sentence the ledger supports, on the same basis:</span><br>${esc(r.rewrite)}</div></div>`;
  $("big").innerHTML = `
    <div class="stat"><div class="v">${pctText(r.volumeBps)}</div><div class="k">on paper: certificates bought / use</div></div>
    <div class="stat"><div class="v">${pctText(r.hourlyBps)}</div><div class="k">hour by hour: retired in the same hour / use</div></div>
    <div class="stat"><div class="v">${r.fullyMatchedHours}<span> / ${r.hours} h</span></div><div class="k">hours fully covered by same-hour certificates</div></div>`;
  drawChart(c, r);
  drawDaily(r);
}

function dailyRows(r) {
  const byDay = new Map();
  for (const h of r.hourly) {
    const d = h.hour.slice(0, 10);
    const x = byDay.get(d) || { use: 0, matched: 0, bought: 0 };
    x.use += h.consumed;
    x.matched += h.matched;
    x.bought += h.bought;
    byDay.set(d, x);
  }
  return [...byDay];
}
function dailyTable(r) {
  const mwh = (k) => (k / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const bps = (a, b) => (b ? Math.floor((a * 10000) / b) : 0);
  return `<table><tr><th>Day</th><th>Use, MWh</th><th>On paper</th><th>Hour by hour</th></tr>${dailyRows(r)
    .map(([d, x]) => `<tr><td class="num">${d}</td><td class="num">${mwh(x.use)}</td><td class="num">${pctText(bps(x.bought, x.use))}</td><td class="num">${pctText(bps(x.matched, x.use))}</td></tr>`)
    .join("")}</table>`;
}
function drawDaily(r) {
  const rows = dailyRows(r);
  $("daily").innerHTML = rows.length > 31 ? `<p class="small muted">${rows.length} days in this period; the printable report lists every day.</p>` : dailyTable(r);
}

function chartSvg(c, r) {
  const sel = new Set(r.hourly.map((h) => h.hour));
  const allRows = scn.ledger.hourly(c.consumer_id, scn.firstHour, scn.firstHour + BigInt(scn.n));
  const byHour = new Map();
  for (const e of scn.ledger.retirementsBy(c.consumer_id)) {
    const key = String(e.hour);
    const m = byHour.get(key) || {};
    const gid = generatorOf(e.id);
    m[gid] = (m[gid] || 0) + Number(e.kwh);
    byHour.set(key, m);
  }
  const W = 1000, H = 400, padL = 70, padB = 34, padT = 12;
  const max = Math.max(...allRows.map((x) => Number(x.consumed))) * 1.08 || 1;
  const bw = (W - padL) / allRows.length;
  const y = (v) => H - padB - (v / max) * (H - padB - padT);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly use and same-hour renewable certificates">`;
  allRows.forEach((row, i) => {
    const x = padL + i * bw;
    if (!sel.has(hourIso(row.hour))) s += `<rect x="${x}" y="${padT}" width="${bw}" height="${H - padB - padT}" fill="var(--night)"/>`;
    s += `<rect x="${x + 0.5}" y="${y(Number(row.consumed))}" width="${Math.max(0.5, bw - 1)}" height="${H - padB - y(Number(row.consumed))}" fill="var(--use)"/>`;
    let base = 0;
    const m = byHour.get(String(row.hour)) || {};
    scn.generators.forEach((g, gi) => {
      const v = m[g.id] || 0;
      if (!v) return;
      s += `<rect x="${x + 0.5}" y="${y(base + v)}" width="${Math.max(0.5, bw - 1)}" height="${y(base) - y(base + v)}" fill="var(${colorOf(g, gi)})"/>`;
      base += v;
    });
  });
  const nd = Math.ceil(allRows.length / 24);
  const step = Math.max(1, Math.ceil(nd / 8));
  for (let d = 0; d < allRows.length; d += 24) {
    const x = padL + d * bw;
    s += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" stroke="var(--line)"/>`;
    if ((d / 24) % step === 0) s += `<text x="${x + 4}" y="${H - 8}" font-size="19" fill="var(--muted)" font-family="IBM Plex Mono">${hourIso(scn.firstHour + BigInt(d)).slice(5, 10)}</text>`;
  }
  const top = Math.round(max / 1.08);
  const unit = top >= 10000 ? [(top / 1000).toFixed(0), "MWh"] : [fmt(top), "kWh"];
  s += `<text x="${padL - 6}" y="${y(top) + 6}" font-size="17" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono">${unit[0]}</text>`;
  s += `<text x="${padL - 6}" y="${y(top) + 26}" font-size="15" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono">${unit[1]}</text>`;
  s += `<text x="${padL - 6}" y="${H - padB}" font-size="17" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono">0</text>`;
  return s + `</svg>`;
}
function legendHtml(c) {
  const used = new Set(scn.ledger.retirementsBy(c.consumer_id).map((e) => generatorOf(e.id)));
  const plants = scn.generators
    .filter((g) => used.has(g.id))
    .map((g, i) => `<span><i style="background:var(${colorOf(g, i)})"></i>matched by ${esc(g.name.replace(" (fictional)", ""))}</span>`)
    .join("");
  return `<span><i style="background:var(--use)"></i>use NOT matched in the same hour</span>${plants}<span><i style="background:var(--night);border:1px solid var(--line)"></i>outside the claim period</span>`;
}
function drawChart(c, r) {
  $("chart").innerHTML = chartSvg(c, r);
  $("legend").innerHTML = legendHtml(c);
}

// ---------- printable report (browser print dialog -> Save as PDF)
$("printBtn").onclick = () => {
  if (!lastResult) return;
  const { c, r } = lastResult;
  const company = scn.consumers.find((x) => x.id === c.consumer_id).name;
  const plants = scn.generators
    .map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.yearKnown === false ? "unknown (counted as old for RE100)" : g.commissionYear}</td></tr>`)
    .join("");
  $("report").innerHTML = `<h1>HourMatch report</h1>
    <p class="muted">Generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC in the browser. Data: ${scn.source === "demo" ? "HourMatch demo week (fictional companies and plants, real Taipower output curves)" : "files provided by the user, read locally"}. ${scn.source === "demo" ? "" : "Nothing was uploaded or written on chain."}</p>
    <h3>Claim</h3><p>${esc($("claim").value)}</p>
    <table><tr><th>Company</th><td>${esc(company)}</td><th>Period</th><td>${esc(c.start_date)} to ${esc(c.end_date)}, ${c.hour_from}:00 to ${c.hour_to}:00${c.weekdays_only ? ", weekdays" : ""} (UTC+8)</td></tr>
    <tr><th>Claimed</th><td>${c.claimed_pct}%</td><th>Basis</th><td>${r.basis === "volume" ? "certificate volume" : "hour by hour"}${c.re100 ? ", RE100" : ""}</td></tr></table>
    ${$("verdict").innerHTML}
    <div class="big">${$("big").innerHTML}</div>
    <div class="chartScroll">${chartSvg(c, r)}</div><div class="legend">${legendHtml(c)}</div>
    <h3>Per day</h3>${dailyTable(r)}
    <h3>Plants</h3><table><tr><th>Plant</th><th>Commissioned</th></tr>${plants}</table>
    <h3>Method</h3><p class="small">A certificate counts only against use in the same hour. Hour-by-hour share = sum over hours of min(use, same-hour certificates) / sum of use. Volume share = certificates bought / use. A claim holds if it is at most 0.5 points above the share on its basis. RE100: plants commissioned more than ${RE100_MAX_AGE_YEARS} years before the claim year may cover at most 15% of use (RE100 Technical Criteria, March 2025, section 4.2; exempt procurement types are not modelled). Percentages are rounded to one decimal.</p>
    <p class="small muted">https://hourmatch.vercel.app</p>`;
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
};

// ---------- data source tabs and upload
function useScenario(next, claimText) {
  scn = next;
  days = daysOf(scn);
  drawChips();
  drawFields();
  $("refusalPanel").hidden = scn.source !== "demo";
  $("claim").value = claimText;
  run();
}
$("tabDemo").onclick = () => {
  $("tabDemo").setAttribute("aria-selected", "true");
  $("tabUpload").setAttribute("aria-selected", "false");
  $("uploadPanel").hidden = true;
  if (scn !== demo) useScenario(demo, EXAMPLES[0]);
};
$("tabUpload").onclick = () => {
  $("tabUpload").setAttribute("aria-selected", "true");
  $("tabDemo").setAttribute("aria-selected", "false");
  $("uploadPanel").hidden = false;
};
const readFile = (input) => (input.files[0] ? input.files[0].text() : Promise.resolve(null));
$("upGo").onclick = async () => {
  const [useCsv, certCsv] = await Promise.all([readFile($("upUse")), readFile($("upCert"))]);
  if (!useCsv || !certCsv) {
    $("upMsg").innerHTML = `<span class="warn">Choose both files first.</span>`;
    return;
  }
  const res = buildFromCsv({ useCsv, certCsv, company: $("upName").value });
  if (!res.ok) {
    $("upMsg").innerHTML = `<span class="warn">Could not read the files:</span><ul class="warn">${res.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    return;
  }
  const s = res.scn;
  const total = s.consumption[UPLOAD_ID].reduce((a, b) => a + b, 0);
  $("upMsg").innerHTML = `Read ${fmt(s.n)} hours (${esc(hourIso(s.firstHour).slice(0, 16).replace("T", " "))} to ${esc(hourIso(s.firstHour + BigInt(s.n - 1)).slice(0, 16).replace("T", " "))}, UTC+8), ${fmt(total)} kWh of use, ${s.generators.length} plant(s).${res.warnings.map((w) => `<br><span class="warn">${esc(w)}</span>`).join("")}`;
  useScenario(s, `${s.consumers[0].name} ran on 100% renewable electricity.`);
};

// ---------- refusals in the demo week (browser ledger)
$("refusals").innerHTML = `<p class="small" style="margin-top:0">Strait Wind (fictional) had already sold each hour's full output to Northbay Fab and Cloudline Data Center. It then tried to sell the same hours again to Harbor Office.</p>
  ${tbl(
    ["Hour (UTC+8)", "Second sale tried", "Ledger answer"],
    demo.log.map((l) => [
      { v: esc(l.hour.slice(0, 16).replace("T", " ")), cls: "num" },
      { v: fmt(l.kwh) + " kWh", cls: "num" },
      l.type === "double-sale-rejected" ? `<span class="no">refused</span> <span class="mono">${esc(l.error)}</span>` : "accepted",
    ])
  )}`;

// ---------- chain panel
const dep = meta.deployment;
const ex = dep.explorer;
const short = (a) => a.slice(0, 6) + "..." + a.slice(-4);
const ROLE_NAME = {
  operator: "Operator (issuer list, company wallets, meter data)",
  "issuer-a": "Issuer A (Sunfield Solar, Old Creek Hydro)",
  "issuer-b": "Issuer B (Strait Wind)",
  "NORTHBAY-FAB": "Northbay Fab",
  "HARBOR-OFFICE": "Harbor Office",
  "CLOUDLINE-DC": "Cloudline Data Center",
};
const txLink = (h) => (h ? `<a class="mono" href="${ex}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 10))}...</a>` : "");
const shown = dep.txs.filter((t) => !t.label.startsWith("fund ") && !t.label.startsWith("bind ") && !t.label.startsWith("add Issuer") && !/ registers /.test(t.label) && t.label !== "deploy contract");
const govCount = dep.txs.length - shown.length;
$("chainBox").innerHTML = `<p class="small" style="margin-top:0">Contract <a class="mono" href="${ex}/address/${esc(dep.contract)}" target="_blank" rel="noopener">${esc(dep.contract)}</a> on Ethereum Sepolia (chain id ${dep.chainId}). Source code verified on <a href="${esc(dep.sourcify.url)}" target="_blank" rel="noopener">Sourcify</a> (exact match). One demo day, ${esc(dep.day.date)}, is written on chain with six separate test wallets; the other six days of the week exist only in the browser ledger. Test ETH only.</p>
  <h3>Wallets</h3>
  ${tbl(
    ["Role", "Address"],
    Object.entries(dep.wallets).map(([k, a]) => [esc(ROLE_NAME[k] || k), `<a class="mono nowrap" href="${ex}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`]),
    ""
  )}
  <h3>What happened on ${esc(dep.day.date)}</h3>
  <p class="small muted">Not listed: ${govCount} setup transactions (deployment, funding the test wallets, adding the two issuers, binding each company to its wallet, registering plants). All are in deployments/sepolia.json.</p>
  ${tbl(
    ["What happened", "From", "Transaction", "Result"],
    shown.map((t) => [
      { v: esc(nice(t.label)), cls: "small" },
      { v: esc((ROLE_NAME[t.from] || t.from).split(" (")[0]), cls: "small" },
      txLink(t.hash),
      { v: t.refused ? `<span class="no">refused</span> <span class="mono">${esc(t.error)}</span>` : `<span class="ok">done</span>`, cls: "small" },
    ])
  )}
  <p class="small">Anchored claim: "${esc(dep.anchoredClaim.text)}" The contract stored it with ${pctText(dep.anchoredClaim.matchedBps)} matched hour by hour, a share it computed itself at that block. Claim hash <span class="mono">${esc(dep.anchoredClaim.hash.slice(0, 18))}...</span></p>
  <h3>Read the chain now</h3>
  <p class="small">This button asks a public Sepolia node for <span class="mono">matchedBps</span> for each company on ${esc(dep.day.date)} and puts the answer next to the number this page computes for the same day.</p>
  <button class="sec" id="readChain" type="button">Read matchedBps from Sepolia</button>
  <div id="chainRead" class="section tableScroll"></div>`;
$("chainInfo").innerHTML = `Contract on Ethereum Sepolia: <span class="mono">${esc(dep.contract)}</span>. Earlier single-wallet version: <span class="mono">${esc(dep.previous.contract)}</span> (superseded).`;

const hex = (n, bytes = 32) => BigInt(n).toString(16).padStart(bytes * 2, "0");
const b32 = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
async function ethCall(data) {
  let last;
  for (const url of meta.chain.rpc) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: dep.contract, data }, "latest"] }) });
      const j = await res.json();
      if (j.result) return { result: j.result, url };
      last = new Error(j.error?.message || "no result");
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
$("readChain").onclick = async () => {
  const btn = $("readChain");
  btn.disabled = true;
  $("chainRead").innerHTML = `<p class="small muted">Asking a public Sepolia node...</p>`;
  try {
    const from = BigInt(dep.day.from);
    const to = BigInt(dep.day.to);
    const rows = [];
    let used = "";
    for (const id of ["NORTHBAY-FAB", "HARBOR-OFFICE", "CLOUDLINE-DC"]) {
      const { result, url } = await ethCall(meta.chain.selectors.matchedBps + b32(id) + hex(from) + hex(to));
      used = url;
      const w = result.slice(2).match(/.{64}/g).map((x) => BigInt("0x" + x));
      const js = demo.ledger.matchedBps(id, from, to);
      const same = Number(w[0]) === js.bps && w[1] === js.consumedKwh && w[2] === js.matchedKwh;
      rows.push([
        esc(ROLE_NAME[id]),
        { v: `${pctText(js.bps)}<br><span class="muted">${fmt(js.matchedKwh)} / ${fmt(js.consumedKwh)} kWh</span>`, cls: "num", l: "Browser ledger" },
        { v: `${pctText(Number(w[0]))}<br><span class="muted">${fmt(w[2])} / ${fmt(w[1])} kWh</span>`, cls: "num", l: "Sepolia" },
        { v: same ? '<span class="ok">same</span>' : '<span class="no">different</span>', l: "" },
      ]);
    }
    $("chainRead").innerHTML = `${tbl([`Company, ${esc(dep.day.date)}`, `<span class="badge js">browser ledger</span><br>matched / used`, `<span class="badge chain">Sepolia</span><br>matched / used`, ""], rows)}
      <p class="small muted">Read at ${esc(new Date().toISOString().slice(11, 19))} UTC from ${esc(new URL(used).host)}. The contract rounds down to basis points (0.01%); the page shows one decimal.</p>`;
  } catch (e) {
    $("chainRead").innerHTML = `<p class="warn">Could not reach a Sepolia node from this browser (${esc(e.message || e)}). The values stored at deployment are in deployments/sepolia.json.</p>`;
  }
  btn.disabled = false;
};

// ---------- evaluation
{
  const row = (name, x) => `<tr><td>${name}</td><td class="num">${x.correct} / ${x.n}</td><td class="num">${x.shareWithin1pt ?? "-"}${x.shareWithin1pt !== undefined ? " / " + x.n : ""}</td></tr>`;
  $("evalBox").innerHTML = `<p class="small" style="margin-top:0">18 fictional claims about the demo week and 8 about a held-out week (22 to 28 September, set aside before the system was finished). The true verdict for each comes from fields read by hand, applied with the rules above.</p>
  <div class="tableScroll"><table><tr><th>Setup</th><th>Correct verdicts</th><th>Share within 1 point</th></tr>
  ${row("HourMatch, demo week (model fills fields, code decides)", S.system)}
  ${row("Model alone, same data and rules in its prompt", S.pure)}
  ${row("Spreadsheet with SUMPRODUCT, fields read by a person", { correct: S.spreadsheet.dev.correct, n: S.spreadsheet.dev.n })}
  ${row("HourMatch, held-out week", S.holdout.system)}
  ${row("Model alone, held-out week", S.holdout.pure)}
  ${row("Spreadsheet, held-out week", { correct: S.spreadsheet.holdout.correct, n: S.spreadsheet.holdout.n })}</table></div>
  <p class="small">Model: ${esc(S.model)} (${esc(S.provider)}), run once on ${esc(runText)}. Answering "NOT SUPPORTED" to every demo-week claim would score 10 of 18. The model alone mostly said no: it rejected 5 of the 8 true claims, and its percentage was off by more than one point in 13 of 18.</p>
  <h3>Three claims worked out by hand</h3>
  <p class="small">eval/HANDCALC.md lists every hour of three claims with the arithmetic written out. It is produced by a separate Python script that imports no HourMatch code; the tests check that the checker gives the same totals.</p>
  <div class="tableScroll"><table><tr><th>Claim</th><th>Hour by hour</th><th>Volume</th><th>Verdict</th></tr>${S.hand
    .map((h) => `<tr><td class="small">${esc(h.text)}</td><td class="num">${pctText(h.hourly_bps)}</td><td class="num">${pctText(h.volume_bps)}</td><td class="small">${h.verdict.replace("_", " ")}</td></tr>`)
    .join("")}</table></div>
  <h3>What this evaluation shows, and what it does not</h3>
  <ul class="small">
    <li>It shows that hour-by-hour arithmetic over 168 rows is unreliable when left to a language model, even with the data and rules in its prompt.</li>
    <li>It shows that the arithmetic itself is not hard: a spreadsheet with the right SUMPRODUCT formulas gets every claim right once a person has read the claim into fields (eval/SPREADSHEET.md, eval/spreadsheet_baseline.xlsx). HourMatch's value is not the arithmetic. It is that the inputs (who holds which hour's certificate, what was already retired, under which issuer) live in one shared state that a spreadsheet does not have and cannot enforce.</li>
    <li>It does not test real companies, real certificate data or real claims. All companies are fictional, the loads were designed (see the note at the top), and the claims were written by the author.</li>
    <li>It does not test the keyword rules used for typed sentences, beyond the unit tests in tests/ruleparse.test.mjs. The model numbers come from one run on 14 October 2026 and were not re-run.</li>
    <li>The truth labels and HourMatch share the same matching rule by definition. The hand calculation and the spreadsheet check the arithmetic independently; they do not check whether the rule itself is the right policy.</li>
  </ul>`;
}

// ---------- Taiwan context
{
  const LAW = "https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0100073";
  const LAW_ZH = "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0100073";
  const g = [
    ["Renewable energy certificate (T-REC)", "再生能源憑證", `Taiwan's certificate. One certificate is issued for every 1,000 kWh accumulated (Regulations, Art. 5). It carries no hour.`],
    ["National Renewable Energy Certification Center", "國家再生能源憑證中心", "Verifies the electricity volumes and runs the platform where certificates are held and transferred (trec.org.tw)."],
    ["Bureau of Standards, Metrology and Inspection (BSMI)", "經濟部標準檢驗局", "Issues the certificates, under the Ministry of Economic Affairs (Art. 2)."],
    ["Wheeling", "轉供", "A renewable plant sells power to a company over Taipower's grid. The certificates transferred must match the wheeled volume (Art. 7)."],
    ["Direct supply", "直供", "A renewable plant sells power straight to a company, over its own line (獨立型) or through the grid (併網型) (Art. 5)."],
    ["Self-generation for own use", "自發自用（現行法規：再生能源自用發電設備）", "A company generates its own renewable power. Certificates it has not used may be transferred to others (Art. 7)."],
    ["Retire", "註銷（法規用語：使用或宣告後向憑證中心登錄）", "Using a certificate for a claim. It must be registered with the Center within two months, and a used certificate can no longer be transferred (Art. 8)."],
    ["Transfer", "讓與", "In principle a certificate is transferred once; the Center may approve exceptions (Art. 7, para. 3)."],
    ["Hourly matching", "逐時媒合", "Counting renewable supply against use hour by hour instead of over a year. Not part of the T-REC rules today."],
    ["Taiwan Power Company (Taipower)", "台灣電力公司", "The grid operator; its open generation data supplies the real output curves in this demo."],
  ];
  const d = [
    ["Certificate size", "1,000 kWh, no hour stamp (Art. 5)", "1 kWh per plant per hour"],
    ["When it can be used", "For the generation year written on it (Art. 8)", "Only against use in the same hour"],
    ["Transfers", "Once in principle; exceptions with the Center's approval (Art. 7)", "Exactly once, plant account to buyer (OnlyOneTransfer). The exception path is not modelled."],
    ["Retirement", "Registered with the Center within two months of use (Art. 8)", "Immediate and public, from the company's own wallet"],
    ["Registry", "One national platform run by the government", "A public contract with an operator and authorized issuers. A demo only; it has no legal standing."],
  ];
  $("twBox").innerHTML = `<p class="small" style="margin-top:0">The interface is in English for an international jury. This table gives the Taiwanese terms and the current rules: <a href="${LAW}" target="_blank" rel="noopener">Implementation Regulations Governing Renewable Energy Certificates</a> (<a href="${LAW_ZH}" target="_blank" rel="noopener" class="zh">再生能源憑證實施辦法</a>, amended 26 May 2025, in force 1 July 2025), and the <a href="https://www.trec.org.tw/" target="_blank" rel="noopener">T-REC Center</a>.</p>
  ${tbl(["English", "中文", "What it means here"], g.map(([e, z, m]) => [{ v: `<b>${esc(e)}</b>`, cls: "small" }, { v: esc(z), cls: "small zh" }, { v: esc(m), cls: "small" }]))}
  <h3>Where HourMatch follows the current rules and where it differs</h3>
  ${tbl(["", "T-REC today", "HourMatch demo"], d.map(([k, a, b]) => [{ v: `<b>${esc(k)}</b>`, cls: "small", l: "" }, { v: esc(a), cls: "small" }, { v: esc(b), cls: "small" }]))}
  <h3>RE100 plant-age rule</h3>
  <p class="small">RE100 Technical Criteria (24 March 2025), section 4.2: renewable electricity must come from projects commissioned or re-powered on or after 1 January of the year fifteen years before the claim year, so 2011 or later for a 2026 claim. Up to 15% of total use may come from older projects. Exempt: self-generation, on-site or direct-line PPAs, long-term project-specific contracts held by the original off-taker, claims to default delivered renewable electricity, and contracts that began before 1 January 2024. HourMatch applies the 15-year limit and the 15% allowance, treats unknown dates as old, and does not model the exempt procurement types. Source: <a href="https://www.there100.org/technical-guidance" target="_blank" rel="noopener">there100.org technical guidance</a>.</p>`;
}

// ---------- start
drawChips();
drawFields();
$("claim").value = EXAMPLES[0];
run();
