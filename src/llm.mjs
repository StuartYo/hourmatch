// Minimal OpenAI-compatible chat client.
// Default: PublicAI free inference (Apertus, Swiss AI). Key only from environment variables.
export const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.APERTUS_BASE_URL || "https://api.publicai.co/v1";
// Apertus 70B returned HTTP 429 on 2026-10-14 (free tier busy); Qwen-SEA-LION 32B answered.
export const LLM_MODEL = process.env.LLM_MODEL || "aisingapore/Qwen-SEA-LION-v4-32B-IT";

function apiKey() {
  return process.env.LLM_API_KEY || process.env.APERTUS_API_KEY || "";
}

export function llmAvailable() {
  return Boolean(apiKey());
}

export async function chat(messages, { model = LLM_MODEL, maxTokens = 600, timeoutMs = 90000, retries = 2 } = {}) {
  const key = apiKey();
  if (!key) throw new Error("no LLM key in environment (LLM_API_KEY or APERTUS_API_KEY)");
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": "hourmatch/0.1" },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? null, model };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export function extractJson(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
