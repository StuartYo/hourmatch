// Language model step: sentence -> structured claim. It never decides the verdict.
import { CONSUMERS } from "./scenario.mjs";
import { chat, extractJson } from "./llm.mjs";
import { validateClaim } from "./checker.mjs";

export function parsePrompt(claimText, { firstDate, lastDate }) {
  const consumers = CONSUMERS.map((c) => `- ${c.id}: ${c.name}, ${c.profile}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You convert a company's green-electricity claim into JSON for a checker. Do not judge whether it is true. " +
        "Output one JSON object only, no prose.",
    },
    {
      role: "user",
      content: `Known electricity consumers:
${consumers}

Ledger data covers ${firstDate} to ${lastDate} (Taiwan time, UTC+8). Days of week: Monday-Friday are weekdays.

Fields:
- consumer_id: one of the ids above
- start_date, end_date: YYYY-MM-DD, inclusive. "this week" = the whole ledger range.
- hour_from: 0-23, hour_to: 1-24 (exclusive). Whole day = 0 and 24. "business hours" = 8 and 19. "at night" = 0 and 6 unless the claim says otherwise.
- weekdays_only: true only if the claim limits itself to weekdays / business days
- claimed_pct: the share of electricity the claim says was renewable (100 for "fully", "all", "100%")
- standard: "hourly" if the claim says hour-by-hour, every hour, 24/7, or around the clock;
  "volume" if it says certificates/purchases equal to or covering X% of consumption (a total over the period);
  otherwise "unspecified"
- re100: true if the claim says RE100-eligible / RE100-compliant
- claim_year: 2026

Claim: """${claimText}"""`,
    },
  ];
}

export async function parseClaim(claimText, range, opts = {}) {
  const r = await chat(parsePrompt(claimText, range), opts);
  const obj = extractJson(r.text);
  if (!obj) return { ok: false, errors: ["model output was not JSON"], raw: r.text, usage: r.usage };
  for (const f of ["hour_from", "hour_to", "claimed_pct", "claim_year"]) {
    if (typeof obj[f] === "string" && obj[f].trim() !== "" && !isNaN(Number(obj[f]))) obj[f] = Number(obj[f]);
  }
  obj.weekdays_only = obj.weekdays_only === true || obj.weekdays_only === "true";
  obj.re100 = obj.re100 === true || obj.re100 === "true";
  const errors = validateClaim(obj);
  return { ok: errors.length === 0, claim: obj, errors, raw: r.text, usage: r.usage };
}
