// Optional serverless AI step: sentence -> structured claim. Returns 503 when no key is configured,
// and the page falls back to cached parses or the manual form. The verdict is never computed here.
import { parsePrompt } from "../src/parse.mjs";
import { chat, extractJson } from "../src/llm.mjs";

const MAX_CHARS = 400;
const hits = new Map(); // naive per-instance rate limit: 20 calls / 10 min / IP

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.LLM_API_KEY) return res.status(503).json({ error: "AI parse is off on this deployment" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 600000);
  if (recent.length >= 20) return res.status(429).json({ error: "rate limit" });
  hits.set(ip, [...recent, now]);
  const text = String(req.body?.text || "").slice(0, MAX_CHARS);
  if (!text.trim()) return res.status(400).json({ error: "empty claim" });
  try {
    const r = await chat(parsePrompt(text, { firstDate: "2026-10-06", lastDate: "2026-10-12" }), { maxTokens: 300, timeoutMs: 25000, retries: 0 });
    const obj = extractJson(r.text);
    if (!obj) return res.status(422).json({ error: "model output was not JSON" });
    return res.status(200).json({ claim: obj, model: r.model });
  } catch (e) {
    return res.status(502).json({ error: "model call failed" });
  }
}
